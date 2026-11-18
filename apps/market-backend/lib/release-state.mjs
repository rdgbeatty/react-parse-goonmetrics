import { readdir, lstat, readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readJson, writeJson } from "./storage.mjs";
import { validateSnapshot } from "../../../packages/shared/src/marketSnapshot.mjs";
const compress = promisify(gzip), decompress = promisify(gunzip);
const MAX_BYTES = 384 * 1024 * 1024;
const checksum = (text) => createHash("sha256").update(text).digest("hex");
const allowed = (name) => /^(?:catalog\/(?:current|types-[a-f0-9]{64})\.json|history\/regions\/\d+\/\d{2}\.json|history\/summaries\/\d+\.json|history\/checkpoints\/[a-z0-9-]+\.json|history\/session\/(?:state|current)\.json|public\/data\/market\.json)$/.test(name);
function noCredentials(value) {
  if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    if (/^(?:refresh_?token|access_?token|client_?secret|private_?key|authorization|csrf)$/i.test(key)) throw new Error("Credential field rejected at the public state boundary.");
    noCredentials(item);
  }
}
export async function encodeState(directory, repository, now = new Date()) {
  directory = resolve(directory);
  const files = [];
  const manifest = await readJson(join(directory, "catalog", "current.json"));
  const walk = async (relative) => {
    const stat = await lstat(join(directory, relative)).catch((e) => { if (e.code === "ENOENT") return null; throw e; });
    if (stat?.isSymbolicLink()) throw new Error("Symlinks are forbidden in retained state.");
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true }).catch((e) => { if (e.code === "ENOENT") return []; throw e; })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error("Symlinks are forbidden in retained state.");
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!allowed(path) || (path.startsWith("catalog/types-") && entry.name !== manifest?.dataFile)) continue;
      const text = await readFile(join(directory, path), "utf8"), value = JSON.parse(text);
      noCredentials(value);
      if (path === "public/data/market.json") { validateSnapshot(value); if (value.mode !== "live") throw new Error("Simulated snapshots cannot be retained as production state."); }
      files.push({ path, sha256: checksum(text), text });
    }
  };
  for (const path of ["catalog", "history", "public/data"]) await walk(path);
  const raw = JSON.stringify({ schemaVersion: 1, repository, createdAt: now.toISOString(), files });
  if (Buffer.byteLength(raw) > MAX_BYTES || files.length > 4096) throw new Error("Retained state exceeds release limits.");
  return compress(raw, { level: 1 });
}
export async function restoreState(buffer, directory, repository) {
  directory = resolve(directory);
  if (buffer.length > 128 * 1024 * 1024) throw new Error("Compressed state exceeds release limits.");
  let archive;
  try { archive = JSON.parse(await decompress(buffer, { maxOutputLength: MAX_BYTES })); } catch { throw new Error("Retained state is corrupt or too large."); }
  if (archive?.schemaVersion !== 1 || archive.repository !== repository || !Number.isFinite(Date.parse(archive.createdAt)) ||
      !Array.isArray(archive.files) || archive.files.length > 4096) throw new Error("Incompatible retained state manifest.");
  const names = new Set();
  // Validate every path and body before writing anything. This format has no tar extraction.
  for (const file of archive.files) {
    if (typeof file.path !== "string" || !allowed(file.path) || names.has(file.path) || typeof file.text !== "string" || checksum(file.text) !== file.sha256) throw new Error("Invalid retained state entry/checksum.");
    names.add(file.path); const value = JSON.parse(file.text); noCredentials(value);
    if (file.path === "public/data/market.json") { validateSnapshot(value); if (value.mode !== "live") throw new Error("Production state contains simulated data."); }
    let path = join(directory, file.path);
    for (;;) {
      const stat = await lstat(path).catch((e) => { if (e.code === "ENOENT") return null; throw e; });
      if (stat?.isSymbolicLink()) throw new Error("Cannot restore through a symlink.");
      const parent = dirname(path); if (parent === path) break; path = parent;
    }
  }
  for (const file of archive.files) await writeJson(join(directory, file.path), JSON.parse(file.text));
  return { createdAt: archive.createdAt, files: archive.files.length };
}

