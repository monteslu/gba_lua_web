// test-hook.js — playwright's door into the app. Exposes the build client and
// an emulator boot on window so test/browser-build.mjs can drive a REAL
// browser build and assert the ROM bytes + a running frame, without poking at
// React internals.
import { build } from "./build/build-client.js";
import { MgbaHost } from "./emu/mgba-host.js";

export function installTestHook() {
  window.__gbaluaWeb = {
    /** build source -> { ok, romBase64, log } (base64 crosses page.evaluate cleanly) */
    async build(source) {
      const r = await build(source);
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
