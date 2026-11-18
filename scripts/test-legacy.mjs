// Execute the existing Deno.test-style pure library tests with Node + Vite's
// already-installed TypeScript transformer. No Deno installation is required.
import { build } from "esbuild";
import { readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../apps/market-backend/lib/paths.mjs";
const directory = await mkdtemp(join(tmpdir(), "legacy-tests-"));
const cases = [];
globalThis.Deno = { test: (name, fn) => cases.push({ name, fn }) };
try {
  const source = join(ROOT, "apps", "web", "src", "lib");
  for (const file of (await readdir(source)).filter((name) => name.endsWith(".test.ts"))) {
    const out = join(directory, `${file}.mjs`);
    await build({ entryPoints: [join(source, file)], outfile: out, bundle: true, platform: "node", format: "esm", logLevel: "silent",
      tsconfig: join(ROOT, "apps", "web", "tsconfig.json") });
    await import(pathToFileURL(out));
  }
  let failed = 0;
  for (const item of cases) { try { await item.fn(); console.log(`PASS ${item.name}`); } catch (e) { failed++; console.error(`FAIL ${item.name}: ${e.message}`); } }
  console.log(`${cases.length - failed}/${cases.length} legacy library tests passed.`);
  if (failed || !cases.length) process.exitCode = 1;
} finally { delete globalThis.Deno; await rm(directory, { recursive: true, force: true }); }
