// gamepad.js - Gamepad API -> GBA pad, with per-controller remapping.
//
// The GBA pad is 10 inputs (d-pad, A, B, L, R, Start, Select). This polls the
// browser Gamepad API each frame and reports which are pressed, resolving each
// through a mapping. A "standard"-layout pad (Xbox/PS) uses sensible defaults
// with no setup; anything non-standard walks through the remap flow
// (GamepadMapper.jsx) and the result is saved per-controller id in
// localStorage.
//
// A mapping is { id, binds: { UP: src, ... } } where src is
//   { kind: "button", index } | { kind: "axis", index, dir: +1|-1 }.
import { PAD } from "./mgba-host.js";

// the 10 GBA inputs, in remap-walk order, each with its RetroPad id
export const GBA_INPUTS = [
  { key: "UP", label: "Up", pad: PAD.UP },
  { key: "DOWN", label: "Down", pad: PAD.DOWN },
  { key: "LEFT", label: "Left", pad: PAD.LEFT },
  { key: "RIGHT", label: "Right", pad: PAD.RIGHT },
  { key: "A", label: "A", pad: PAD.A },
  { key: "B", label: "B", pad: PAD.B },
  { key: "L", label: "L (shoulder)", pad: PAD.L },
  { key: "R", label: "R (shoulder)", pad: PAD.R },
  { key: "START", label: "Start", pad: PAD.START },
  { key: "SELECT", label: "Select", pad: PAD.SELECT },
];

const STORAGE_PREFIX = "gbalua-gamepad-map:";
const BUTTON_ON = 0.5;
const AXIS_ON = 0.5;

// Standard-layout default: the browser normalizes Xbox/PS pads to a fixed
// button/axis order, so these binds work for any "standard" controller.
export const STANDARD_BINDS = {
  UP: { kind: "button", index: 12 },
  DOWN: { kind: "button", index: 13 },
  LEFT: { kind: "button", index: 14 },
  RIGHT: { kind: "button", index: 15 },
  A: { kind: "button", index: 1 },   // east face (Circle / B position) -> GBA A
  B: { kind: "button", index: 0 },   // south face (Cross / A position) -> GBA B
  L: { kind: "button", index: 4 },
  R: { kind: "button", index: 5 },
  START: { kind: "button", index: 9 },
  SELECT: { kind: "button", index: 8 },
};

export function loadMapping(id) {
  try { const j = localStorage.getItem(STORAGE_PREFIX + id); return j ? JSON.parse(j) : null; }
  catch { return null; }
}
export function saveMapping(mapping) {
  try { localStorage.setItem(STORAGE_PREFIX + mapping.id, JSON.stringify(mapping)); return true; }
  catch { return false; }
}
export function removeMapping(id) {
  try { localStorage.removeItem(STORAGE_PREFIX + id); return true; } catch { return false; }
}

// The binds a controller should use now: a saved custom map wins; else the
// standard defaults if the browser recognizes the layout; else null (unmapped).
export function bindsFor(gp) {
  const saved = loadMapping(gp.id);
  if (saved) return saved.binds;
  if (gp.mapping === "standard" || gp.mapping === "xbox") return STANDARD_BINDS;
  return null;
}

export function srcActive(gp, src) {
  if (!src) return false;
  if (src.kind === "button") {
    const b = gp.buttons[src.index];
    return !!b && (b.pressed || b.value > BUTTON_ON);
  }
  const v = gp.axes[src.index] ?? 0;
  return src.dir > 0 ? v > AXIS_ON : v < -AXIS_ON;
}

/**
 * Poll every connected gamepad and OR their inputs into one RetroPad state.
 * Left stick doubles as the d-pad for standard pads. Returns the filled array.
 */
export function pollGamepads(out = new Uint8Array(16)) {
  out.fill(0);
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) {
    if (!gp) continue;
    const binds = bindsFor(gp);
    if (!binds) continue;   // unmapped: contributes nothing until mapped
    for (const inp of GBA_INPUTS) if (srcActive(gp, binds[inp.key])) out[inp.pad] = 1;
    // standard pads: left analog stick also drives the d-pad
    if (binds === STANDARD_BINDS) {
      const ax = gp.axes[0] ?? 0, ay = gp.axes[1] ?? 0;
      if (ax < -AXIS_ON) out[PAD.LEFT] = 1;
      if (ax > AXIS_ON) out[PAD.RIGHT] = 1;
      if (ay < -AXIS_ON) out[PAD.UP] = 1;
      if (ay > AXIS_ON) out[PAD.DOWN] = 1;
    }
  }
  return out;
}

/** A connected pad, or null. */
export function firstConnected() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) if (gp) return gp;
  return null;
}

/** A connected pad with no usable binds (non-standard, unsaved), or null. */
export function firstUnmapped() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) if (gp && !bindsFor(gp)) return gp;
  return null;
}
