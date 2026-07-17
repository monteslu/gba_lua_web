import { useEffect, useRef, useState } from "react";
import { GBA_INPUTS, saveMapping } from "./gamepad.js";

// Walk the 10 GBA inputs one at a time: prompt, wait for the pad to settle,
// then capture the first button or axis that moves. Thresholds match
// gamepad.js so what you bind is what fires in-game.
const BUTTON_ON = 0.5;
const AXIS_ON = 0.5;
const SETTLE = 0.35;

const snapshot = (gp) => ({ buttons: Array.from(gp.buttons, (b) => b.value), axes: Array.from(gp.axes) });

export function GamepadMapper({ gamepad, onDone, onClose }) {
  const [step, setStep] = useState(0);
  const [settling, setSettling] = useState(false);
  const bindsRef = useRef({});
  const restRef = useRef(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const gpNow = () => (navigator.getGamepads ? navigator.getGamepads()[gamepad.index] : null);
    restRef.current = snapshot(gpNow() || gamepad);

    const isSettled = (gp) => {
      const rest = restRef.current;
      for (let i = 0; i < gp.buttons.length; i++) if (gp.buttons[i].value > BUTTON_ON) return false;
      for (let i = 0; i < gp.axes.length; i++) if (Math.abs(gp.axes[i] - (rest.axes[i] ?? 0)) > SETTLE) return false;
      return true;
    };
    const detect = (gp) => {
      const rest = restRef.current;
      for (let i = 0; i < gp.buttons.length; i++) {
        if ((rest.buttons[i] ?? 0) < BUTTON_ON && gp.buttons[i].value >= BUTTON_ON) return { kind: "button", index: i };
      }
      for (let i = 0; i < gp.axes.length; i++) {
        const d = gp.axes[i] - (rest.axes[i] ?? 0);
        if (Math.abs(d) > AXIS_ON) return { kind: "axis", index: i, dir: d > 0 ? 1 : -1 };
      }
      return null;
    };

    let stepLocal = 0, settleLocal = false;
    const loop = () => {
      const gp = gpNow();
      if (gp && stepLocal < GBA_INPUTS.length) {
        if (settleLocal) {
          if (isSettled(gp)) { settleLocal = false; setSettling(false); restRef.current = snapshot(gp); }
        } else {
          const src = detect(gp);
          if (src) {
            bindsRef.current[GBA_INPUTS[stepLocal].key] = src;
            stepLocal += 1; settleLocal = true;
            setStep(stepLocal); setSettling(true);
            restRef.current = snapshot(gp);
          }
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [gamepad, onClose]);

  const done = step >= GBA_INPUTS.length;
  const cur = GBA_INPUTS[step];

  const finish = () => {
    const mapping = { id: gamepad.id, binds: bindsRef.current };
    saveMapping(mapping);
    onDone(mapping.binds);
  };

  return (
    <div className="modal-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mapper-box">
        <div className="mapper-head">
          <span className="newproj-title">Map controller</span>
          <button className="newproj-close" onClick={onClose} aria-label="close">×</button>
        </div>
        <p className="mapper-id">{gamepad.id}</p>
        {!done ? (
          <div className="mapper-prompt">
            {settling
              ? <span className="dim">release…</span>
              : <>press the button for <b className="mapper-input">{cur.label}</b></>}
            <div className="mapper-progress">{step} / {GBA_INPUTS.length}</div>
          </div>
        ) : (
          <div className="mapper-prompt">
            <span className="ok-text">all 10 inputs mapped ✓</span>
          </div>
        )}
        <div className="mapper-actions">
          {done && <button className="newproj-clone" onClick={finish}>Save mapping</button>}
          <button onClick={() => { setStep(0); bindsRef.current = {}; }}>restart</button>
        </div>
      </div>
    </div>
  );
}
