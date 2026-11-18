import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const args = process.argv.slice(2);
if (args.some((a) => !/^--port=\d+$/.test(a))) throw new Error("Only --port=NUMBER is supported.");
const port = Number(args.find((a) => a.startsWith("--port="))?.slice(7) ?? 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Use a port from 1024 to 65535.");
const files = new Map([ ["/", ["index.html", "text/html"]], ["/auth/eve/callback", ["index.html", "text/html"]],
  ["/page.mjs", ["page.mjs", "text/javascript"]], ["/eve-browser.mjs", ["eve-browser.mjs", "text/javascript"]] ]);
const server = createServer(async (req, res) => {
  let entry;
  try { entry = files.get(new URL(req.url, "http://localhost").pathname); } catch { /* malformed URL */ }
  res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "DENY");
  if (!["GET", "HEAD"].includes(req.method) || !entry) { res.writeHead(404); res.end(); return; }
  try {
    const body = await readFile(new URL(entry[0], import.meta.url));
    res.writeHead(200, { "Content-Type": `${entry[1]}; charset=utf-8` }); res.end(req.method === "HEAD" ? undefined : body);
  } catch { res.writeHead(500); res.end("Static file unavailable."); }
});
server.on("error", (error) => { console.error(error.code === "EADDRINUSE" ? `Port ${port} is busy. Stop the normal backend first, or pass --port=4177 for credential-free probes.` : "Static spike server could not start."); process.exitCode = 1; });
server.listen(port, "127.0.0.1", () => {
  console.log(`GitHub-only feasibility spike: http://localhost:${port}`);
  console.log("Static files only. No request logging, credential files, OAuth server or GitHub writes.");
  console.log("Use Run browser checks, or append /?probe=1. Ctrl+C stops this test server.");
});
const stop = () => { server.close(); server.closeAllConnections(); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
