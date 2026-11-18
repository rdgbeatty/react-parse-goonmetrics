import { resolve } from "node:path";
import { DEFAULT_STATE } from "./lib/paths.mjs";
import { updateCatalog } from "./lib/catalog.mjs";

try {
  const flags = process.argv.slice(2);
  for (const flag of flags) if (!/^--(?:check|force|json|state-dir=.+)$/.test(flag)) throw new Error(`Unknown catalog option: ${flag}`);
  if (flags.includes("--check") && flags.includes("--force")) throw new Error("Choose --check or --force, not both.");
  const directory = resolve(flags.find((flag) => flag.startsWith("--state-dir="))?.slice("--state-dir=".length) ?? DEFAULT_STATE);
  let lastPhase, lastUpdate = 0;
  const result = await updateCatalog(directory, { checkOnly: flags.includes("--check"), force: flags.includes("--force"), onProgress: (progress) => {
    if (progress.phase === lastPhase && Date.now() - lastUpdate < 1000) return;
    lastPhase = progress.phase; lastUpdate = Date.now();
    if (!flags.includes("--json")) console.error(progress.phase === "extracting" ?
      `Reading SDE types: ${Math.floor(progress.completedBytes / progress.totalBytes * 100)}%` : `Catalog: ${progress.phase}`);
  } });
  console.log(JSON.stringify({ ...result, stateDirectory: directory }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
