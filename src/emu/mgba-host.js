// mgba-host.js — the GBA binding for the shared browser presenter.
//
// The libretro wiring + canvas/audio/input presentation now live in
// luacretro-web's WebHost (over romdev-core-host). What remains here is the
// genuinely GBA-specific part: which core to fetch, and the button maps.
//
// gbalua btn(n) -> RetroPad id:
//   0 LEFT 1 RIGHT 2 UP 3 DOWN  4 A  5 B  6 L  7 R  8 START  9 SELECT

import { WebHost, PAD } from "luacretro-web/emu";

export { PAD };

const CORE_BASE = "/gba/wasm";

// gbalua button index -> RetroPad id (mgba maps GBA A<-RetroPad A, B<-B, L<-L, R<-R)
export const GBA_BTN = [PAD.LEFT, PAD.RIGHT, PAD.UP, PAD.DOWN, PAD.A, PAD.B, PAD.L, PAD.R, PAD.START, PAD.SELECT];

// default keyboard map: key -> RetroPad id
export const DEFAULT_KEYS = {
  ArrowUp: PAD.UP, ArrowDown: PAD.DOWN, ArrowLeft: PAD.LEFT, ArrowRight: PAD.RIGHT,
  KeyX: PAD.A, KeyZ: PAD.B, KeyA: PAD.L, KeyS: PAD.R,
  Enter: PAD.START, ShiftRight: PAD.SELECT, Backspace: PAD.SELECT,
};

/** A running GBA instance bound to a canvas. One host per loaded ROM. */
export class MgbaHost extends WebHost {
  constructor() {
    super({
      platform: "gba",
      coreGlueUrl: `${CORE_BASE}/mgba_libretro.js`,
      coreWasmUrl: `${CORE_BASE}/mgba_libretro.wasm`,
      buttonMap: GBA_BTN,
      keyMap: DEFAULT_KEYS,
      width: 240,          // native GBA resolution
      height: 160,
      fpsFallback: 59.727,
    });
  }
}
