// AssetsPane — the resource layer: sprite sheet (editable), background map,
// Mode-7 plane, and music. Imports go through the SDK's own converters
// (.png/.ase/.aseprite/.tmx for images; .xm/.mod/.it/.s3m for music) — the
// same files the CLI's --sheet/--map/--mode7/--music flags take.
import { useState, useRef } from "react";
import SheetEditor from "./SheetEditor.jsx";
import { importImage, IMAGE_EXTS, MUSIC_EXTS } from "./asset-store.js";
import { decodePng } from "gbalua/compiler/png-tiles.mjs";

const TABS = [
  ["sheet", "Sheet"],
  ["map", "Map"],
  ["mode7", "Mode 7"],
  ["music", "Music"],
];

// preview a PNG asset on a small canvas
function PngPreview({ file }) {
  const ref = useRef(null);
  const draw = (cv) => {
    if (!cv || !file) return;
    try {
      const { width, height, rgba } = decodePng(file.bytes);
      cv.width = width; cv.height = height;
      const ctx = cv.getContext("2d");
      const id = ctx.createImageData(width, height);
      id.data.set(rgba);
      ctx.putImageData(id, 0, 0);
      // small images shown 2x, everything capped to the pane width
      cv.style.width = `${Math.min(320, width * 2)}px`;
    } catch { /* preview only */ }
  };
  return <canvas ref={(cv) => { ref.current = cv; draw(cv); }} className="asset-preview" />;
}

function readFiles(fileList) {
  return Promise.all([...fileList].map(async (f) => ({
    name: f.name, bytes: new Uint8Array(await f.arrayBuffer()),
  })));
}

// an image slot (map / mode7): import + preview + clear
function ImageSlot({ label, hint, file, onChange }) {
  const [error, setError] = useState("");
  const pick = async (e) => {
    try {
      const files = await readFiles(e.target.files);
      e.target.value = "";
      if (!files.length) return;
      const main = files.find((f) => !/\.png$/i.test(f.name)) ?? files[0];
      const siblings = {};
      for (const f of files) siblings[f.name] = f.bytes;
      onChange(importImage(main, siblings));
      setError("");
    } catch (err) { setError(String(err?.message ?? err)); }
  };
  return (
    <div className="asset-slot">
      <div className="asset-slot-head">
        <label className="import-btn">
          import {IMAGE_EXTS.join(" / ")}
          <input type="file" multiple accept={IMAGE_EXTS.join(",")} onChange={pick} />
        </label>
        {file && <button onClick={() => onChange(undefined)}>clear</button>}
        <span className="sheet-dim">{file ? file.name : `none — ${hint}`}</span>
      </div>
      {error && <div className="asset-error">{error}</div>}
      {file && <PngPreview file={file} />}
    </div>
  );
}

function MusicSlot({ music = [], onChange }) {
  const [error, setError] = useState("");
  const add = async (e) => {
    try {
      const files = await readFiles(e.target.files);
      e.target.value = "";
      for (const f of files) {
        if (!MUSIC_EXTS.some((x) => f.name.toLowerCase().endsWith(x))) {
          throw new Error(`${f.name}: not a tracker module (${MUSIC_EXTS.join("/")})`);
        }
      }
      onChange([...music, ...files]);
      setError("");
    } catch (err) { setError(String(err?.message ?? err)); }
  };
  const removeAt = (i) => onChange(music.filter((_, j) => j !== i));
  return (
    <div className="asset-slot">
      <div className="asset-slot-head">
        <label className="import-btn">
          add module {MUSIC_EXTS.join(" / ")}
          <input type="file" multiple accept={MUSIC_EXTS.join(",")} onChange={add} />
        </label>
        <span className="sheet-dim">
          {music.length ? "music(n) plays the nth module" : "none — the default chiptune plays as music(0)"}
        </span>
      </div>
      {error && <div className="asset-error">{error}</div>}
      <ol className="music-list">
        {music.map((m, i) => (
          <li key={i}>
            <code>music({i})</code> {m.name} <span className="sheet-dim">({(m.bytes.length / 1024).toFixed(1)} KB)</span>
            <button onClick={() => removeAt(i)}>remove</button>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * @param {{assets: object, onChange: (assets: object) => void}} props
 */
export default function AssetsPane({ assets, onChange }) {
  const [tab, setTab] = useState("sheet");
  const set = (key, value) => {
    const next = { ...assets };
    if (value === undefined || (Array.isArray(value) && !value.length)) delete next[key];
    else next[key] = value;
    onChange(next);
  };
  const badge = (key) =>
    key === "music" ? (assets.music?.length ? ` (${assets.music.length})` : "")
      : (assets[key] ? " ●" : "");

  return (
    <div className="assets-pane">
      <div className="asset-tabs">
        {TABS.map(([key, label]) => (
          <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
            {label}{badge(key)}
          </button>
        ))}
      </div>
      {tab === "sheet" && (
        <div className="asset-body">
          <ImageSlot label="sheet" hint="builds use the built-in fallback sprite"
            file={assets.sheet} onChange={(f) => set("sheet", f)} />
          <SheetEditor file={assets.sheet} onChange={(f) => set("sheet", f)} />
        </div>
      )}
      {tab === "map" && (
        <div className="asset-body">
          <p className="asset-help">Background tilemap for <code>map_show()</code> — 4bpp, 15 colors + transparent, tiles deduped automatically.</p>
          <ImageSlot label="map" hint="map_show() has nothing to show" file={assets.map} onChange={(f) => set("map", f)} />
        </div>
      )}
      {tab === "mode7" && (
        <div className="asset-body">
          <p className="asset-help">Affine plane for <code>mode7()</code> — square PNG, 128/256/512/1024 px per side, up to 255 colors.</p>
          <ImageSlot label="mode7" hint="mode7() has no plane" file={assets.mode7} onChange={(f) => set("mode7", f)} />
        </div>
      )}
      {tab === "music" && (
        <div className="asset-body">
          <MusicSlot music={assets.music} onChange={(m) => set("music", m)} />
        </div>
      )}
    </div>
  );
}
