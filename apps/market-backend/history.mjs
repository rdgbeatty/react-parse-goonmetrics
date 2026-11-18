import { join } from "node:path";
import { DEFAULT_STATE } from "./lib/paths.mjs";
import { readJson, withLock } from "./lib/storage.mjs";
import { runHistorySession } from "./lib/history-session.mjs";
import { runJob } from "./lib/jobs.mjs";

try {
  const args = process.argv.slice(2);
  for (const arg of args) if (!/^--(?:verify|all|resume|seconds=\d+|pairs=\d+)$/.test(arg)) throw new Error(`Unknown history option: ${arg}`);
  const number = (name, fallback) => Number(args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const result = await withLock(DEFAULT_STATE, async () => (args.includes("--all") || args.includes("--resume") ? runHistorySession : runJob)(args.includes("--verify") ? "verify" : "history", DEFAULT_STATE,
      await readJson(join(DEFAULT_STATE, "private", "config.json"), {}), null,
      { signal: controller.signal, resume: args.includes("--resume"), historyOptions: { maxSeconds: number("seconds", 300), maxPairs: number("pairs", 1000) } }));
    console.log(JSON.stringify(result.history ?? result.verification, null, 2));
  } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
} catch (error) { console.error(error.message); process.exitCode = 1; }
