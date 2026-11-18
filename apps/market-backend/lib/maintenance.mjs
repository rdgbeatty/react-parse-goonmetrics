import { readdir, readFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";

// One-time cleanup of the earlier proof's raw page cache. Never visits private/ or catalog/.
export async function removeLegacyOrderCaches(directory) {
  const cache = join(directory, "cache");
  let entries;
  try { entries = await readdir(cache, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return { deletedFiles: 0, removedBytes: 0 }; throw error; }
  let deletedFiles = 0, removedBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(cache, entry.name);
    let content;
    try { content = JSON.parse(await readFile(path, "utf8")); } catch { continue; }
    if (!Array.isArray(content.body) || !content.body.some((row) => Number.isSafeInteger(row?.order_id) && Number.isSafeInteger(row?.type_id))) continue;
    const { size } = await stat(path); await unlink(path); deletedFiles++; removedBytes += size;
  }
  return { deletedFiles, removedBytes };
}
