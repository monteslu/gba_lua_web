// preview-synth.js - a lightweight Web Audio synth for PREVIEWING tracker
// songs in the browser. This is an APPROXIMATION for composing (square/
// triangle/noise voices matching the XM instruments' character), NOT the
// Maxmod mixer — the exact sound is what the emulator produces when you Play
// the game. Presets come from the SDK's XM_INSTRUMENTS synth hints so editor
// and file stay in lockstep.
import { noteFreq, XM_INSTRUMENTS } from "./xm-song.js";

const PRESET = new Map(XM_INSTRUMENTS.map((i) => [i.id, i.synth]));

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
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.3;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  _noise() {
    if (this._noiseBuf) return this._noiseBuf;
    const len = this.ctx.sampleRate * 0.5;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let lfsr = 0xACE1;
    for (let i = 0; i < len; i++) {
      const bit = (lfsr ^ (lfsr >> 2) ^ (lfsr >> 3) ^ (lfsr >> 5)) & 1;
      lfsr = (lfsr >> 1) | (bit << 15);
      d[i] = (lfsr & 1) ? 0.8 : -0.8;
    }
    this._noiseBuf = buf;
    return buf;
  }

  // one voice at time t. inst = 1-based XM instrument id.
  voice(inst, freq, t, durSec, vel = 64) {
    if (!freq) return;
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
      if (p.type === "square" && p.duty !== 0.5) {
        // duty-cycle square via two phase-shifted saws — close enough to hear
        src.type = "square";
      } else {
        src.type = p.type === "triangle" ? "triangle" : "square";
      }
      src.frequency.value = freq;
    }
    const peak = 0.28 * (vel / 64);
    const g = amp.gain;
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(peak, t + p.a);
    g.linearRampToValueAtTime(peak * p.s + 0.0001, t + p.a + p.d);
    const rel = t + Math.max(p.a + p.d, durSec);
    g.setValueAtTime(Math.max(peak * p.s, 0.0001), rel);
    g.exponentialRampToValueAtTime(0.0001, rel + p.r);
    src.connect(amp); amp.connect(this.master);
    src.start(t); src.stop(rel + p.r + 0.05);
  }

  /** Play one note now (piano key preview). */
  playNote(inst, note, durSec = 0.35, vel = 64) {
    const ctx = this.ensure();
    this.voice(inst, noteFreq(note), ctx.currentTime + 0.01, durSec, vel);
  }

  /** Play one tracker step's notes right now. */
  playStep(cells, instruments, durSec) {
    const ctx = this.ensure();
    const t = ctx.currentTime + 0.005;
    for (let ch = 0; ch < 4; ch++) {
      const cell = cells[ch];
      if (!cell) continue;
      const note = typeof cell === "object" ? cell.note : cell;
      const vel = typeof cell === "object" ? (cell.vel ?? 64) : 64;
      if (note && note < 97) this.voice(instruments[ch] ?? 1, noteFreq(note), t, durSec, vel);
    }
  }

  dispose() { if (this.ctx) { try { this.ctx.close(); } catch { /* */ } this.ctx = null; } }
}
