// arm-tools.js — run the GBA WASM toolchain (cc1-arm / as / ld / objcopy) in
// the browser. Runs inside the build Web Worker.
//
// The tool glue is emscripten EXPORT_ES6 output built for node
// (-sENVIRONMENT=node). Its node-only paths are all behind ENVIRONMENT_IS_NODE
// guards with dynamic imports, so flipping the flag to false at load time gives
// a clean browser module — the same trick the gt-lua web IDE proved with cc65.
//
// Each tool's .wasm is fetched + compiled to a WebAssembly.Module ONCE (cc1-arm
// is 38 MB — compiling per run would be brutal); each run then instantiates the
// precompiled module via emscripten's instantiateWasm hook, mounts the input
// files into a fresh MEMFS, calls main, and collects outputs. Fresh instance
// per run = no state leaks between compiles.

const BASE = "/gba/wasm";

const tools = new Map();   // name -> { factory, module }

async function loadTool(name) {
  const cached = tools.get(name);
  if (cached) return cached;

  const [glueText, wasmBytes] = await Promise.all([
    fetch(`${BASE}/${name}.mjs`).then((r) => {
      if (!r.ok) throw new Error(`fetch ${name}.mjs: ${r.status}`);
      return r.text();
    }),
    fetch(`${BASE}/${name}.wasm`).then((r) => {
      if (!r.ok) throw new Error(`fetch ${name}.wasm: ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);

  // Browser-flip the glue. It was built -sENVIRONMENT=node with assertions, so
  // three things stand between it and a browser, all JS-level:
  //   1. minimum_runtime_check: a UA sniff that rejects every browser (the
  //      support table only lists node). Strip the block.
  //   2. ENVIRONMENT_IS_NODE=true: gates `await import('module')` + fs hooks
  //      that would throw in a browser. Flip to false. (Do NOT flip
  //      ENVIRONMENT_IS_WORKER — an assert forbids it in this build.)
  //   3. The env-detection chain then falls through to
  //      `throw new Error('environment detection error')` — its only job is
  //      picking file-read hooks we never use (wasmBinary + instantiateWasm
  //      are supplied directly). Neutralize the throw.
  const patched = glueText
    .replace(/\/\/ include: minimum_runtime_check\.js[\s\S]*?\/\/ end include: minimum_runtime_check\.js/, "")
    .replace(/ENVIRONMENT_IS_NODE\s*=\s*true/, "ENVIRONMENT_IS_NODE=false")
    .replace(/throw new Error\(['"]environment detection error['"]\)/, "/* browser: file hooks unused (wasmBinary supplied) */");

  const blobUrl = URL.createObjectURL(new Blob([patched], { type: "text/javascript" }));
  const mod = await import(/* @vite-ignore */ blobUrl);
  URL.revokeObjectURL(blobUrl);

  const module = await WebAssembly.compile(wasmBytes);   // once per tool
  const entry = { factory: mod.default, module };
  tools.set(name, entry);
  return entry;
}

function ensureDirs(FS, filePath) {
  const parts = filePath.split("/").filter(Boolean);
  parts.pop();
  let cur = "";
  for (const p of parts) {
    cur += "/" + p;
    try { FS.mkdir(cur); } catch { /* exists */ }
  }
}

// base64 <-> bytes (workers have atob/btoa)
const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function bytesToB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/**
 * env.runTool for buildGbaC — executes one ToolJob (the driver marshals argv +
 * files; we own WASM instantiation + MEMFS). Contract matches the node worker
 * pool: each output comes back in ITS declared encoding — utf8 outputs as
 * text, base64 outputs as base64 (getOutputText reads the value verbatim).
 * @param {{glueFile:string, argv:string[],
 *   inputFiles:Array<{vfsPath:string, encoding:"utf8"|"base64", data:string}>,
 *   outputFiles:Array<{vfsPath:string, encoding:"utf8"|"base64"}>}} job
 * @returns {Promise<{exitCode:number, log:string, outputs:Record<string,string>}>}
 */
export async function runToolJob(job) {
  const inputs = {};
  for (const f of job.inputFiles ?? []) {
    inputs[f.vfsPath] = f.encoding === "base64" ? b64ToBytes(f.data) : f.data;
  }
  const outFiles = job.outputFiles ?? [];
  const r = await runTool(job.glueFile.replace(/\.mjs$/, ""), job.argv, inputs, outFiles.map((f) => f.vfsPath));
  const outputs = {};
  for (const f of outFiles) {
    const bytes = r.outputs[f.vfsPath];
    if (!bytes) { outputs[f.vfsPath] = ""; continue; }
    outputs[f.vfsPath] = f.encoding === "base64" ? bytesToB64(bytes) : new TextDecoder().decode(bytes);
  }
  return { exitCode: r.exitCode, log: r.log, outputs };
}

/**
 * Run one tool.
 * @param {string} name  tool basename, e.g. "cc1-arm"
 * @param {string[]} argv
 * @param {Record<string, string|Uint8Array>} inputs  vfsPath -> contents
 * @param {string[]} outputs  vfs paths to read back after the run
 * @returns {Promise<{exitCode:number, log:string, outputs:Record<string,Uint8Array|null>}>}
 */
export async function runTool(name, argv, inputs = {}, outputs = []) {
  const { factory, module } = await loadTool(name);

  let log = "";
  let captured = null;
  const mod = await factory({
    noInitialRun: true,
    print: (m) => { log += m + "\n"; },
    printErr: (m) => { log += m + "\n"; },
    quit: (status, toThrow) => {
      captured = status;
      throw toThrow ?? new Error("exit " + status);
    },
    onExit: (status) => { captured = status; },
    // instantiate from the precompiled module — skips the 38 MB recompile.
    instantiateWasm: (imports, done) => {
      WebAssembly.instantiate(module, imports).then((inst) => done(inst));
      return {};
    },
  });

  for (const [p, data] of Object.entries(inputs)) {
    ensureDirs(mod.FS, p);
    mod.FS.writeFile(p, typeof data === "string" ? data : new Uint8Array(data));
  }
  for (const p of outputs) ensureDirs(mod.FS, p);

  let exitCode = 0;
  try {
    // copy: emscripten's callMain mutates the array (unshifts the program
    // name), which would poison a caller's reused argv on the next run.
    mod.callMain([...argv]);
  } catch (e) {
    if (e && typeof e === "object" && "status" in e) exitCode = e.status;
    else if (captured !== null) exitCode = captured;
    else {
      log += `\n[worker] abort in ${name}: ${e?.message ?? e}\n`;
      exitCode = 1;
    }
  }
  if (captured !== null && exitCode === 0) exitCode = captured;

  const out = {};
  for (const p of outputs) {
    try { out[p] = mod.FS.readFile(p); } catch { out[p] = null; }
  }
  return { exitCode, log, outputs: out };
}
