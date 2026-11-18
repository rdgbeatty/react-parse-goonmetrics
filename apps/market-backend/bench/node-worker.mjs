import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serialize, deserialize } from "node:v8";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { readJson, durable, sourceItems, sourceQuotes, sourceHistory, summarize, publish, QUOTE_COLUMNS, HISTORY_COLUMNS, stateBytes } from "./common.mjs";

const [mode, scenario, input, state, native] = process.argv.slice(2);
mkdirSync(state, { recursive: true });
const fixture = readJson(join(input, "fixture.json")), phases = {};
const asOfDay = fixture.asOfDay + (scenario === "history" ? 1 : 0);
const timed = (name, work) => { const start = performance.now(); const value = work(); phases[name] = (phases[name] ?? 0) + performance.now() - start; return value; };
const files = ["items", "quotes", "history", "summaries"];
function objectRows(name, rows) {
  const columns = name === "quotes" ? QUOTE_COLUMNS : name === "history" ? HISTORY_COLUMNS : name === "items" ? ["typeId", "name", "volumeM3"] : ["region", "type", "volume7d", "volume14d"];
  return rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}
function tupleRows(name, rows) {
  const columns = name === "quotes" ? QUOTE_COLUMNS : name === "history" ? HISTORY_COLUMNS : name === "items" ? ["typeId", "name", "volumeM3"] : ["region", "type", "volume7d", "volume14d"];
  return rows.map((row) => columns.map((column) => row[column]));
}
function encodeBinary(name, rows) {
  if (name === "items") {
    const names = rows.map((row) => Buffer.from(row[1], "utf8"));
    const buffer = Buffer.allocUnsafe(4 + rows.reduce((sum, row, index) => sum + 16 + names[index].length, 0));
    buffer.writeUInt32LE(rows.length); let offset = 4;
    for (let i = 0; i < rows.length; i++) {
      buffer.writeUInt32LE(rows[i][0], offset); buffer.writeDoubleLE(rows[i][2], offset + 4); buffer.writeUInt32LE(names[i].length, offset + 12);
      names[i].copy(buffer, offset + 16); offset += 16 + names[i].length;
    }
    return buffer;
  }
  const width = rows[0]?.length ?? (name === "history" ? 8 : name === "quotes" ? 11 : 4);
  const buffer = Buffer.allocUnsafe(8 + rows.length * width * 8); buffer.writeUInt32LE(rows.length); buffer.writeUInt32LE(width, 4);
  let offset = 8;
  for (const row of rows) for (const value of row) { buffer.writeDoubleLE(value === null ? NaN : value, offset); offset += 8; }
  return buffer;
}
function decodeBinaryItems(buffer) {
  const rows = []; let offset = 4;
  for (let i = 0; i < buffer.readUInt32LE(0); i++) {
    const type = buffer.readUInt32LE(offset), volume = buffer.readDoubleLE(offset + 4), size = buffer.readUInt32LE(offset + 12);
    rows.push([type, buffer.toString("utf8", offset + 16, offset + 16 + size), volume]); offset += 16 + size;
  }
  return rows;
}
function write(name, rows) {
  timed("store", () => {
    const data = mode === "node-object-json" ? JSON.stringify(objectRows(name, rows)) : mode === "node-json" ? JSON.stringify(rows) : mode === "node-v8" ? serialize(rows) : encodeBinary(name, rows);
    durable(join(state, name), data);
  });
}
function read(name) {
  return timed("restore", () => {
    const buffer = readFileSync(join(state, name));
    if (mode === "node-object-json") return tupleRows(name, JSON.parse(buffer));
    if (mode === "node-json") return JSON.parse(buffer);
    if (mode === "node-v8") return deserialize(buffer);
    if (name === "items") return decodeBinaryItems(buffer);
    throw Error("The C worker reads numeric binary tables directly.");
  });
}

const start = performance.now();
const items = scenario === "bootstrap" ? timed("source", () => sourceItems(input)) : read("items");
if (scenario === "bootstrap") write("items", items);
let quotes, summaries;
if (scenario !== "history") {
  quotes = timed("source", () => sourceQuotes(input, items, fixture.now)); write("quotes", quotes);
}
if (scenario !== "prices") {
  const history = timed("source", () => sourceHistory(input, items, fixture.now, scenario === "history"));
  // A daily response overlaps all retained dates; replacing the reconciled window is intentional.
  write("history", history);
  if (mode !== "node-c-binary") { summaries = timed("process", () => summarize(history, items.length, asOfDay)); write("summaries", summaries); }
}
if (mode === "node-c-binary") {
  timed("native_process_publish", () => {
    const result = spawnSync(native, [state, scenario === "prices" ? "publish" : "summarize", String(items.length), String(asOfDay)], { encoding: "utf8" });
    if (result.status !== 0) throw Error(result.stderr || "Native worker failed");
  });
} else {
  if (!quotes) quotes = read("quotes");
  if (!summaries) summaries = read("summaries");
  timed("publish", () => durable(join(state, "public.json"), JSON.stringify(publish(items, quotes, summaries))));
}
console.log(JSON.stringify({ mode, scenario, internalWallMs: performance.now() - start, phases,
  stateBytes: stateBytes(state, files), publicBytes: readFileSync(join(state, "public.json")).length }));
