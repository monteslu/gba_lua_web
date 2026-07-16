// SheetEditor — a pixel editor for the sprite sheet. Edits plain RGBA and
// round-trips through the SDK's PNG codec, so what you draw is exactly what
// `--sheet` would import: 16x16 sprites, up to 15 opaque colors + transparent.
import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { decodePng } from "gbalua/compiler/png-tiles.mjs";
import { encodePng } from "gbalua/compiler/png-encode.mjs";

const CHECKER_A = "#3a3f4c", CHECKER_B = "#2e3340";
const MAX_COLORS = 15;

const hex = (r, g, b) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function paletteOf(img) {
  const seen = new Map();
  for (let i = 0; i < img.rgba.length; i += 4) {
    if (img.rgba[i + 3] < 128) continue;
    const k = hex(img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]);
    if (!seen.has(k)) seen.set(k, true);
  }
  return [...seen.keys()];
}

export default function SheetEditor({ file, onChange }) {
  const [img, setImg] = useState(null);           // {width, height, rgba}
  const [color, setColor] = useState("#ffffff");  // draw color; null = eraser
  const [tool, setTool] = useState("pencil");     // pencil | eraser | fill
  const [error, setError] = useState("");
  const canvasRef = useRef(null);
  const undoRef = useRef([]);
  const drawingRef = useRef(false);
  const [tick, bump] = useState(0);                // repaint tick after edits

  // decode incoming PNG bytes — but not our own edits echoing back (that would
  // reset the undo stack mid-session)
  const emittedRef = useRef(null);
  useEffect(() => {
    if (!file) { setImg(null); return; }
    if (emittedRef.current === file.bytes) return;
    try {
      const d = decodePng(file.bytes);
      setImg({ width: d.width, height: d.height, rgba: new Uint8Array(d.rgba) });
      undoRef.current = [];
      setError("");
    } catch (e) { setError(String(e?.message ?? e)); }
  }, [file]);

  const palette = useMemo(() => (img ? paletteOf(img) : []), [img, tick]);
  const zoom = img ? Math.max(1, Math.floor(384 / Math.max(img.width, img.height))) : 1;

  // repaint the canvas from rgba
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !img) return;
    cv.width = img.width * zoom;
    cv.height = img.height * zoom;
    const ctx = cv.getContext("2d");
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++) {
        const o = (y * img.width + x) * 4;
        if (img.rgba[o + 3] < 128) {
          ctx.fillStyle = ((x >> 2) + (y >> 2)) % 2 ? CHECKER_A : CHECKER_B;
        } else {
          ctx.fillStyle = hex(img.rgba[o], img.rgba[o + 1], img.rgba[o + 2]);
        }
        ctx.fillRect(x * zoom, y * zoom, zoom, zoom);
      }
    // sprite grid: 8px minor, 16px major (a sprite cell)
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    for (let x = 8; x < img.width; x += 8) { ctx.beginPath(); ctx.moveTo(x * zoom, 0); ctx.lineTo(x * zoom, cv.height); ctx.stroke(); }
    for (let y = 8; y < img.height; y += 8) { ctx.beginPath(); ctx.moveTo(0, y * zoom); ctx.lineTo(cv.width, y * zoom); ctx.stroke(); }
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    for (let x = 16; x < img.width; x += 16) { ctx.beginPath(); ctx.moveTo(x * zoom, 0); ctx.lineTo(x * zoom, cv.height); ctx.stroke(); }
    for (let y = 16; y < img.height; y += 16) { ctx.beginPath(); ctx.moveTo(0, y * zoom); ctx.lineTo(cv.width, y * zoom); ctx.stroke(); }
  });

  const commit = useCallback(() => {
    if (!img || !file) return;
    const bytes = encodePng(img.rgba, img.width, img.height);
    emittedRef.current = bytes;
    onChange({ name: file.name, bytes });
  }, [img, file, onChange]);

  const putPixel = (x, y) => {
    const o = (y * img.width + x) * 4;
    if (tool === "eraser" || color === null) {
      img.rgba[o] = img.rgba[o + 1] = img.rgba[o + 2] = img.rgba[o + 3] = 0;
      return true;
    }
    const [r, g, b] = fromHex(color);
    // enforce the 4bpp budget: a NEW color only if <15 opaques exist
    const cur = hex(img.rgba[o], img.rgba[o + 1], img.rgba[o + 2]);
    const isNew = !palette.includes(color);
    if (isNew && palette.length >= MAX_COLORS && !(img.rgba[o + 3] >= 128 && cur === color)) {
      setError(`palette full (${MAX_COLORS} opaque colors max for 4bpp) — reuse an existing color`);
      return false;
    }
    img.rgba[o] = r; img.rgba[o + 1] = g; img.rgba[o + 2] = b; img.rgba[o + 3] = 255;
    return true;
  };

  const fill = (x, y) => {
    const o0 = (y * img.width + x) * 4;
    const match = Array.from(img.rgba.slice(o0, o0 + 4));
    const same = (o) => img.rgba[o] === match[0] && img.rgba[o + 1] === match[1] &&
      img.rgba[o + 2] === match[2] && img.rgba[o + 3] === match[3];
    const stack = [[x, y]];
    const seen = new Set([y * img.width + x]);
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (!putPixel(cx, cy)) return;
      for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
        const key = ny * img.width + nx;
        if (nx < 0 || ny < 0 || nx >= img.width || ny >= img.height || seen.has(key)) continue;
        if (same(key * 4)) { seen.add(key); stack.push([nx, ny]); }
      }
    }
  };

  const pixelAt = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / zoom);
    const y = Math.floor((e.clientY - rect.top) / zoom);
    return x >= 0 && y >= 0 && x < img.width && y < img.height ? [x, y] : null;
  };

  const onPointerDown = (e) => {
    if (!img) return;
    e.preventDefault();
    canvasRef.current.setPointerCapture(e.pointerId);
    undoRef.current.push(new Uint8Array(img.rgba));
    if (undoRef.current.length > 50) undoRef.current.shift();
    const p = pixelAt(e);
    if (!p) return;
    setError("");
    if (tool === "fill") fill(p[0], p[1]);
    else { drawingRef.current = true; putPixel(p[0], p[1]); }
    bump((n) => n + 1);
  };
  const onPointerMove = (e) => {
    if (!drawingRef.current || !img) return;
    const p = pixelAt(e);
    if (p) { putPixel(p[0], p[1]); bump((n) => n + 1); }
  };
  const onPointerUp = () => {
    drawingRef.current = false;
    commit();
  };

  const undo = () => {
    const prev = undoRef.current.pop();
    if (!prev || !img) return;
    img.rgba.set(prev);
    bump((n) => n + 1);
    commit();
  };

  const newSheet = () => {
    const w = 128, h = 128;
    onChange({ name: "sheet.png", bytes: encodePng(new Uint8Array(w * h * 4), w, h) });
  };

  const exportPng = () => {
    if (!file) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([file.bytes], { type: "image/png" }));
    a.download = file.name;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (!img) {
    return (
      <div className="asset-empty">
        <p>No sprite sheet — builds use the built-in fallback sprite.</p>
        <button onClick={newSheet}>new blank sheet (128x128)</button>
        {error && <p className="asset-error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="sheet-editor">
      <div className="sheet-tools">
        {["pencil", "eraser", "fill"].map((t) => (
          <button key={t} className={tool === t ? "active" : ""} onClick={() => setTool(t)}>{t}</button>
        ))}
        <button onClick={undo} disabled={!undoRef.current.length}>undo</button>
        <button onClick={exportPng}>export .png</button>
        <span className="sheet-dim">{img.width}x{img.height} · sprite {Math.floor(img.width / 16)}x{Math.floor(img.height / 16)} grid</span>
      </div>
      <div className="sheet-palette">
        {palette.map((c) => (
          <button key={c} className={"swatch" + (color === c && tool !== "eraser" ? " active" : "")}
            style={{ background: c }} title={c}
            onClick={() => { setColor(c); if (tool === "eraser") setTool("pencil"); }} />
        ))}
        <label className={"swatch add" + (palette.length >= MAX_COLORS ? " full" : "")}
          title={palette.length >= MAX_COLORS ? "palette full (15)" : "add color"}>
          +<input type="color" value={color ?? "#ffffff"}
            onChange={(e) => { setColor(e.target.value); if (tool === "eraser") setTool("pencil"); }} />
        </label>
        <span className="sheet-dim">{palette.length}/{MAX_COLORS} colors</span>
      </div>
      {error && <div className="asset-error">{error}</div>}
      <div className="sheet-canvas-wrap">
        <canvas ref={canvasRef} className="sheet-canvas"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove}
          onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
      </div>
    </div>
  );
}
