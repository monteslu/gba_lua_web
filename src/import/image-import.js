// image-import.js — normalize an imported image to PNG bytes (the build
// pipeline's contract). Import conversion is THE SDK'S CODE
// (gbalua/compiler/*-import.mjs) — the web app adds zero formats of its own.

import { aseToRgba } from "gbalua/compiler/ase-import.mjs";
import { tmxToRgba, listTmxImages } from "gbalua/compiler/tmx-import.mjs";
import { encodePng } from "gbalua/compiler/png-encode.mjs";
import { decodePng } from "gbalua/compiler/png-tiles.mjs";

export const IMAGE_EXTS = [".png", ".ase", ".aseprite", ".tmx"];

const ext = (name) => {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
};

/**
 * Normalize an imported image file to PNG bytes.
 * .png passes through (validated); .ase/.aseprite flattens frame 0; .tmx
 * composites its layers — its tileset images must be in `siblings` (picked in
 * the same file dialog).
 * @param {{name:string, bytes:Uint8Array}} file
 * @param {Record<string, Uint8Array>} [siblings] files picked alongside
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
