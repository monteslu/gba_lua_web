// Stage the GBA WASM toolchain + emulator core + SDK artifacts into public/gba/
// so Vite serves them to the browser. Everything comes from npm packages the
// `gbalua` dependency pulls in — no checkouts, no servers:
//   romdev-platform-gba  -> cc1-arm / as / ld / objcopy WASM + the mGBA core
//   romdevtools          -> libtonc/maxmod headers, prebuilt .a seeds, crt
//                           objects, gba_crt0.s, gba_cart.ld, arm archives
//   gbalua               -> the gba-sdk/*.c runtime sources + soundbank.bin
//
// Text assets (headers, runtime sources, crt0, ld script) are bundled into two
// JSON files (share/headers.json, sdk/sdk.json) so the build worker fetches a
// handful of files instead of hundreds. Binaries stay as raw files.
//
// public/gba is gitignored — regenerate any time (postinstall runs this).
import { cp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const TOOLS = resolvePkgDir("romdevtools", "src/platforms/gba/lib/libtonc/gba_cart.ld");
const LIB = path.join(TOOLS, "src", "platforms", "gba", "lib");

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

// ---- 2. headers (bundled as one JSON) ----------------------------------------
// Groups mirror what romdev's gba-c pipeline mounts for cc1: newlib sysinclude,
// libtonc's include tree, maxmod's include. Plus the crt0 + linker script text.
async function readTree(dir, filter = /\.(h|inc)$/i) {
  const out = {};
  async function walk(d, rel = "") {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      const sub = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(full, sub);
      else if (e.isFile() && filter.test(e.name)) out[sub] = await readFile(full, "utf8");
    }
  }
  await walk(dir);
  return out;
}

const headers = {
  sys: await readTree(path.join(LIB, "libgba", "sysinclude")),
  tonc: await readTree(path.join(LIB, "libtonc", "include")),
  maxmod: await readTree(path.join(LIB, "maxmod", "include")),
  crt0: await readFile(path.join(LIB, "libtonc", "gba_crt0.s"), "utf8"),
  ldscript: await readFile(path.join(LIB, "libtonc", "gba_cart.ld"), "utf8"),
};
await writeFile(path.join(OUT, "share", "headers.json"), JSON.stringify(headers));

// ---- 3. link-stage binaries ---------------------------------------------------
// Prebuilt SDK seeds (mounted as libtonc.a / libmm.a at link time), the crt
// objects, and the gcc/newlib target archives.
const BIN = [
  [path.join(LIB, "libtonc", "libtonc.seed.a"), "libtonc.a"],
  [path.join(LIB, "maxmod", "maxmod.seed.a"), "libmm.a"],
  [path.join(LIB, "libtonc", "crti.o"), "crti.o"],
  [path.join(LIB, "libtonc", "crtn.o"), "crtn.o"],
  [path.join(LIB, "libtonc", "crtbegin.o"), "crtbegin.o"],
  [path.join(LIB, "libtonc", "crtend.o"), "crtend.o"],
  [path.join(LIB, "arm-archives", "libc.a"), "libc.a"],
  [path.join(LIB, "arm-archives", "libgcc.a"), "libgcc.a"],
  [path.join(LIB, "arm-archives", "libnosys.a"), "libnosys.a"],
];
for (const [src, name] of BIN) {
  await cp(src, path.join(OUT, "share", name));
}

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
// of deep-importing through the package.
const EXAMPLES = [
  ["hello", "hello", false],
  ["effects", "effects (blend + fade)", false],
  ["anim", "anim helpers", true],
  ["hwtest", "hwtest (save + timer + raster)", false],
  ["showcase", "showcase (scene tour)", true],
  ["starfall", "starfall (shmup)", true],
];
const examples = [];
for (const [id, name, assets] of EXAMPLES) {
  const p = path.join(GBALUA, "examples", id, "main.lua");
  if (!existsSync(p)) continue;
  examples.push({ id, name, assets, source: await readFile(p, "utf8") });
}
await writeFile(path.join(OUT, "examples.json"), JSON.stringify(examples));

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
