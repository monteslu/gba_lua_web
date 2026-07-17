// EffectsPane — an interactive playground for the GBA PPU effects the
// GameTank simply doesn't have: alpha blend, brightness fade, hardware mosaic,
// clip windows, the backdrop color, and per-scanline HBlank gradients. Each
// control previews the effect on a sample scene (CSS/canvas approximation) and
// emits the exact SDK call to paste into _draw(). The emulator is the ground
// truth — this teaches the knobs and hands you the code.
import { useState, useMemo, useRef, useEffect } from "react";

const LAYERS = [
  { v: 0, label: "BG 0 (tiles)" },
  { v: 1, label: "BG 1 (tiles)" },
  { v: 2, label: "BG 2 (tiles / mode7)" },
  { v: 3, label: "text" },
  { v: 4, label: "sprites" },
];

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

// a tiny sample scene: a pink sprite over a cyan bar over a plum field, so the
// effects read visibly
function SampleScene({ style, mosaic, children }) {
  return (
    <div className="fx-scene" style={style}>
      <div className="fx-scene-inner" style={mosaic ? { filter: `url(#none)`, imageRendering: "pixelated" } : undefined}>
        <div className="fx-bg0" />
        <div className="fx-bg1" />
        <div className="fx-obj" />
        {children}
      </div>
    </div>
  );
}

