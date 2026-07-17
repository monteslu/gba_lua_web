// p8-import.js - PICO-8 cart -> a gbalua project to port from.
//
//   __lua__  -> main.lua, verbatim under a banner explaining what to expect
//               (glyphs neutralized so the source lexes cleanly)
//   __gfx__  -> sheet.png — the P8 16-color palette maps 1:1 onto the GBA's
//               4bpp budget (P8 color 0 -> transparent + 15 opaque colors)
//
// Both the text .p8 and the steganographic .p8.png cart work (the ROM hides
// in the low 2 bits of each pixel; code comes raw, legacy- or pxa-compressed —
// decompressors follow the PICO-8 wiki / zepto8 reference).
//
// sfx/__music__ are NOT converted (gbalua music is real tracker modules —
// compose in the music tab or import a .xm); __map__ is noted but skipped.

import { decodePng } from "gbalua/compiler/png-tiles.mjs";
import { encodePng } from "gbalua/compiler/png-encode.mjs";

// the PICO-8 palette, RGB. Index 0 (black) becomes transparent — the P8
// convention spr() uses, and exactly what fits GBA 4bpp (15 opaque + clear).
const P8_RGB = [
  null,
  [0x1d, 0x2b, 0x53], [0x7e, 0x25, 0x53], [0x00, 0x87, 0x51], [0xab, 0x52, 0x36],
  [0x5f, 0x57, 0x4f], [0xc2, 0xc3, 0xc7], [0xff, 0xf1, 0xe8], [0xff, 0x00, 0x4d],
  [0xff, 0xa3, 0x00], [0xff, 0xec, 0x27], [0x00, 0xe4, 0x36], [0x29, 0xad, 0xff],
  [0x83, 0x76, 0x9c], [0xff, 0x77, 0xa8], [0xff, 0xcc, 0xaa],
];

const SECTIONS = ["lua", "gfx", "gff", "label", "map", "sfx", "music"];

export function parseP8(text) {
  if (!text.includes("__lua__")) throw new Error("not a .p8 text cart (no __lua__ section)");
  const out = {};
  for (const name of SECTIONS) {
    const start = text.indexOf(`__${name}__`);
    if (start < 0) continue;
    let end = text.length;
    for (const other of SECTIONS) {
      const i = text.indexOf(`__${other}__`, start + name.length + 4);
      if (i > start && i < end) end = i;
    }
    out[name] = text.slice(start + name.length + 4, end).replace(/^\r?\n/, "");
  }
  return out;
}

// ---- gfx: 128 lines of 128 hex nibbles -> sheet.png -------------------------
function nibblesToPng(readNibble, width = 128, height = 128) {
  const rgba = new Uint8Array(width * height * 4);
  let any = false;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const idx = readNibble(x, y);
      if (!idx) continue;
      any = true;
      const [r, g, b] = P8_RGB[idx];
      const o = (y * width + x) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
    }
  return any ? encodePng(rgba, width, height) : null;
}

export function gfxToSheetPng(gfxSection) {
  if (!gfxSection) return null;
  const lines = gfxSection.split("\n").map((l) => l.trim()).filter((l) => /^[0-9a-f]+$/.test(l));
  if (!lines.length) return null;
  return nibblesToPng((x, y) => {
    const line = lines[y];
    return line && x < line.length ? parseInt(line[x], 16) : 0;
  });
}

// ---- glyph neutralization (see the gt web IDE — same tables) -----------------
const P8_BTN_ASCII = { 0x8b: "[<]", 0x91: "[>]", 0x94: "[^]", 0x83: "[v]", 0x8e: "[O]", 0x97: "[X]" };
const P8_BTN_INDEX = { 0x8b: "0", 0x91: "1", 0x94: "2", 0x83: "3", 0x8e: "4", 0x97: "5" };
const isStrayByte = (c) => (c !== 9 && c !== 10 && c !== 13 && c < 0x20) || (c >= 0x7f && c < 0xa0);

