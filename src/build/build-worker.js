// build-worker.js — the browser build runs in a Web Worker, off the UI thread.
// Protocol: main posts { type:"build", id, source }; worker replies
// { type:"progress"|"done"|"error", id, ... }. The pipeline module owns all the
// toolchain logic; this file is just the message plumbing.
import { buildRom } from "./pipeline.js";

self.onmessage = async (e) => {
  const { type, id, source } = e.data || {};
  if (type !== "build") return;
  try {
    const r = await buildRom({
      source,
      onProgress: (msg) => self.postMessage({ type: "progress", id, msg }),
    });
    // rom transfers (zero-copy) when present
    self.postMessage(
      { type: "done", id, ok: r.ok, rom: r.rom, log: r.log, diagnostics: r.diagnostics },
      r.rom ? [r.rom.buffer] : [],
    );
  } catch (err) {
    self.postMessage({ type: "error", id, message: err?.message ?? String(err) });
  }
};
