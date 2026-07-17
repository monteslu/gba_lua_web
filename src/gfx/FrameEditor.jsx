// FrameEditor — animation preview over the sprite sheet. GBA animations are
// SPRITE-INDEX RANGES (the SDK's anim(slot, first, last, fps) cycles spr()
// indices), so this pane is a range picker + live preview + the ready-to-paste
// line, not a separate frame-table format.
//
// Starts PAUSED — opening the tab must never auto-animate. You pick the range
// by clicking sprites in the strip (click = first, shift-click = last), then
// press play to preview.
import { useEffect, useRef, useState, useMemo } from "react";
import { colorParts } from "./sheet-model.js";

const CELL = 16;   // GBA sprites are 16x16 on the sheet grid

function drawCell(ctx, sheet, index) {
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
  ctx.putImageData(id, 0, 0);
}

export function FrameEditor({ sheet }) {
  const nCells = sheet ? (sheet.width >> 4) * (sheet.height >> 4) : 0;
  const [first, setFirst] = useState(0);
  const [last, setLast] = useState(Math.min(1, Math.max(0, nCells - 1)));
  const [fps, setFps] = useState(8);
  const [mode, setMode] = useState("loop");   // loop | once | pingpong
  const [playing, setPlaying] = useState(false);   // ← never auto-play on open
  const [frame, setFrame] = useState(0);
  const [copied, setCopied] = useState(false);
  // affine (sprr) preview: rotate/scale the current sprite — GBA hardware OBJ
  // affine, which the GameTank has no equivalent of
  const [affine, setAffine] = useState(false);
  const [angle, setAngle] = useState(0);
  const [scale, setScale] = useState(1);
  const previewRef = useRef(null);

  const lo = Math.max(0, Math.min(first, last));
  const hi = Math.min(nCells - 1, Math.max(first, last));
  const range = useMemo(() => {
    const arr = [];
    for (let i = lo; i <= hi; i++) arr.push(i);
    return arr;
  }, [lo, hi]);

  // stopping playback rests the preview on the FIRST frame of the range, so a
  // paused pane always shows a stable, meaningful sprite (not a random one)
  useEffect(() => { if (!playing) setFrame(lo); }, [playing, lo]);

  // the animation clock — mirrors the SDK's cycle modes; only runs when playing
  useEffect(() => {
    if (!playing || range.length < 2) return;
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

  // paint the big preview — affine mode always shows the range-start sprite
  // (the one sprr() would transform); otherwise the current animation frame
  useEffect(() => {
    const cv = previewRef.current;
    if (!cv || !sheet) return;
    drawCell(cv.getContext("2d"), sheet, Math.min(affine ? lo : frame, nCells - 1));
  }, [frame, sheet, nCells, affine, lo]);

  // clicking a sprite sets the range: plain click = new single-frame start,
  // shift/ctrl click = extend the range to that sprite
  const pickCell = (i, extend) => {
    setPlaying(false);
    if (extend) { setLast(i); }
    else { setFirst(i); setLast(i); }
    setFrame(i);
  };

  const call = mode === "once" ? "anim_once" : mode === "pingpong" ? "anim_pingpong" : "anim";
  const snippet = affine
    ? `sprr(${lo}, x, y, ${angle.toFixed(3)}${scale !== 1 ? `, ${scale.toFixed(2)}` : ""})`
    : `spr(${call}(0, ${lo}, ${hi}, ${fps}), x, y)`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard blocked */ }
  };

  if (!sheet) return <div className="frames-empty">add a sprite sheet first — animations cycle its 16×16 sprites</div>;

  const canPlay = range.length >= 2;

  return (
    <div className="frame-editor">
      <div className="frame-toolbar">
        <button className={"m-play " + (playing ? "on" : "")} disabled={!canPlay}
          onClick={() => setPlaying((p) => !p)}
          title={canPlay ? "" : "pick a range of 2+ sprites to animate"}>
          {playing ? "❚❚ pause" : "▶ play"}
        </button>
        <label className="m-field">first <input type="number" min="0" max={nCells - 1} value={first} onChange={(e) => { setPlaying(false); setFirst(Math.max(0, Math.min(nCells - 1, +e.target.value | 0))); }} /></label>
        <label className="m-field">last <input type="number" min="0" max={nCells - 1} value={last} onChange={(e) => { setPlaying(false); setLast(Math.max(0, Math.min(nCells - 1, +e.target.value | 0))); }} /></label>
        <label className="m-field">fps <input type="number" min="1" max="60" value={fps} onChange={(e) => setFps(Math.max(1, +e.target.value | 0))} /></label>
        <select value={mode} onChange={(e) => setMode(e.target.value)} title="the SDK's three cycle modes" disabled={affine}>
          <option value="loop">loop (anim)</option>
          <option value="once">once (anim_once)</option>
          <option value="pingpong">pingpong (anim_pingpong)</option>
        </select>
        <span className="tb-sep" />
        <label className="fx-check" title="preview a hardware affine sprite (sprr): rotate + scale">
          <input type="checkbox" checked={affine} onChange={(e) => { setAffine(e.target.checked); if (e.target.checked) setPlaying(false); }} /> affine (sprr)
        </label>
        <span className="frame-count dim">{nCells} sprites</span>
      </div>
      {affine && (
        <div className="frame-toolbar frame-affine-bar">
          <label className="m-field">angle <input type="range" min="-3.14159" max="3.14159" step="0.02" value={angle} onChange={(e) => setAngle(+e.target.value)} /><b>{Math.round(angle * 180 / Math.PI)}°</b></label>
          <label className="m-field">scale <input type="range" min="0.25" max="3" step="0.05" value={scale} onChange={(e) => setScale(+e.target.value)} /><b>{scale.toFixed(2)}×</b></label>
        </div>
      )}

      <div className="frame-body">
        <div className="frame-preview-wrap">
          <canvas ref={previewRef} width={CELL} height={CELL} className="frame-preview"
            style={affine ? { transform: `rotate(${-angle}rad) scale(${scale})` } : undefined} />
          <div className="frame-label">{affine ? `sprr spr(${lo})` : playing ? `spr(${frame})` : `range ${lo}–${hi}`}</div>
        </div>
        <div className="frame-strip">
          {Array.from({ length: Math.min(nCells, 256) }, (_, i) => {
            const inRange = i >= lo && i <= hi;
            return (
              <button key={i}
                className={"frame-cell " + (playing && i === frame ? "now" : "") + (inRange ? " inrange" : "")}
                onClick={(e) => pickCell(i, e.shiftKey || e.ctrlKey || e.metaKey)}
                title={`spr(${i}) · click = start, shift-click = end`}>
                <canvas width={CELL} height={CELL} ref={(cv) => { if (cv) drawCell(cv.getContext("2d"), sheet, i); }} />
                <span>{i}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="frame-usebar">
        <span className="music-usehint"><b>use in game:</b> <code>{snippet}</code></span>
        <button className="tb-btn" onClick={copy}>{copied ? "✓ copied" : "⧉ copy"}</button>
      </div>
      <div className="music-hint">
        click a sprite to set the range start · shift-click another to set the end · press play to preview ·
        anim() RETURNS the current frame each call — feed it straight to spr() · 32 slots, anim_reset(slot) restarts
      </div>
    </div>
  );
}
