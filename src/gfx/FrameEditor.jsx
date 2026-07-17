// FrameEditor — animation preview over the sprite sheet. GBA animations are
// SPRITE-INDEX RANGES (the SDK's anim(slot, first, last, fps) cycles spr()
// indices), so this pane is a range picker + live preview + the ready-to-paste
// line, not a separate frame-table format.
import { useEffect, useRef, useState, useMemo } from "react";
import { colorParts } from "./sheet-model.js";

const CELL = 16;   // GBA sprites are 16x16 on the sheet grid

function drawCell(ctx, sheet, index, scale) {
  const cols = sheet.width >> 4;
  const sx = (index % cols) * CELL, sy = Math.floor(index / cols) * CELL;
  const id = ctx.createImageData(CELL, CELL);
  for (let y = 0; y < CELL; y++)
    for (let x = 0; x < CELL; x++) {
      const c = sheet.px[(sy + y) * sheet.width + (sx + x)];
      const o = (y * CELL + x) * 4;
      if (!c) {
        const v = ((x >> 2) + (y >> 2)) & 1 ? 44 : 32;
        id.data[o] = v; id.data[o + 1] = v; id.data[o + 2] = v + 4; id.data[o + 3] = 255;
      } else {
        const [r, g, b] = colorParts(c);
        id.data[o] = r; id.data[o + 1] = g; id.data[o + 2] = b; id.data[o + 3] = 255;
      }
    }
  // draw at 1x then let CSS scale (canvas is CELL px, style scales)
  ctx.putImageData(id, 0, 0);
}

export function FrameEditor({ sheet }) {
  const [first, setFirst] = useState(0);
  const [last, setLast] = useState(3);
  const [fps, setFps] = useState(8);
  const [mode, setMode] = useState("loop");   // loop | once | pingpong
  const [playing, setPlaying] = useState(true);
  const [frame, setFrame] = useState(0);
  const [copied, setCopied] = useState(false);
  const previewRef = useRef(null);
  const stripRef = useRef(null);

  const nCells = sheet ? (sheet.width >> 4) * (sheet.height >> 4) : 0;
  const lo = Math.max(0, Math.min(first, last));
  const hi = Math.min(nCells - 1, Math.max(first, last));
  const range = useMemo(() => {
    const arr = [];
    for (let i = lo; i <= hi; i++) arr.push(i);
    return arr;
  }, [lo, hi]);

  // the animation clock — mirrors the SDK's cycle modes
  useEffect(() => {
    if (!playing || !range.length) return;
    let i = 0, dir = 1;
    setFrame(range[0]);
    const t = setInterval(() => {
      if (mode === "loop") i = (i + 1) % range.length;
      else if (mode === "once") i = Math.min(i + 1, range.length - 1);
      else {   // pingpong
        i += dir;
        if (i >= range.length - 1) { i = range.length - 1; dir = -1; }
        else if (i <= 0) { i = 0; dir = 1; }
      }
      setFrame(range[i]);
    }, 1000 / Math.max(1, fps));
    return () => clearInterval(t);
  }, [playing, range, fps, mode]);

  // paint the big preview
  useEffect(() => {
    const cv = previewRef.current;
    if (!cv || !sheet) return;
    drawCell(cv.getContext("2d"), sheet, Math.min(frame, nCells - 1), 1);
  }, [frame, sheet, nCells]);

  const call = mode === "once" ? "anim_once" : mode === "pingpong" ? "anim_pingpong" : "anim";
  const snippet = `spr(${call}(0, ${lo}, ${hi}, ${fps}), x, y)`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard blocked */ }
  };

  if (!sheet) return <div className="frames-empty">add a sprite sheet first — animations cycle its 16×16 sprites</div>;

  return (
    <div className="frame-editor">
      <div className="frame-toolbar">
        <button className={"m-play " + (playing ? "on" : "")} onClick={() => setPlaying((p) => !p)}>
          {playing ? "❚❚ pause" : "▶ play"}
        </button>
        <label className="m-field">first <input type="number" min="0" max={nCells - 1} value={first} onChange={(e) => setFirst(+e.target.value | 0)} /></label>
        <label className="m-field">last <input type="number" min="0" max={nCells - 1} value={last} onChange={(e) => setLast(+e.target.value | 0)} /></label>
        <label className="m-field">fps <input type="number" min="1" max="60" value={fps} onChange={(e) => setFps(Math.max(1, +e.target.value | 0))} /></label>
        <select value={mode} onChange={(e) => setMode(e.target.value)} title="the SDK's three cycle modes">
          <option value="loop">loop (anim)</option>
          <option value="once">once (anim_once)</option>
          <option value="pingpong">pingpong (anim_pingpong)</option>
        </select>
      </div>

      <div className="frame-body">
        <div className="frame-preview-wrap">
          <canvas ref={previewRef} width={CELL} height={CELL} className="frame-preview" />
          <div className="frame-label">spr({frame})</div>
        </div>
        <div className="frame-strip" ref={stripRef}>
          {range.slice(0, 64).map((i) => (
            <button key={i} className={"frame-cell " + (i === frame ? "now" : "")}
              onClick={() => { setPlaying(false); setFrame(i); }} title={`spr(${i})`}>
              <canvas width={CELL} height={CELL} ref={(cv) => { if (cv) drawCell(cv.getContext("2d"), sheet, i, 1); }} />
              <span>{i}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="frame-usebar">
        <span className="music-usehint"><b>use in game:</b> <code>{snippet}</code></span>
        <button className="tb-btn" onClick={copy}>{copied ? "✓ copied" : "⧉ copy"}</button>
      </div>
      <div className="music-hint">
        pick a sprite range on the sheet (16×16 cells, spr(0) top-left) · anim() RETURNS the current
        frame each call — feed it straight to spr() · 32 slots, one per actor · anim_reset(slot) restarts,
        anim_done(slot) tells you a once-anim finished
      </div>
    </div>
  );
}
