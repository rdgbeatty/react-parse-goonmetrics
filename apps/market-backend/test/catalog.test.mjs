import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { deflateRawSync } from "node:zlib";
import { compileCatalog, updateCatalog, loadCatalog, LATEST_SDE_URL } from "../lib/catalog.mjs";
import { updateCrc32 } from "../lib/sde-archive.mjs";

const sourceType = (id, overrides = {}) => ({ _key: id, name: { en: id === 34 ? "Tritanium" : "Rifter", de: "Other language" },
  groupID: 18, marketGroupID: 1857, published: true, volume: 27000, packagedVolume: 2500, ...overrides });
const records = [sourceType(0), sourceType(34, { volume: 0.01, packagedVolume: 0.01 }), sourceType(587), sourceType(48464, { published: false, groupID: 0 })];
function zipTypes(rows, corrupt = false) {
  const raw = Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n"), packed = deflateRawSync(raw);
  const name = Buffer.from("types.jsonl"), crc = (updateCrc32(0xffffffff, raw) ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(corrupt ? (crc ^ 1) >>> 0 : crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + packed.length, 16);
  return Buffer.concat([local, name, packed, central, name, end]);
}
function provider(rows = records) {
  const state = { rows, build: 12345, corrupt: false, calls: [] };
  state.fetch = async (url, options = {}) => {
    state.calls.push({ url, range: options.headers?.Range });
    if (url === LATEST_SDE_URL) return new Response(JSON.stringify({ _key: "sde", buildNumber: state.build, releaseDate: "2026-11-04T12:00:00Z" }));
    const zip = zipTypes(state.rows, state.corrupt), range = /^bytes=(\d*)-(\d*)$/.exec(options.headers?.Range ?? "");
    assert.ok(range);
    const start = range[1] ? Number(range[1]) : Math.max(0, zip.length - Number(range[2]));
    const end = range[1] ? Number(range[2]) : zip.length - 1;
    return new Response(zip.subarray(start, end + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${zip.length}`, ETag: '"immutable-build"' } });
  };
  return state;
}
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), "market-catalog-test-"));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}

test("SDE catalog imports static fields, skips reserved zero and keeps unpublished group-zero types", async () => {
  const catalog = await compileCatalog(Readable.from(records.map((row) => JSON.stringify(row) + "\n")));
  assert.equal(Object.keys(catalog.types).length, 3);
  assert.equal(catalog.types[587].volumeM3, 27000);
  assert.equal(catalog.types[587].packagedVolumeM3, 2500);
  assert.equal(catalog.types[34].name, "Tritanium");
  assert.equal(catalog.types[48464].groupId, 0);
  await assert.rejects(compileCatalog(Readable.from([JSON.stringify(sourceType(34)) + "\n" + JSON.stringify(sourceType(34))])), /Duplicate/);
  await assert.rejects(compileCatalog(Readable.from([JSON.stringify(sourceType(34, { packagedVolume: -1 }))])), /packagedVolume/);
});

test("catalog updater validates ranges/CRC, activates an atomic manifest and skips an unchanged build", async (t) => {
  const directory = await temporary(t), source = provider();
  const result = await updateCatalog(directory, { fetchImpl: source.fetch });
  assert.equal(result.status, "updated"); assert.equal(result.typeCount, 3); assert.equal(source.calls.length, 5);
  const { manifest, catalog } = await loadCatalog(directory);
  assert.equal(manifest.buildNumber, 12345); assert.equal(catalog.types[587].packagedVolumeM3, 2500);
  source.calls = [];
  assert.equal((await updateCatalog(directory, { fetchImpl: source.fetch })).status, "up_to_date");
  assert.equal(source.calls.length, 1);
  source.build++;
  source.calls = [];
  assert.equal((await updateCatalog(directory, { fetchImpl: source.fetch, checkOnly: true })).status, "update_available");
  assert.equal(source.calls.length, 1); assert.equal((await loadCatalog(directory)).manifest.buildNumber, 12345);
  assert.equal((await updateCatalog(directory, { fetchImpl: source.fetch })).status, "version_advanced_content_unchanged");
  assert.equal((await readdir(join(directory, "catalog"))).filter((name) => name.startsWith("types-")).length, 1);
});

test("a corrupt or invalid new SDE never replaces the active catalog", async (t) => {
  const directory = await temporary(t), source = provider();
  await updateCatalog(directory, { fetchImpl: source.fetch });
  const path = join(directory, "catalog", "current.json"), before = await readFile(path, "utf8");
  source.build++; source.corrupt = true;
  await assert.rejects(updateCatalog(directory, { fetchImpl: source.fetch }), /integrity/);
  assert.equal(await readFile(path, "utf8"), before);
  source.corrupt = false; source.rows = [sourceType(34, { packagedVolume: -1 })];
  await assert.rejects(updateCatalog(directory, { fetchImpl: source.fetch }), /packagedVolume/);
  assert.equal(await readFile(path, "utf8"), before);
});

test("catalog corruption is detected and --force repairs it", async (t) => {
  const directory = await temporary(t), source = provider();
  await updateCatalog(directory, { fetchImpl: source.fetch });
  const { manifest } = await loadCatalog(directory);
  await writeFile(join(directory, "catalog", manifest.dataFile), "{}");
  await assert.rejects(loadCatalog(directory), /checksum/);
  await assert.rejects(updateCatalog(directory, { fetchImpl: source.fetch }), /checksum/);
  await updateCatalog(directory, { fetchImpl: source.fetch, force: true });
  assert.equal((await loadCatalog(directory)).catalog.types[587].name, "Rifter");
  await writeFile(join(directory, "catalog", "current.json"), "broken JSON");
  await updateCatalog(directory, { fetchImpl: source.fetch, force: true });
  assert.equal((await loadCatalog(directory)).manifest.buildNumber, source.build);
});
