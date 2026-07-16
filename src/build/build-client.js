// build-client.js — main-thread client for the build Worker. One long-lived
// worker (warm WASM modules + cached share payloads survive across builds),
// driven request/response by id. The React app and the playwright test hook
// both use this, so one place owns the protocol.

let worker = null;
let nextId = 1;
const pending = new Map();   // id -> { resolve, reject, onProgress }

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./build-worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const { type, id } = e.data || {};
    const p = pending.get(id);
    if (!p) return;
    if (type === "progress") p.onProgress?.(e.data.msg);
    else if (type === "done") { pending.delete(id); p.resolve(e.data); }
    else if (type === "error") { pending.delete(id); p.reject(new Error(e.data.message)); }
  };
  worker.onerror = (e) => {
    for (const [, p] of pending) p.reject(new Error(e.message || "build worker crashed"));
    pending.clear();
    worker = null;   // recycle on next build
  };
  return worker;
}

/**
 * Build a gbalua source in the browser.
 * @param {string} source main.lua text
 * @param {{onProgress?:(msg:string)=>void}} [opts]
 * @returns {Promise<{ok:boolean, rom:Uint8Array|null, log:string, diagnostics:Array}>}
 */
export function build(source, opts = {}) {
  const w = ensureWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress: opts.onProgress });
    w.postMessage({ type: "build", id, source });
  });
}
