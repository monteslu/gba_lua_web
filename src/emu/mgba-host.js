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
    this._audioCtx = null;
    this._nextAudioTime = 0;
    this._audioQueue = [];
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
      const n = frames * 2;   // interleaved s16 stereo
      const src = new Int16Array(mod.HEAP16.buffer, dataPtr, n);
      this._audioQueue.push(Int16Array.from(src));
      return frames;
    }, "iii");
    mod._retro_set_audio_sample_batch(audioBatchCb);
    mod._retro_set_audio_sample(mod.addFunction(() => {}, "vii"));

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
    this._audioQueue.length = 0;
  }

  resume() {
    if (this.running || !this.mod) return;
    this.running = true;
    this._acc = 0; this._lastT = 0;
    if (this._audioCtx) {
      try { this._audioCtx.resume(); } catch { /* ignore */ }
      this._nextAudioTime = this._audioCtx.currentTime;
    }
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
    while (this._acc >= frameMs) {
      this._acc -= frameMs;
      this.mod._retro_run();
      this._flushAudio();
      ran = true;
    }
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

  /** Call from a user gesture to enable sound (browsers gate AudioContext). */
  unlockAudio() {
    if (!this._audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this._audioCtx = new AC({ sampleRate: this.sampleRate });
      this._nextAudioTime = this._audioCtx.currentTime;
    }
    if (this._audioCtx.state === "suspended") this._audioCtx.resume();
  }

  _flushAudio() {
    if (!this._audioQueue.length) return;
    if (!this._audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this._audioCtx = new AC({ sampleRate: this.sampleRate });
      this._nextAudioTime = this._audioCtx.currentTime;
    }
    const ctx = this._audioCtx;
    for (const chunk of this._audioQueue) {
      const frames = chunk.length / 2;
      if (!frames) continue;
      const buf = ctx.createBuffer(2, frames, this.sampleRate);
      const L = buf.getChannelData(0), R = buf.getChannelData(1);
      for (let i = 0; i < frames; i++) {
        L[i] = chunk[i * 2] / 32768;
        R[i] = chunk[i * 2 + 1] / 32768;
      }
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.connect(ctx.destination);
      const now = ctx.currentTime;
      if (this._nextAudioTime < now) this._nextAudioTime = now;
      node.start(this._nextAudioTime);
      this._nextAudioTime += frames / this.sampleRate;
    }
    this._audioQueue.length = 0;
  }

  dispose() {
    this.pause();
    const mod = this.mod;
    if (mod) {
      try { mod._retro_unload_game(); mod._retro_deinit(); } catch { /* ignore */ }
    }
    if (this._audioCtx) { try { this._audioCtx.close(); } catch { /* ignore */ } this._audioCtx = null; }
    this.mod = null;
    this._latestFrame = null;
  }
}
