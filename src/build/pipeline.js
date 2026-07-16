// pipeline.js — the browser GBA build: Lua source -> .gba ROM, entirely
// in-worker. Mirrors the exact stage graph + argv of romdevtools'
// buildWithLibtonc() (the pipeline the gbalua CLI runs in-process), so the
// ROM bytes are byte-identical to a CLI build of the same source:
//
//   1. gbalua compile()          Lua -> C (pure JS, runs right here)
//   2. cc1-arm  (per .c)         C -> ARM asm      (thumb-interwork)
//   3. as       (per .s)         asm -> .o
//   4. as gba_crt0.s + stubs     runtime objects
//   5. ld                        .o's + libtonc.a (+libmm.a) + libc/libgcc -> ELF
//   6. objcopy -O binary         ELF -> .gba
//
// Assets note (v1): browser builds use the built-in fallback sprite — the
// PNG->tile converter needs the SDK's A2 (browser-safe png-tiles) before
// --sheet/--map/--mode7 equivalents work here. Sound DOES work: the staged
// default soundbank links when a game calls music()/sfx().

import { compile, formatDiagnostics } from "gbalua/compiler/index.js";
import { runTool } from "./arm-tools.js";

// argv fragments copied from romdevtools (arm config + gba-c defaults).
const ARM_FLAGS = ["-mcpu=arm7tdmi", "-mthumb-interwork"];
const CC1_DEFAULTS = ["-O2", "-mthumb", "-ffunction-sections", "-fdata-sections", "-Wall", "-Wextra", "-Wno-unused-parameter"];

const FAKE_HEAP_STUB = `
      .section .data
      .global fake_heap_end
      .global end
      .align 2
      fake_heap_end:
        .word 0x02040000   /* end of EWRAM — 256 KB after 0x02000000 */
      end:
        .word 0x02000000   /* start of EWRAM — sbrk grows from here */
    `;

const SOUNDBANK_STUB = `
        .section .rodata
        .align 2
        .global soundbank_bin
        .global soundbank_bin_size
        soundbank_bin:
          .incbin "soundbank.bin"
        soundbank_bin_end:
        .align 2
        soundbank_bin_size:
          .word soundbank_bin_end - soundbank_bin
      `;

// the fallback gba_assets.h (no custom sheet in browser builds yet).
const ALIEN_ASSETS_H = `// browser build: built-in alien sprite (custom sheets need SDK A2)
#ifndef GBA_ASSETS_H
#define GBA_ASSETS_H
#include "alien_sprite.h"
#define GBA_SHEET_TILES alien_tiles
#define GBA_SHEET_TILES_WORDS (sizeof(alien_tiles)/4)
#define GBA_SHEET_HAS_PAL 0
#endif
`;
const MAP_STUB_H = `#ifndef GBA_MAP_ASSET_H\n#define GBA_MAP_ASSET_H\n#define GBA_HAS_MAP 0\n#endif\n`;
const MODE7_STUB_H = `#ifndef GBA_MODE7_ASSET_H\n#define GBA_MODE7_ASSET_H\n#define GBA_HAS_MODE7 0\n#endif\n`;

// ---- static payloads (fetched once, cached for the worker's life) -----------
let staticsPromise = null;
async function loadStatics() {
  if (staticsPromise) return staticsPromise;
  staticsPromise = (async () => {
    const json = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`fetch ${u}: ${r.status}`); return r.json(); });
    const bin = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`fetch ${u}: ${r.status}`); return r.arrayBuffer(); }).then((b) => new Uint8Array(b));
    const [share, sdk, soundbank, ...bins] = await Promise.all([
      json("/gba/share/headers.json"),
      json("/gba/sdk/sdk.json"),
      bin("/gba/sdk/soundbank.bin"),
      bin("/gba/share/libtonc.a"),
      bin("/gba/share/libmm.a"),
      bin("/gba/share/crti.o"),
      bin("/gba/share/crtn.o"),
      bin("/gba/share/crtbegin.o"),
      bin("/gba/share/crtend.o"),
      bin("/gba/share/libc.a"),
      bin("/gba/share/libgcc.a"),
      bin("/gba/share/libnosys.a"),
    ]);
    const [libtonc, libmm, crti, crtn, crtbegin, crtend, libc, libgcc, libnosys] = bins;
    return { share, sdk, soundbank, libtonc, libmm, crti, crtn, crtbegin, crtend, libc, libgcc, libnosys };
  })();
  return staticsPromise;
}

