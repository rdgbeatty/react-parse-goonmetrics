import { mkdir, open, readFile, rename, unlink, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { validateSnapshot } from "../../../packages/shared/src/marketSnapshot.mjs";

export async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw new Error(`Cannot read local ${path.split(/[\\/]/).pop()}; invalid or unreadable JSON.`); }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function publishSnapshot(path, snapshot) {
  validateSnapshot(snapshot);
  await writeJson(path, snapshot);
}

export async function withLock(directory, callback) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "operation.lock");
  let file;
  try { file = await open(path, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = await readJson(path, {});
    let alive = true;
    if (Number.isInteger(owner.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); } catch (cause) { if (cause.code === "ESRCH") alive = false; }
    }
    if (alive) throw new Error("Another local operation is running. Wait for it to finish.");
    await unlink(path);
    return withLock(directory, callback);
  }
  try { await file.writeFile(JSON.stringify({ pid: process.pid })); return await callback(); }
  finally { await file.close(); await unlink(path).catch(() => {}); }
}
