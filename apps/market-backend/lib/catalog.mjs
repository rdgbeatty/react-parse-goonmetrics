import { createHash } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { validateCatalog, CATALOG_VERSION } from "../../../packages/shared/src/marketCatalog.mjs";
import { readJson, writeJson, withLock } from "./storage.mjs";
import { openSdeTypes } from "./sde-archive.mjs";

const SDE_ROOT = "https://developers.eveonline.com/static-data/tranquility";
export const LATEST_SDE_URL = `${SDE_ROOT}/latest.jsonl`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || !Number.isSafeInteger(manifest.buildNumber) || manifest.buildNumber <= 0 ||
    !Number.isFinite(Date.parse(manifest.sourceReleasedAt)) || !Number.isFinite(Date.parse(manifest.importedAt)) ||
    !/^[a-f0-9]{64}$/.test(manifest.contentSha256) || manifest.dataFile !== `types-${manifest.contentSha256}.json` ||
    !Number.isSafeInteger(manifest.typeCount) || manifest.typeCount < 1) throw new Error("Invalid catalog manifest. Run the catalog updater with --force to rebuild.");
  return manifest;
}

export async function loadCatalog(directory) {
  const manifest = await readJson(join(directory, "catalog", "current.json"));
  if (!manifest) throw new Error("No static item catalog. Run npm run backend:catalog before collecting markets.");
  validateManifest(manifest);
  let bytes;
  try { bytes = await readFile(join(directory, "catalog", manifest.dataFile)); }
  catch { throw new Error("Catalog data file is missing. Run npm run backend:catalog -- --force."); }
  if (sha256(bytes) !== manifest.contentSha256) throw new Error("Catalog checksum mismatch. Run npm run backend:catalog -- --force.");
  const catalog = validateCatalog(JSON.parse(bytes));
  if (Object.keys(catalog.types).length !== manifest.typeCount) throw new Error("Catalog type count mismatch.");
  return { manifest, catalog };
}

export async function compileCatalog(stream) {
  const types = Object.create(null);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let source;
      try { source = JSON.parse(line); } catch { throw new Error("Invalid JSON line in SDE types."); }
      // CCP includes a reserved type-zero record; it cannot identify a tradable item.
      if (source._key === 0) continue;
      const id = String(source._key);
      if (Object.hasOwn(types, id)) throw new Error(`Duplicate SDE type ${id}.`);
      types[id] = { name: source.name?.en, groupId: source.groupID ?? 0, marketGroupId: source.marketGroupID ?? null,
        published: source.published ?? false, volumeM3: source.volume ?? null, packagedVolumeM3: source.packagedVolume ?? null };
    }
  } finally { lines.close(); stream.destroy(); }
  return validateCatalog({ schemaVersion: CATALOG_VERSION, types });
}

async function latestBuild(fetchImpl) {
  const response = await fetchImpl(LATEST_SDE_URL, { signal: AbortSignal.timeout(30_000), headers: { Accept: "application/jsonl" } });
  if (!response.ok) throw new Error(`SDE version check failed (${response.status}).`);
  const content = await response.text();
  if (content.length > 100_000) throw new Error("Oversized SDE version response.");
  const records = content.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const latest = records.find((record) => record._key === "sde");
  if (!Number.isSafeInteger(latest?.buildNumber) || latest.buildNumber <= 0 || !Number.isFinite(Date.parse(latest.releaseDate))) throw new Error("Invalid SDE build metadata.");
  return latest;
}

// Internal entrypoint for a job already holding the shared operation lock.
export async function updateCatalogUnlocked(directory, { fetchImpl = fetch, now = () => new Date(), checkOnly = false, force = false, onProgress = () => {} } = {}) {
    onProgress({ phase: "checking" });
    const latest = await latestBuild(fetchImpl);
    let previous;
    try { previous = await readJson(join(directory, "catalog", "current.json")); }
    catch (error) { if (!force) throw error; previous = null; }
    if (previous) {
      try { validateManifest(previous); } catch (error) { if (!force) throw error; previous = null; }
    }
    if (checkOnly) return { status: previous?.buildNumber === latest.buildNumber ? "up_to_date" : "update_available",
      installedBuild: previous?.buildNumber ?? null, availableBuild: latest.buildNumber };
    if (!force && previous?.buildNumber === latest.buildNumber) {
      await loadCatalog(directory); // Same version is not enough if local data was lost or corrupted.
      return { status: "up_to_date", buildNumber: latest.buildNumber, typeCount: previous.typeCount, contentSha256: previous.contentSha256 };
    }
    const archiveUrl = `${SDE_ROOT}/eve-online-static-data-${latest.buildNumber}-jsonl.zip`;
    onProgress({ phase: "downloading", buildNumber: latest.buildNumber });
    const entry = await openSdeTypes(archiveUrl, { fetchImpl, onProgress });
    const catalog = await compileCatalog(entry.stream);
    const serialized = JSON.stringify(catalog), contentSha256 = sha256(serialized), dataFile = `types-${contentSha256}.json`;
    const dataPath = join(directory, "catalog", dataFile);
    let reusable = false;
    try { await access(dataPath); reusable = sha256(await readFile(dataPath)) === contentSha256; } catch { /* New catalog. */ }
    if (!reusable) await writeJson(dataPath, catalog);
    const manifest = { schemaVersion: 1, buildNumber: latest.buildNumber, sourceReleasedAt: latest.releaseDate,
      importedAt: now().toISOString(), sourceUrl: archiveUrl, sourceMember: entry.member.name,
      sourceCrc32: entry.member.crc32.toString(16).padStart(8, "0"), contentSha256, dataFile,
      typeCount: Object.keys(catalog.types).length };
    // Only this last atomic pointer swap activates the new, validated catalog.
    await writeJson(join(directory, "catalog", "current.json"), manifest);
    const result = { status: previous?.contentSha256 === contentSha256 ? "version_advanced_content_unchanged" : "updated",
      buildNumber: latest.buildNumber, typeCount: manifest.typeCount, contentSha256, catalogBytes: Buffer.byteLength(serialized), ...entry.statistics() };
    onProgress({ phase: "complete", ...result });
    return result;
}

export function updateCatalog(directory, options = {}) {
  return withLock(directory, () => updateCatalogUnlocked(directory, options));
}
