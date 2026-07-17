// sheet-model.js - the GBA sprite sheet as editable pixels.
//
// The persisted form is a real PNG (sheet.png in the project — the exact file
// `gbalua build --sheet` takes). The edit form is { width, height, px } where
// px is a Uint32Array of 0xAABBGGRR pixels; 0 = transparent. GBA sprites are
// 4bpp: at most 15 opaque colors + transparent, enforced at paint time.

import { decodePng } from "gbalua/compiler/png-tiles.mjs";
import { encodePng } from "gbalua/compiler/png-encode.mjs";
import { aseToRgba } from "gbalua/compiler/ase-import.mjs";

export const MAX_COLORS = 15;
export const TRANSPARENT = 0;

export const packColor = (r, g, b) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
export const colorParts = (c) => [c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff];
export const colorHex = (c) => {
  const [r, g, b] = colorParts(c);
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
};
export const hexColor = (h) =>
  packColor(parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16));

export const getPixel = (img, x, y) => img.px[y * img.width + x];
export const setPixel = (img, x, y, c) => { img.px[y * img.width + x] = c; };

/** A blank (transparent) sheet. */
export function newSheet(width = 128, height = 128) {
  return { width, height, px: new Uint32Array(width * height) };
}

export function cloneSheet(img) {
  return { width: img.width, height: img.height, px: new Uint32Array(img.px) };
}

/** PNG bytes -> sheet (alpha<128 becomes transparent). */
export function sheetFromPng(bytes) {
  const { width, height, rgba } = decodePng(bytes);
  const px = new Uint32Array(width * height);
  for (let i = 0; i < px.length; i++) {
    px[i] = rgba[i * 4 + 3] < 128 ? 0 : packColor(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  }
  return { width, height, px };
}

/** Sheet -> PNG bytes (the build/persist form). */
export function sheetToPng(img) {
  const rgba = new Uint8Array(img.width * img.height * 4);
  for (let i = 0; i < img.px.length; i++) {
    const c = img.px[i];
    if (!c) continue;
    const [r, g, b] = colorParts(c);
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
  }
  return encodePng(rgba, img.width, img.height);
}

/** .ase/.aseprite bytes -> sheet (frame 0 flattened, semi-alpha hardened). */
export function sheetFromAse(bytes) {
  const { width, height, rgba } = aseToRgba(bytes);
  const px = new Uint32Array(width * height);
  for (let i = 0; i < px.length; i++) {
    px[i] = rgba[i * 4 + 3] < 128 ? 0 : packColor(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  }
  return { width, height, px };
}

/** The sheet's opaque colors in first-seen order. */
export function paletteOf(img) {
  const seen = new Set();
  const out = [];
  for (const c of img.px) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    if (out.length > MAX_COLORS + 4) break;   // enough to show the overflow
  }
  return out;
}

/**
 * Reduce an imported sheet to the 4bpp budget if needed: keeps the 15 most
 * frequent colors, snaps the rest to their nearest keeper. Returns
 * { img, reduced: droppedCount }.
 */
export function enforcePalette(img) {
  const counts = new Map();
  for (const c of img.px) if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  if (counts.size <= MAX_COLORS) return { img, reduced: 0 };
  const keep = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_COLORS).map(([c]) => c);
  const keepParts = keep.map(colorParts);
  const remap = new Map(keep.map((c) => [c, c]));
  for (const c of counts.keys()) {
    if (remap.has(c)) continue;
    const [r, g, b] = colorParts(c);
    let best = keep[0], bd = Infinity;
    for (let i = 0; i < keep.length; i++) {
      const [kr, kg, kb] = keepParts[i];
      const d = (r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2;
      if (d < bd) { bd = d; best = keep[i]; }
    }
    remap.set(c, best);
  }
  const out = cloneSheet(img);
  for (let i = 0; i < out.px.length; i++) if (out.px[i]) out.px[i] = remap.get(out.px[i]);
  return { img: out, reduced: counts.size - MAX_COLORS };
}
