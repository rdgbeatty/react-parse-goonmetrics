import { join } from "node:path";
import { initialize, exportSite, createBackendServer, DEFAULT_STATE } from "./lib/server.mjs";
import { runJob } from "./lib/jobs.mjs";
import { EveSso } from "./lib/auth.mjs";
import { readJson, withLock } from "./lib/storage.mjs";

try {
  if (Number(process.versions.node.split(".")[0]) < 18) throw new Error("Node 18 or newer is required. No npm packages are needed.");
  const flags = process.argv.slice(2);
  for (const flag of flags) if (!/^--(?:collect|quotes|export|static|port=\d+)$/.test(flag)) throw new Error(`Unknown option: ${flag}`);
  const port = Number(flags.find((flag) => flag.startsWith("--port="))?.split("=")[1] ?? 4173);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Choose a local port between 1024 and 65535.");
  await initialize();
  if (flags.includes("--collect") || flags.includes("--quotes")) {
    const controller = new AbortController(), stop = () => controller.abort();
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try {
      await withLock(DEFAULT_STATE, async () => {
        await runJob(flags.includes("--quotes") ? "quotes" : "collect", DEFAULT_STATE,
          await readJson(join(DEFAULT_STATE, "private", "config.json")), new EveSso(), { signal: controller.signal });
      });
    } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  } else if (flags.includes("--export") && !flags.includes("--static")) {
    console.log(`Static site written to ${await exportSite()}`);
  } else {
    const local = !flags.includes("--static");
    if (!local) await exportSite();
    const server = createBackendServer({ local });
    server.requestTimeout = 30_000;
    server.on("error", (error) => { console.error(error.code === "EADDRINUSE" ? `Port ${port} is in use. Stop the other server or use --port=4174 (and update the EVE callback).` : error.message); process.exitCode = 1; });
    server.listen(port, "127.0.0.1", () => {
      console.log(`Market backend scaffold · ${local ? "local collector + snapshot viewer" : "static export only"}`);
      console.log(`Open http://localhost:${port}`);
      console.log(local ? "First run creates 60,000 simulated rows; existing snapshots are retained. Use Setup & diagnostics to connect EVE." : "This mode serves the export without OAuth or collector endpoints.");
      if (local) console.log("Local EVE login: PKCE/S256, using the registered client ID without an application secret.");
      console.log(`Ctrl+C stops the server. Local files are retained in ignored ${DEFAULT_STATE}.`);
    });
    const stop = () => { server.stopJobs(); server.close(); server.closeAllConnections(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
