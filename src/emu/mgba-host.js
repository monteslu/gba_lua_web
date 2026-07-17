// mgba-host.js — run a .gba ROM in the browser on the mGBA libretro core.
//
// The core glue (mgba_libretro.js from romdev-platform-gba) is emscripten
// output built for node; its node paths sit behind ENVIRONMENT_IS_NODE guards,
// so we fetch the glue text, flip the env flags to web, and import it as a
// blob module. Then it's standard libretro wiring: env/video/audio/input
// callbacks, retro_load_game from memory, retro_run paced to the core's own
// fps, canvas present, Web Audio sink.
//
// gbalua btn(n) -> RetroPad id:
//   0 LEFT 1 RIGHT 2 UP 3 DOWN  4 A  5 B  6 L  7 R  8 START  9 SELECT

const CORE_BASE = "/gba/wasm";

const RETRO_DEVICE_JOYPAD = 1;
const RETRO_PIXEL_FORMAT_XRGB8888 = 1;
const RETRO_PIXEL_FORMAT_RGB565 = 2;

// libretro RetroPad ids
export const PAD = {
  B: 0, Y: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7,
  A: 8, X: 9, L: 10, R: 11,
};

// gbalua button index -> RetroPad id (mgba maps GBA A<-RetroPad A, B<-B, L<-L, R<-R)
export const GBA_BTN = [PAD.LEFT, PAD.RIGHT, PAD.UP, PAD.DOWN, PAD.A, PAD.B, PAD.L, PAD.R, PAD.START, PAD.SELECT];

// default keyboard map: key -> RetroPad id
export const DEFAULT_KEYS = {
  ArrowUp: PAD.UP, ArrowDown: PAD.DOWN, ArrowLeft: PAD.LEFT, ArrowRight: PAD.RIGHT,
  KeyX: PAD.A, KeyZ: PAD.B, KeyA: PAD.L, KeyS: PAD.R,
  Enter: PAD.START, ShiftRight: PAD.SELECT, Backspace: PAD.SELECT,
};

let factoryPromise = null;
async function loadCoreFactory() {
  if (factoryPromise) return factoryPromise;
  factoryPromise = (async () => {
    const [glueText, wasmBinary] = await Promise.all([
      fetch(`${CORE_BASE}/mgba_libretro.js`).then((r) => r.text()),
      fetch(`${CORE_BASE}/mgba_libretro.wasm`).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)),
    ]);
    // This glue is minified with an empty non-node else branch — flipping the
    // node flag is the whole browser port (wasmBinary is supplied directly).
    const patched = glueText
      .replace(/ENVIRONMENT_IS_NODE\s*=\s*true/, "ENVIRONMENT_IS_NODE=false");
    const blobUrl = URL.createObjectURL(new Blob([patched], { type: "text/javascript" }));
    const mod = await import(/* @vite-ignore */ blobUrl);
    URL.revokeObjectURL(blobUrl);
    return { factory: mod.default, wasmBinary };
  })();
  return factoryPromise;
}

/** A running GBA instance bound to a canvas. One host per loaded ROM. */
export class MgbaHost {
  constructor() {
    this.mod = null;
    this.canvas = null;
    this.ctx = null;
    this.imageData = null;
    this.running = false;
    this._rafId = 0;
    this.buttons = new Uint8Array(16);      // keyboard state (RetroPad ids)
    this.padButtons = new Uint8Array(16);   // gamepad state, polled per frame
    this._latestFrame = null;
    this._pixelFormat = RETRO_PIXEL_FORMAT_XRGB8888;
    this.fbWidth = 240;
    this.fbHeight = 160;
    this.fps = 59.727;
    this.sampleRate = 32768;
    // audio: a continuous ring buffer feeding ONE persistent node, so audio
    // never depends on when rAF fires (per-chunk scheduling glitched badly).
    this._audioCtx = null;
    this._audioNode = null;
    this._ring = null;         // Float32Array, interleaved stereo
    this._ringCap = 0;         // frames (L+R pairs) the ring holds
    this._ringWrite = 0;       // write cursor (in frames)
    this._ringRead = 0;        // read cursor (in frames)
    this._ringFill = 0;        // frames currently buffered
    this._lastL = 0; this._lastR = 0;   // held on underrun (no click)
    this._primed = false;      // wait until enough buffered before playing
  }

