// gamepad.js — the GBA binding for luacretro-web's shared gamepad layer.
//
// The polling, persistence and remap-capture logic live in the shared layer.
// What is genuinely GBA-specific is the 10-input table and the standard-pad
// defaults, both preserved here exactly as they were.
import { createGamepad } from "luacretro-web/input";
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

const gp = createGamepad({
  inputs: GBA_INPUTS,
  standardBinds: STANDARD_BINDS,
  storagePrefix: "gbalua-gamepad-map:",
});

export const {
  loadMapping, saveMapping, removeMapping,
  bindsFor, srcActive, pollGamepads,
  firstConnected, firstUnmapped,
} = gp;
