// EmulatorPane — the mGBA canvas + controls. Owns the host lifecycle: a new
// ROM disposes the old host and boots a fresh one. Keyboard input maps to the
// GBA pad while the pane has focus (so typing in the editor never steers the
// game).
import { useEffect, useRef, useState, useCallback } from "react";
import { MgbaHost, DEFAULT_KEYS } from "./mgba-host.js";

export default function EmulatorPane({ rom }) {
  const canvasRef = useRef(null);
  const hostRef = useRef(null);
  const [status, setStatus] = useState("no ROM — build something");
  const [paused, setPaused] = useState(false);

  // boot a new host whenever a fresh ROM arrives
  useEffect(() => {
    if (!rom) return;
    let cancelled = false;
    (async () => {
      setStatus("booting…");
      hostRef.current?.dispose();
      hostRef.current = null;
      try {
        const host = await new MgbaHost().load(rom);
        if (cancelled) { host.dispose(); return; }
        host.start(canvasRef.current);
        hostRef.current = host;
        setPaused(false);
        setStatus(`running — ${rom.length.toLocaleString()} bytes`);
      } catch (e) {
        setStatus(`emulator error: ${e.message}`);
      }
    })();
    return () => { cancelled = true; };
  }, [rom]);

  useEffect(() => () => hostRef.current?.dispose(), []);

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
        width={240}
        height={160}
        tabIndex={0}
        onKeyDown={onKey(true)}
        onKeyUp={onKey(false)}
        onClick={() => { hostRef.current?.unlockAudio(); canvasRef.current?.focus(); }}
        style={{ width: "100%", imageRendering: "pixelated", background: "#000", outline: "none", borderRadius: 4 }}
      />
      <div className="emu-bar">
        <span className="emu-status">{status}</span>
        <span style={{ flex: 1 }} />
        <button onClick={togglePause} disabled={!hostRef.current}>{paused ? "resume" : "pause"}</button>
        <button onClick={() => hostRef.current?.reset()} disabled={!hostRef.current}>reset</button>
      </div>
      <div className="emu-help">
        click the screen for sound + keys · arrows = d-pad · X=A Z=B · A/S = L/R · Enter=Start · Shift=Select
      </div>
    </div>
  );
}
