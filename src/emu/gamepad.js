// gamepad.js - Gamepad API -> GBA pad. A "standard"-layout controller
// (Xbox/PS — mapping === "standard") works with no setup; the d-pad, face
// buttons, shoulders, start/select map to the GBA's 10 inputs.
import { PAD } from "./mgba-host.js";

const BUTTON_ON = 0.5;
const AXIS_ON = 0.5;

// standard-layout binds: browser button index -> RetroPad id
const STANDARD = [
  [12, PAD.UP], [13, PAD.DOWN], [14, PAD.LEFT], [15, PAD.RIGHT],
  [1, PAD.A],    // east face (Circle/B position) -> GBA A
  [0, PAD.B],    // south face (Cross/A position) -> GBA B
  [4, PAD.L], [5, PAD.R],
  [9, PAD.START], [8, PAD.SELECT],
];

/**
 * Poll every connected gamepad and OR their inputs into one RetroPad state.
 * Returns a Uint8Array(16) indexed by RetroPad id (also treats the left
 * stick as the d-pad).
 */
export function pollGamepads(out = new Uint8Array(16)) {
  out.fill(0);
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) {
    if (!gp || (gp.mapping !== "standard" && gp.mapping !== "xbox")) continue;
    for (const [idx, pad] of STANDARD) {
      const b = gp.buttons[idx];
      if (b && (b.pressed || b.value > BUTTON_ON)) out[pad] = 1;
    }
    const ax = gp.axes[0] ?? 0, ay = gp.axes[1] ?? 0;
    if (ax < -AXIS_ON) out[PAD.LEFT] = 1;
    if (ax > AXIS_ON) out[PAD.RIGHT] = 1;
    if (ay < -AXIS_ON) out[PAD.UP] = 1;
    if (ay > AXIS_ON) out[PAD.DOWN] = 1;
  }
  return out;
}

/** Any standard-layout gamepad connected? (for the hint line) */
export function gamepadConnected() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) if (gp && (gp.mapping === "standard" || gp.mapping === "xbox")) return true;
  return false;
}