// mount a {name:text} header group under /work/
function mountHeaders(into, group) {
  for (const [name, text] of Object.entries(group)) into[`/work/${name}`] = text;
}

/**
 * Build a gbalua game.
 * @param {{source:string, onProgress?:(msg:string)=>void}} args
 * @returns {Promise<{ok:boolean, rom:Uint8Array|null, log:string,
 *   diagnostics:Array<{line:number,col:number,severity:string,message:string}>}>}
 */
export async function buildRom({ source, onProgress = () => {} }) {
  let log = "";
  const note = (m) => { log += m + "\n"; onProgress(m); };

  // ── 1. Lua -> C ───────────────────────────────────────────────────────────
  onProgress("compiling Lua");
  const res = compile(source, "main.lua", { target: "gba" });
  if (!res.ok) {
    return {
      ok: false, rom: null,
      log: formatDiagnostics(res.diagnostics.filter((d) => d.severity === "error")),
      diagnostics: res.diagnostics,
    };
  }

  const st = await loadStatics();
  const usesSound = /\bgba_music\b|\bgba_sfx\b/.test(res.c);

  // ── 2. assemble the source set (same as the CLI's build-gba.mjs) ──────────
  // ORDER MATTERS for byte-identity: object insertion order = link order =
  // section layout. This is the CLI's exact insertion order (gba_sound.c last,
  // only when the game uses sound). Any staged source not in this list is
  // appended after — that keeps new SDK files building, but flags that this
  // list should be updated to match the CLI.
  const SOURCE_ORDER = [
    "gba_api.c", "gba_math.c", "gba_bg.c", "gba_text.c", "gba_fx.c",
    "gba_mode7.c", "gba_win.c", "gba_anim.c", "gba_hw.c", "gba_more.c",
  ];
  const sources = { "main.c": res.c };
  for (const n of SOURCE_ORDER) {
    if (st.sdk.sources[n]) sources[n] = st.sdk.sources[n];
  }
  for (const n of Object.keys(st.sdk.sources)) {
    if (!(n in sources) && n !== "gba_sound.c") sources[n] = st.sdk.sources[n];
  }
  if (usesSound && st.sdk.sources["gba_sound.c"]) sources["gba_sound.c"] = st.sdk.sources["gba_sound.c"];
  const includes = { ...st.sdk.includes };
  includes["gba_config.h"] =
    `#ifndef GBA_CONFIG_H\n#define GBA_CONFIG_H\n${usesSound ? "#define GBA_HAVE_SOUND 1\n" : ""}#endif\n`;
  includes["gba_assets.h"] = ALIEN_ASSETS_H;
  includes["gba_map_asset.h"] = MAP_STUB_H;
  includes["gba_mode7_asset.h"] = MODE7_STUB_H;

  // header set mounted for every cc1 run (sys + tonc + maxmod + generated)
  const cc1Headers = {};
  mountHeaders(cc1Headers, st.share.sys);
  mountHeaders(cc1Headers, st.share.tonc);
  if (usesSound) mountHeaders(cc1Headers, st.share.maxmod);
  mountHeaders(cc1Headers, includes);

  const cc1Argv = [
    ...ARM_FLAGS, ...CC1_DEFAULTS, "-mthumb-interwork",
    "-iquote", "/work", "-I", "/work",
    "/work/main.c", "-o", "/work/main.s",
  ];
  const asArgv = [...ARM_FLAGS, "-I", "/work", "/work/main.s", "-o", "/work/main.o"];

  async function assemble(label, asmText, extraBin = {}) {
    const r = await runTool("arm-none-eabi-as", asArgv,
      { "/work/main.s": asmText, ...extraBin }, ["/work/main.o"]);
    log += r.log;
    if (r.exitCode !== 0 || !r.outputs["/work/main.o"]) throw new Error(`as (${label}) failed`);
    return r.outputs["/work/main.o"];
  }

  const objects = {};
  try {
    // ── 3. cc1 + as per translation unit ────────────────────────────────────
    for (const [name, src] of Object.entries(sources)) {
      onProgress(`cc1 ${name}`);
      const cc1 = await runTool("cc1-arm", cc1Argv,
        { "/work/main.c": src, ...cc1Headers }, ["/work/main.s"]);
      log += cc1.log;
      if (cc1.exitCode !== 0 || !cc1.outputs["/work/main.s"]) {
        return { ok: false, rom: null, log, diagnostics: res.diagnostics };
      }
      onProgress(`as ${name}`);
      objects[name.replace(/\.c$/, ".o")] =
        await assemble(name, new TextDecoder().decode(cc1.outputs["/work/main.s"]));
    }

    // ── 4. runtime objects ──────────────────────────────────────────────────
    onProgress("as gba_crt0.s");
    objects["gba_crt0.o"] = await assemble("gba_crt0.s", st.share.crt0);
    objects["fake_heap_end.o"] = await assemble("fake_heap_end", FAKE_HEAP_STUB);
    if (usesSound) {
      note("--- soundbank stub auto-emitted (.incbin) ---");
      objects["soundbank.o"] = await assemble("soundbank.s", SOUNDBANK_STUB,
        { "/work/soundbank.bin": st.soundbank });
    }

    // ── 5. link ─────────────────────────────────────────────────────────────
    onProgress("ld");
    const ldInputs = { "/work/gba.ld": st.share.ldscript };
    for (const [n, bytes] of Object.entries(objects)) ldInputs[`/work/${n}`] = bytes;
    ldInputs["/work/libtonc.a"] = st.libtonc;
    if (usesSound) ldInputs["/work/libmm.a"] = st.libmm;
    ldInputs["/work/crti.o"] = st.crti;
    ldInputs["/work/crtn.o"] = st.crtn;
    ldInputs["/work/crtbegin.o"] = st.crtbegin;
    ldInputs["/work/crtend.o"] = st.crtend;
    ldInputs["/work/libc.a"] = st.libc;
    ldInputs["/work/libgcc.a"] = st.libgcc;
    ldInputs["/work/libnosys.a"] = st.libnosys;

    const ldArgv = [
      "-T", "/work/gba.ld",
      "-o", "/work/main.elf",
      "-Map=/work/main.map",
      "-L", "/work",
      ...Object.keys(objects).map((n) => "/work/" + n),
      "/work/crti.o",
      "/work/crtbegin.o",
      "--start-group",
      "-ltonc",
      ...(usesSound ? ["-lmm"] : []),
      "-lc",
      "-lgcc",
      "-lnosys",
      "--end-group",
      "/work/crtend.o",
      "/work/crtn.o",
    ];
    const ld = await runTool("arm-none-eabi-ld", ldArgv, ldInputs, ["/work/main.elf", "/work/main.map"]);
    log += ld.log;
    if (ld.exitCode !== 0 || !ld.outputs["/work/main.elf"]) {
      return { ok: false, rom: null, log, diagnostics: res.diagnostics };
    }

    // ── 6. objcopy -> .gba ──────────────────────────────────────────────────
    onProgress("objcopy");
    const oc = await runTool("arm-none-eabi-objcopy",
      ["-O", "binary", "/work/main.elf", "/work/main.gba"],
      { "/work/main.elf": ld.outputs["/work/main.elf"] }, ["/work/main.gba"]);
    log += oc.log;
    if (oc.exitCode !== 0 || !oc.outputs["/work/main.gba"]) {
      return { ok: false, rom: null, log, diagnostics: res.diagnostics };
    }

    return { ok: true, rom: oc.outputs["/work/main.gba"], log, diagnostics: res.diagnostics };
  } catch (e) {
    return { ok: false, rom: null, log: log + `\n${e?.message ?? e}\n`, diagnostics: res.diagnostics };
  }
}
