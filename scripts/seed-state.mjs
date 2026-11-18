import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, DEFAULT_STATE } from "../apps/market-backend/lib/paths.mjs";
import { readJson, withLock } from "../apps/market-backend/lib/storage.mjs";
import { validateReleaseConfig } from "../apps/market-backend/lib/release-config.mjs";
import { GitHubApi } from "../apps/market-backend/lib/github-client.mjs";
import { encodeState, stateRelease, saveStateRelease } from "../apps/market-backend/lib/release-state.mjs";

export async function seedFirstState({ directory, config, api, dryRun = false, save = saveStateRelease }) {
  if ((await readJson(join(directory, "public", "data", "market.json")))?.mode !== "live") throw new Error("Seed requires a validated live local snapshot; simulated/unavailable data is refused.");
  return withLock(directory, async () => {
    if (dryRun) return { dryRun: true, archiveBytes: (await encodeState(directory, config.repository)).length, uploaded: false };
    await api.verifyOwner(config.branch);
    if (await stateRelease(api)) throw new Error("A hosted state release already exists. Seeding is only for the first publication; use the collector for updates.");
    const result = await save(api, directory, { branch: config.branch, generation: `${Date.now()}-${randomBytes(4).toString("hex")}` });
    return { uploaded: true, archiveBytes: result.bytes, generation: result.generation };
  });
}
async function promptToken() {
  if (!process.stdin.isTTY) throw new Error("Run interactively for the hidden token prompt, or supply MARKET_SEED_TOKEN through your secret manager.");
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stdout.write("GitHub owner token (repository Contents: read/write; input hidden): ");
  try { return (await rl.question("")).trim(); }
  finally { rl.close(); process.stdout.write("\n"); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    for (const arg of args) if (!/^--(?:dry-run|state-dir=.+)$/.test(arg)) throw new Error("Use --dry-run or --state-dir=PATH.");
    const config = validateReleaseConfig(await readJson(join(ROOT, "config", "market.json")));
    const dryRun = args.includes("--dry-run"), directory = resolve(args.find((a) => a.startsWith("--state-dir="))?.slice(12) ?? DEFAULT_STATE);
    const api = dryRun ? null : new GitHubApi({ repository: config.repository, token: process.env.MARKET_SEED_TOKEN ?? await promptToken() });
    console.log(JSON.stringify(await seedFirstState({ directory, config, api, dryRun })));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
