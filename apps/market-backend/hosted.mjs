import { join, resolve } from "node:path";
import { mkdir, appendFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ROOT } from "./lib/paths.mjs";
import { readJson, writeJson, withLock } from "./lib/storage.mjs";
import { validateReleaseConfig } from "./lib/release-config.mjs";
import { GitHubApi } from "./lib/github-client.mjs";
import { secretWriter, maskSecret } from "./lib/github-node.mjs";
import { restoreLatest, saveStateRelease, pruneStateRelease, stateRelease } from "./lib/release-state.mjs";
import { adoptGrant, parseGrant, durableSso, installGrant } from "./lib/hosted-auth.mjs";
import { EveSso } from "./lib/auth.mjs";
import { updateCatalogUnlocked } from "./lib/catalog.mjs";
import { runJob } from "./lib/jobs.mjs";

export function checkHostedContext(config, env) {
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REPOSITORY !== config.repository || env.GITHUB_REF !== `refs/heads/${config.branch}` ||
      env.GITHUB_ACTOR?.toLowerCase() !== config.repository.split("/")[0].toLowerCase()) throw new Error("Hosted mutation requires an owner-triggered Action on the configured repository/default branch.");
}
export async function runHosted({ operation, directory, config, env = process.env, sso = new EveSso(), writer,
  api = new GitHubApi({ repository: config.repository, token: env.GITHUB_TOKEN }), dependencies = {} }) {
  checkHostedContext(config, env);
  if (!["adopt", "quotes", "history", "resume", "catalog", "restore", "prune"].includes(operation)) throw new Error("Invalid hosted operation.");
  const restore = dependencies.restore ?? restoreLatest, save = dependencies.save ?? saveStateRelease;
  const run = dependencies.run ?? runJob, catalog = dependencies.catalog ?? updateCatalogUnlocked;
  await mkdir(directory, { recursive: true });
  if (operation === "prune") { const release = await stateRelease(api); if (release) await pruneStateRelease(api, { releaseId: release.id }); return { pruned: true }; }
  return withLock(directory, async () => {
    if (operation === "adopt") {
      writer ??= await secretWriter(config, env);
      const grant = await adoptGrant({ config, pendingText: env.EVE_PENDING_GRANT, currentText: env.EVE_GRANT, nonce: env.MARKET_SETUP_NONCE, writer, sso });
      return { adopted: true, characterId: grant.character.id };
    }
    const restored = await restore(api, directory);
    if (operation === "restore") return { restored: Boolean(restored) };
    let authenticated;
    if (["quotes", "resume"].includes(operation)) {
      writer ??= await secretWriter(config, env);
      const grant = parseGrant(env.EVE_GRANT, config.collectorCharacterId);
      await installGrant(directory, grant); authenticated = durableSso(sso, writer, config.collectorCharacterId);
    }
    if (operation === "history" && (await readJson(join(directory, "public", "data", "market.json")))?.mode !== "live") throw new Error("Collect live quotes before continuing history.");
    await writeJson(join(directory, "private", "config.json"), config);
    const controller = new AbortController();
    const stop = () => controller.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
    let report, failure;
    try {
      if (operation !== "history") await catalog(directory, { ...dependencies.catalogOptions, onProgress: (p) => { if (p.phase !== "extracting") console.log(`Catalog: ${p.phase}`); } });
      if (operation !== "catalog") report = await run(operation === "resume" ? "collect" : operation, directory, config, authenticated,
        { signal: controller.signal, historyOptions: { maxPairs: 1000, maxSeconds: 300 } });
    } catch (error) { failure = error; }
    finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
    // A failed history batch may still have durable completed checkpoints. Preserve them.
    const generation = `${Date.now()}-${randomBytes(4).toString("hex")}`;
    if (!await readJson(join(directory, "catalog", "current.json")) && !await readJson(join(directory, "public", "data", "market.json"))) throw failure ?? new Error("No valid data to checkpoint yet.");
    const checkpoint = await save(api, directory, { branch: config.branch, generation });
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `state_release_id=${checkpoint.releaseId}\n`);
    if (failure) throw failure;
    return { restored: Boolean(restored), operation, generation, archiveBytes: checkpoint.bytes, status: report?.status ?? "complete", metrics: report ? { durationMs: report.durationMs, cpuUserMs: report.cpuUserMs, cpuSystemMs: report.cpuSystemMs, maxRssKiB: report.maxRssKiB, quoteRequests: report.quoteRequests, history: report.history } : null };
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    for (const arg of args) if (!/^--operation=(?:adopt|quotes|history|resume|catalog|restore|prune)$/.test(arg)) throw new Error("Use --operation=adopt|quotes|history|resume|catalog|restore|prune.");
    const operation = args[0]?.split("=")[1];
    const config = validateReleaseConfig(await readJson(join(ROOT, "config", "market.json")));
    if (!process.env.MARKET_STATE_DIRECTORY) throw new Error("Set an isolated MARKET_STATE_DIRECTORY in the workflow.");
    maskSecret(process.env.MARKET_WRITER_TOKEN); maskSecret(process.env.MARKET_APP_PRIVATE_KEY);
    if (process.env.EVE_GRANT) { try { maskSecret(JSON.parse(process.env.EVE_GRANT).refreshToken); } catch { /* Validation follows. */ } }
    if (process.env.EVE_PENDING_GRANT) { try { maskSecret(JSON.parse(process.env.EVE_PENDING_GRANT).grant?.refreshToken); } catch { /* Validation follows. */ } }
    console.log(JSON.stringify(await runHosted({ operation, directory: resolve(process.env.MARKET_STATE_DIRECTORY), config })));
  } catch (error) { console.error(error.message); if (error.name === "EveSsoError") console.error("Reconnect the hosted collector through market/connect.html; its production grant is separate from local setup."); process.exitCode = 1; }
}
