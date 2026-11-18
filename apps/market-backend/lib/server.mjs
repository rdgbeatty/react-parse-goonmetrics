import { createServer } from "node:http";
import { readFile, mkdir, unlink, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { EveSso } from "./auth.mjs";
import { runHistorySession, sessionSummaryPath } from "./history-session.mjs";
import { historyDiagnostics } from "./history-diagnostics.mjs";
import { recentRuns } from "./jobs.mjs";
import { collectLive } from "./collector.mjs";
import { createFixture } from "./fixture.mjs";
import { readJson, writeJson, publishSnapshot, withLock } from "./storage.mjs";
import { ROOT, DEFAULT_STATE } from "./paths.mjs";
export { ROOT, DEFAULT_STATE } from "./paths.mjs";

const DEFAULT_CONFIG = { clientId: "", clientSecret: "", tortugaId: "", tortugaEnabled: false, additionalHubs: [], cjId: "1049588174021", contact: "", typeLimit: 0, historyLimit: 0, historyBatchSeconds: 300 };
const textHeaders = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
const assets = { "/": ["index.html", "text/html; charset=utf-8"], "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.mjs": ["app.mjs", "text/javascript; charset=utf-8"], "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/snapshot.mjs": ["snapshot.mjs", "text/javascript; charset=utf-8"], "/data/market.json": ["data/market.json", "application/json"] };

export async function initialize(directory = DEFAULT_STATE) {
  const snapshotPath = join(directory, "public", "data", "market.json");
  if (!(await readJson(snapshotPath))) await publishSnapshot(snapshotPath, createFixture());
  if (!(await readJson(join(directory, "private", "config.json")))) await writeJson(join(directory, "private", "config.json"), DEFAULT_CONFIG);
}

export async function exportSite(directory = DEFAULT_STATE) {
  const site = join(directory, "site");
  await mkdir(join(site, "data"), { recursive: true });
  for (const file of ["index.html", "app.mjs", "styles.css"]) await copyFile(join(ROOT, "apps", "market-backend", "public", file), join(site, file));
  await copyFile(join(ROOT, "packages", "shared", "src", "marketSnapshot.mjs"), join(site, "snapshot.mjs"));
  await copyFile(join(directory, "public", "data", "market.json"), join(site, "data", "market.json"));
  return site;
}

export function createBackendServer({ directory = DEFAULT_STATE, local = true, sso = new EveSso(), collector = collectLive, jobOptions = {} } = {}) {
  const configPath = join(directory, "private", "config.json");
  const grantPath = join(directory, "private", "grant.json");
  const snapshotPath = join(directory, "public", "data", "market.json");
  const csrf = randomBytes(32).toString("hex");
  const pending = new Map();
  let busy = false;
  let lastError = null;
  let progress = null;
  let controller, pauseRequested = false;
  const reportProgress = (update) => { progress = { ...progress, ...update, updatedAt: new Date().toISOString() }; };
  const json = (res, status, body, headers = {}) => { res.writeHead(status, { ...textHeaders, "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
  const operation = async (fn) => {
    if (busy) throw new Error("Another local operation is running. Wait for it to finish.");
    busy = true;
    try { return await withLock(directory, fn); } finally { busy = false; }
  };
  async function requestJson(req) {
    if (!String(req.headers["content-type"]).startsWith("application/json")) throw new Error("Expected application/json.");
    let content = "";
    for await (const chunk of req) { content += chunk; if (content.length > 16_384) throw new Error("Local configuration request is too large."); }
    return JSON.parse(content || "{}");
  }

  const server = createServer(async (req, res) => {
    const port = res.socket.localPort;
    const allowedHosts = [`localhost:${port}`, `127.0.0.1:${port}`];
    if (!allowedHosts.includes(req.headers.host)) return json(res, 403, { error: "Local host required." });
    const origin = `http://${req.headers.host}`;
    const url = new URL(req.url, origin);
    const callback = `${origin}/auth/eve/callback`;
    try {
      if (local && url.pathname === "/local/status" && req.method === "GET") {
        const config = { ...DEFAULT_CONFIG, ...await readJson(configPath, {}) };
        const grant = await readJson(grantPath);
        return json(res, 200, { csrf, busy, lastError, progress, pauseRequested, historySession: await readJson(sessionSummaryPath(directory)), callback, connected: Boolean(grant?.character), character: grant?.character?.name ?? null,
          config: { ...config, clientSecret: undefined, hasClientSecret: Boolean(config.clientSecret) } });
      }
      if (local && url.pathname === "/local/history-state" && req.method === "GET") {
        const snapshot = await readJson(snapshotPath);
        return json(res, 200, snapshot.mode === "live" ? await historyDiagnostics(directory, snapshot) : { targetPairs: 0, deferred: [] });
      }
      if (local && url.pathname === "/local/metrics" && req.method === "GET") return json(res, 200, { runs: await recentRuns(directory) });
      if (local && url.pathname.startsWith("/local/") && req.method === "POST") {
        if (req.headers.origin !== origin || req.headers["x-local-csrf"] !== csrf) return json(res, 403, { error: "Reload this local page before making changes." });
        const body = await requestJson(req);
        if (url.pathname === "/local/pause-history") {
          pauseRequested = true;
          return json(res, 200, { ok: true, message: "Pause requested; the current batch will checkpoint and publish before stopping." });
        }
        if (url.pathname === "/local/config") {
          await operation(async () => {
            const old = { ...DEFAULT_CONFIG, ...await readJson(configPath, {}) };
            const secretInput = String(body.clientSecret ?? "").trim();
            const config = { clientId: String(body.clientId ?? "").trim(), clientSecret: secretInput || old.clientSecret.trim(),
              tortugaId: String(body.tortugaId ?? "").trim(), tortugaEnabled: body.tortugaEnabled ?? old.tortugaEnabled, additionalHubs: old.additionalHubs, cjId: String(body.cjId ?? "").trim(), contact: String(body.contact ?? "").trim(),
              typeLimit: Number(body.typeLimit), historyLimit: 0, historyBatchSeconds: Number(body.historyBatchSeconds ?? old.historyBatchSeconds) };
            if (!Number.isInteger(config.typeLimit) || config.typeLimit < 0 || config.typeLimit > 200 ||
              !Number.isInteger(config.historyBatchSeconds) || config.historyBatchSeconds < 1 || config.historyBatchSeconds > 1800) throw new Error("Live types must be 0 (all) or 1–200; history batch seconds must be 1–1800.");
            if (typeof config.tortugaEnabled !== "boolean") throw new Error("Tortuga enabled must be true or false.");
            for (const id of [config.tortugaId, config.cjId]) if (id && !/^\d{1,16}$/.test(id)) throw new Error("Structure IDs must contain digits only.");
            if ([config.clientId, config.clientSecret, config.contact].some((value) => /[\r\n]/.test(value))) throw new Error("Configuration fields must be single-line values.");
            await writeJson(configPath, config);
            if (config.clientId !== old.clientId || config.clientSecret !== old.clientSecret) await unlink(grantPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
            lastError = null;
          });
          return json(res, 200, { ok: true });
        }
        if (url.pathname === "/local/connect") {
          const config = await readJson(configPath);
          if (!config?.clientId) throw new Error("Save your EVE application client ID first. Local login uses PKCE and does not require the application secret.");
          const state = randomBytes(32).toString("hex");
          const codeVerifier = randomBytes(32).toString("base64url");
          for (const [key, value] of pending) if (value.expiresAt < Date.now()) pending.delete(key);
          if (pending.size > 20) pending.clear();
          pending.set(state, { expiresAt: Date.now() + 300_000, clientId: config.clientId, redirectUri: callback, codeVerifier });
          const authorizationUrl = await sso.authorizationUrl(config, callback, state, codeVerifier);
          return json(res, 200, { url: authorizationUrl }, { "Set-Cookie": `eve_poc_state=${state}; HttpOnly; SameSite=Lax; Path=/auth/eve/callback; Max-Age=300` });
        }
        if (url.pathname === "/local/disconnect") {
          await operation(() => unlink(grantPath).catch((error) => { if (error.code !== "ENOENT") throw error; }));
          lastError = null;
          return json(res, 200, { ok: true });
        }
        if (["/local/collect", "/local/fixture", "/local/history", "/local/verify", "/local/quotes"].includes(url.pathname)) {
          if (busy) return json(res, 409, { error: "A collection is already running." });
          pauseRequested = false;
          progress = { phase: "starting", message: url.pathname === "/local/fixture" ? "Generating the simulated snapshot…" : "Starting live collection…",
            startedAt: new Date().toISOString(), hubsCompleted: 0, hubTotal: null, hubIndex: 0, hubName: null,
            completed: 0, total: null, unit: "steps" };
          // Work stays in this local process; the public site consumes only the resulting file.
          void operation(async () => {
            lastError = null;
            controller = new AbortController();
            try { await runHistorySession(url.pathname.slice(7), directory, await readJson(configPath), sso,
              { ...jobOptions, collector, resume: Boolean(body.resume), shouldPause: () => pauseRequested, onProgress: reportProgress, signal: controller.signal }); }
            finally { controller = null; }
          }).catch((error) => { lastError = error.message; reportProgress({ phase: "failed", message: error.message }); });
          return json(res, 202, { ok: true });
        }
      }
      if (local && url.pathname === "/auth/eve/callback" && req.method === "GET") {
        const state = url.searchParams.get("state") ?? "";
        const cookie = /(?:^|;\s*)eve_poc_state=([a-f0-9]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
        const record = pending.get(state);
        if (!record || record.expiresAt < Date.now() || state.length !== cookie.length || !timingSafeEqual(Buffer.from(state), Buffer.from(cookie))) throw new Error("EVE login state is invalid or expired. Start Connect EVE again from the local page.");
        pending.delete(state);
        if (url.searchParams.has("error")) throw new Error("EVE login was canceled or denied. You can reconnect from the local page.");
        const code = url.searchParams.get("code");
        if (!code || code.length > 4096) throw new Error("EVE did not return an authorization code.");
        await operation(async () => {
          const config = await readJson(configPath);
          if (config.clientId !== record.clientId) throw new Error("Application client ID changed during login. Connect EVE again.");
          if (callback !== record.redirectUri) throw new Error("The local callback address changed during login. Open the original local address and start Connect EVE again.");
          await sso.authorize(config, code, record.redirectUri, (grant) => writeJson(grantPath, grant), record.codeVerifier);
        });
        lastError = null;
        res.writeHead(303, { ...textHeaders, Location: "/?connected=1", "Set-Cookie": "eve_poc_state=; HttpOnly; SameSite=Lax; Path=/auth/eve/callback; Max-Age=0" });
        return res.end();
      }
      if (req.method !== "GET" && req.method !== "HEAD") return json(res, 404, { error: "Not found." });
      const asset = assets[url.pathname];
      if (!asset) return json(res, 404, { error: "Not found." });
      let path;
      if (!local) path = join(directory, "site", asset[0]);
      else if (url.pathname === "/snapshot.mjs") path = join(ROOT, "packages", "shared", "src", "marketSnapshot.mjs");
      else if (url.pathname === "/data/market.json") path = snapshotPath;
      else path = join(ROOT, "apps", "market-backend", "public", asset[0]);
      const contents = await readFile(path);
      res.writeHead(200, { ...textHeaders, "Content-Type": asset[1], "Content-Length": contents.length });
      res.end(req.method === "HEAD" ? undefined : contents);
    } catch (error) {
      const message = error instanceof SyntaxError ? "Invalid JSON request." : error.code === "ENOENT" ? "File unavailable. Run the local backend first." : error.message;
      if (url.pathname === "/auth/eve/callback") {
        lastError = message;
        res.writeHead(303, { ...textHeaders, Location: "/?auth=failed", "Set-Cookie": "eve_poc_state=; HttpOnly; SameSite=Lax; Path=/auth/eve/callback; Max-Age=0" });
        res.end();
      } else json(res, 400, { error: message });
    }
  });
  server.stopJobs = () => controller?.abort();
  return server;
}

// Compatibility for existing local test/preview harnesses.
export const createPrototypeServer = createBackendServer;
