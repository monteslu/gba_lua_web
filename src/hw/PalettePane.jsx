// PalettePane — the GBA's runtime palette control, which the GameTank lacks.
// The GBA stores color as 15-bit BGR555 (32 levels per channel); pal(i,r,g,b)
// and spr_col(i,r,g,b) rewrite palette entries live for swaps, day/night, and
// color cycling. This pane is a BGR555-accurate color designer that shows the
// current sheet's palette and hands you the exact calls.
import { useState, useMemo } from "react";
import { paletteOf, colorParts, colorHex } from "../gfx/sheet-model.js";

// snap an 8-bit channel to the GBA's 5-bit precision, both as the 0-31 level
// and the reconstructed 8-bit value the hardware actually shows
const to31 = (v) => Math.round(v / 255 * 31);
const from31 = (v) => Math.round(v * 255 / 31);
const snap8 = (v) => from31(to31(v));

function Snippet({ code }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1200); }
    catch { /* blocked */ }
  };
  return (
    <div className="fx-snippet">
      <code>{code}</code>
      <button className="tb-btn" onClick={copy}>{copied ? "✓" : "⧉ copy"}</button>
    </div>
  );
}

export function PalettePane({ sheet }) {
  const [target, setTarget] = useState("spr");   // spr | bg
  const [index, setIndex] = useState(1);
  const [rgb, setRgb] = useState({ r: 255, g: 122, b: 198 });

  const palette = useMemo(() => (sheet ? paletteOf(sheet) : []), [sheet]);

  const snapped = { r: snap8(rgb.r), g: snap8(rgb.g), b: snap8(rgb.b) };
  const hex = `#${[rgb.r, rgb.g, rgb.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  const shownHex = `#${[snapped.r, snapped.g, snapped.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  const fn = target === "spr" ? "spr_col" : "pal";

  return (
    <div className="pal-pane">
      <div className="pal-left">
        <h3 className="pal-title">GBA color designer</h3>
        <p className="fx-desc">
          The GBA shows 15-bit <b>BGR555</b> color — 32 levels per channel. Pick a color; the panel snaps it to what
          the hardware actually displays and gives you the runtime palette call.
        </p>

        <div className="pal-picker">
          <input type="color" className="pal-color-input" value={hex}
            onChange={(e) => {
              const h = e.target.value;
              setRgb({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });
            }} />
          <div className="pal-chips">
            <div className="pal-chip"><span className="pal-swatch" style={{ background: hex }} /><span>picked</span></div>
            <div className="pal-chip"><span className="pal-swatch" style={{ background: shownHex }} /><span>on GBA</span></div>
          </div>
        </div>

        {["r", "g", "b"].map((ch) => (
          <label key={ch} className="pal-slider">
            <span className="pal-ch" style={{ color: ch === "r" ? "#ff6b8a" : ch === "g" ? "#6ce7a8" : "#57e2e5" }}>{ch.toUpperCase()}</span>
            <input type="range" min="0" max="255" value={rgb[ch]} onChange={(e) => setRgb((c) => ({ ...c, [ch]: +e.target.value }))} />
            <b className="pal-val">{to31(rgb[ch])}<span className="dim">/31</span></b>
          </label>
        ))}

        <div className="pal-controls">
          <label className="m-field">palette
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="spr">sprite (spr_col)</option>
              <option value="bg">background (pal)</option>
            </select>
          </label>
          <label className="m-field">index
            <input type="number" min="0" max="255" value={index} onChange={(e) => setIndex(Math.max(0, Math.min(255, +e.target.value | 0)))} />
          </label>
        </div>
        <Snippet code={`${fn}(${index}, ${rgb.r}, ${rgb.g}, ${rgb.b})`} />
        <Snippet code={`rgb15(${rgb.r}, ${rgb.g}, ${rgb.b})   -- = ${(to31(rgb.b) << 10 | to31(rgb.g) << 5 | to31(rgb.r))}`} />
        <p className="fx-hint">
          Index 0 is transparent for sprites, the backdrop for BGs. spr_col/pal reach all 15 bits — do palette
          cycling by rewriting entries each frame, or a day/night wash by ramping them.
        </p>
      </div>

      <div className="pal-right">
        <h3 className="pal-title">this project's sheet palette</h3>
        {palette.length ? (
          <div className="pal-sheet-grid">
            <button className="pal-entry" onClick={() => setIndex(0)} title="index 0 = transparent">
              <span className="pal-swatch trans" />
              <span className="pal-idx">0</span>
            </button>
            {palette.map((c, i) => {
              const [r, g, b] = colorParts(c);
              return (
                <button key={c} className="pal-entry" title={`index ${i + 1} · ${colorHex(c)} · click to edit`}
                  onClick={() => { setIndex(i + 1); setRgb({ r, g, b }); setTarget("spr"); }}>
                  <span className="pal-swatch" style={{ background: colorHex(c) }} />
                  <span className="pal-idx">{i + 1}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="fx-hint">no sprite sheet yet — the palette fills in as you draw in the Sprites tab (up to 15 opaque colors + transparent).</p>
        )}
        <p className="fx-hint">click an entry to load it into the designer, then spr_col(i, …) to recolor it live in-game.</p>
      </div>
    </div>
  );
}
