// Actual persistent refresher/store/publication pipeline; only ESI transport is replayed.
import { mkdtemp, rm, readdir, readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { createFixture } from "../lib/fixture.mjs";
import { refreshHistory, attachHistory } from "../lib/history-refresh.mjs";
import { verifyHistory } from "../lib/history-store.mjs";
import { publishSnapshot, readJson, writeJson } from "../lib/storage.mjs";

const args = process.argv.slice(2), option = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const types = Number(option("types", 20_000)), repeats = Number(option("repeats", 3));
const childCase = option("case", ""), directory = option("directory", "");
const DAY = 86400000, BASE = Date.parse("2026-11-07T15:00:00Z");
if (!Number.isInteger(types) || types < 1 || types > 25_000 || !Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error("Use 1–25000 types and 1–10 repeats.");
async function footprint(path) {
  let bytes = 0, gzipBytes = 0, files = 0;
  for (const name of await readdir(path)) {
    const file = join(path, name), info = await stat(file);
    if (info.isDirectory()) { const nested = await footprint(file); bytes += nested.bytes; gzipBytes += nested.gzipBytes; files += nested.files; }
    else { const body = await readFile(file); bytes += body.length; gzipBytes += gzipSync(body).length; files++; }
  }
  return { bytes, gzipBytes, files };
}
if (childCase) {
  const start = performance.now(), cpu = process.cpuUsage();
  let snapshot = childCase === "cold" ? createFixture(types, new Date(BASE)) : await readJson(join(directory, "public", "data", "market.json"));
  snapshot.mode = "live"; snapshot.hubs.forEach((hub, i) => { hub.regionId = String(10000002 + i); hub.locationId = String(60003760 + i); });
  const now = childCase === "next-day" ? BASE + DAY : BASE;
  const end = Math.floor(now / DAY) * DAY - DAY;
  const response = JSON.stringify(Array.from({ length: 402 }, (_, i) => ({ date: new Date(end - (401 - i) * DAY).toISOString().slice(0, 10),
    volume: childCase === "next-day" && i === 400 ? 99 : 10, order_count: 3, average: 20.5, highest: 30, lowest: 10 })));
  let httpCalls = 0;
  const fetchImpl = async () => {
    httpCalls++;
    return new Response(response, { headers: { "Content-Type": "application/json", Expires: new Date(now + 3600000).toUTCString(), "Last-Modified": new Date(now).toUTCString(), ETag: `"${childCase}"` } });
  };
  const result = childCase === "verify" ? await verifyHistory(directory, snapshot.hubs.map((hub) => hub.regionId)) :
    await refreshHistory(snapshot, directory, { contact: "benchmark.invalid", maxSeconds: 0, maxPairs: 0, fetchImpl, now: () => now });
  if (childCase === "warm" && httpCalls) throw new Error("Fresh history unexpectedly made HTTP calls.");
  if (childCase !== "verify") {
    snapshot = await attachHistory(snapshot, directory);
    const expected = childCase === "next-day" ? 159 : 70;
    for (const hub of snapshot.hubs) for (const row of hub.rows) if (row.regionalWeekVolume !== expected || row.history.retainedDays !== 21) throw new Error("History lifecycle semantic check failed.");
    await publishSnapshot(join(directory, "public", "data", "market.json"), snapshot);
  } else if (result.mismatches) throw new Error("Verification mismatch.");
  const used = process.cpuUsage(cpu);
  const measured = { case: childCase, typesPerHub: types, pairs: types * 3, httpCalls, sourceRowsPerResponse: 402,
    replayedResponseBytes: httpCalls * Buffer.byteLength(response), wallMs: performance.now() - start,
    cpuUserMs: used.user / 1000, cpuSystemMs: used.system / 1000, maxRssKiB: process.resourceUsage().maxRSS, result };
  measured.footprint = await footprint(directory); // Deliberately outside measured pipeline timings.
  process.stdout.write(JSON.stringify(measured));
} else {
  const runs = [], cases = ["cold", "warm", "next-day", "verify"];
  for (let repeat = 0; repeat < repeats; repeat++) {
    const temporary = await mkdtemp(join(tmpdir(), "market-history-benchmark-"));
    try {
      for (const name of cases) {
        console.log(`History lifecycle · repeat ${repeat + 1}/${repeats} · ${name} · ${types * 3} region/item pairs`);
        const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--case=${name}`, `--directory=${temporary}`, `--types=${types}`], { encoding: "utf8", maxBuffer: 10_000_000 });
        if (child.error || child.status !== 0) throw new Error(child.error?.message || child.stderr || child.stdout || "Benchmark child failed.");
        const run = JSON.parse(child.stdout); runs.push({ repeat: repeat + 1, ...run });
        console.log(`  ${(run.wallMs / 1000).toFixed(2)} s wall · ${((run.cpuUserMs + run.cpuSystemMs) / 1000).toFixed(2)} s CPU · ${(run.maxRssKiB / 1024).toFixed(0)} MiB peak RSS · ${run.httpCalls} replay calls`);
      }
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  const median = (values) => { const sorted = values.sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
  const summary = cases.map((name) => { const group = runs.filter((run) => run.case === name); return { case: name,
    wallMs: median(group.map((r) => r.wallMs)), cpuMs: median(group.map((r) => r.cpuUserMs + r.cpuSystemMs)), maxRssKiB: median(group.map((r) => r.maxRssKiB)),
    bytesRead: median(group.map((r) => r.result.bytesRead)), bytesWritten: median(group.map((r) => r.result.bytesWritten)), footprint: group[0].footprint }; });
  const report = { generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, typesPerHub: types, repeats,
    limitations: "Local WSL /tmp filesystem, standard Node libraries, fresh child per case. ESI HTTP transport is replayed without latency; JSON encoding, response decode/parse, reconciliation, validation, durable checkpoints, summary derivation, snapshot publication and verification are real. Not a GitHub runner measurement. Filesystem footprint/compression is outside measured timings. No live ESI bulk requests.", summary, runs };
  const output = resolve(option("output", `docs/discovery/benchmarks/history-lifecycle-${types}.json`));
  await mkdir(resolve(output, ".."), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`Saved ${output}`); console.table(summary.map((row) => ({ case: row.case, wallSeconds: +(row.wallMs / 1000).toFixed(2), cpuSeconds: +(row.cpuMs / 1000).toFixed(2), peakMiB: +(row.maxRssKiB / 1024).toFixed(1), stateMB: +(row.footprint.bytes / 1e6).toFixed(2) })));
}