export function EffectsPane() {
  const [tab, setTab] = useState("blend");
  return (
    <div className="fx-pane">
      <div className="fx-tabs">
        {[["blend", "Blend"], ["fade", "Fade"], ["mosaic", "Mosaic"], ["window", "Window"], ["backdrop", "Backdrop"], ["gradient", "HGradient"]].map(([k, l]) => (
          <button key={k} className={"fx-tab " + (tab === k ? "sel" : "")} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      <div className="fx-body">
        {tab === "blend" && <BlendFx />}
        {tab === "fade" && <FadeFx />}
        {tab === "mosaic" && <MosaicFx />}
        {tab === "window" && <WindowFx />}
        {tab === "backdrop" && <BackdropFx />}
        {tab === "gradient" && <GradientFx />}
      </div>
    </div>
  );
}

function BlendFx() {
  const [layer, setLayer] = useState(4);
  const [alpha, setAlpha] = useState(0.5);
  return (
    <div className="fx-card">
      <p className="fx-desc"><b>blend(layer, alpha)</b> — draw a layer at partial opacity over the scene (glass, ghosts, dimmed UI). Free on the PPU blend unit, no per-pixel CPU.</p>
      <div className="fx-controls">
        <label className="m-field">layer
          <select value={layer} onChange={(e) => setLayer(+e.target.value)}>
            {LAYERS.map((l) => <option key={l.v} value={l.v}>{l.label}</option>)}
          </select>
        </label>
        <label className="m-field">alpha
          <input type="range" min="0" max="1" step="0.0625" value={alpha} onChange={(e) => setAlpha(+e.target.value)} />
          <b>{alpha.toFixed(2)}</b>
        </label>
      </div>
      <SampleScene>
        <div className="fx-blend-obj" style={{ opacity: layer === 4 ? alpha : 1 }} />
      </SampleScene>
      <Snippet code={`blend(${layer}, ${alpha.toFixed(3)})`} />
      <p className="fx-hint">blend_off() clears it. alpha is 0..1 (16.16 fixed).</p>
    </div>
  );
}

function FadeFx() {
  const [amount, setAmount] = useState(0.5);
  const [white, setWhite] = useState(false);
  return (
    <div className="fx-card">
      <p className="fx-desc"><b>fade(amount, [white])</b> — darken (or whiten) the whole screen: level wipes, hit flashes, pause dims. Whole-screen, free.</p>
      <div className="fx-controls">
        <label className="m-field">amount
          <input type="range" min="0" max="1" step="0.0625" value={amount} onChange={(e) => setAmount(+e.target.value)} />
          <b>{amount.toFixed(2)}</b>
        </label>
        <label className="fx-check"><input type="checkbox" checked={white} onChange={(e) => setWhite(e.target.checked)} /> to white</label>
      </div>
      <SampleScene>
        <div className="fx-fade-veil" style={{ background: white ? "#fff" : "#000", opacity: amount }} />
      </SampleScene>
      <Snippet code={`fade(${amount.toFixed(3)}${white ? ", true" : ""})`} />
      <p className="fx-hint">fade(0) or blend_off() clears it.</p>
    </div>
  );
}

function MosaicFx() {
  const [n, setN] = useState(4);
  return (
    <div className="fx-card">
      <p className="fx-desc"><b>mosaic(n)</b> — hardware pixelate, 0 (off) to 15: dissolves, heat shimmer, retro transitions. mosaic2(bh, bv) sets horizontal/vertical block size separately.</p>
      <div className="fx-controls">
        <label className="m-field">block size
          <input type="range" min="0" max="15" value={n} onChange={(e) => setN(+e.target.value)} />
          <b>{n}</b>
        </label>
      </div>
      <SampleScene>
        <div className="fx-mosaic-obj" style={{ "--m": `${(n + 1) * 3}px` }} />
      </SampleScene>
      <Snippet code={`mosaic(${n})`} />
      <p className="fx-hint">applies to BG layers; spr_mosaic() opts the next sprite in.</p>
    </div>
  );
}

function WindowFx() {
  const [box, setBox] = useState({ x0: 60, y0: 40, x1: 180, y1: 120 });
  const clamp = (v, hi) => Math.max(0, Math.min(hi, v | 0));
  const set = (k, v, hi) => setBox((b) => ({ ...b, [k]: clamp(v, hi) }));
  return (
    <div className="fx-card">
      <p className="fx-desc"><b>window(x0, y0, x1, y1)</b> — a hardware spotlight: everything inside the box shows, outside is hidden (iris, reveal, flashlight). Sprites are clipped too.</p>
      <div className="fx-controls fx-window-controls">
        <label className="m-field">x0 <input type="number" min="0" max="240" value={box.x0} onChange={(e) => set("x0", +e.target.value, 240)} /></label>
        <label className="m-field">y0 <input type="number" min="0" max="160" value={box.y0} onChange={(e) => set("y0", +e.target.value, 160)} /></label>
        <label className="m-field">x1 <input type="number" min="0" max="240" value={box.x1} onChange={(e) => set("x1", +e.target.value, 240)} /></label>
        <label className="m-field">y1 <input type="number" min="0" max="160" value={box.y1} onChange={(e) => set("y1", +e.target.value, 160)} /></label>
      </div>
      <SampleScene>
        <div className="fx-window-mask" style={{
          clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 ${box.y0 / 160 * 100}%, ${box.x0 / 240 * 100}% ${box.y0 / 160 * 100}%, ${box.x0 / 240 * 100}% ${box.y1 / 160 * 100}%, ${box.x1 / 240 * 100}% ${box.y1 / 160 * 100}%, ${box.x1 / 240 * 100}% ${box.y0 / 160 * 100}%, 0 ${box.y0 / 160 * 100}%)`,
        }} />
        <div className="fx-window-box" style={{
          left: `${box.x0 / 240 * 100}%`, top: `${box.y0 / 160 * 100}%`,
          width: `${(box.x1 - box.x0) / 240 * 100}%`, height: `${(box.y1 - box.y0) / 160 * 100}%`,
        }} />
      </SampleScene>
      <Snippet code={`window(${box.x0}, ${box.y0}, ${box.x1}, ${box.y1})`} />
      <p className="fx-hint">window_inside(x0,y0,x1,y1,layers) shows only chosen layers inside; window_off() disables.</p>
    </div>
  );
}

function BackdropFx() {
  const [rgb, setRgb] = useState({ r: 40, g: 20, b: 80 });
  const to31 = (v) => Math.round(v / 255 * 31);
  const hex = `#${[rgb.r, rgb.g, rgb.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  return (
    <div className="fx-card">
      <p className="fx-desc"><b>backdrop(color)</b> — the color behind every layer (palette entry 0). Sets the "sky" a tile game shows through gaps. color is a GBA byte 0-255 or an rgb15() value.</p>
      <div className="fx-controls">
        <label className="m-field">color <input type="color" value={hex} onChange={(e) => {
          const h = e.target.value;
          setRgb({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });
        }} /></label>
        <span className="fx-hint">BGR555: ({to31(rgb.r)}, {to31(rgb.g)}, {to31(rgb.b)})</span>
      </div>
      <SampleScene style={{ background: hex }}>
        <div className="fx-backdrop-holes" />
      </SampleScene>
      <Snippet code={`backdrop(rgb15(${rgb.r}, ${rgb.g}, ${rgb.b}))`} />
    </div>
  );
}

// hgradient designer: a top + bottom color, interpolated over 160 scanlines,
// emitting an array of 160 rgb15 values (or a compact loop)
function GradientFx() {
  const [top, setTop] = useState({ r: 40, g: 120, b: 255 });
  const [bot, setBot] = useState({ r: 255, g: 180, b: 60 });
  const canvasRef = useRef(null);
  const hex = (c) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    for (let y = 0; y < 160; y++) {
      const t = y / 159;
      const r = Math.round(top.r + (bot.r - top.r) * t);
      const g = Math.round(top.g + (bot.g - top.g) * t);
      const b = Math.round(top.b + (bot.b - top.b) * t);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, y, 240, 1);
    }
  }, [top, bot]);
  const code = useMemo(() => {
    // emit a build-time loop that fills 160 scanlines — readable, not 160 literals
    return `-- sky gradient (paste into _init, then hgradient(sky) in _draw)\n` +
      `local sky = array(160)\n` +
      `for i=1,160 do\n` +
      `  local t = (i-1)/159\n` +
      `  sky[i] = rgb15(\n` +
      `    ${top.r} + (${bot.r} - ${top.r}) * t,\n` +
      `    ${top.g} + (${bot.g} - ${top.g}) * t,\n` +
      `    ${top.b} + (${bot.b} - ${top.b}) * t)\n` +
      `end`;
  }, [top, bot]);
  return (
    <div className="fx-card">
      <p className="fx-desc"><b>hgradient(table)</b> — a per-scanline backdrop color via HBlank IRQ (160 BGR555 colors): skies, water, fire. Design the top→bottom ramp; copy the fill loop.</p>
      <div className="fx-controls">
        <label className="m-field">top <input type="color" value={hex(top)} onChange={(e) => { const h = e.target.value; setTop({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) }); }} /></label>
        <label className="m-field">bottom <input type="color" value={hex(bot)} onChange={(e) => { const h = e.target.value; setBot({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) }); }} /></label>
      </div>
      <canvas ref={canvasRef} width={240} height={160} className="fx-gradient-canvas" />
      <Snippet code={code} />
      <p className="fx-hint">hgradient(0) turns it off.</p>
    </div>
  );
}
