// App — the gbalua web IDE shell: examples picker | Monaco editor | emulator.
// Build & Run compiles the editor buffer in the build worker (the real WASM
// arm-gcc toolchain) and boots the ROM on the mGBA core. Edits persist to
// localStorage per example slot; Download saves the built .gba.
import { useState, useRef, useCallback, useEffect } from "react";
import Editor from "./Editor.jsx";
import EmulatorPane from "./emu/EmulatorPane.jsx";
import { build } from "./build/build-client.js";
import { loadExamples } from "./examples.js";

const LS_KEY = "gbalua-web:";

function loadSource(id, fallback) {
  try { return localStorage.getItem(LS_KEY + id) ?? fallback; } catch { return fallback; }
}

export default function App() {
  const [examples, setExamples] = useState(null);
  const [exampleId, setExampleId] = useState("hello");
  const [source, setSource] = useState("");
  const [rom, setRom] = useState(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");
  const [progress, setProgress] = useState("");
  const saveTimer = useRef(0);

  useEffect(() => {
    loadExamples().then((exs) => {
      setExamples(exs);
      const first = exs[0];
      if (first) {
        setExampleId(first.id);
        setSource(loadSource(first.id, first.source));
      }
    }).catch((e) => setProgress(`failed to load examples: ${e.message}`));
  }, []);

  const pick = useCallback((id) => {
    const ex = examples?.find((e) => e.id === id);
    if (!ex) return;
    setExampleId(id);
    setSource(loadSource(id, ex.source));
    setLog("");
  }, [examples]);

  const onChange = useCallback((v) => {
    setSource(v);
    clearTimeout(saveTimer.current);
    const id = exampleId;
    saveTimer.current = setTimeout(() => {
      try { localStorage.setItem(LS_KEY + id, v); } catch { /* full */ }
    }, 500);
  }, [exampleId]);

  const revert = useCallback(() => {
    const ex = examples?.find((e) => e.id === exampleId);
    if (!ex) return;
    try { localStorage.removeItem(LS_KEY + exampleId); } catch { /* ignore */ }
    setSource(ex.source);
  }, [examples, exampleId]);

  const doBuild = useCallback(async () => {
    setBusy(true);
    setLog("");
    setProgress("starting build…");
    try {
      const r = await build(source, { onProgress: setProgress });
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
  }, [source]);

  const download = useCallback(() => {
    if (!rom) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([rom], { type: "application/octet-stream" }));
    a.download = `${exampleId}.gba`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [rom, exampleId]);

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

  const ex = examples.find((e) => e.id === exampleId);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">gbalua<span className="brand-dim"> web</span></span>
        <select value={exampleId} onChange={(e) => pick(e.target.value)}>
          {examples.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <button onClick={revert} title="discard local edits for this example">revert</button>
        <span style={{ flex: 1 }} />
        <span className="progress">{progress}</span>
        <button className="primary" onClick={doBuild} disabled={busy}>
          {busy ? "building…" : "Build & Run  (Ctrl+Enter)"}
        </button>
        <button onClick={download} disabled={!rom}>download .gba</button>
      </header>

      {ex?.assets && (
        <div className="notice">
          this example ships custom art in the SDK — browser builds use the fallback
          sprite until browser asset conversion lands, so it will look different here.
        </div>
      )}

      <div className="columns">
        <div className="editor-col">
          <Editor value={source} onChange={onChange} />
        </div>
        <div className="emu-col">
          <EmulatorPane rom={rom} />
          <pre className="build-log">{log}</pre>
        </div>
      </div>
    </div>
  );
}