export function translateP8Glyphs(lua) {
  let out = "";
  let quote = null;
  for (let i = 0; i < lua.length; i++) {
    const ch = lua[i];
    const c = ch.codePointAt(0);
    if (quote) {
      if (ch === "\\") { out += ch + (lua[++i] ?? ""); continue; }
      if (ch === quote) { quote = null; out += ch; continue; }
      if (P8_BTN_ASCII[c] !== undefined) { out += P8_BTN_ASCII[c]; continue; }
      if (isStrayByte(c)) continue;
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (P8_BTN_INDEX[c] !== undefined) { out += P8_BTN_INDEX[c]; continue; }
    if (isStrayByte(c)) { out += `_p${c.toString(16)}`; continue; }
    out += ch;
  }
  return out;
}

// ---- what-to-expect: name the dialect gaps this cart actually uses -----------
const DIALECT_GAPS = [
  { re: /function\s*\(/, say: "anonymous functions / closures - define named top-level functions instead" },
  { re: /(?<![.\w])[A-Za-z_]\w*\s*:\s*[A-Za-z_]\w*\s*\(/, say: "method calls a:b() - no methods; pass the object explicitly" },
  { re: /(?<![.\w])(?:nil)(?![.\w])/, say: "nil / dynamic typing - initialize every variable with a real value" },
  { re: /(?<![.\w])(?:split|all|foreach|del|deli|count|mget|mset|map|pal|palt|sspr|menuitem|coresume|cocreate|yield)(?![.\w])/,
    say: "PICO-8 builtins gbalua doesn't have (split/all/foreach/map/coroutines...) - port these by hand" },
];

const BANNER = (name, notes, gaps) => `-- ${name} - imported from a PICO-8 cart.
--
-- gbalua is a PICO-8-FLAVORED dialect that compiles to native ARM, not
-- PICO-8: the art imported fine, but the CODE usually needs hand-porting.
-- Errors in the Problems panel are EXPECTED, not a broken import - they mark
-- the PICO-8 features that don't map to a static, compiled target.
--
${gaps.length ? "-- This cart specifically uses:\n" + gaps.map((g) => `--   * ${g}`).join("\n") + "\n--\n" : ""}${notes.map((n) => `-- NOT imported: ${n}`).join("\n")}${notes.length ? "\n" : ""}
`;

function finishProject(lua, gfxPng, name, notes) {
  const gaps = DIALECT_GAPS.filter((g) => g.re.test(lua)).map((g) => g.say);
  const files = { "main.lua": BANNER(name, notes, gaps) + lua };
  if (gfxPng) files["sheet.png"] = gfxPng;
  return { files, notes };
}

/** Convert a .p8 text cart into gbalua project files. */
export function p8ToProject(text, name) {
  const cart = parseP8(text);
  const notes = [];
  if (cart.map?.trim()) notes.push("__map__ data (draw or compose the level with map_show/tset instead)");
  if (cart.sfx?.trim() || cart.music?.trim()) notes.push("__sfx__/__music__ (compose in the music tab — gbalua music is real tracker modules)");
  const lua = translateP8Glyphs((cart.lua ?? "").replace(/\r\n/g, "\n").trimEnd() + "\n");
  return finishProject(lua, gfxToSheetPng(cart.gfx), name, notes);
}

// ---- .p8.png carts ------------------------------------------------------------
const LEGACY_LUT = "\n 0123456789abcdefghijklmnopqrstuvwxyz!#%(){}[]<>+=/*:;.,~_";

function legacyDecompress(code) {
  const length = code[4] * 256 + code[5];
  let out = "";
  for (let i = 8; i < code.length && out.length < length; i++) {
    const byte = code[i];
    if (byte === 0x00) out += String.fromCharCode(code[++i]);
    else if (byte < 0x3c) out += LEGACY_LUT[byte - 1];
    else {
      const offset = (byte - 0x3c) * 16 + (code[i + 1] & 0xf);
      const len = (code[i + 1] >> 4) + 2;
      const start = out.length - offset;
      if (start >= 0) for (let j = 0; j < len; j++) out += out[start + j];
      i++;
    }
  }
  return out;
}

function pxaDecompress(input) {
  const length = input[4] * 256 + input[5];
  const compressed = input[6] * 256 + input[7];
  let pos = 8 * 8;
  const getBits = (count) => {
    let n = 0;
    for (let i = 0; i < count && pos < compressed * 8; i++, pos++) {
      n |= ((input[pos >> 3] >> (pos & 7)) & 1) << i;
    }
    return n;
  };
  const mtf = Array.from({ length: 256 }, (_, i) => i);
  let out = "";
  while (out.length < length && pos < compressed * 8) {
    if (getBits(1)) {
      let nbits = 4;
      while (getBits(1)) nbits++;
      const n = getBits(nbits) + (1 << nbits) - 16;
      const ch = mtf[n];
      mtf.splice(n, 1); mtf.unshift(ch);
      if (!ch) break;
      out += String.fromCharCode(ch);
    } else {
      const nbits = getBits(1) ? (getBits(1) ? 5 : 10) : 15;
      const offset = getBits(nbits) + 1;
      if (nbits === 10 && offset === 1) {
        let ch = getBits(8);
        while (ch) { out += String.fromCharCode(ch); ch = getBits(8); }
      } else {
        let n, len = 3;
        do len += (n = getBits(3)); while (n === 7);
        for (let i = 0; i < len; i++) out += out[out.length - offset];
      }
    }
  }
  return out;
}

function romLua(rom) {
  const code = rom.subarray(0x4300, 0x8000);
  if (code[0] === 0 && code[1] === 0x70 && code[2] === 0x78 && code[3] === 0x61) return pxaDecompress(code);
  if (code[0] === 0x3a && code[1] === 0x63 && code[2] === 0x3a && code[3] === 0) return legacyDecompress(code);
  let end = code.indexOf(0);
  if (end < 0) end = code.length;
  let out = "";
  for (let i = 0; i < end; i++) out += String.fromCharCode(code[i]);
  return out;
}

/** Convert a steganographic .p8.png cart into gbalua project files. */
export function p8PngToProject(bytes, name) {
  const { rgba } = decodePng(bytes);
  if (rgba.length < 0x8000 * 4) throw new Error("PNG too small to be a PICO-8 cart (needs 160x205)");
  const rom = new Uint8Array(0x8000);
  for (let i = 0; i < 0x8000; i++) {
    const o = i * 4;
    rom[i] = ((rgba[o + 3] & 3) << 6) | ((rgba[o] & 3) << 4) | ((rgba[o + 1] & 3) << 2) | (rgba[o + 2] & 3);
  }
  const lua = romLua(rom);
  if (!lua.trim()) throw new Error("no code found - not a PICO-8 cart PNG");
  const notes = ["__sfx__/__music__ (compose in the music tab — gbalua music is real tracker modules)"];
  // gfx: 0x0000-0x1fff, two pixels per byte (low nibble = left pixel)
  const gfxPng = nibblesToPng((x, y) => {
    const byte = rom[y * 64 + (x >> 1)];
    return x & 1 ? byte >> 4 : byte & 0xf;
  });
  return finishProject(translateP8Glyphs(lua.replace(/\r\n/g, "\n").trimEnd() + "\n"), gfxPng, name, notes);
}
