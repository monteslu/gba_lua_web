// App — the gbalua web IDE shell: examples picker | editor + assets | emulator.
// Build & Run compiles the editor buffer + assets in the build worker (the
// real WASM arm-gcc toolchain) and boots the ROM on the mGBA core. Edits and
// assets persist to localStorage per example slot; Download saves the built
// .gba; zip export/import moves whole projects.
import { useState, useRef, useCallback, useEffect } from "react";
import Editor from "./Editor.jsx";
import EmulatorPane from "./emu/EmulatorPane.jsx";
import AssetsPane from "./assets/AssetsPane.jsx";
import CheatsheetPane from "./CheatsheetPane.jsx";
import { build } from "./build/build-client.js";
import { loadExamples, loadExampleAssets } from "./examples.js";
import { saveAssets, loadAssets, clearAssets } from "./assets/asset-store.js";
import { zipWrite, zipRead } from "./zip.js";

const LS_KEY = "gbalua-web:";
const LS_ASSETS = "gbalua-web-assets:";

function loadSource(id, fallback) {
  try { return localStorage.getItem(LS_KEY + id) ?? fallback; } catch { return fallback; }
}

export default function App() {
  const [examples, setExamples] = useState(null);
  const [exampleId, setExampleId] = useState("hello");
  const [source, setSource] = useState("");
  const [assets, setAssets] = useState({});
  const [rom, setRom] = useState(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");
  const [progress, setProgress] = useState("");
  const [view, setView] = useState("code");        // code | assets
  const [showCheat, setShowCheat] = useState(false);
  const saveTimer = useRef(0);

  // load a slot: saved source/assets, else the example's own
  const loadSlot = useCallback(async (ex) => {
    setExampleId(ex.id);
    setSource(loadSource(ex.id, ex.source));
    const saved = loadAssets(LS_ASSETS + ex.id);
    if (saved) { setAssets(saved); return; }
    try { setAssets(await loadExampleAssets(ex)); }
    catch { setAssets({}); }
  }, []);

  useEffect(() => {
    loadExamples().then((exs) => {
      setExamples(exs);
      if (exs[0]) loadSlot(exs[0]);
    }).catch((e) => setProgress(`failed to load examples: ${e.message}`));
  }, [loadSlot]);

  const pick = useCallback((id) => {
    const ex = examples?.find((e) => e.id === id);
    if (!ex) return;
    loadSlot(ex);
    setLog("");
  }, [examples, loadSlot]);

  const onChange = useCallback((v) => {
    setSource(v);
    clearTimeout(saveTimer.current);
    const id = exampleId;
    saveTimer.current = setTimeout(() => {
      try { localStorage.setItem(LS_KEY + id, v); } catch { /* full */ }
    }, 500);
  }, [exampleId]);

  const onAssetsChange = useCallback((next) => {
    setAssets(next);
    saveAssets(LS_ASSETS + exampleId, next);
  }, [exampleId]);

  const revert = useCallback(async () => {
    const ex = examples?.find((e) => e.id === exampleId);
    if (!ex) return;
    try { localStorage.removeItem(LS_KEY + exampleId); } catch { /* ignore */ }
    clearAssets(LS_ASSETS + exampleId);
    await loadSlot(ex);
  }, [examples, exampleId, loadSlot]);

  const doBuild = useCallback(async () => {
    setBusy(true);
    setLog("");
    setProgress("starting build…");
    try {
      const r = await build(source, { assets, onProgress: setProgress });
      setLog(r.log || "");
      if (r.ok && r.rom) {
        setRom(r.rom);
        setProgress(`built ${r.rom.length.toLocaleString()} bytes`);
      } else {
        setProgress("build failed");
      }
    } catch (e) {
      setLog(String(e?.message ?? e));
      setProgress("build crashed");
    } finally {
      setBusy(false);
    }
  }, [source, assets]);

  const download = useCallback(() => {
    if (!rom) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([rom], { type: "application/octet-stream" }));
    a.download = `${exampleId}.gba`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [rom, exampleId]);

  // ---- project zip: main.lua + assets in a plain zip, nothing invented ------
  const exportZip = useCallback(() => {
    const files = { "main.lua": new TextEncoder().encode(source) };
    if (assets.sheet) files[`sheet/${assets.sheet.name}`] = assets.sheet.bytes;
    if (assets.map) files[`map/${assets.map.name}`] = assets.map.bytes;
    if (assets.mode7) files[`mode7/${assets.mode7.name}`] = assets.mode7.bytes;
    for (const [i, m] of (assets.music ?? []).entries()) {
      files[`music/${String(i).padStart(2, "0")}-${m.name}`] = m.bytes;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([zipWrite(files)], { type: "application/zip" }));
    a.download = `${exampleId}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [source, assets, exampleId]);

  const importZip = useCallback(async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      const entries = zipRead(new Uint8Array(await f.arrayBuffer()));
      const luaName = Object.keys(entries).find((n) => n.endsWith("main.lua")) ??
        Object.keys(entries).find((n) => n.endsWith(".lua"));
      if (!luaName) throw new Error("zip has no .lua source");
      const next = {};
      const music = [];
      for (const [name, bytes] of Object.entries(entries)) {
        const base = name.split("/").pop();
        if (name.startsWith("sheet/")) next.sheet = { name: base, bytes };
        else if (name.startsWith("map/")) next.map = { name: base, bytes };
        else if (name.startsWith("mode7/")) next.mode7 = { name: base, bytes };
        else if (name.startsWith("music/")) music.push({ name: base.replace(/^\d+-/, ""), bytes });
      }
      if (music.length) next.music = music;
      const text = new TextDecoder().decode(entries[luaName]);
      setSource(text);
      setAssets(next);
      try { localStorage.setItem(LS_KEY + exampleId, text); } catch { /* full */ }
      saveAssets(LS_ASSETS + exampleId, next);
      setProgress(`imported ${f.name}`);
    } catch (err) {
      setProgress(`zip import failed: ${err?.message ?? err}`);
    }
  }, [exampleId]);

  // Ctrl/Cmd+Enter builds
  useEffect(() => {
    const h = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); if (!busy) doBuild(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [doBuild, busy]);

  if (!examples) {
    return <div className="app"><div style={{ padding: 24, color: "#9aa3b5" }}>{progress || "loading…"}</div></div>;
  }

  const assetCount = ["sheet", "map", "mode7"].filter((k) => assets[k]).length + (assets.music?.length ?? 0);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">gbalua<span className="brand-dim"> web</span></span>
        <select value={exampleId} onChange={(e) => pick(e.target.value)}>
          {examples.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <button onClick={revert} title="discard local edits + assets for this example">revert</button>
        <div className="view-tabs">
          <button className={view === "code" ? "active" : ""} onClick={() => setView("code")}>code</button>
          <button className={view === "assets" ? "active" : ""} onClick={() => setView("assets")}>
            assets{assetCount ? ` (${assetCount})` : ""}
          </button>
        </div>
        <button onClick={() => setShowCheat((v) => !v)}>cheatsheet</button>
        <span style={{ flex: 1 }} />
        <span className="progress">{progress}</span>
        <button className="primary" onClick={doBuild} disabled={busy}>
          {busy ? "building…" : "Build & Run  (Ctrl+Enter)"}
        </button>
        <button onClick={download} disabled={!rom}>download .gba</button>
        <button onClick={exportZip}>export .zip</button>
        <label className="import-btn as-button">
          import .zip<input type="file" accept=".zip" onChange={importZip} />
        </label>
      </header>

      <div className="columns">
        <div className="editor-col">
          <div style={{ display: view === "code" ? "contents" : "none" }}>
            <Editor value={source} onChange={onChange} />
          </div>
          {view === "assets" && <AssetsPane assets={assets} onChange={onAssetsChange} />}
        </div>
        <div className="emu-col">
          <EmulatorPane rom={rom} />
          <pre className="build-log">{log}</pre>
        </div>
        {showCheat && <CheatsheetPane onClose={() => setShowCheat(false)} />}
      </div>
    </div>
  );
}
