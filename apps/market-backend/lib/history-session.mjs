import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { readJson, writeJson } from "./storage.mjs";
import { runJob } from "./jobs.mjs";
import { historyTargets } from "./history-refresh.mjs";

const statePath = (directory) => join(directory, "history", "session", "state.json");
export const sessionSummaryPath = (directory) => join(directory, "history", "session", "current.json");
const scope = (snapshot) => createHash("sha256").update(JSON.stringify(historyTargets(snapshot))).digest("hex");

// The caller holds the existing operation lock. Each runJob is one bounded,
// independently checkpointed/reported batch; the session survives browser reloads.
export async function runHistorySession(kind, directory, config, sso, { autoContinue = true, resume = false,
  shouldPause = () => false, onProgress = () => {}, onSession = () => {}, ...jobOptions } = {}) {
  if (!["history", "collect"].includes(kind)) return runJob(kind, directory, config, sso, { ...jobOptions, onProgress });
  let snapshot = await readJson(join(directory, "public", "data", "market.json"));
  const old = resume ? await readJson(statePath(directory)) : null;
  const reusable = old?.schemaVersion === 1 && ["paused", "running", "interrupted", "rate-limit", "source-errors", "cancelled"].includes(old.status) && old.scopeHash === scope(snapshot);
  const session = reusable ? old : { schemaVersion: 1, id: `${Date.now()}-${randomBytes(4).toString("hex")}`, startedAt: new Date().toISOString(),
    scopeHash: scope(snapshot), batchesCompleted: 0, refreshedPairs: 0, handledTargets: [] };
  const handled = new Set(session.handledTargets.map(([regionId, typeId]) => `${regionId}:${typeId}`));
  let lastReport, lastBatch;
  const summary = () => ({ schemaVersion: 1, id: session.id, startedAt: session.startedAt, updatedAt: session.updatedAt, status: session.status,
    batchesCompleted: session.batchesCompleted, refreshedPairs: session.refreshedPairs, pairsHandledThisPass: handled.size,
    lastRunId: lastReport?.id ?? session.lastRunId, lastBatch: lastBatch ?? session.lastBatch });
  const persist = async () => {
    session.updatedAt = new Date().toISOString(); session.lastRunId = lastReport?.id ?? session.lastRunId;
    session.lastBatch = lastBatch ?? session.lastBatch;
    await writeJson(statePath(directory), session);
    const publicState = summary(); await writeJson(sessionSummaryPath(directory), publicState); onSession(publicState);
  };
  session.status = "running"; await persist();
  try {
    for (;;) {
      const batchNumber = session.batchesCompleted + 1;
      lastReport = await runJob(lastReport || reusable ? "history" : kind, directory, config, sso, { ...jobOptions, sessionId: session.id, batchNumber,
        historyOptions: { ...jobOptions.historyOptions, excludeTargets: handled },
        onProgress: (value) => onProgress({ ...value, sessionId: session.id, batchNumber,
          sessionStatus: "running", message: value.phase === "history" ? `Batch ${batchNumber} · ${value.message}` : value.message }) });
      const history = lastReport.history;
      if (!history) { session.status = lastReport.historyError ? "failed" : "complete"; break; }
      session.batchesCompleted++; session.refreshedPairs += history.refreshedPairs;
      for (const pair of history.completedTargets) if (!handled.has(pair.join(":"))) { handled.add(pair.join(":")); session.handledTargets.push(pair); }
      lastBatch = { attemptedPairs: history.attemptedPairs, refreshedPairs: history.refreshedPairs, deferredPairs: history.deferredPairsNow,
        eligiblePairs: history.remainingEligiblePairs, collectedPairs: history.collectedPairs, neverCollectedPairs: history.neverCollectedPairs, targetPairs: history.targetPairs,
        stopReason: history.stopReason };
      // Quote collection can change the tracked universe before the first batch.
      if (kind === "collect" && session.batchesCompleted === 1) { snapshot = await readJson(join(directory, "public", "data", "market.json")); session.scopeHash = scope(snapshot); }
      if (jobOptions.signal?.aborted || history.stopReason === "cancelled") session.status = "cancelled";
      else if (["rate-limit", "source-errors"].includes(history.stopReason)) session.status = history.stopReason;
      else if (!history.remainingEligiblePairs) session.status = history.deferredPairsNow ? "complete-with-deferrals" : "complete";
      else if (shouldPause()) session.status = "paused";
      else if (!autoContinue) session.status = "paused";
      else if (!history.completedTargets.length) session.status = "no-progress";
      await persist();
      if (session.status !== "running") break;
    }
  } catch (error) { session.status = "failed"; await persist(); throw error; }
  await persist();
  const remaining = lastBatch?.eligiblePairs ?? 0, deferred = lastBatch?.deferredPairs ?? 0;
  const message = session.status === "paused" ? `History paused after batch ${session.batchesCompleted}. ${remaining} eligible pairs remain; ${deferred} deferred. Resume history to continue.` :
    ["complete", "complete-with-deferrals"].includes(session.status) ? `History pass complete: ${session.refreshedPairs} pairs refreshed, ${deferred} deferred. See deferred items and retry times below.` :
    `History stopped (${session.status}). Completed batches are saved; ${deferred} pairs deferred. Resume when the source is ready.`;
  onProgress({ phase: "complete", sessionId: session.id, sessionStatus: session.status, batchNumber: session.batchesCompleted,
    jobKind: "history", message, completed: 1, total: 1, unit: "pass" });
  return { ...lastReport, session: summary() };
}
