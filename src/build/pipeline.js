// pipeline.js — the browser GBA build: Lua source -> .gba ROM, entirely
// in-worker, through THE canonical build driver:
//
//   1. gbalua compile()                  Lua -> C (pure JS, runs right here)
//   2. buildGbaC() from romdev-platform-gba  C -> .gba, with every seam
//      injected (env.runTool / env.share / env.hash) so the IDENTICAL
//      pipeline the gbalua CLI and the romdev server run executes against
//      our staged WASM + share manifest. No hand-mirrored argv, no copied
//      stage graph — byte-identity with the CLI is by construction (and
//      still enforced by the playwright gates).
//
// Assets: the browser equivalent of the CLI's --sheet/--map/--mode7/--music.
// The header + soundbank generation is the SDK's OWN browser-safe code
// (gbalua/compiler/asset-headers.mjs + soundbank.mjs), so the generated text —
// and therefore the ROM bytes — is identical to a CLI build with the same
// files.

import { compile, formatDiagnostics } from "gbalua/compiler/index.js";
import {
  sheetAssetsHeader, mapAssetHeader, mode7AssetHeader,
  alienAssetsHeader, mapStubHeader, mode7StubHeader,
} from "gbalua/compiler/asset-headers.mjs";
import { buildSoundbank } from "gbalua/compiler/soundbank.mjs";
import { buildGbaC } from "romdev-platform-gba/build/gba-c/gba-c.js";
import { parseBuildLog } from "romdev-platform-gba/build/parse-errors.js";
import { runToolJob } from "./arm-tools.js";

// ---- static payloads (fetched once, cached for the worker's life) -----------
let staticsPromise = null;
async function loadStatics() {
  if (staticsPromise) return staticsPromise;
  staticsPromise = (async () => {
    const json = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`fetch ${u}: ${r.status}`); return r.json(); });
    const bin = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`fetch ${u}: ${r.status}`); return r.arrayBuffer(); }).then((b) => new Uint8Array(b));
    const [sdk, soundbank, shareEntries] = await Promise.all([
      json("/gba/sdk/sdk.json"),
      bin("/gba/sdk/soundbank.bin"),
      json("/gba/share/share-manifest.json"),
    ]);
    // rebuild the share manifest IN STAGED ORDER — key order feeds SDK compile
    // order -> ar member order -> ROM bytes (per the romdev reply).
    const share = {};
    for (const [rel, kind, data] of shareEntries) {
      share[rel] = kind === "t" ? data : Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    }
    return { sdk, soundbank, share };
  })();
  return staticsPromise;
}

// env.hash — the canonical source-map digest (sorted keys, NUL-delimited),
// mirroring sdk-cache.js hashSources, via crypto.subtle.
async function subtleHash(srcMap) {
  const enc = new TextEncoder();
  const toBytes = (v) => (typeof v === "string" ? enc.encode(v) : v instanceof Uint8Array ? v : new Uint8Array(v));
  const NUL = new Uint8Array([0]);
  const chunks = [];
  for (const name of Object.keys(srcMap).sort()) {
    chunks.push(toBytes(name), NUL, toBytes(srcMap[name]), NUL);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  const digest = await crypto.subtle.digest("SHA-256", all);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// warm rebuild cache for the worker's lifetime (SDK seed archives etc.)
const sdkCache = new Map();

/**
 * Build a gbalua game.
 * @param {{source:string,
 *   assets?: {sheet?: {name:string, bytes:Uint8Array},
 *             map?: {name:string, bytes:Uint8Array},
 *             mode7?: {name:string, bytes:Uint8Array},
 *             music?: Array<{name:string, bytes:Uint8Array}>},
 *   onProgress?:(msg:string)=>void}} args
 *   asset bytes are PNGs (the UI normalizes .ase/.tmx imports to PNG first,
 *   exactly like the CLI does); music entries are raw tracker modules.
 * @returns {Promise<{ok:boolean, rom:Uint8Array|null, log:string,
 *   diagnostics:Array<{line:number,col:number,severity:string,message:string}>}>}
 */
export async function buildRom({ source, assets = {}, onProgress = () => {} }) {
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

  // asset headers: the SDK's own generators (same text as a CLI --sheet/... build)
  try {
    includes["gba_assets.h"] = assets.sheet
      ? sheetAssetsHeader(assets.sheet.bytes, assets.sheet.name, "sheet") : alienAssetsHeader();
    includes["gba_map_asset.h"] = assets.map
      ? mapAssetHeader(assets.map.bytes, assets.map.name) : mapStubHeader();
    includes["gba_mode7_asset.h"] = assets.mode7
      ? mode7AssetHeader(assets.mode7.bytes, assets.mode7.name) : mode7StubHeader();
  } catch (e) {
    return { ok: false, rom: null, log: `asset conversion failed: ${e?.message ?? e}\n`, diagnostics: res.diagnostics };
  }

  // custom music: compile the tracker modules into a soundbank (replaces the
  // staged default). music(n) plays the nth module in list order.
  let soundbank = st.soundbank;
  if (usesSound && assets.music?.length) {
    try {
      soundbank = buildSoundbank(assets.music).bin;
      note(`--- soundbank compiled from ${assets.music.map((m) => m.name).join(", ")} ---`);
    } catch (e) {
      return { ok: false, rom: null, log: `soundbank build failed: ${e?.message ?? e}\n`, diagnostics: res.diagnostics };
    }
  }

  const binaryIncludes = {};
  if (usesSound) binaryIncludes["soundbank.bin"] = soundbank;

  // ── 3. C -> .gba through the canonical driver, env-injected ───────────────
  onProgress("building ROM (arm-gcc WASM)");
  try {
    const r = await buildGbaC({
      sources, headers: includes, binaryIncludes,
      runtime: "libtonc", maxmod: usesSound,
      env: {
        runTool: async (job) => {
          onProgress(`${job.tool} ${job.argv?.find((a) => a.endsWith(".c") || a.endsWith(".s")) ?? ""}`.trim());
          return runToolJob(job);
        },
        share: st.share,
        hash: subtleHash,
        sdkCache: { get: (k) => sdkCache.get(k) ?? null, put: (k, b) => sdkCache.set(k, b) },
      },
    });
    log += r.log || "";
    if (!r.ok || !r.binary) {
      const issues = parseBuildLog(r.log || "");
      for (const iss of issues) log += `\n${iss.severity ?? "error"}: ${iss.file ?? ""}:${iss.line ?? ""} ${iss.message}`;
      return { ok: false, rom: null, log, diagnostics: res.diagnostics };
    }
    return { ok: true, rom: r.binary, log, diagnostics: res.diagnostics };
  } catch (e) {
    return { ok: false, rom: null, log: log + `\n${e?.message ?? e}\n`, diagnostics: res.diagnostics };
  }
}
