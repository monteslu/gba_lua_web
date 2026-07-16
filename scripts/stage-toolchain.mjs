// Stage the GBA WASM toolchain + emulator core + SDK artifacts into public/gba/
// so Vite serves them to the browser. Everything comes from npm packages the
// `gbalua` dependency pulls in — no checkouts, no servers:
//   romdev-platform-gba  -> cc1-arm / as / ld / objcopy WASM + the mGBA core
//                           + the share/gba/lib tree (libtonc, maxmod, crt,
//                           ld scripts, arm archives) + THE build driver
//   gbalua               -> the gba-sdk/*.c runtime sources + soundbank.bin
//
// The share tree is staged as ONE manifest (share-manifest.json) built by the
// package's own buildShareManifest() — the exact walk order node uses, which
// matters: key order feeds SDK compile order -> ar member order -> ROM bytes.
// The build worker hands it to buildGbaC() as env.share.
//
// public/gba is gitignored — regenerate any time (postinstall runs this).
import { cp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

// Resolve packages through gbalua's scope first so hoisting layout doesn't
// matter (the same trick the gt web IDE uses for its toolchain package).
const GBALUA = path.dirname(require.resolve("gbalua/package.json"));
function resolvePkgDir(pkg, sentinel) {
  for (const base of [GBALUA, HERE]) {
    try {
      const main = require.resolve(pkg, { paths: [base] });
      const root = main.slice(0, main.lastIndexOf(pkg) + pkg.length);
      if (existsSync(path.join(root, sentinel))) return root;
    } catch { /* try next */ }
  }
  throw new Error(`could not resolve ${pkg} (run npm install first)`);
}

const PLATFORM = resolvePkgDir("romdev-platform-gba", "wasm/cc1-arm.wasm");

const OUT = path.join(HERE, "public", "gba");
await rm(OUT, { recursive: true, force: true });
await mkdir(path.join(OUT, "wasm"), { recursive: true });
await mkdir(path.join(OUT, "share"), { recursive: true });
await mkdir(path.join(OUT, "sdk"), { recursive: true });

// ---- 1. WASM tools + emulator core ------------------------------------------
const WASM_FILES = [
  "cc1-arm.mjs", "cc1-arm.wasm",
  "arm-none-eabi-as.mjs", "arm-none-eabi-as.wasm",
  "arm-none-eabi-ld.mjs", "arm-none-eabi-ld.wasm",
  "arm-none-eabi-objcopy.mjs", "arm-none-eabi-objcopy.wasm",
  "mgba_libretro.js", "mgba_libretro.wasm",
];
for (const f of WASM_FILES) {
  await cp(path.join(PLATFORM, "wasm", f), path.join(OUT, "wasm", f));
}

// ---- 2. the share tree, as the package's own manifest -------------------------
// buildShareManifest() classifies text vs binary and walks in the canonical
// order. Serialized as an ORDERED array (JSON objects would survive, but be
// explicit): [[relPath, "t", text] | [relPath, "b", base64]].
const { buildShareManifest } = await import(
  pathToFileURL(path.join(PLATFORM, "build", "common", "share-fs.js")).href
);
const manifest = await buildShareManifest(path.join(PLATFORM, "share", "gba", "lib"));
const entries = [];
for (const [rel, data] of Object.entries(manifest)) {
  entries.push(typeof data === "string"
    ? [rel, "t", data]
    : [rel, "b", Buffer.from(data).toString("base64")]);
}
await writeFile(path.join(OUT, "share", "share-manifest.json"), JSON.stringify(entries));

// ---- 4. the gbalua runtime (C sources + headers) + default soundbank ----------
const SDK_SRC = path.join(GBALUA, "gba-sdk");
const sdk = { sources: {}, includes: {} };
for (const e of await readdir(SDK_SRC, { withFileTypes: true })) {
  if (!e.isFile()) continue;
  if (e.name.endsWith(".c")) sdk.sources[e.name] = await readFile(path.join(SDK_SRC, e.name), "utf8");
  else if (e.name.endsWith(".h")) sdk.includes[e.name] = await readFile(path.join(SDK_SRC, e.name), "utf8");
}
await writeFile(path.join(OUT, "sdk", "sdk.json"), JSON.stringify(sdk));
await cp(path.join(GBALUA, "assets", "soundbank.bin"), path.join(OUT, "sdk", "soundbank.bin"));

// ---- 4b. the SDK's example games (the gallery) --------------------------------
// gbalua's exports map doesn't expose ./examples/*, so bundle them here instead
// of deep-importing through the package. Each example's asset files (the same
// ones the SDK's CI passes as --sheet/--mode7) are staged as raw files so the
// browser build uses the REAL art, not the fallback — the asset mapping below
// mirrors gba_lua_sdk/.github/workflows/ci.yml.
const EXAMPLES = [
  ["hello", "hello", {}],
  ["effects", "effects (blend + fade)", {}],
  ["anim", "anim helpers", {}],
  ["hwtest", "hwtest (save + timer + raster)", {}],
  ["mode7", "mode7 (affine plane)", { mode7: "plane.png" }],
  ["windows", "windows (hw spotlight)", { mode7: "plane.png" }],
  ["showcase", "showcase (scene tour)", { mode7: "plane.png" }],
  ["starfall", "starfall (shmup)", { sheet: "shmup_sheet.png" }],
];
const examples = [];
for (const [id, name, assets] of EXAMPLES) {
  const p = path.join(GBALUA, "examples", id, "main.lua");
  if (!existsSync(p)) continue;
  for (const file of Object.values(assets)) {
    await mkdir(path.join(OUT, "examples", id), { recursive: true });
    await cp(path.join(GBALUA, "examples", id, file), path.join(OUT, "examples", id, file));
  }
  examples.push({ id, name, assets, source: await readFile(p, "utf8") });
}
await writeFile(path.join(OUT, "examples.json"), JSON.stringify(examples));

// ---- 4c. the SDK cheatsheet (rendered in the help pane) ------------------------
await cp(path.join(GBALUA, "docs", "CHEATSHEET.md"), path.join(OUT, "cheatsheet.md"));

// ---- 5. manifest (toolchain signature for cache versioning) -------------------
import { createHash } from "node:crypto";
const sig = createHash("sha256");
for (const f of WASM_FILES.filter((f) => f.endsWith(".wasm"))) {
  sig.update(await readFile(path.join(OUT, "wasm", f)));
}
const gbaluaVersion = JSON.parse(await readFile(path.join(GBALUA, "package.json"), "utf8")).version;
await writeFile(path.join(OUT, "manifest.json"), JSON.stringify({
  generated: new Date().toISOString(),
  gbalua: gbaluaVersion,
  toolchainSignature: sig.digest("hex"),
}, null, 2));

console.log(`staged GBA toolchain + SDK into public/gba (gbalua ${gbaluaVersion})`);