  /** Load the core and a ROM (Uint8Array). */
  async load(romBytes) {
    const { factory, wasmBinary } = await loadCoreFactory();
    const mod = await factory({ wasmBinary, locateFile: (p) => p });
    this.mod = mod;

    const envCb = mod.addFunction((cmd, dataPtr) => {
      switch (cmd) {
        case 3:   // GET_CAN_DUPE
          if (dataPtr) mod.HEAP8[dataPtr] = 1;
          return 1;
        case 10:  // SET_PIXEL_FORMAT
          this._pixelFormat = mod.HEAP32[dataPtr >> 2];
          return 1;
        default:
          return 0;
      }
    }, "iii");
    mod._retro_set_environment(envCb);

    const videoCb = mod.addFunction((dataPtr, width, height, pitch) => {
      if (dataPtr) this._latestFrame = { ptr: dataPtr, width, height, pitch };
      this.fbWidth = width; this.fbHeight = height;
    }, "viiii");
    mod._retro_set_video_refresh(videoCb);

    const audioBatchCb = mod.addFunction((dataPtr, frames) => {
      // s16 interleaved stereo straight into the ring (converted to float)
      this._pushAudio(new Int16Array(mod.HEAP16.buffer, dataPtr, frames * 2), frames);
      return frames;
    }, "iii");
    mod._retro_set_audio_sample_batch(audioBatchCb);
    mod._retro_set_audio_sample(mod.addFunction((l, r) => {
      const s = new Int16Array(2); s[0] = l; s[1] = r;
      this._pushAudio(s, 1);
    }, "vii"));

    mod._retro_set_input_poll(mod.addFunction(() => {}, "v"));
    const inputStateCb = mod.addFunction((port, device, index, id) => {
      if (port !== 0 || device !== RETRO_DEVICE_JOYPAD) return 0;
      return this.buttons[id] || this.padButtons[id] ? 1 : 0;
    }, "iiiii");
    mod._retro_set_input_state(inputStateCb);

    mod._retro_init();

    const romPtr = mod._malloc(romBytes.length);
    mod.HEAPU8.set(romBytes, romPtr);
    const info = mod._malloc(24);
    mod.HEAPU32[(info >> 2) + 0] = 0;               // path = NULL
    mod.HEAPU32[(info >> 2) + 1] = romPtr;          // data
    mod.HEAPU32[(info >> 2) + 2] = romBytes.length; // size
    mod.HEAPU32[(info >> 2) + 3] = 0;               // meta = NULL
    if (!mod._retro_load_game(info)) throw new Error("retro_load_game failed");

    const av = mod._malloc(64);
    mod._retro_get_system_av_info(av);
    const dv = new DataView(mod.HEAPU8.buffer, av, 64);
    this.fps = dv.getFloat64(24, true) || 59.727;
    this.sampleRate = dv.getFloat64(32, true) || 32768;
    return this;
  }

  start(canvas) {
    if (!this.mod) throw new Error("load() a ROM before start()");
    this.canvas = canvas;
    this.canvas.width = this.fbWidth;
    this.canvas.height = this.fbHeight;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.ctx.imageSmoothingEnabled = false;
    this.imageData = this.ctx.createImageData(this.fbWidth, this.fbHeight);
    this.running = true;
    this._acc = 0;
    this._lastT = 0;
    this._loop();
  }

  pause() {
    this.running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    if (this._audioCtx && this._audioCtx.state === "running") {
      try { this._audioCtx.suspend(); } catch { /* ignore */ }
    }
    this._resetRing();
  }

  resume() {
    if (this.running || !this.mod) return;
    this.running = true;
    this._acc = 0; this._lastT = 0;
    if (this._audioCtx) { try { this._audioCtx.resume(); } catch { /* ignore */ } }
    this._loop();
  }

  isPaused() { return !this.running && !!this.mod; }
  reset() { if (this.mod) this.mod._retro_reset(); }

  /** Set a gbalua button index (0-9) down/up. */
  setButton(i, down) {
    const id = GBA_BTN[i];
    if (id !== undefined) this.buttons[id] = down ? 1 : 0;
  }
  /** Set a RetroPad id directly. */
  setPad(padId, down) { this.buttons[padId] = down ? 1 : 0; }

