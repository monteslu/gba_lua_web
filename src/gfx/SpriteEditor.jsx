import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  MAX_COLORS, TRANSPARENT, getPixel, setPixel, cloneSheet, newSheet,
  sheetFromPng, sheetToPng, sheetFromAse, paletteOf, enforcePalette,
  colorHex, hexColor, colorParts,
} from "./sheet-model.js";
import { pickFile, downloadBytes } from "../util/download.js";

// drawing tools: id -> label + tooltip
const TOOLS = [
  { id: "pencil", label: "✏", tip: "Pencil" },
  { id: "eraser", label: "◻", tip: "Eraser (paint transparent)" },
  { id: "fill", label: "🪣", tip: "Fill (flood the same-color region; a selection fences it)" },
  { id: "line", label: "╱", tip: "Line" },
  { id: "rect", label: "▭", tip: "Rectangle (outline)" },
  { id: "dropper", label: "💧", tip: "Eyedropper (pick a color from the sheet)" },
  { id: "select", label: "⬚", tip: "Select (drag a box; Ctrl+C copy, Ctrl+X cut, Ctrl+V paste, Del clears)" },
];

// Paint the sheet into an ImageData (transparent -> checkerboard so it reads
// as "no pixel", matching how the hardware skips palette index 0).
function drawSheet(ctx, img) {
  const id = ctx.createImageData(img.width, img.height);
  const d = id.data;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const c = img.px[y * img.width + x];
      const o = (y * img.width + x) * 4;
      if (!c) {
        const v = ((x >> 2) + (y >> 2)) & 1 ? 44 : 32;
        d[o] = v; d[o + 1] = v; d[o + 2] = v + 4; d[o + 3] = 255;
      } else {
        const [r, g, b] = colorParts(c);
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
      }
    }
  }
  ctx.putImageData(id, 0, 0);
}

// guide overlay: 8px minor grid + 16px sprite-cell grid (spr(n) cells).
function drawGuides(ctx, img, zoom, showCells) {
  const w = img.width * zoom, h = img.height * zoom;
  ctx.clearRect(0, 0, w, h);
  if (!showCells) return;
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 8; x < img.width; x += 8) { const p = x * zoom + 0.5; ctx.moveTo(p, 0); ctx.lineTo(p, h); }
  for (let y = 8; y < img.height; y += 8) { const p = y * zoom + 0.5; ctx.moveTo(0, p); ctx.lineTo(w, p); }
  ctx.stroke();
  ctx.strokeStyle = "rgba(120,200,255,0.4)";
  ctx.beginPath();
  for (let x = 16; x < img.width; x += 16) { const p = x * zoom + 0.5; ctx.moveTo(p, 0); ctx.lineTo(p, h); }
  for (let y = 16; y < img.height; y += 16) { const p = y * zoom + 0.5; ctx.moveTo(0, p); ctx.lineTo(w, p); }
  ctx.stroke();
}

// spr(n) index for a pixel: sprites are 16x16, numbered left-to-right,
// top-to-bottom across the sheet.
const cellAt = (img, x, y) => (y >> 4) * (img.width >> 4) + (x >> 4);

/**
 * The GBA sprite-sheet editor. `sheet` is the {width,height,px} model;
 * onChange fires with a NEW model after each edit (immutable so React and
 * autosave see it). Palette: 15 opaque colors + transparent (4bpp).
 */
