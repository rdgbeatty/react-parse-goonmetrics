import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { readJson, writeJson, publishSnapshot } from "./storage.mjs";
import { collectLive } from "./collector.mjs";
import { createFixture } from "./fixture.mjs";
import { attachHistory, refreshHistory } from "./history-refresh.mjs";
import { verifyHistory } from "./history-store.mjs";

export async function recentRuns(directory, limit = 20) {
  const path = join(directory, "metrics", "runs");
  const names = await readdir(path).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  return Promise.all(names.filter((name) => /^\d{13}-[a-f0-9]{8}\.json$/.test(name)).sort().reverse().slice(0, limit).map((name) => readJson(join(path, name))));
}

// Caller holds the shared operation lock. This entrypoint is shared by HTTP and CLI.
export async function runJob(kind, directory, config, sso, { collector = collectLive, onProgress = () => {},
  historyOptions = {}, signal, consoleImpl = console, sessionId, batchNumber } = {}) {
  const started = performance.now(), cpu = process.cpuUsage();
  const id = `${Date.now()}-${randomBytes(4).toString("hex")}`, path = join(directory, "metrics", "runs", `${id}.json`);
  const snapshotPath = join(directory, "public", "data", "market.json");
  const report = { schemaVersion: 1, id, kind, startedAt: new Date().toISOString(), status: "running", ...(sessionId ? { sessionId, batchNumber } : {}), events: [] };
  let lastEvent = 0, phase, checkpoint = Promise.resolve(), lastCheckpoint = 0;
  const progress = (value) => {
    const elapsedMs = Math.round(performance.now() - started);
    onProgress({ ...value, jobKind: kind, runId: id, elapsedMs });
    if (value.deferred || phase !== value.phase || elapsedMs - lastEvent >= 5000) {
      phase = value.phase; lastEvent = elapsedMs;
      report.events.push({ elapsedMs, phase, message: value.message });
      if (report.events.length > 150) report.events.shift();
      consoleImpl.log(`[market ${id}] ${phase}: ${value.message}`);
      if (elapsedMs - lastCheckpoint >= 10_000) {
        lastCheckpoint = elapsedMs;
        const copy = JSON.parse(JSON.stringify(report));
        checkpoint = checkpoint.then(() => writeJson(path, copy));
        // Keep failures observed until the final awaited checkpoint.
        checkpoint.catch(() => {});
      }
    }
  };
  await writeJson(path, report);
  if (sessionId) consoleImpl.log(`[market ${id}] batch ${batchNumber} · history pass ${sessionId}`);
  try {
    let snapshot = await readJson(snapshotPath);
    if (kind === "verify") {
      if (snapshot.mode !== "live") throw new Error("Collect a live snapshot before verifying retained regional history.");
      progress({ phase: "verification", message: "Verifying local history checksums, daily records and serving summaries…" });
      report.verification = await verifyHistory(directory, snapshot.hubs.map((hub) => hub.regionId), { repair: true });
      snapshot = await attachHistory(snapshot, directory);
      await publishSnapshot(snapshotPath, snapshot);
    } else if (kind === "fixture") {
      progress({ phase: "fixture", message: "Generating 60,000 simulated rows…" });
      snapshot = createFixture(); await publishSnapshot(snapshotPath, snapshot);
    } else {
      if (!["collect", "history", "quotes"].includes(kind)) throw new Error("Unknown collection job.");
      if (kind !== "history") {
        snapshot = await collector(config, directory, sso, { onProgress: progress, onMetrics: (metrics) => Object.assign(report, metrics), signal });
        await publishSnapshot(snapshotPath, snapshot);
        report.quotesPublishedAt = new Date().toISOString();
        progress({ phase: "quotes-published", message: kind === "quotes" ? "Fresh quotes saved with retained history summaries." : "Fresh quotes saved. Updating history while the new prices remain available…" });
      }
      if (kind !== "quotes" && snapshot.mode === "live") {
        try {
          report.history = await refreshHistory(snapshot, directory, { contact: config.contact, maxSeconds: config.historyBatchSeconds ?? 300, maxPairs: 1000,
            ...historyOptions, signal, onProgress: progress });
          snapshot = await attachHistory(snapshot, directory);
          await publishSnapshot(snapshotPath, snapshot);
        } catch (error) {
          // Quote publication succeeds independently of history/corrupt retained state.
          report.historyError = error.message;
          if (kind === "history") throw error;
        }
      }
    }
    report.snapshotRows = snapshot.hubs.reduce((total, hub) => total + hub.rows.length, 0);
    report.status = report.historyError || report.historySummaryError || report.history?.remainingEligiblePairs ? "partial" : report.history?.deferredPairsNow ? "complete-with-deferrals" : "complete";
    const message = report.historyError || report.historySummaryError ? `Quotes saved; history needs attention: ${report.historyError ?? report.historySummaryError}` : report.history?.pendingPairs ?
      `Snapshot saved. ${report.history.refreshedPairs} history pairs verified; ${report.history.remainingEligiblePairs} eligible for another batch; ${report.history.deferredPairsNow} deferred (${report.history.stopReason}).` :
      kind === "verify" ? `Verified ${report.verification.series} history series; repaired ${report.verification.repaired} summaries.` : "Snapshot saved successfully.";
    progress({ phase: "complete", message, hubsCompleted: snapshot.hubs.length, hubTotal: snapshot.hubs.length, completed: 1, total: 1, unit: "run" });
  } catch (error) {
    report.status = "failed"; report.error = error.message;
    progress({ phase: "failed", message: error.message });
    throw error;
  } finally {
    const used = process.cpuUsage(cpu);
    Object.assign(report, { finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started),
      cpuUserMs: used.user / 1000, cpuSystemMs: used.system / 1000, maxRssKiB: process.resourceUsage().maxRSS });
    await checkpoint;
    await writeJson(path, report);
    consoleImpl.log(`[market ${id}] ${report.status} · ${report.durationMs} ms wall · ${(report.cpuUserMs + report.cpuSystemMs).toFixed(0)} ms CPU`);
  }
  return report;
}
