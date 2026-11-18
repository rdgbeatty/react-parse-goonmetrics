import { build } from "vite";
import { mkdir, mkdtemp, rm, rename, copyFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, DEFAULT_STATE } from "../apps/market-backend/lib/paths.mjs";
import { readJson } from "../apps/market-backend/lib/storage.mjs";
import { validateSnapshot } from "../packages/shared/src/marketSnapshot.mjs";
import { validateReleaseConfig } from "../apps/market-backend/lib/release-config.mjs";

export function publicBase(base) {
  if (typeof base !== "string" || !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base)) throw new Error("Base must be / or a directory path such as /react-parse-goonmetrics/.");
  return base;
}
export async function buildSite({ base = process.env.SITE_BASE ?? "/react-parse-goonmetrics/", directory = DEFAULT_STATE,
  destination = join(ROOT, "dist"), allowFixture = false, config = null } = {}) {
  publicBase(base); directory = resolve(directory); destination = resolve(destination);
  config = validateReleaseConfig(config ?? await readJson(join(ROOT, "config", "market.json")));
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(join(directory, "release-build-"));
  try {
    await build({ configFile: join(ROOT, "apps", "web", "vite.config.ts"), root: join(ROOT, "apps", "web"), base, logLevel: "warn",
      define: { "import.meta.env.VITE_API_BASE_URL": JSON.stringify(config.legacyApi) },
      build: { outDir: temporary, emptyOutDir: false, sourcemap: false } });
    const market = join(temporary, "market"); await mkdir(join(market, "data"), { recursive: true });
    for (const file of ["app.mjs", "styles.css"]) await copyFile(join(ROOT, "apps", "market-backend", "public", file), join(market, file));
    const template = await readFile(join(ROOT, "apps", "market-backend", "public", "index.html"), "utf8");
    await writeFile(join(market, "index.html"), template.replace("<head>", '<head><meta name="market-mode" content="hosted">'));
    await copyFile(join(ROOT, "packages", "shared", "src", "marketSnapshot.mjs"), join(market, "snapshot.mjs"));
    const snapshot = await readJson(join(directory, "public", "data", "market.json"));
    if (snapshot) {
      validateSnapshot(snapshot);
      if (snapshot.mode !== "live" && !allowFixture) throw new Error("Refusing to publish simulated market data. Collect live data, or use --allow-fixture only for local QA.");
      await writeFile(join(market, "data", "market.json"), JSON.stringify(snapshot));
    }
    await writeFile(join(market, "hosted-config.json"), JSON.stringify(config));
    await build({ configFile: false, root: join(ROOT, "apps", "market-backend", "admin"), base: `${base}market/`, logLevel: "warn",
      build: { target: "es2022", outDir: market, emptyOutDir: false, sourcemap: false,
        rollupOptions: { input: join(ROOT, "apps", "market-backend", "admin", "connect.html") } } });
    const guide = await readFile(join(ROOT, "docs", "deployment.md"), "utf8");
    const escape = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    await writeFile(join(market, "operations.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Collector operations</title><link rel="stylesheet" href="./styles.css"><main><p><a href="./connect.html">← Owner setup</a> · <a href="./">Market viewer</a></p><h1>Deployment and recovery</h1><pre class="operations-guide">${escape(guide)}</pre></main></html>`);
    await writeFile(join(temporary, ".nojekyll"), "");
    await writeFile(join(temporary, "release.json"), JSON.stringify({ schemaVersion: 1, builtAt: new Date().toISOString(), base,
      snapshotGeneratedAt: snapshot?.generatedAt ?? null, mode: snapshot?.mode ?? "unavailable", legacyApi: config.legacyApi }));
    // Only these explicit public inputs enter the temporary release tree.
    const previous = `${destination}.previous`;
    await rm(previous, { recursive: true, force: true });
    let replaced = false;
    try { await rename(destination, previous); replaced = true; } catch (e) { if (e.code !== "ENOENT") throw e; }
    try { await mkdir(resolve(destination, ".."), { recursive: true }); await rename(temporary, destination); }
    catch (e) { if (replaced) await rename(previous, destination); throw e; }
    await rm(previous, { recursive: true, force: true });
    return { destination, base, mode: snapshot?.mode ?? "unavailable", snapshotGeneratedAt: snapshot?.generatedAt ?? null };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    for (const a of args) if (!/^--(?:base=.+|state-dir=.+|out=.+|allow-fixture)$/.test(a)) throw new Error(`Unknown build option: ${a}`);
    const option = (key) => args.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3);
    console.log(JSON.stringify(await buildSite({ ...(option("base") ? { base: option("base") } : {}),
      ...(option("state-dir") ? { directory: option("state-dir") } : {}), ...(option("out") ? { destination: option("out") } : {}), allowFixture: args.includes("--allow-fixture") })));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