export function SpriteEditor({ sheet, onChange }) {
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const rootRef = useRef(null);
  const [zoom, setZoom] = useState(4);
  const [tool, setTool] = useState("pencil");
  const [color, setColor] = useState(0xffffffff >>> 0);
  const [showGrid, setShowGrid] = useState(true);
  const [hover, setHover] = useState(null);
  const [msg, setMsg] = useState("");
  const drawing = useRef(null);

  const [sel, setSel] = useState(null);          // { x0, y0, x1, y1 }
  const [clip, setClip] = useState(null);        // { w, h, data: Uint32Array }
  const [pasting, setPasting] = useState(null);  // { x, y } ghost anchor
  const clipCanvas = useRef(null);

  const palette = useMemo(() => (sheet ? paletteOf(sheet) : []), [sheet]);
  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(""), 4000); };

  // undo/redo: whole-edit snapshots
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const [histLen, setHistLen] = useState({ u: 0, r: 0 });
  const snapshot = useCallback(() => {
    undoStack.current.push(cloneSheet(sheet));
    if (undoStack.current.length > 40) undoStack.current.shift();
    redoStack.current.length = 0;
    setHistLen({ u: undoStack.current.length, r: 0 });
  }, [sheet]);
  const undo = useCallback(() => {
    if (!undoStack.current.length) return;
    redoStack.current.push(cloneSheet(sheet));
    onChange(undoStack.current.pop());
    setHistLen({ u: undoStack.current.length, r: redoStack.current.length });
  }, [sheet, onChange]);
  const redo = useCallback(() => {
    if (!redoStack.current.length) return;
    undoStack.current.push(cloneSheet(sheet));
    onChange(redoStack.current.pop());
    setHistLen({ u: undoStack.current.length, r: redoStack.current.length });
  }, [sheet, onChange]);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx && sheet) drawSheet(ctx, sheet);
  }, [sheet]);

  useEffect(() => {
    const ctx = overlayRef.current?.getContext("2d");
    if (!ctx || !sheet) return;
    drawGuides(ctx, sheet, zoom, showGrid);
    if (pasting && clipCanvas.current) {
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = 0.7;
      ctx.drawImage(clipCanvas.current, pasting.x * zoom, pasting.y * zoom,
        clipCanvas.current.width * zoom, clipCanvas.current.height * zoom);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "rgba(120,255,160,0.9)";
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(pasting.x * zoom + 0.5, pasting.y * zoom + 0.5,
        clipCanvas.current.width * zoom, clipCanvas.current.height * zoom);
      ctx.restore();
    } else if (sel) {
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(sel.x0 * zoom + 0.5, sel.y0 * zoom + 0.5,
        (sel.x1 - sel.x0 + 1) * zoom, (sel.y1 - sel.y0 + 1) * zoom);
      ctx.restore();
    }
  }, [sheet, zoom, showGrid, sel, pasting]);

  const pixelAt = useCallback((e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / zoom);
    const y = Math.floor((e.clientY - rect.top) / zoom);
    if (!sheet || x < 0 || y < 0 || x >= sheet.width || y >= sheet.height) return null;
    return { x, y };
  }, [zoom, sheet]);

  // painting with a NEW color only when there's palette room
  const canUse = useCallback((c) => {
    if (c === TRANSPARENT || palette.includes(c)) return true;
    if (palette.length >= MAX_COLORS) {
      flash(`palette full (${MAX_COLORS} opaque colors max for 4bpp) — reuse an existing color`);
      return false;
    }
    return true;
  }, [palette]);

  const floodFill = (img, x, y, target, replace, bounds) => {
    if (target === replace) return;
    const b = bounds ?? { x0: 0, y0: 0, x1: img.width - 1, y1: img.height - 1 };
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (cx < b.x0 || cy < b.y0 || cx > b.x1 || cy > b.y1) continue;
      if (getPixel(img, cx, cy) !== target) continue;
      setPixel(img, cx, cy, replace);
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  };
  const drawLine = (img, x0, y0, x1, y1, c) => {
    let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      setPixel(img, x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  };
  const drawRect = (img, x0, y0, x1, y1, c) => {
    const lx = Math.min(x0, x1), hx = Math.max(x0, x1);
    const ly = Math.min(y0, y1), hy = Math.max(y0, y1);
    for (let x = lx; x <= hx; x++) { setPixel(img, x, ly, c); setPixel(img, x, hy, c); }
    for (let y = ly; y <= hy; y++) { setPixel(img, lx, y, c); setPixel(img, hx, y, c); }
  };

  const normSel = (a, b) => ({
    x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y),
  });
  const copySel = useCallback(() => {
    if (!sel || !sheet) return;
    const w = sel.x1 - sel.x0 + 1, h = sel.y1 - sel.y0 + 1;
    const data = new Uint32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        data[y * w + x] = getPixel(sheet, sel.x0 + x, sel.y0 + y);
    setClip({ w, h, data });
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    const id = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      if (!data[i]) { id.data[o + 3] = 0; continue; }
      const [r, g, b] = colorParts(data[i]);
      id.data[o] = r; id.data[o + 1] = g; id.data[o + 2] = b; id.data[o + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    clipCanvas.current = c;
  }, [sel, sheet]);
  const clearSel = useCallback(() => {
    if (!sel || !sheet) return;
    snapshot();
    const img = cloneSheet(sheet);
    for (let y = sel.y0; y <= sel.y1; y++)
      for (let x = sel.x0; x <= sel.x1; x++)
        setPixel(img, x, y, TRANSPARENT);
    onChange(img);
  }, [sel, sheet, snapshot, onChange]);
  const cutSel = useCallback(() => { copySel(); clearSel(); }, [copySel, clearSel]);
  const pasteBegin = useCallback(() => {
    if (!clip || !sheet) return;
    setTool("select");
    setSel(null);
    setPasting({
      x: (hover?.x ?? sheet.width / 2) - (clip.w >> 1),
      y: (hover?.y ?? sheet.height / 2) - (clip.h >> 1),
    });
  }, [clip, hover, sheet]);
  const stampPaste = useCallback((at) => {
    if (!clip || !at || !sheet) return;
    // pasting can bring colors in — check the budget across the union
    const incoming = new Set();
    for (const c of clip.data) if (c) incoming.add(c);
    const union = new Set([...palette, ...incoming]);
    if (union.size > MAX_COLORS) {
      flash(`paste needs ${union.size} colors (max ${MAX_COLORS}) — erase or recolor first`);
      setPasting(null);
      return;
    }
    snapshot();
    const img = cloneSheet(sheet);
    for (let y = 0; y < clip.h; y++) {
      const sy = at.y + y;
      if (sy < 0 || sy >= img.height) continue;
      for (let x = 0; x < clip.w; x++) {
        const sx = at.x + x;
        if (sx < 0 || sx >= img.width) continue;
        const c = clip.data[y * clip.w + x];
        if (c) setPixel(img, sx, sy, c);   // paste keeps holes
      }
    }
    onChange(img);
    setPasting(null);
  }, [clip, sheet, palette, snapshot, onChange]);

  const onDown = (e) => {
    const p = pixelAt(e);
    if (!p) return;
    e.preventDefault();
    rootRef.current?.focus();
    if (tool === "dropper") {
      const c = getPixel(sheet, p.x, p.y);
      if (c) setColor(c);
      else setTool("eraser");
      return;
    }
    if (pasting) { stampPaste(pasting); return; }
    if (tool === "select") {
      drawing.current = { tool: "select", start: p };
      setSel({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      return;
    }
    const paint = tool === "eraser" ? TRANSPARENT : color;
    if (!canUse(paint)) return;
    snapshot();
    const img = cloneSheet(sheet);
    if (tool === "pencil" || tool === "eraser") {
      setPixel(img, p.x, p.y, paint);
      drawing.current = { tool, paint, last: p };
      onChange(img);
    } else if (tool === "fill") {
      floodFill(img, p.x, p.y, getPixel(img, p.x, p.y), paint, sel ?? undefined);
      onChange(img);
    } else if (tool === "line" || tool === "rect") {
      drawing.current = { tool, paint, start: p, base: cloneSheet(sheet) };
    }
  };

  const onMove = (e) => {
    const p = pixelAt(e);
    if (p && sheet) setHover({ x: p.x, y: p.y, cell: cellAt(sheet, p.x, p.y) });
    if (pasting && p && clip) {
      setPasting({ x: p.x - (clip.w >> 1), y: p.y - (clip.h >> 1) });
      return;
    }
    const d = drawing.current;
    if (!d || !p) return;
    if (d.tool === "select") { setSel(normSel(d.start, p)); return; }
    if (d.tool === "pencil" || d.tool === "eraser") {
      const img = cloneSheet(sheet);
      drawLine(img, d.last.x, d.last.y, p.x, p.y, d.paint);
      d.last = p;
      onChange(img);
    } else if (d.tool === "line") {
      const img = cloneSheet(d.base);
      drawLine(img, d.start.x, d.start.y, p.x, p.y, d.paint);
      onChange(img);
    } else if (d.tool === "rect") {
      const img = cloneSheet(d.base);
      drawRect(img, d.start.x, d.start.y, p.x, p.y, d.paint);
      onChange(img);
    }
  };

  const onUp = () => { drawing.current = null; };
  useEffect(() => {
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  // keyboard: undo/redo/copy/cut/paste/clear — only while this pane owns focus
  useEffect(() => {
    const onKey = (e) => {
      if (!rootRef.current || !rootRef.current.contains(document.activeElement)) return;
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) {
        if (e.key === "Escape") { setPasting(null); setSel(null); return; }
        if ((e.key === "Delete" || e.key === "Backspace") && sel) { e.preventDefault(); clearSel(); return; }
        return;
      }
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
      else if (k === "c" && sel) { e.preventDefault(); copySel(); }
      else if (k === "x" && sel) { e.preventDefault(); cutSel(); }
      else if (k === "v" && clip) { e.preventDefault(); pasteBegin(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, sel, clip, copySel, cutSel, pasteBegin, clearSel]);

  const importImage = useCallback(async () => {
    const picked = await pickFile(".png,.ase,.aseprite,image/png");
    if (!picked) return;
    try {
      const isAse = /\.(ase|aseprite)$/i.test(picked.name);
      const raw = isAse ? sheetFromAse(picked.bytes) : sheetFromPng(picked.bytes);
      const { img, reduced } = enforcePalette(raw);
      snapshot();
      onChange(img);
      flash(`imported ${img.width}×${img.height}${reduced ? ` (${reduced} colors snapped to the 15-color budget)` : ""}`);
    } catch (e) { flash(`import failed: ${e.message}`); }
  }, [onChange, snapshot]);

  const exportPng = useCallback(() => {
    if (sheet) downloadBytes("sheet.png", sheetToPng(sheet), "image/png");
  }, [sheet]);

  if (!sheet) {
    return (
      <div className="sprite-empty">
        <p>no sprite sheet — builds use the built-in fallback sprite</p>
        <button className="tb-btn" onClick={() => onChange(newSheet())}>+ new blank sheet (128×128)</button>
      </div>
    );
  }

  return (
    <div className="sprite-editor" ref={rootRef} tabIndex={-1}>
      <div className="sprite-toolbar">
        {TOOLS.map((t) => (
          <button key={t.id} className={"tool " + (tool === t.id ? "sel" : "")}
            onClick={() => setTool(t.id)} title={t.tip} aria-label={t.tip}>{t.label}</button>
        ))}
        <span className="tb-gap" />
        <button className="tool" onClick={undo} disabled={histLen.u === 0} title="Undo (Ctrl+Z)">↶</button>
        <button className="tool" onClick={redo} disabled={histLen.r === 0} title="Redo (Ctrl+Shift+Z)">↷</button>
        <span className="tb-gap" />
        <button className="tool" onClick={copySel} disabled={!sel} title="Copy selection (Ctrl+C)">⧉</button>
        <button className="tool" onClick={cutSel} disabled={!sel} title="Cut selection (Ctrl+X)">✂</button>
        <button className="tool" onClick={pasteBegin} disabled={!clip} title="Paste (Ctrl+V) — rides the cursor; click to stamp, Esc cancels">📋</button>
        <span className="tb-sep" />
        {msg && <span className="import-msg">{msg}</span>}
        <button className="tool wide" onClick={importImage} title="Import a PNG or Aseprite file">import</button>
        <button className="tool wide" onClick={exportPng} title="Export the sheet as sheet.png">export .png</button>
        <label className="grid-toggle" title="show the 8px grid + 16px sprite cells">
          <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> grid
        </label>
        <label className="zoom">zoom
          <input type="range" min="1" max="12" value={zoom} onChange={(e) => setZoom(+e.target.value)} />
          {zoom}x
        </label>
      </div>

      <div className="sprite-body">
        <div className="sprite-canvas-wrap">
          <div className="sprite-canvas-stack" style={{ width: sheet.width * zoom, height: sheet.height * zoom }}>
            <canvas ref={canvasRef} className="sprite-canvas"
              width={sheet.width} height={sheet.height}
              style={{ width: sheet.width * zoom, height: sheet.height * zoom }}
              onMouseDown={onDown} onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
            <canvas ref={overlayRef} className="sprite-overlay"
              width={sheet.width * zoom} height={sheet.height * zoom}
              style={{ width: sheet.width * zoom, height: sheet.height * zoom }} />
          </div>
          <div className="sprite-readout">
            {hover
              ? <span>x {hover.x} y {hover.y} · spr({hover.cell})</span>
              : <span className="dim">{sheet.width}×{sheet.height} · 16×16 sprites, spr(0) top-left · 15 colors + transparent</span>}
          </div>
        </div>
        <div className="palette-col">
          <div className="palette-head">palette {palette.length}/{MAX_COLORS}</div>
          <div className="palette-grid">
            <button className={"pswatch trans " + (tool === "eraser" ? "sel" : "")}
              onClick={() => setTool("eraser")} title="transparent (eraser)" />
            {palette.map((c) => (
              <button key={c} className={"pswatch " + (color === c && tool !== "eraser" ? "sel" : "")}
                style={{ background: colorHex(c) }} title={colorHex(c)}
                onClick={() => { setColor(c); if (tool === "eraser" || tool === "select") setTool("pencil"); }} />
            ))}
            <label className={"pswatch add" + (palette.length >= MAX_COLORS ? " full" : "")}
              title={palette.length >= MAX_COLORS ? `palette full (${MAX_COLORS})` : "pick a new color"}>
              +
              <input type="color" value={colorHex(color)}
                onChange={(e) => { setColor(hexColor(e.target.value)); if (tool === "eraser" || tool === "select") setTool("pencil"); }} />
            </label>
          </div>
          <div className="palette-current" style={{ background: tool === "eraser" ? "transparent" : colorHex(color) }}>
            {tool === "eraser" ? "erase" : colorHex(color)}
          </div>
        </div>
      </div>
    </div>
  );
}
