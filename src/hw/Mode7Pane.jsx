// Mode7Pane — a designer for the GBA's affine (Mode 7) background: a
// perspective ground plane you rotate, scale, and drive over (F-Zero /
// Mario Kart ground). GameTank has nothing like this. Drag the camera and
// the panel previews the transform and emits mode7()/mode7_cam(x,y,angle,zoom).
//
// The preview is a CSS approximation of the affine ground; the emulator is the
// real thing. What matters is that the controls map 1:1 to the SDK call.
import { useState, useMemo, useRef, useEffect } from "react";
import { decodePng } from "gbalua/compiler/png-tiles.mjs";

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

export function Mode7Pane({ mode7Png, onImport }) {
  const [cam, setCam] = useState({ x: 128, y: 128, angle: 0, zoom: 1 });
  const canvasRef = useRef(null);
  const planeRef = useRef(null);

  // decode the project's mode7 plane into a flat pixel buffer (read once — a
  // per-pixel getImageData in the render loop would be brutal)
  useEffect(() => {
    if (!mode7Png) { planeRef.current = null; return; }
    try {
      const { width, height, rgba } = decodePng(mode7Png);
      planeRef.current = { width, height, rgba };
    } catch { planeRef.current = null; }
  }, [mode7Png]);

  // render a fake-perspective ground: sample the plane along the camera angle,
  // rows nearer the horizon sampled from farther away (1/z). Enough to show what
  // the knobs do.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    const W = 240, H = 160, HORIZON = 40;
    ctx.clearRect(0, 0, W, H);
    // sky
    ctx.fillStyle = "#0d1b3a";
    ctx.fillRect(0, 0, W, HORIZON);
    const plane = planeRef.current;
    const cos = Math.cos(cam.angle), sin = Math.sin(cam.angle);
    const out = ctx.getImageData(0, 0, W, H);
    const od = out.data;
    for (let sy = HORIZON; sy < H; sy++) {
      const depth = (sy - HORIZON + 1);
      const scale = (H - HORIZON) / depth / cam.zoom;
      for (let sx = 0; sx < W; sx++) {
        const dx = (sx - W / 2) * scale;
        const dz = (H - sy) * scale * 2;
        const wx = cam.x + dx * cos - dz * sin;
        const wy = cam.y + dx * sin + dz * cos;
        let r = 26, g = 35, b = 64;
        if (plane) {
          const px = ((wx % plane.width) + plane.width) % plane.width | 0;
          const py = ((wy % plane.height) + plane.height) % plane.height | 0;
          const o = (py * plane.width + px) * 4;
          if (plane.rgba[o + 3]) { r = plane.rgba[o]; g = plane.rgba[o + 1]; b = plane.rgba[o + 2]; }
        } else {
          const cell = ((wx >> 4) + (wy >> 4)) & 1;
          if (cell) { r = 42; g = 58; b = 90; }
        }
        const o = (sy * W + sx) * 4;
        od[o] = r; od[o + 1] = g; od[o + 2] = b; od[o + 3] = 255;
      }
    }
    // sky rows above the horizon
    for (let sy = 0; sy < HORIZON; sy++)
      for (let sx = 0; sx < W; sx++) {
        const o = (sy * W + sx) * 4;
        od[o] = 13; od[o + 1] = 27; od[o + 2] = 58; od[o + 3] = 255;
      }
    ctx.putImageData(out, 0, 0);
  }, [cam, mode7Png]);

  const deg = Math.round(cam.angle * 180 / Math.PI);
  const snippet = useMemo(() =>
    `mode7()                          -- once, in _init\n` +
    `mode7_cam(${cam.x}, ${cam.y}, ${(cam.angle).toFixed(3)}${cam.zoom !== 1 ? `, ${cam.zoom.toFixed(2)}` : ""})  -- each frame`,
    [cam]);

  return (
    <div className="m7-pane">
      <div className="m7-preview-col">
        <canvas ref={canvasRef} width={240} height={160} className="m7-canvas" />
        {!mode7Png && (
          <div className="m7-noplane">
            <span>no Mode 7 plane imported — showing a checker.</span>
            <button className="tb-btn" onClick={onImport}>import a plane (Backgrounds tab)</button>
          </div>
        )}
      </div>
      <div className="m7-controls-col">
        <h3 className="pal-title">Mode 7 camera</h3>
        <p className="fx-desc">
          BG2 becomes a rotate/scale ground plane. Drive the camera over it: <b>x/y</b> = position on the plane,
          <b> angle</b> = heading, <b>zoom</b> = height/scale.
        </p>
        <label className="m7-field">x <input type="range" min="0" max="1024" value={cam.x} onChange={(e) => setCam((c) => ({ ...c, x: +e.target.value }))} /><b>{cam.x}</b></label>
        <label className="m7-field">y <input type="range" min="0" max="1024" value={cam.y} onChange={(e) => setCam((c) => ({ ...c, y: +e.target.value }))} /><b>{cam.y}</b></label>
        <label className="m7-field">angle <input type="range" min="-3.14159" max="3.14159" step="0.02" value={cam.angle} onChange={(e) => setCam((c) => ({ ...c, angle: +e.target.value }))} /><b>{deg}°</b></label>
        <label className="m7-field">zoom <input type="range" min="0.25" max="4" step="0.05" value={cam.zoom} onChange={(e) => setCam((c) => ({ ...c, zoom: +e.target.value }))} /><b>{cam.zoom.toFixed(2)}×</b></label>
        <Snippet code={snippet} />
        <p className="fx-hint">
          Mode 7 planes are 8bpp / 256-color / square (128/256/512/1024 px). Import one in the Backgrounds tab.
          Sprites and a HUD compose on top. mode7_off() returns to normal.
        </p>
      </div>
    </div>
  );
}
