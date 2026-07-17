// EmulatorPane — the mGBA canvas + controls. Owns the host lifecycle: a new
// ROM disposes the old host and boots a fresh one. Keyboard maps to the GBA
// pad while the screen has focus; standard-layout gamepads work with no setup,
// and a mapper handles anything else. A building overlay with a real progress
// bar sits on top of the (still-running) previous game. Exposes the running
// host upward (onHost) for the RAM debugger.
import { useEffect, useRef, useState, useCallback } from "react";
import { MgbaHost, DEFAULT_KEYS } from "./mgba-host.js";
import { pollGamepads, firstConnected, firstUnmapped, bindsFor } from "./gamepad.js";
import { GamepadMapper } from "./GamepadMapper.jsx";

export default function EmulatorPane({ rom, onHost, building, progress }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const hostRef = useRef(null);
  const [status, setStatus] = useState("no ROM");
  const [paused, setPaused] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pad, setPad] = useState(null);        // { connected, needsMap } | null
  const [mapping, setMapping] = useState(null);  // the Gamepad being remapped

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

  // gamepad presence: poll connection state + whether the pad needs mapping
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const gp = firstConnected();
      setPad(gp ? { connected: true, needsMap: !bindsFor(gp) } : null);
      raf = requestAnimationFrame(() => setTimeout(tick, 500));
    };
    tick();
    return () => cancelAnimationFrame(raf);
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

  const goFullscreen = () => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) { document.exitFullscreen?.(); return; }
    (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
    hostRef.current?.unlockAudio();
    canvasRef.current?.focus();
  };

  const select = () => { hostRef.current?.unlockAudio(); canvasRef.current?.focus(); };
  const openMapper = () => { const gp = firstUnmapped() || firstConnected(); if (gp) setMapping(gp); };

  return (
    <div className="emu-pane">
      <div className="emu-screen-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="emu-screen"
          width={240}
          height={160}
          tabIndex={0}
          onKeyDown={onKey(true)}
          onKeyUp={onKey(false)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onClick={select}
        />

        {/* building overlay sits ON TOP of the still-running previous game */}
        {building && (
          <div className="emu-overlay building">
            <span className="emu-ov-label">{progress?.label ?? "building…"}</span>
            <div className="emu-bar"><div className="emu-fill" style={{ width: `${Math.round((progress?.frac ?? 0) * 100)}%` }} /></div>
          </div>
        )}
        {/* click-to-play/select prompt when the game is up but not focused */}
        {!building && hostRef.current && !focused && (
          <div className="emu-overlay hint" onClick={select}>
            <span>click to play</span>
          </div>
        )}
        {!building && !hostRef.current && !rom && (
          <div className="emu-overlay idle"><span>▶ Play to build & run</span></div>
        )}

        <button className="emu-fs" onClick={goFullscreen} title="fullscreen (grabs the controls)" aria-label="fullscreen">⛶</button>
      </div>

      <div className="emu-bar-row">
        <span className="emu-status">{status}</span>
        {pad?.connected && (
          <button className={"emu-pad " + (pad.needsMap ? "unmapped" : "")}
            onClick={openMapper}
            title={pad.needsMap ? "controller needs mapping — click to map" : "controller connected — click to remap"}>
            🎮{pad.needsMap ? " map" : ""}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button onClick={togglePause} disabled={!hostRef.current}>{paused ? "resume" : "pause"}</button>
        <button onClick={() => hostRef.current?.reset()} disabled={!hostRef.current}>reset</button>
      </div>
      <div className="emu-help">
        arrows = d-pad · X=A Z=B · A/S = L/R · Enter=Start · Shift=Select · gamepad supported
      </div>

      {mapping && (
        <GamepadMapper
          gamepad={mapping}
          onDone={() => setMapping(null)}
          onClose={() => setMapping(null)}
        />
      )}
    </div>
  );
}