const TAG = "market-state";
async function listAssets(api, releaseId) {
  const assets = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api.request(`${api.base}/releases/${releaseId}/assets?per_page=100&page=${page}`);
    assets.push(...batch);
    if (batch.length < 100) return assets;
  }
  throw new Error("State release has too many assets; prune it before collecting.");
}
export async function stateRelease(api, { create = false, branch = "main" } = {}) {
  let release = await api.request(`${api.base}/releases/tags/${TAG}`, { allow404: true });
  if (!release && create) release = await api.request(`${api.base}/releases`, { method: "POST", body: {
    tag_name: TAG, target_commitish: branch, name: "Market collector state", body: "Generated nonsecret catalog/history checkpoints. Credentials are stored only in Actions Secrets.", prerelease: true } });
  if (release?.immutable) throw new Error("Collector state requires a mutable release. Disable release immutability for this checkpoint store or select another store.");
  return release;
}
export async function downloadAsset(api, asset) {
  if (!Number.isSafeInteger(asset.id) || asset.size > 128 * 1024 * 1024) throw new Error("Invalid state release asset.");
  let response = await api.fetch(`https://api.github.com${api.base}/releases/assets/${asset.id}`, { redirect: "manual", signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${api.token}`, Accept: "application/octet-stream", "X-GitHub-Api-Version": "2022-11-28" } });
  if (response.status === 302) {
    const location = new URL(response.headers.get("location"));
    await response.body?.cancel();
    if (location.protocol !== "https:" || !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(location.hostname)) throw new Error("Unexpected release download redirect.");
    // Signed CDN URL: never forward the GitHub bearer token to it.
    response = await api.fetch(location, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`State download failed (${response.status}).`); }
  const chunks = []; let length = 0;
  for await (const chunk of response.body) { length += chunk.length; if (length > 128 * 1024 * 1024) throw new Error("State download exceeds limits."); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks);
  if (asset.digest && asset.digest !== `sha256:${checksum(bytes)}`) throw new Error("Release asset digest mismatch.");
  return bytes;
}
export async function restoreLatest(api, directory) {
  const release = await stateRelease(api);
  if (!release) return null;
  const assets = (await listAssets(api, release.id)).filter((a) => /^state-\d{13}-[a-f0-9]{8}\.json\.gz$/.test(a.name) && a.state === "uploaded").sort((a,b) => b.name.localeCompare(a.name));
  if (!assets.length) throw new Error("State release exists but has no valid checkpoints; resolve it before creating a replacement.");
  // Never silently fall back to an older generation: doing so could roll state backwards.
  return restoreState(await downloadAsset(api, assets[0]), directory, api.repository);
}
export async function saveStateRelease(api, directory, { branch, generation, retain = 3 } = {}) {
  if (!/^\d{13}-[a-f0-9]{8}$/.test(generation)) throw new Error("Invalid state generation.");
  const body = await encodeState(directory, api.repository);
  const release = await stateRelease(api, { create: true, branch });
  const url = new URL(release.upload_url.replace(/\{.*$/, ""));
  if (url.origin !== "https://uploads.github.com" || !url.pathname.startsWith(`/repos/${api.repository}/releases/`)) throw new Error("Unexpected release upload endpoint.");
  url.searchParams.set("name", `state-${generation}.json.gz`);
  const response = await api.fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${api.token}`, "Content-Type": "application/gzip", "X-GitHub-Api-Version": "2022-11-28" }, body });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`State upload failed (${response.status}); previous checkpoints retained.`); }
  const asset = await response.json();
  if (asset.state !== "uploaded" || asset.size !== body.length || (asset.digest && asset.digest !== `sha256:${checksum(body)}`)) throw new Error("Uploaded state could not be verified.");
  // Download and validate before declaring the new generation usable. Deletion is separate.
  const downloaded = await downloadAsset(api, asset);
  if (checksum(downloaded) !== checksum(body)) throw new Error("Uploaded state differs from the local checkpoint.");
  return { generation, bytes: body.length, releaseId: release.id, retain };
}
export async function pruneStateRelease(api, { releaseId, retain = 3 }) {
  const assets = (await listAssets(api, releaseId)).filter((a) => /^state-\d{13}-[a-f0-9]{8}\.json\.gz$/.test(a.name) && a.state === "uploaded").sort((a,b) => b.name.localeCompare(a.name));
  for (const asset of assets.slice(retain)) await api.request(`${api.base}/releases/assets/${asset.id}`, { method: "DELETE" });
}