  // ---- debugger access: the running machine's work RAM -----------------------
  // libretro RETRO_MEMORY_SYSTEM_RAM (2) = the GBA's EWRAM (0x02000000, 256 KB
  // — where gbalua globals/arrays live via the heap).
  _ramPtr() {
    if (!this.mod || typeof this.mod._retro_get_memory_data !== "function") return 0;
    return this.mod._retro_get_memory_data(2);
  }
  /** Size of the inspectable RAM (0 if the core doesn't expose it). */
  ramSize() {
    if (!this.mod || typeof this.mod._retro_get_memory_size !== "function") return 0;
    return this.mod._retro_get_memory_size(2);
  }
  /** Read `len` bytes at RAM offset `off` (a copy — safe to hold). */
  readRam(off, len) {
    const ptr = this._ramPtr();
    if (!ptr) return new Uint8Array(0);
    const size = this.ramSize();
    const n = Math.max(0, Math.min(len, size - off));
    return this.mod.HEAPU8.slice(ptr + off, ptr + off + n);
  }
  /** Write one byte into the running machine's RAM. */
  writeRam(off, value) {
    const ptr = this._ramPtr();
    if (ptr && off >= 0 && off < this.ramSize()) this.mod.HEAPU8[ptr + off] = value & 0xff;
  }

  /** Hook: called once per rAF to refresh gamepad state (set by the pane). */
  pollPads = null;

  // Pace retro_run to the core's fps against the wall clock — rAF fires at the
  // display's refresh (may be 120+ Hz) and must not double-speed the game.
  _loop = (now) => {
    if (!this.running || !this.mod) return;
    if (this.pollPads) this.pollPads(this.padButtons);
    if (typeof now !== "number") now = performance.now();
    if (!this._lastT) this._lastT = now;
    this._acc += now - this._lastT;
    this._lastT = now;
    if (this._acc > 250) this._acc = 250;
    const frameMs = 1000 / this.fps;
    let ran = false;
    // cap catch-up to 4 frames so a stall can't dump a huge audio burst that
    // overruns the ring (the extra audio would just be dropped anyway)
    let budget = 4;
    while (this._acc >= frameMs && budget-- > 0) {
      this._acc -= frameMs;
      this.mod._retro_run();          // pushes audio into the ring via the callback
      ran = true;
    }
    if (this._acc > frameMs * 4) this._acc = 0;   // give up on a big backlog
    if (ran) this._present();
    this._rafId = requestAnimationFrame(this._loop);
  };

