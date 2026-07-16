// asset-store.js — project asset state: import conversion + persistence.
//
// An asset project = { sheet?, map?, mode7?, music? } where sheet/map/mode7
// are {name, bytes} (PNG bytes — imports normalize first, exactly like the
// CLI) and music is an ordered [{name, bytes}] of raw tracker modules.
//
// Import conversion is THE SDK'S CODE (gbalua/compiler/*-import.mjs) — the web
// app adds zero formats of its own.

import { aseToRgba } from "gbalua/compiler/ase-import.mjs";
import { tmxToRgba, listTmxImages } from "gbalua/compiler/tmx-import.mjs";
import { encodePng } from "gbalua/compiler/png-encode.mjs";
import { decodePng } from "gbalua/compiler/png-tiles.mjs";

export const MUSIC_EXTS = [".xm", ".mod", ".it", ".s3m"];
export const IMAGE_EXTS = [".png", ".ase", ".aseprite", ".tmx"];

const ext = (name) => {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
};

/**
 * Normalize an imported image file to PNG bytes (the pipeline's contract).
 * .png passes through; .ase/.aseprite flattens frame 0; .tmx composites its
 * layers — its tileset images must be in `siblings` (same file-picker batch).
 * @param {{name:string, bytes:Uint8Array}} file
 * @param {Record<string, Uint8Array>} [siblings] other files picked alongside
 * @returns {{name:string, bytes:Uint8Array}} name rewritten to .png
 */
export function importImage(file, siblings = {}) {
  const e = ext(file.name);
  if (e === ".png") {
    decodePng(file.bytes);                      // validate early, fail loudly
    return file;
  }
  if (e === ".ase" || e === ".aseprite") {
    const { width, height, rgba } = aseToRgba(file.bytes);
    return { name: file.name.replace(/\.[^.]+$/, ".png"), bytes: encodePng(rgba, width, height) };
  }
  if (e === ".tmx") {
    const text = new TextDecoder().decode(file.bytes);
    const needed = listTmxImages(text).map((s) => s.split("/").pop());
    const images = {};
    for (const n of needed) {
      if (!siblings[n]) {
        throw new Error(`the map needs its tileset image "${n}" — select the .tmx and its image(s) together`);
      }
      images[n] = siblings[n];
    }
    const { width, height, rgba } = tmxToRgba(text, images);
    return { name: file.name.replace(/\.[^.]+$/, ".png"), bytes: encodePng(rgba, width, height) };
  }
  throw new Error(`unsupported image format "${e}" (use ${IMAGE_EXTS.join("/")})`);
}

// ---- persistence (localStorage, bytes as base64) ------------------------------
const b64encode = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
};
const b64decode = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const packFile = (f) => (f ? { name: f.name, b64: b64encode(f.bytes) } : undefined);
const unpackFile = (p) => (p ? { name: p.name, bytes: b64decode(p.b64) } : undefined);

export function saveAssets(key, assets) {
  try {
    const packed = {
      sheet: packFile(assets.sheet),
      map: packFile(assets.map),
      mode7: packFile(assets.mode7),
      music: assets.music?.map(packFile),
    };
    localStorage.setItem(key, JSON.stringify(packed));
  } catch { /* quota — assets just won't persist */ }
}

export function loadAssets(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const p = JSON.parse(raw);
    const out = {};
    if (p.sheet) out.sheet = unpackFile(p.sheet);
    if (p.map) out.map = unpackFile(p.map);
    if (p.mode7) out.mode7 = unpackFile(p.mode7);
    if (p.music?.length) out.music = p.music.map(unpackFile);
    return out;
  } catch { return null; }
}

export function clearAssets(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}
