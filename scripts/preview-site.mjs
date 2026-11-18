import { createServer } from "node:http";
import { readFile, lstat } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { ROOT, DEFAULT_STATE } from "../apps/market-backend/lib/paths.mjs";
import { buildSite, publicBase } from "./build-site.mjs";
const args = process.argv.slice(2);
for (const a of args) if (!/^--(?:base=.+|port=\d+|state-dir=.+|no-build|allow-fixture)$/.test(a)) throw new Error(`Unknown preview option: ${a}`);
const option = (key, fallback) => args.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const base = publicBase(option("base", "/react-parse-goonmetrics/"));
const port = Number(option("port", "4173"));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Use a local port from 1024 to 65535.");
if (!args.includes("--no-build")) await buildSite({ base, directory: resolve(option("state-dir", DEFAULT_STATE)), allowFixture: args.includes("--allow-fixture") });
const root = join(ROOT, "dist");
const types = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm" };
const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("X-Frame-Options", "DENY");
  if (!["GET", "HEAD"].includes(req.method) || ![`localhost:${port}`, `127.0.0.1:${port}`].includes(req.headers.host)) { res.writeHead(403); res.end(); return; }
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/" && base !== "/") { res.writeHead(302, { Location: base }); res.end(); return; }
    const path = decodeURIComponent(url.pathname);
    if (!path.startsWith(base)) throw new Error();
    const relative = path.slice(base.length);
    if (relative.split("/").some((p) => p === ".." || p.startsWith(".") || p.includes("\\"))) throw new Error();
    let file = join(root, relative);
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error();
    if (stat.isDirectory()) {
      if (!path.endsWith("/")) { res.writeHead(302, { Location: `${url.pathname}/${url.search}` }); res.end(); return; }
      file = join(file, "index.html");
    }
    const content = await readFile(file);
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" }); res.end(req.method === "HEAD" ? undefined : content);
  } catch { res.writeHead(404); res.end("Not found"); }
});
server.on("error", (e) => { console.error(e.code === "EADDRINUSE" ? `Port ${port} is busy. Stop the other local server or use --port=4174.` : "Preview could not start."); process.exitCode = 1; });
server.listen(port, "127.0.0.1", () => console.log(`Combined release preview: http://localhost:${port}${base}\nOriginal site at the root; new viewer at market/. No upload or GitHub mutation occurs automatically.`));
const stop = () => { server.close(); server.closeAllConnections(); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
