// preview-synth.js - a Web Audio synth for PREVIEWING tracker songs while
// composing. An APPROXIMATION (the real sound is the Maxmod mixer when you Play
// the game), but a clean, musical one: band-limited-ish voices through a gentle
// lowpass + soft limiter, click-free attack/release ramps, and SAMPLE-ACCURATE
// scheduling (all timing comes from the AudioContext clock, never setTimeout).
// Presets come from the SDK's XM_INSTRUMENTS so editor and file stay in step.
import { noteFreq, XM_INSTRUMENTS } from "./xm-song.js";

const PRESET = new Map(XM_INSTRUMENTS.map((i) => [i.id, i.synth]));
const MIN = 0.0005;   // envelope floor (exponential ramps can't hit 0)

export class PreviewSynth {
  constructor() {
    this.ctx = null;
    this.master = null;
    this._noiseBuf = null;
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      // master chain: gain -> soft-clip limiter -> gentle lowpass -> out.
      // keeps 4 stacked square voices from clipping into a harsh buzz.
      const gain = this.ctx.createGain();
      gain.gain.value = 0.22;                 // headroom for 4 channels
      const shaper = this.ctx.createWaveShaper();
      shaper.curve = softClipCurve();
      shaper.oversample = "2x";
      const lp = this.ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 7000;              // tame the top-end fizz
      lp.Q.value = 0.5;
      gain.connect(shaper); shaper.connect(lp); lp.connect(this.ctx.destination);
      this.master = gain;
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  _noise() {
    if (this._noiseBuf) return this._noiseBuf;
    const len = this.ctx.sampleRate;   // 1s loop
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let lfsr = 0xACE1;
    for (let i = 0; i < len; i++) {
      const bit = (lfsr ^ (lfsr >> 2) ^ (lfsr >> 3) ^ (lfsr >> 5)) & 1;
      lfsr = (lfsr >> 1) | (bit << 15);
      d[i] = (lfsr & 1) ? 0.5 : -0.5;
    }
    this._noiseBuf = buf;
    return buf;
  }

  /**
   * Schedule one voice to start at absolute AudioContext time `t`. inst =
   * 1-based XM instrument id. durSec is the note length; the envelope's release
   * tail extends past it. All ramps are click-free.
   */
  voice(inst, freq, t, durSec, vel = 64) {
    if (!freq || !this.ctx) return;
    const p = PRESET.get(inst) ?? PRESET.get(1);
    const ctx = this.ctx;
    const amp = ctx.createGain();
    let src;
    if (p.type === "noise") {
      src = ctx.createBufferSource();
      src.buffer = this._noise();
      src.loop = true;
      src.playbackRate.value = Math.max(0.1, freq / 440);
    } else {
      src = ctx.createOscillator();
      src.type = p.type === "triangle" ? "triangle" : p.type === "sawtooth" ? "sawtooth" : "square";
      src.frequency.setValueAtTime(freq, t);
    }
    // per-voice lowpass a touch above the note so squares aren't razor-bright
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = Math.min(9000, Math.max(1400, freq * 6));
    tone.Q.value = 0.3;

    // ADSR — a real attack ramp (>= 4ms) kills the click; release always
    // returns to the floor so tails don't pile up into mud
    const atk = Math.max(0.004, p.a);
    const dec = Math.max(0.01, p.d);
    const rel = Math.max(0.03, p.r);
    const peak = 0.32 * (vel / 64);
    const sus = Math.max(MIN, peak * p.s);
    const g = amp.gain;
    g.setValueAtTime(MIN, t);
    g.linearRampToValueAtTime(peak, t + atk);
    g.exponentialRampToValueAtTime(sus, t + atk + dec);
    const relStart = t + Math.max(atk + dec, durSec);
    g.setValueAtTime(Math.max(MIN, g.value), relStart);   // hold sustain to release
    g.setValueAtTime(sus, relStart);
    g.exponentialRampToValueAtTime(MIN, relStart + rel);

    src.connect(tone); tone.connect(amp); amp.connect(this.master);
    src.start(t);
    src.stop(relStart + rel + 0.02);
  }

  /** Play one note now (piano key preview). */
  playNote(inst, note, durSec = 0.35, vel = 64) {
    const ctx = this.ensure();
    this.voice(inst, noteFreq(note), ctx.currentTime + 0.02, durSec, vel);
  }

  /** Schedule one tracker step's notes at absolute time `t` (look-ahead). */
  scheduleStep(cells, instruments, t, durSec) {
    if (!this.ctx) this.ensure();
    for (let ch = 0; ch < 4; ch++) {
      const cell = cells[ch];
      if (!cell) continue;
      const note = typeof cell === "object" ? cell.note : cell;
      const vel = typeof cell === "object" ? (cell.vel ?? 64) : 64;
      if (note && note < 97) this.voice(instruments[ch] ?? 1, noteFreq(note), t, durSec, vel);
    }
  }

  now() { return this.ensure().currentTime; }

  dispose() { if (this.ctx) { try { this.ctx.close(); } catch { /* */ } this.ctx = null; } }
}

// a mild tanh-style soft clip so summed voices saturate smoothly instead of
// hard-clipping into a buzz
function softClipCurve() {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = 1.6;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}
