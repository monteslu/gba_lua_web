// EmulatorPane — the mGBA canvas + controls. Owns the host lifecycle: a new
// ROM disposes the old host and boots a fresh one. Keyboard maps to the GBA
// pad while the screen has focus (so typing in the editor never steers the
// game); any standard-layout gamepad works with no setup. Exposes the running
// host upward (onHost) for the RAM debugger.
import { useEffect, useRef, useState, useCallback } from "react";
import { MgbaHost, DEFAULT_KEYS } from "./mgba-host.js";
import { pollGamepads, gamepadConnected } from "./gamepad.js";

export default function EmulatorPane({ rom, onHost }) {
  const canvasRef = useRef(null);
  const hostRef = useRef(null);
  const [status, setStatus] = useState("no ROM — build something");
  const [paused, setPaused] = useState(false);
  const [padSeen, setPadSeen] = useState(false);

  useEffect(() => {
    if (!rom) return;
    let cancelled = false;
    (async () => {
      setStatus("booting…");
      hostRef.current?.dispose();
      hostRef.current = null;
      onHost?.(null);
      try {
        const host = await new MgbaHost().load(rom);
        if (cancelled) { host.dispose(); return; }
        host.pollPads = (out) => { pollGamepads(out); };
        host.start(canvasRef.current);
        hostRef.current = host;
        onHost?.(host);
        setPaused(false);
        setStatus(`running — ${rom.length.toLocaleString()} bytes`);
      } catch (e) {
        setStatus(`emulator error: ${e.message}`);
      }
    })();
    return () => { cancelled = true; };
  }, [rom, onHost]);

  useEffect(() => () => { hostRef.current?.dispose(); onHost?.(null); }, [onHost]);

  // show the gamepad hint once one connects
  useEffect(() => {
    const check = () => setPadSeen(gamepadConnected());
    check();
    window.addEventListener("gamepadconnected", check);
    window.addEventListener("gamepaddisconnected", check);
    return () => {
      window.removeEventListener("gamepadconnected", check);
      window.removeEventListener("gamepaddisconnected", check);
    };
  }, []);

  const onKey = useCallback((down) => (e) => {
    const id = DEFAULT_KEYS[e.code];
    if (id === undefined || !hostRef.current) return;
    e.preventDefault();
    hostRef.current.setPad(id, down);
  }, []);

  const togglePause = () => {
    const h = hostRef.current;
    if (!h) return;
    if (h.isPaused()) { h.resume(); setPaused(false); }
    else { h.pause(); setPaused(true); }
  };

  return (
    <div className="emu-pane">
      <canvas
        ref={canvasRef}
        className="emu-screen"
        width={240}
        height={160}
        tabIndex={0}
        onKeyDown={onKey(true)}
        onKeyUp={onKey(false)}
        onClick={() => { hostRef.current?.unlockAudio(); canvasRef.current?.focus(); }}
      />
      <div className="emu-bar">
        <span className="emu-status">{status}</span>
        <span style={{ flex: 1 }} />
        <button onClick={togglePause} disabled={!hostRef.current}>{paused ? "resume" : "pause"}</button>
        <button onClick={() => hostRef.current?.reset()} disabled={!hostRef.current}>reset</button>
      </div>
      <div className="emu-help">
        click the screen for sound + keys · arrows = d-pad · X=A Z=B · A/S = L/R · Enter=Start · Shift=Select
        {padSeen ? " · 🎮 gamepad connected" : ""}
      </div>
    </div>
  );
}
