// zip.js — minimal ZIP for project import/export. Writes stored (method 0)
// entries; reads stored and deflated entries (deflate via the SDK's own
// inflate — raw deflate stream, so we wrap it with a fake zlib header).
// Standard PKZIP format only, nothing invented.

import { inflate } from "gbalua/compiler/png-tiles.mjs";

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const te = new TextEncoder(), td = new TextDecoder();

/**
 * Build a ZIP from {name: Uint8Array} entries (stored, no compression).
 * @param {Record<string, Uint8Array>} files
 * @returns {Uint8Array}
 */
export function zipWrite(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];

  for (const [name, bytes] of Object.entries(files)) {
    const nameBytes = te.encode(name);
    const crc = crc32(bytes);
    const local = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(0),   // sig, version, flags, method 0
      ...u16(0), ...u16(0),                                       // mtime, mdate (zeroed: deterministic)
      ...u32(crc), ...u32(bytes.length), ...u32(bytes.length),
      ...u16(nameBytes.length), ...u16(0),
      ...nameBytes,
    ]);
    central.push(new Uint8Array([
      0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0),
      ...u32(crc), ...u32(bytes.length), ...u32(bytes.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset),
      ...nameBytes,
    ]));
    chunks.push(local, bytes);
    offset += local.length + bytes.length;
  }
  const centralStart = offset;
  let centralLen = 0;
  for (const c of central) { chunks.push(c); centralLen += c.length; }
  chunks.push(new Uint8Array([
    0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0),
    ...u16(central.length), ...u16(central.length),
    ...u32(centralLen), ...u32(centralStart), ...u16(0),
  ]));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * Read a ZIP into {name: Uint8Array}. Supports methods 0 (stored) and 8 (deflate).
 * @param {Uint8Array} bytes
 * @returns {Record<string, Uint8Array>}
 */
export function zipRead(bytes) {
  // find end-of-central-directory (scan back past any comment)
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const u16 = (o) => bytes[o] | (bytes[o + 1] << 8);
  const u32 = (o) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
  const count = u16(eocd + 10);
  let p = u32(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (u32(p) !== 0x02014b50) throw new Error("bad central directory");
    const method = u16(p + 10);
    const csize = u32(p + 20), usize = u32(p + 24);
    const nameLen = u16(p + 28), extraLen = u16(p + 30), commentLen = u16(p + 32);
    const localOff = u32(p + 42);
    const name = td.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // local header: skip its own (possibly different) name/extra lengths
    const lNameLen = u16(localOff + 26), lExtraLen = u16(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = bytes.subarray(dataStart, dataStart + csize);
    if (!name.endsWith("/")) {                       // skip directory entries
      if (method === 0) out[name] = new Uint8Array(data);
      else if (method === 8) {
        // wrap the raw deflate stream in a zlib header for the SDK's inflate
        const wrapped = new Uint8Array(data.length + 2);
        wrapped[0] = 0x78; wrapped[1] = 0x01;
        wrapped.set(data, 2);
        const inflated = inflate(wrapped);
        if (inflated.length !== usize) throw new Error(`${name}: bad inflate size`);
        out[name] = inflated;
      } else throw new Error(`${name}: unsupported compression method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