  _present() {
    const f = this._latestFrame;
    if (!f) return;
    const { ptr, width, height, pitch } = f;
    if (width !== this.imageData.width || height !== this.imageData.height) {
      this.canvas.width = width; this.canvas.height = height;
      this.imageData = this.ctx.createImageData(width, height);
    }
    const out = this.imageData.data;
    const mod = this.mod;
    if (this._pixelFormat === RETRO_PIXEL_FORMAT_RGB565) {
      const src = new Uint16Array(mod.HEAP16.buffer, ptr, (pitch / 2) * height);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const p = src[y * (pitch / 2) + x], o = (y * width + x) * 4;
        out[o] = ((p >> 11) & 0x1f) << 3;
        out[o + 1] = ((p >> 5) & 0x3f) << 2;
        out[o + 2] = (p & 0x1f) << 3;
        out[o + 3] = 255;
      }
    } else {
      // XRGB8888 in memory is BGRA byte order -> RGBA
      const src = new Uint8Array(mod.HEAPU8.buffer, ptr, pitch * height);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const s = y * pitch + x * 4, o = (y * width + x) * 4;
        out[o] = src[s + 2]; out[o + 1] = src[s + 1]; out[o + 2] = src[s]; out[o + 3] = 255;
      }
    }
    this.ctx.putImageData(this.imageData, 0, 0);
  }

  // ---- ring-buffer audio: one persistent node pulls continuously -----------
  _resetRing() {
    this._ringWrite = this._ringRead = this._ringFill = 0;
    this._resamplePos = 0;
    this._primed = false;
  }

  /** Call from a user gesture to enable sound (browsers gate AudioContext). */
  unlockAudio() {
    if (!this._audioCtx) this._initAudio();
    if (this._audioCtx && this._audioCtx.state === "suspended") this._audioCtx.resume();
  }

  _initAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    // The GBA core outputs at this.sampleRate (65536 Hz). Browsers CANNOT make
    // an AudioContext above ~48kHz — asking for 65536 silently yields 44100/
    // 48000, and then the stream plays at the wrong pitch/speed ("sounds like
    // shit"). So take the context's own rate and RESAMPLE in the pull.
    this._audioCtx = new AC();
    const rate = this._audioCtx.sampleRate;      // e.g. 48000
    this._resampleStep = this.sampleRate / rate; // core-frames advanced per out-frame
    this._resamplePos = 0;                        // fractional read position
    // the ring holds CORE-rate frames; ~0.5s of them
    this._ringCap = Math.ceil(this.sampleRate * 0.5);
    this._ring = new Float32Array(this._ringCap * 2);
    this._resetRing();
    // ScriptProcessor is deprecated but universally available and perfect for a
    // pull sink; 2048 frames ≈ 62ms blocks. (An AudioWorklet would need a
    // separate module file + SAB; not worth it for a preview emulator.)
    const BUF = 2048;
    const node = this._audioCtx.createScriptProcessor(BUF, 0, 2);
    node.onaudioprocess = (e) => this._pullAudio(e.outputBuffer);
    node.connect(this._audioCtx.destination);
    this._audioNode = node;
  }

  // core -> ring. `interleaved` is s16 L,R,L,R…; `frames` = L/R pairs.
  _pushAudio(interleaved, frames) {
    if (!this._audioCtx) return;   // no audio until unlocked
    const ring = this._ring, cap = this._ringCap;
    let w = this._ringWrite;
    for (let i = 0; i < frames; i++) {
      if (this._ringFill >= cap) break;   // overrun: drop (we're ahead of realtime)
      ring[w * 2] = interleaved[i * 2] / 32768;
      ring[w * 2 + 1] = interleaved[i * 2 + 1] / 32768;
      w = (w + 1) % cap;
      this._ringFill++;
    }
    this._ringWrite = w;
    // prime once we have a comfortable cushion (~1/8s) so playback starts smooth
    if (!this._primed && this._ringFill >= this._ringCap / 4) this._primed = true;
  }

  // ring (core rate) -> speakers (context rate), linearly resampled. Advances
  // the fractional read position by _resampleStep per output frame; on underrun
  // holds the last sample (click-free) and re-primes.
  _pullAudio(outBuf) {
    const L = outBuf.getChannelData(0), R = outBuf.getChannelData(1);
    const n = outBuf.length;
    const ring = this._ring, cap = this._ringCap, step = this._resampleStep;
    if (!this._primed) { L.fill(this._lastL); R.fill(this._lastR); return; }
    let r = this._ringRead, frac = this._resamplePos;
    for (let i = 0; i < n; i++) {
      // need at least 2 core frames buffered to interpolate the next output frame
      if (this._ringFill < 2 && frac >= 1) { L[i] = this._lastL; R[i] = this._lastR; continue; }
      const i0 = r, i1 = (r + 1) % cap;
      const l = ring[i0 * 2] + (ring[i1 * 2] - ring[i0 * 2]) * frac;
      const rr = ring[i0 * 2 + 1] + (ring[i1 * 2 + 1] - ring[i0 * 2 + 1]) * frac;
      L[i] = this._lastL = l; R[i] = this._lastR = rr;
      frac += step;
      while (frac >= 1 && this._ringFill > 1) { frac -= 1; r = (r + 1) % cap; this._ringFill--; }
    }
    this._ringRead = r; this._resamplePos = frac;
    if (this._ringFill <= 1) this._primed = false;   // re-prime after a dropout
  }

  dispose() {
    this.pause();
    const mod = this.mod;
    if (mod) {
      try { mod._retro_unload_game(); mod._retro_deinit(); } catch { /* ignore */ }
    }
    if (this._audioNode) { try { this._audioNode.disconnect(); this._audioNode.onaudioprocess = null; } catch { /* ignore */ } this._audioNode = null; }
    if (this._audioCtx) { try { this._audioCtx.close(); } catch { /* ignore */ } this._audioCtx = null; }
    this.mod = null;
    this._latestFrame = null;
  }
}
