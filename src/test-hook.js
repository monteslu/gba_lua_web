// test-hook.js — playwright's door into the app. Exposes the build client and
// an emulator boot on window so test/browser-build.mjs can drive a REAL
// browser build and assert the ROM bytes + a running frame, without poking at
// React internals.
import { build } from "./build/build-client.js";
import { MgbaHost } from "./emu/mgba-host.js";

export function installTestHook() {
  window.__gbaluaWeb = {
    /** build source (+ optional assets, bytes as base64) -> { ok, romBase64, log } */
    async build(source, assetsB64) {
      const un = (p) => p && { name: p.name, bytes: Uint8Array.from(atob(p.b64), (c) => c.charCodeAt(0)) };
      const assets = {};
      if (assetsB64?.sheet) assets.sheet = un(assetsB64.sheet);
      if (assetsB64?.map) assets.map = un(assetsB64.map);
      if (assetsB64?.mode7) assets.mode7 = un(assetsB64.mode7);
      if (assetsB64?.music?.length) assets.music = assetsB64.music.map(un);
      const r = await build(source, { assets });
      let romBase64 = null;
      if (r.ok && r.rom) {
        let s = "";
        for (let i = 0; i < r.rom.length; i += 0x8000) {
          s += String.fromCharCode.apply(null, r.rom.subarray(i, i + 0x8000));
        }
        romBase64 = btoa(s);
      }
      return { ok: r.ok, romBase64, log: r.log };
    },
    /** boot a ROM, run n frames, return the canvas as a PNG dataURL (thumbnails) */
    async bootShot(romBase64, frames = 180, presses = []) {
      const bytes = Uint8Array.from(atob(romBase64), (c) => c.charCodeAt(0));
      const host = await new MgbaHost().load(bytes);
      const canvas = document.createElement("canvas");
      canvas.width = 240; canvas.height = 160;
      document.body.appendChild(canvas);
      host.canvas = canvas;
      host.ctx = canvas.getContext("2d", { alpha: false });
      host.imageData = host.ctx.createImageData(240, 160);
      for (let i = 0; i < frames; i++) {
        for (const p of presses) host.setPad(p.pad, i >= p.at && i < p.at + (p.hold ?? 4));
        host.mod._retro_run();
      }
      host._present();
      const url = canvas.toDataURL("image/png");
      host.dispose();
      canvas.remove();
      return url;
    },
    /** boot a ROM, capture the core's audio into the ring, report stream stats */
    async audioProbe(romBase64, frames = 300) {
      const bytes = Uint8Array.from(atob(romBase64), (c) => c.charCodeAt(0));
      const host = await new MgbaHost().load(bytes);
      // stand in for the AudioContext so _pushAudio accepts samples, and
      // capture everything the core emits (no ScriptProcessor pull, so nothing
      // drains — we read the raw produced stream)
      const captured = [];
      host._audioCtx = { sampleRate: host.sampleRate, state: "running", resume() {}, close() {} };
      host._ringCap = 1e9;   // never overrun during capture
      host._ring = null;
      host._pushAudio = (interleaved, n) => {
        for (let i = 0; i < n * 2; i++) captured.push(interleaved[i] / 32768);
      };
      for (let i = 0; i < frames; i++) host.mod._retro_run();
      host.dispose();
      // measure the captured stereo stream
      let peak = 0, sumSq = 0;
      for (const v of captured) { const a = Math.abs(v); if (a > peak) peak = a; sumSq += v * v; }
      const rms = Math.sqrt(sumSq / Math.max(1, captured.length));
      // continuity: longest run of near-zero samples AFTER audio first starts
      // (skip the boot/intro silence — that's the ROM, not the audio path)
      let firstSound = captured.findIndex((v) => Math.abs(v) > 1e-3);
      if (firstSound < 0) firstSound = captured.length;
      let maxSilentRun = 0, run = 0;
      for (let i = firstSound; i < captured.length; i++) {
        if (Math.abs(captured[i]) < 1e-4) { if (++run > maxSilentRun) maxSilentRun = run; } else run = 0;
      }
      const framesPerVideoFrame = captured.length / 2 / frames;
      return { samples: captured.length, peak, rms, maxSilentRun, firstSound, framesPerVideoFrame };
    },
    /** boot a base64 ROM on an offscreen canvas, run n frames, return canvas pixels sum */
    async bootSmoke(romBase64, frames = 120) {
      const bytes = Uint8Array.from(atob(romBase64), (c) => c.charCodeAt(0));
      const host = await new MgbaHost().load(bytes);
      const canvas = document.createElement("canvas");
      canvas.width = 240; canvas.height = 160;
      document.body.appendChild(canvas);
      host.canvas = canvas;
      host.ctx = canvas.getContext("2d", { alpha: false });
      host.imageData = host.ctx.createImageData(240, 160);
      for (let i = 0; i < frames; i++) host.mod._retro_run();
      host._present();
      const px = host.ctx.getImageData(0, 0, 240, 160).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
      host.dispose();
      canvas.remove();
      return { pixelSum: sum };
    },
  };
}
