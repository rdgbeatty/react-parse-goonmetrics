import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  return crc >>> 0;
});
export function updateCrc32(crc, chunk) {
  for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 255] ^ crc >>> 8;
  return crc >>> 0;
}

// Read just one member of CCP's ZIP; never extract filesystem paths or buffer the full SDE.
// Unsupported ZIP features fail explicitly and leave the active catalog intact.
export async function openSdeTypes(url, { fetchImpl = fetch, onProgress = () => {} } = {}) {
  let archiveSize, archiveEtag, transferredBytes = 0, requests = 0;
  async function range(start, end) {
    const requested = start === null ? `bytes=-${end}` : `bytes=${start}-${end}`;
    const headers = { Range: requested, "Accept-Encoding": "identity", "User-Agent": "GoonmetricsMarketBackend/0.2 (SDE catalog updater)" };
    if (archiveEtag) headers["If-Match"] = archiveEtag;
    requests++;
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(120_000) });
    if (response.status !== 206) {
      await response.body?.cancel();
      throw new Error(`SDE archive range request failed (${response.status}); expected HTTP 206. Active catalog retained.`);
    }
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") ?? "");
    const total = Number(match?.[3]), first = Number(match?.[1]), last = Number(match?.[2]);
    if (!match || !Number.isSafeInteger(total) || total < 22 || total > 2 ** 32 - 1 ||
      (archiveSize !== undefined && total !== archiveSize) || first !== (start ?? Math.max(0, total - end)) || last !== (start === null ? total - 1 : end)) {
      await response.body?.cancel(); throw new Error("Invalid or inconsistent SDE Content-Range.");
    }
    const etag = response.headers.get("ETag");
    if (archiveEtag && etag && etag !== archiveEtag) { await response.body?.cancel(); throw new Error("SDE archive changed during download."); }
    archiveSize = total; archiveEtag ??= etag;
    return { response, length: last - first + 1 };
  }
  async function bufferRange(start, end) {
    const { response, length } = await range(start, end);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length !== length) throw new Error("Truncated SDE archive range.");
    transferredBytes += buffer.length;
    return buffer;
  }

  const tail = await bufferRange(null, 65_557);
  let eocd = -1;
  for (let index = tail.length - 22; index >= 0; index--) {
    if (tail.readUInt32LE(index) === 0x06054b50 && index + 22 + tail.readUInt16LE(index + 20) === tail.length) { eocd = index; break; }
  }
  if (eocd < 0 || tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0 ||
    tail.readUInt16LE(eocd + 8) !== tail.readUInt16LE(eocd + 10)) throw new Error("Unsupported SDE ZIP directory or multiple disks.");
  const count = tail.readUInt16LE(eocd + 10), size = tail.readUInt32LE(eocd + 12), offset = tail.readUInt32LE(eocd + 16);
  if (!count || count === 0xffff || size > 2_000_000 || size === 0 || offset + size > archiveSize - 22) throw new Error("Unsupported SDE ZIP64 or invalid directory bounds.");
  const directory = await bufferRange(offset, offset + size - 1);
  let member, cursor = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid SDE ZIP directory entry.");
    const nameLength = directory.readUInt16LE(cursor + 28), extraLength = directory.readUInt16LE(cursor + 30), commentLength = directory.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > directory.length) throw new Error("Truncated SDE ZIP directory entry.");
    const name = directory.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    if (name === "types.jsonl") {
      if (member) throw new Error("Duplicate types.jsonl members in SDE.");
      member = { name, flags: directory.readUInt16LE(cursor + 8), method: directory.readUInt16LE(cursor + 10),
        crc32: directory.readUInt32LE(cursor + 16), compressedBytes: directory.readUInt32LE(cursor + 20),
        uncompressedBytes: directory.readUInt32LE(cursor + 24), offset: directory.readUInt32LE(cursor + 42) };
    }
    cursor = next;
  }
  if (!member || member.flags & 1 || ![0, 8].includes(member.method) || member.compressedBytes > 128 * 1024 ** 2 ||
    member.uncompressedBytes > 512 * 1024 ** 2 || member.offset + 30 > offset) throw new Error("Missing, encrypted, oversized or unsupported SDE types member.");
  const local = await bufferRange(member.offset, member.offset + 29);
  if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(8) !== member.method || local.readUInt16LE(6) !== member.flags) throw new Error("Invalid SDE member header.");
  const dataOffset = member.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  if (!member.compressedBytes || dataOffset + member.compressedBytes > offset) throw new Error("Invalid SDE member bounds.");
  const { response, length } = await range(dataOffset, dataOffset + member.compressedBytes - 1);
  const input = Readable.fromWeb(response.body);
  const decoded = member.method === 8 ? input.pipe(createInflateRaw()) : input;
  // Forward input errors into the consumer rather than leaving the inflater waiting.
  if (decoded !== input) input.on("error", (error) => decoded.destroy(error));
  let completedBytes = 0, crc = 0xffffffff;
  async function* chunks() {
    try {
      for await (const chunk of decoded) {
        completedBytes += chunk.length;
        if (completedBytes > member.uncompressedBytes) throw new Error("SDE member exceeded its declared size.");
        crc = updateCrc32(crc, chunk);
        onProgress({ phase: "extracting", completedBytes, totalBytes: member.uncompressedBytes });
        yield chunk;
      }
      if (completedBytes !== member.uncompressedBytes || (crc ^ 0xffffffff) >>> 0 !== member.crc32) throw new Error("SDE types integrity check failed (size/CRC32).");
      transferredBytes += length;
    } finally { input.destroy(); if (decoded !== input) decoded.destroy(); }
  }
  return { stream: Readable.from(chunks()), member,
    statistics: () => ({ requests, transferredBytes, archiveBytes: archiveSize }) };
}
