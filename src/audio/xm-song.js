// xm-song.js - the tracker's song model and its .xm serialization.
//
// A song is { steps, delay, instruments: [i0..i3] (1-based XM instrument ids),
// velocity: bool, grid[step][ch] = 0 | note | {note, vel} } — note numbers are
// XM notes (1 = C-0, 58 = A-4 = 440 Hz). songToXm() writes a REAL FastTracker
// .xm via the SDK's writer, so a composed song opens in OpenMPT/MilkyTracker
// and compiles into the Maxmod soundbank exactly like an imported module.

import { writeXm, NOTE, KEY_OFF, noteName, noteFreq, XM_INSTRUMENTS } from "gbalua/compiler/xm-write.mjs";

export { NOTE, KEY_OFF, noteName, noteFreq, XM_INSTRUMENTS };
export const CHANNELS = 4;
export const MAX_STEPS = 256;
export const MAX_VEL = 64;
export const DEFAULT_VEL = 64;

export const noteOf = (cell) => (cell && typeof cell === "object" ? cell.note : cell) || 0;
export const velOf = (cell) => (cell && typeof cell === "object" && cell.vel != null ? cell.vel : DEFAULT_VEL);
export const makeCell = (note, vel, withVel) =>
  (note && withVel && vel !== DEFAULT_VEL ? { note, vel } : note);

/** a fresh 16-step song: lead / chip / bass / drum */
export function newSong() {
  const steps = 16;
  const grid = [];
  for (let i = 0; i < steps; i++) grid.push([0, 0, 0, 0]);
  return { steps, delay: 8, velocity: false, instruments: [1, 4, 2, 3], grid };
}

/**
 * Serialize the song model to .xm bytes.
 * `delay` is the step length in 60 Hz frames (the SDK's music timing unit);
 * XM rows tick at speed*2.5/bpm sec, so with speed 6 the bpm that matches is
 * 900/delay (row time = 15/bpm sec = delay/60 sec).
 */
export function songToXm(model, title = "song") {
  const bpm = Math.max(32, Math.min(255, Math.round(900 / Math.max(2, model.delay))));
  const grid = [];
  for (let s = 0; s < model.steps; s++) {
    const row = [];
    for (let ch = 0; ch < CHANNELS; ch++) {
      const cell = model.grid[s]?.[ch];
      const note = noteOf(cell);
      row.push(note ? { note, inst: model.instruments[ch] ?? 1, vol: model.velocity ? velOf(cell) : undefined } : 0);
    }
    grid.push(row);
  }
  return writeXm({ title, channels: CHANNELS, speed: 6, bpm, patterns: [grid] });
}
