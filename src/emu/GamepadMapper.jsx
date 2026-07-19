// GamepadMapper — the shared prompt-style remap dialog, bound to the GBA input
// table.
import { GamepadMapper as SharedMapper } from "luacretro-web/input";
import { GBA_INPUTS, saveMapping } from "./gamepad.js";

export function GamepadMapper({ gamepad, onDone, onClose }) {
  return (
    <SharedMapper
      gamepad={gamepad}
      inputs={GBA_INPUTS}
      saveMapping={saveMapping}
      onDone={onDone}
      onClose={onClose}
      doneLabel="all 10 inputs mapped"
    />
  );
}
