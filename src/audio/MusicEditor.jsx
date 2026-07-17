import { useEffect, useRef, useState, useCallback } from "react";
import {
  CHANNELS, MAX_STEPS, MAX_VEL, DEFAULT_VEL, NOTE, noteName,
  noteOf, velOf, makeCell, XM_INSTRUMENTS, songToXm,
} from "./xm-song.js";
import { PreviewSynth } from "./preview-synth.js";
import { Piano } from "./Piano.jsx";
import { downloadBytes } from "../util/download.js";

const CH_COLORS = ["#ff7ac6", "#57e2e5", "#ffd45e", "#b48cff"];

// Computer-keyboard -> note, the tracker/DAW layout (Renoise/FL/LMMS style):
// the Z row is the base octave, the Q row is one octave up. code -> semitone.
const KEY_SEMITONE = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7,
  KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11, Comma: 12, KeyL: 13, Period: 14, Semicolon: 15, Slash: 16,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19,
  Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23, KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28,
};

/**
 * Step tracker for a project song. The song is { steps, delay, velocity,
 * instruments, grid } (see xm-song.js); it serializes to a REAL .xm at build
 * time, so music(n) plays exactly what you composed (through Maxmod, not the
 * preview synth).
 */
export function MusicEditor({ song, songName, onChange }) {
  const model = song;
  const modelRef = useRef(model);
  modelRef.current = model;
  const preview = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [playRow, setPlayRow] = useState(-1);
  const [pitch, setPitch] = useState(NOTE["C4"]);
  const [baseOctave, setBaseOctave] = useState(4);
  const [cursor, setCursor] = useState({ step: 0, ch: 0 });
  const [vel, setVel] = useState(DEFAULT_VEL);
  const gridRef = useRef(null);
  const heldKeys = useRef(new Set());

  const scrollRowIntoView = useCallback((s) => {
    const grid = gridRef.current;
    if (!grid || s < 0) return;
    const row = grid.children[s];
    if (row?.scrollIntoView) row.scrollIntoView({ block: "nearest" });
  }, []);
  useEffect(() => { if (playRow >= 0) scrollRowIntoView(playRow); }, [playRow, scrollRowIntoView]);
  useEffect(() => { scrollRowIntoView(cursor.step); }, [cursor.step, scrollRowIntoView]);

  useEffect(() => {
    preview.current = new PreviewSynth();
    return () => preview.current?.dispose();
  }, []);

  useEffect(() => {
    setCursor((c) => (c.step < model.steps ? c : { ...c, step: model.steps - 1 }));
  }, [model.steps]);

  const setGrid = (step, ch, note, noteVel = vel) => {
    const grid = model.grid.map((row) => row.slice());
    grid[step][ch] = makeCell(note, noteVel, model.velocity);
    onChange({ ...model, grid });
  };

  const setCellVel = (v) => {
    const cur = model.grid[cursor.step]?.[cursor.ch];
    const n = noteOf(cur);
    if (!n) return;
    const grid = model.grid.map((row) => row.slice());
    grid[cursor.step][cursor.ch] = makeCell(n, v, true);
    onChange({ ...model, velocity: true, grid });
  };

  const previewNote = useCallback((note, v = vel) => {
    if (!playing) preview.current?.playNote(model.instruments[cursor.ch] ?? 1, note, 0.35, v);
  }, [playing, model.instruments, cursor.ch, vel]);

  // tracker-style keyboard entry (see gt web IDE — same layout)
  useEffect(() => {
    const editing = () => {
      const el = document.activeElement;
      if (!el) return false;
      if (el.closest && el.closest(".emu-screen")) return true;
      return el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.isContentEditable;
    };
    const onDown = (e) => {
      if (editing() || e.ctrlKey || e.metaKey || e.altKey) return;
      const steps = model.steps;
      if (e.code === "BracketLeft") { setBaseOctave((o) => Math.max(1, o - 1)); e.preventDefault(); return; }
      if (e.code === "BracketRight") { setBaseOctave((o) => Math.min(6, o + 1)); e.preventDefault(); return; }
      if (e.code === "ArrowUp") { setCursor((c) => ({ ...c, step: (c.step - 1 + steps) % steps })); e.preventDefault(); return; }
      if (e.code === "ArrowDown") { setCursor((c) => ({ ...c, step: (c.step + 1) % steps })); e.preventDefault(); return; }
      if (e.code === "ArrowLeft") { setCursor((c) => ({ ...c, ch: (c.ch - 1 + CHANNELS) % CHANNELS })); e.preventDefault(); return; }
      if (e.code === "ArrowRight") { setCursor((c) => ({ ...c, ch: (c.ch + 1) % CHANNELS })); e.preventDefault(); return; }
      if (e.code === "Delete" || e.code === "Backspace") {
        setGrid(cursor.step, cursor.ch, 0);
        setCursor((c) => ({ ...c, step: (c.step + 1) % steps }));
        e.preventDefault(); return;
      }
      const semi = KEY_SEMITONE[e.code];
      if (semi === undefined) return;
      if (heldKeys.current.has(e.code)) { e.preventDefault(); return; }
      heldKeys.current.add(e.code);
      const note = NOTE["C" + baseOctave] + semi;
      if (note >= 1 && note <= 96) {
        setPitch(note);
        setGrid(cursor.step, cursor.ch, note);
        previewNote(note);
        setCursor((c) => ({ ...c, step: (c.step + 1) % steps }));
      }
      e.preventDefault();
    };
    const onUp = (e) => { heldKeys.current.delete(e.code); };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => { window.removeEventListener("keydown", onDown); window.removeEventListener("keyup", onUp); heldKeys.current.clear(); };
  }, [baseOctave, previewNote, cursor, model]);

  const setInstrument = (ch, id) => {
    const instruments = model.instruments.slice();
    instruments[ch] = id;
    onChange({ ...model, instruments });
  };
  const setSteps = (steps) => {
    steps = Math.max(4, Math.min(MAX_STEPS, steps | 0));
    const grid = [];
    for (let i = 0; i < steps; i++) grid.push(model.grid[i] ? model.grid[i].slice() : [0, 0, 0, 0]);
    onChange({ ...model, steps, grid });
  };
  const setDelay = (delay) => onChange({ ...model, delay: Math.max(2, Math.min(60, delay | 0)) });

  const exportXm = () => downloadBytes(`${songName || "song"}.xm`, songToXm(model, songName), "application/octet-stream");

  // LOOK-AHEAD playback: all note timing rides the AudioContext clock (never
  // setTimeout), which is what kills the choppiness. A fast poll schedules any
  // steps landing inside the look-ahead window; the playhead highlight is fired
  // by a per-step timer aligned to each step's scheduled audio time. Reads the
  // CURRENT model each step, so edits + tempo changes take effect on the fly.
  const playRunning = useRef(false);
  const pollTimer = useRef(0);
  const LOOKAHEAD = 0.12;   // schedule up to 120ms ahead
  const play = useCallback(() => {
    if (playRunning.current) return;
    const synth = preview.current;
    if (!synth) return;
    synth.ensure();
    playRunning.current = true;
    setPlaying(true);
    let row = 0;
    let nextTime = synth.now() + 0.06;   // small lead-in
    const poll = () => {
      if (!playRunning.current) return;
      const m = modelRef.current;
      const steps = Math.max(1, m.steps);
      const stepSec = m.delay / 60;
      while (nextTime < synth.now() + LOOKAHEAD) {
        if (row >= steps) row = 0;
        synth.scheduleStep(m.grid[row] || [], m.instruments, nextTime, Math.max(0.05, stepSec * 0.92));
        // move the playhead exactly when this step is heard
        const hlRow = row;
        const delayMs = Math.max(0, (nextTime - synth.now()) * 1000);
        setTimeout(() => { if (playRunning.current) setPlayRow(hlRow); }, delayMs);
        nextTime += stepSec;
        row++;
      }
      pollTimer.current = setTimeout(poll, 25);
    };
    poll();
  }, []);
  const stop = useCallback(() => {
    playRunning.current = false;
    clearTimeout(pollTimer.current);
    setPlaying(false); setPlayRow(-1);
  }, []);
  useEffect(() => () => { playRunning.current = false; clearTimeout(pollTimer.current); }, []);

  return (
    <div className="music-editor">
      <div className="music-toolbar">
        <button className={"m-play " + (playing ? "on" : "")} onClick={playing ? stop : play}>
          {playing ? "❚❚ stop" : "▶ preview"}
        </button>
        <label className="m-field" title="how long each step lasts, in 60 Hz frames. Fewer = faster.">
          step (frames)
          <input type="number" min="2" max="60" value={model.delay} onChange={(e) => setDelay(+e.target.value)} />
          <span className="m-rate">≈ {(60 / model.delay).toFixed(1)}/s</span>
        </label>
        <label className="m-field">steps
          <input type="number" min="4" max={MAX_STEPS} value={model.steps} onChange={(e) => setSteps(+e.target.value)} />
        </label>
        <span className="tb-sep" />
        <button className="tb-btn" onClick={exportXm} title="export as a standard FastTracker .xm (opens in OpenMPT/MilkyTracker)">.xm ▴</button>
      </div>

      <div className="music-piano-bar">
        <div className="mpb-info">
          <span className="mpb-label">note <b>{noteName(pitch)}</b></span>
          <label className="mpb-vel" title="per-note velocity (loudness, 1-64)">
            <input type="checkbox" checked={!!model.velocity}
              onChange={(e) => onChange({ ...model, velocity: e.target.checked })} />
            velocity
            <input type="range" min="1" max={MAX_VEL} value={vel} disabled={!model.velocity}
              onChange={(e) => { const v = +e.target.value; setVel(v); if (model.velocity) setCellVel(v); }} />
            <b>{model.velocity ? vel : "—"}</b>
          </label>
          <span className="mpb-kbd">keyboard: Z/S/X… = oct {baseOctave} · Q/2/W… = oct {baseOctave + 1} · [ ] octave</span>
        </div>
        <Piano value={pitch} onChange={setPitch} onPreview={(n) => previewNote(n, vel)} baseOctave={baseOctave} />
      </div>

      <div className="music-heads">
        <div className="mh-step">#</div>
        {model.instruments.map((inst, ch) => (
          <div key={ch} className="mh-chan" style={{ borderColor: CH_COLORS[ch] }}>
            <span className="mh-dot" style={{ background: CH_COLORS[ch] }} />
            <select value={inst} onChange={(e) => setInstrument(ch, +e.target.value)}>
              {XM_INSTRUMENTS.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
            </select>
          </div>
        ))}
      </div>

      <div className="music-grid" ref={gridRef}>
        {model.grid.slice(0, model.steps).map((row, s) => (
          <div key={s} className={"mg-row " + (s === playRow ? "playhead" : "") + (s % 4 === 0 ? " beat" : "")}>
            <div className="mg-step">{s}</div>
            {row.map((cell, ch) => {
              const note = noteOf(cell);
              const v = velOf(cell);
              const intensity = model.velocity ? 0.35 + 0.65 * (v / MAX_VEL) : 1;
              return (
                <button key={ch}
                  className={"mg-cell " + (note ? "on" : "") + (cursor.step === s && cursor.ch === ch ? " cursor" : "")}
                  style={note ? { background: CH_COLORS[ch], color: "#1a1726", opacity: intensity } : undefined}
                  onClick={() => { setCursor({ step: s, ch }); setGrid(s, ch, note ? 0 : pitch); }}
                  onContextMenu={(e) => { e.preventDefault(); setCursor({ step: s, ch }); setGrid(s, ch, 0); }}
                  title={note ? `${noteName(note)}${model.velocity ? ` · vel ${v}` : ""} (click to clear)` : "click to place " + noteName(pitch)}>
                  {note ? noteName(note) : "·"}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="music-hint">
        click a cell to place · type notes (Z/Q rows) to fill from the cursor · arrows move · Del clears ·
        4 channels · the preview is an approximation — Play the game to hear the real Maxmod mix
      </div>
    </div>
  );
}
