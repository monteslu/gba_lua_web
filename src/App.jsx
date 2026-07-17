// App — the gbalua web IDE shell.
//
// Root layout: project sidebar | editor panes (code / sprites / frames /
// music / backgrounds / cheatsheet) | emulator, with a problems/RAM debugger
// strip under the editor. Projects persist to IndexedDB (autosaved); Play
// (Ctrl+Enter or Ctrl+R) builds the CURRENT project with its assets through
// the real WASM arm-gcc pipeline and boots the ROM on the mGBA core.
import { useState, useMemo, useRef, useCallback, useEffect, Suspense, lazy } from "react";
import { compile } from "gbalua/compiler/index.js";
import EmulatorPane from "./emu/EmulatorPane.jsx";
import { RamViewer } from "./emu/RamViewer.jsx";
import { build, prewarm } from "./build/build-client.js";
import { Sidebar } from "./projects/Sidebar.jsx";
import { NewProjectModal, BLANK_SOURCE } from "./projects/NewProjectModal.jsx";
import { listProjects, getProject, createProject, saveProject, deleteProject } from "./projects/store.js";
import { loadExampleFiles } from "./examples.js";
import { readManifest, writeManifest, ensureManifest, defaultManifest } from "./projects/manifest.js";
import { zipWrite, zipRead } from "./zip.js";
import { downloadBytes, pickFile } from "./util/download.js";
import { useResizableColumns } from "./util/useResizableColumns.js";
import { SpriteEditor } from "./gfx/SpriteEditor.jsx";
import { sheetFromPng, sheetToPng, newSheet } from "./gfx/sheet-model.js";
import { FrameEditor } from "./gfx/FrameEditor.jsx";
import { MusicEditor } from "./audio/MusicEditor.jsx";
import { newSong, songToXm } from "./audio/xm-song.js";
import { p8ToProject, p8PngToProject } from "./import/p8-import.js";

const Editor = lazy(() => import("./Editor.jsx"));
const CheatsheetPane = lazy(() => import("./CheatsheetPane.jsx"));

const dec = new TextDecoder();
const enc = new TextEncoder();
const asText = (v) => (typeof v === "string" ? v : dec.decode(v));
const asBytes = (v) => (typeof v === "string" ? enc.encode(v) : v);

// music.json: the ordered songbook. Entries: { name, kind: "song", model } for
// tracker songs, { name, kind: "file", path } for imported modules (bytes live
// in files[path]). Build order = list order = music(n).
const parseSongbook = (text) => {
  if (!text) return [];
  try { return JSON.parse(text)?.entries ?? []; } catch { return []; }
};
const serializeSongbook = (entries) => JSON.stringify({ v: 1, entries }, null, 1);

export default function App() {
  const [projects, setProjects] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [projectName, setProjectName] = useState("");
  const [source, setSource] = useState("");
  const [sheet, setSheet] = useState(null);        // {width,height,px} or null
  const [mapPng, setMapPng] = useState(null);      // Uint8Array or null
  const [mode7Png, setMode7Png] = useState(null);
  const [songs, setSongs] = useState([]);          // songbook entries
  const [songIdx, setSongIdx] = useState(0);
  const [musicFiles, setMusicFiles] = useState({});  // path -> bytes (imported modules)
  const [view, setView] = useState("code");
  const [bottomTab, setBottomTab] = useState("problems");

  const [rom, setRom] = useState(null);
  const [host, setHost] = useState(null);
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState(null);   // { frac, label } while building
  const [warm, setWarm] = useState(false);
  const [buildMsg, setBuildMsg] = useState("");
  const [buildErr, setBuildErr] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const buildSeq = useRef(0);
  const saveTimers = useRef({});
  const { sidebarPx, emuPx, startSidebarDrag, startEmuDrag } = useResizableColumns();

  // --- projects list + initial project --------------------------------------
  const refreshProjects = useCallback(async () => {
    const list = await listProjects();
    setProjects(list);
    return list;
  }, []);

  const openProject = useCallback(async (id) => {
    const rec = await getProject(id);
    if (!rec) return;
    setCurrentId(rec.id);
    setProjectName(rec.name);
    setSource(asText(rec.files["main.lua"] ?? ""));
    setSheet(rec.files["sheet.png"] ? sheetFromPng(asBytes(rec.files["sheet.png"])) : null);
    setMapPng(rec.files["map.png"] ? asBytes(rec.files["map.png"]) : null);
    setMode7Png(rec.files["mode7.png"] ? asBytes(rec.files["mode7.png"]) : null);
    const book = parseSongbook(rec.files["music.json"] ? asText(rec.files["music.json"]) : null);
    setSongs(book);
    setSongIdx(0);
    const mf = {};
    for (const [p, v] of Object.entries(rec.files)) if (p.startsWith("music/")) mf[p] = asBytes(v);
    setMusicFiles(mf);
    setView("code");
    setRom(null); setBuildMsg(""); setBuildErr("");
  }, []);

  useEffect(() => {
    prewarm().then(() => setWarm(true));
    (async () => {
      const list = await refreshProjects();
      if (list.length) await openProject(list[0].id);
      else setShowNew(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- live compile ----------------------------------------------------------
  const result = useMemo(() => {
    if (!currentId) return { ok: true, diagnostics: [] };
    try { return compile(source, "main.lua", { target: "gba" }); }
    catch (e) {
      return { ok: false, diagnostics: [{ severity: "error", message: String(e?.message ?? e), line: 1, col: 1 }] };
    }
  }, [source, currentId]);
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  const warnings = result.diagnostics.filter((d) => d.severity === "warning");

  // --- debounced persistence --------------------------------------------------
  const persist = useCallback((key, mutate, debounceMs = 500) => {
    if (!currentId) return;
    clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = setTimeout(async () => {
      const rec = await getProject(currentId);
      if (!rec) return;
      mutate(rec);
      await saveProject(rec, Date.now());
      refreshProjects();
    }, debounceMs);
  }, [currentId, refreshProjects]);

  const onChange = useCallback((v) => {
    setSource(v);
    persist("lua", (rec) => { rec.files["main.lua"] = v; });
  }, [persist]);

  const onSheetChange = useCallback((img) => {
    setSheet(img);
    persist("sheet", (rec) => {
      if (img) rec.files["sheet.png"] = sheetToPng(img);
      else delete rec.files["sheet.png"];
    });
  }, [persist]);

  const setBgFile = useCallback((slot, bytes) => {
    (slot === "map" ? setMapPng : setMode7Png)(bytes);
    persist(slot, (rec) => {
      if (bytes) rec.files[`${slot}.png`] = bytes;
      else delete rec.files[`${slot}.png`];
    }, 50);
  }, [persist]);

  // musicFilesRef mirrors the musicFiles state so the debounced write always
  // sees the latest module bytes — NOT a stale `extraFiles` closure. Without
  // this, importing a module then quickly editing a note (whose write shares
  // the "music" debounce key and carries no extraFiles) would drop the import.
  const musicFilesRef = useRef(musicFiles);
  useEffect(() => { musicFilesRef.current = musicFiles; }, [musicFiles]);

  const persistSongbook = useCallback((entries) => {
    persist("music", (rec) => {
      rec.files["music.json"] = serializeSongbook(entries);
      const referenced = new Set(entries.filter((e) => e.kind === "file").map((e) => e.path));
      // drop unreferenced music/ files; write back every referenced one from
      // the live map (survives a note edit landing after an import)
      for (const p of Object.keys(rec.files)) {
        if (p.startsWith("music/") && !referenced.has(p)) delete rec.files[p];
      }
      for (const p of referenced) {
        const bytes = musicFilesRef.current[p];
        if (bytes) rec.files[p] = bytes;
      }
    }, 300);
  }, [persist]);

  const onSongsChange = useCallback((entries, extraFiles) => {
    setSongs(entries);
    // update the ref synchronously so a debounced write firing before React
    // commits still sees the new bytes
    if (extraFiles) {
      musicFilesRef.current = { ...musicFilesRef.current, ...extraFiles };
      setMusicFiles(musicFilesRef.current);
    }
    persistSongbook(entries);
  }, [persistSongbook]);

  // --- project ops -------------------------------------------------------------
  const newProject = useCallback(async () => {
    const files = { "main.lua": BLANK_SOURCE, "project.json": writeManifest(defaultManifest("untitled")) };
    const rec = await createProject("untitled", files, Date.now());
    await refreshProjects();
    await openProject(rec.id);
    setShowNew(false);
  }, [refreshProjects, openProject]);

  const forkExample = useCallback(async (ex) => {
    const files = await loadExampleFiles(ex);
    ensureManifest(files, ex.name);
    const rec = await createProject(ex.name, files, Date.now());
    await refreshProjects();
    await openProject(rec.id);
    setShowNew(false);
  }, [refreshProjects, openProject]);

  const removeProject = useCallback(async (id) => {
    await deleteProject(id);
    const list = await refreshProjects();
    if (id === currentId) {
      if (list.length) await openProject(list[0].id);
      else {
        setCurrentId(null); setProjectName(""); setSource("");
        setSheet(null); setMapPng(null); setMode7Png(null);
        setSongs([]); setMusicFiles({}); setRom(null); setView("code");
        setShowNew(true);
      }
    }
  }, [currentId, refreshProjects, openProject]);

  const rename = useCallback((name) => {
    setProjectName(name);
    persist("name", (rec) => {
      rec.name = name || "untitled";
      const m = readManifest(rec.files["project.json"] && asText(rec.files["project.json"]), rec.name);
      m.title = rec.name;
      rec.files["project.json"] = writeManifest(m);
    });
  }, [persist]);

  // --- build assets from the project state --------------------------------------
  const buildAssets = useCallback(() => {
    const assets = {};
    if (sheet) assets.sheet = { name: "sheet.png", bytes: sheetToPng(sheet) };
    if (mapPng) assets.map = { name: "map.png", bytes: mapPng };
    if (mode7Png) assets.mode7 = { name: "mode7.png", bytes: mode7Png };
    if (songs.length) {
      assets.music = songs.map((e) =>
        e.kind === "song"
          ? { name: `${e.name}.xm`, bytes: songToXm(e.model, e.name) }
          : { name: e.name, bytes: musicFiles[e.path] }).filter((m) => m.bytes);
    }
    return assets;
  }, [sheet, mapPng, mode7Png, songs, musicFiles]);

  // --- play ---------------------------------------------------------------------
  const play = useCallback(async () => {
    if (errors.length || !warm || !currentId || building) return;
    const seq = ++buildSeq.current;
    setBuilding(true); setBuildErr(""); setBuildMsg("building…");
    setProgress({ frac: 0, label: "starting…" });
    try {
      const r = await build(source, {
        assets: buildAssets(),
        onProgress: (p) => {
          if (seq !== buildSeq.current) return;
          // pipeline emits { frac, label }; be tolerant of a bare string too
          if (p && typeof p === "object") { setProgress(p); setBuildMsg(p.label); }
          else { setBuildMsg(String(p)); }
        },
      });
      if (seq !== buildSeq.current) return;
      if (r.ok && r.rom) {
        setProgress({ frac: 1, label: "done" });
        setBuildMsg(`built ${r.rom.length.toLocaleString()} bytes`);
        setRom(r.rom);
      } else {
        setBuildErr((r.log || "build failed").split("\n").filter(Boolean).slice(-3).join(" · "));
        setBuildMsg("");
      }
    } catch (e) {
      if (seq !== buildSeq.current) return;
      setBuildErr(String(e?.message ?? e));
      setBuildMsg("");
    } finally {
      if (seq === buildSeq.current) setBuilding(false);
    }
  }, [source, errors.length, warm, currentId, building, buildAssets]);

  // Ctrl+Enter / Ctrl+R = play
  useEffect(() => {
    const h = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "Enter" || e.key === "r" || e.key === "R")) {
        e.preventDefault();
        play();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [play]);

  // clicking outside the emulator hands keyboard focus back to the editors
  useEffect(() => {
    const onDown = (e) => {
      const active = document.activeElement;
      if (active?.closest?.(".emu-screen") && !e.target.closest?.(".emu-screen")) active.blur();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, []);

  // --- export / import -------------------------------------------------------------
  const downloadRom = useCallback(() => {
    if (rom) downloadBytes(`${projectName || "game"}.gba`, rom);
  }, [rom, projectName]);

  const exportBundle = useCallback(async () => {
    const rec = currentId ? await getProject(currentId) : { files: { "main.lua": source } };
    const files = {};
    for (const [p, v] of Object.entries(rec.files)) files[p] = asBytes(v);
    downloadBytes(`${projectName || "project"}.zip`, zipWrite(files), "application/zip");
  }, [currentId, source, projectName]);

  const importBundle = useCallback(async () => {
    const picked = await pickFile(".zip,.p8,.png");
    if (!picked) return;
    try {
      if (/\.p8$/i.test(picked.name) || /\.png$/i.test(picked.name)) {
        const name = picked.name.replace(/\.p8\.png$/i, "").replace(/\.(p8|png)$/i, "");
        const { files } = /\.png$/i.test(picked.name)
          ? p8PngToProject(picked.bytes, name)
          : p8ToProject(dec.decode(picked.bytes), name);
        ensureManifest(files, name);
        const rec = await createProject(name, files, Date.now());
        await refreshProjects();
        await openProject(rec.id);
        return;
      }
      const entries = zipRead(picked.bytes);
      const files = {};
      for (const [p, bytes] of Object.entries(entries)) {
        files[p] = (p.endsWith(".lua") || p.endsWith(".json")) ? dec.decode(bytes) : bytes;
      }
      if (!files["main.lua"]) {
        const lua = Object.keys(files).find((p) => p.endsWith(".lua"));
        if (!lua) throw new Error("zip has no .lua source");
        files["main.lua"] = files[lua];
      }
      const name = picked.name.replace(/\.zip$/i, "");
      const m = ensureManifest(files, name);
      const rec = await createProject(m.title || name, files, Date.now());
      await refreshProjects();
      await openProject(rec.id);
    } catch (e) {
      setBuildErr(`import failed: ${e?.message ?? e}`);
    }
  }, [refreshProjects, openProject]);

  // --- test hook (installed by main.jsx; here we bind the app-level pieces) -------
  useEffect(() => {
    if (!window.__gbaluaWeb) return;
    window.__gbaluaWeb.setSource = (t) => onChange(t);
    window.__gbaluaWeb.getSource = () => source;
    window.__gbaluaWeb.getHost = () => host;
    window.__gbaluaWeb.buildCurrent = () => build(source, { assets: buildAssets() });
  }, [onChange, source, host, buildAssets]);

  const tabs = [
    ["code", "main.lua"],
    ["sprite", sheet ? "sprites" : "+ sprites"],
    ["frames", "frames"],
    ["music", songs.length ? `music (${songs.length})` : "+ music"],
    ["bg", "backgrounds"],
    ["cheat", "📖 cheatsheet"],
  ];

  return (
    <div className="ide">
      <header className="topbar">
        <span className="logo">gbalua <span className="dim">web</span></span>
        <button className="play" onClick={play}
          disabled={!warm || !currentId || building || errors.length > 0}
          title={warm ? "build & run (Ctrl+Enter / Ctrl+R)" : "warming up the build tools…"}>
          {building ? "building…" : warm ? "▶ Play" : "warming up…"}
        </button>
        <button className="tb-btn" onClick={downloadRom} disabled={!rom} title="download the built .gba ROM">.gba</button>
        <button className="tb-btn" onClick={importBundle} title="import a project .zip or a PICO-8 .p8 / .p8.png cart">import</button>
        <button className="tb-btn" onClick={exportBundle} disabled={!currentId} title="export the project as a plain .zip">export</button>
        <input className="proj-name" value={projectName} placeholder="project name"
          onChange={(e) => rename(e.target.value)} disabled={!currentId} />
        <span className={"status " + (errors.length ? "err" : "ok")}>
          {errors.length ? `${errors.length} error${errors.length > 1 ? "s" : ""}` : warm ? "ready" : "warming up…"}
          {warnings.length ? ` · ${warnings.length} warning${warnings.length > 1 ? "s" : ""}` : ""}
        </span>
        <span className="build-msg">{buildErr ? <span className="err">{buildErr}</span> : buildMsg}</span>
      </header>

      <div className="body">
        <Sidebar width={sidebarPx} projects={projects} currentId={currentId}
          onOpen={openProject} onNew={() => setShowNew(true)}
          onDelete={(id) => setConfirmDelete(projects.find((p) => p.id === id) ?? { id, name: "this project" })} />
        <div className="col-resizer" onPointerDown={startSidebarDrag} title="drag to resize" />

        {showNew && (
          <NewProjectModal onClone={forkExample} onBlank={newProject}
            onClose={() => setShowNew(false)} dismissable={!!currentId} />
        )}
        {confirmDelete && (
          <div className="modal-back" onClick={(e) => { if (e.target === e.currentTarget) setConfirmDelete(null); }}>
            <div className="confirm-box">
              <div className="confirm-title">Delete project?</div>
              <p className="confirm-text">
                <b>{confirmDelete.name}</b> and everything in it (code, sprites, music) will be deleted. This can't be undone.
              </p>
              <div className="confirm-actions">
                <button onClick={() => setConfirmDelete(null)}>Cancel</button>
                <button className="confirm-danger" onClick={() => { removeProject(confirmDelete.id); setConfirmDelete(null); }}>Delete</button>
              </div>
            </div>
          </div>
        )}

        <main className="panes" style={{ gridTemplateColumns: `minmax(0, 1fr) ${emuPx}px` }}>
          <section className="pane editor-pane">
            {!currentId && (
              <div className="no-project">
                <p>nothing open yet</p>
                <button className="side-new" onClick={() => setShowNew(true)}>+ New Project</button>
              </div>
            )}
            {currentId && (<>
              <div className="pane-tabs">
                {tabs.map(([id, label]) => (
                  <button key={id} className={"tab " + (view === id ? "sel" : "")} onClick={() => setView(id)}>{label}</button>
                ))}
              </div>
              <div className="pane-body" style={{ display: view === "code" ? "flex" : "none" }}>
                <Suspense fallback={<div className="pane-loading">loading editor…</div>}>
                  <Editor value={source} onChange={onChange} />
                </Suspense>
              </div>
              {view === "sprite" && <SpriteEditor sheet={sheet} onChange={onSheetChange} />}
              {view === "frames" && <FrameEditor sheet={sheet} />}
              {view === "music" && (
                <MusicPane songs={songs} songIdx={songIdx} setSongIdx={setSongIdx}
                  musicFiles={musicFiles} onChange={onSongsChange} />
              )}
              {view === "bg" && (
                <BackgroundsPane mapPng={mapPng} mode7Png={mode7Png} setBgFile={setBgFile} setBuildErr={setBuildErr} />
              )}
              {view === "cheat" && (
                <Suspense fallback={<div className="pane-loading">loading…</div>}>
                  <CheatsheetPane onClose={() => setView("code")} embedded />
                </Suspense>
              )}
            </>)}
          </section>

          <section className="pane emu-col">
            <div className="col-resizer emu-resizer" onPointerDown={startEmuDrag} title="drag to resize" />
            <EmulatorPane rom={rom} onHost={setHost} building={building} progress={progress} />
            <div className="pane-tabs bottom">
              <button className={"tab " + (bottomTab === "problems" ? "sel" : "")} onClick={() => setBottomTab("problems")}>
                problems{errors.length ? ` (${errors.length})` : ""}
              </button>
              <button className={"tab " + (bottomTab === "ram" ? "sel" : "")} onClick={() => setBottomTab("ram")}>RAM</button>
            </div>
            {bottomTab === "problems" && (
              <ul className="problems">
                {result.diagnostics.length === 0 && <li className="ok">no problems — compiles clean</li>}
                {result.diagnostics.map((d, i) => (
                  <li key={i} className={d.severity}>
                    <span className="loc">{d.line}:{d.col}</span> {d.message}
                  </li>
                ))}
              </ul>
            )}
            {bottomTab === "ram" && <RamViewer host={host} />}
          </section>
        </main>
      </div>
    </div>
  );
}

// ---- music pane: the songbook bar + tracker / module list ---------------------
function MusicPane({ songs, songIdx, setSongIdx, musicFiles, onChange }) {
  const active = songs[songIdx];

  const addSong = () => {
    const entries = [...songs, { name: `song ${songs.length}`, kind: "song", model: newSong() }];
    setSongIdx(entries.length - 1);
    onChange(entries);
  };
  const importModule = async () => {
    const picked = await pickFile(".xm,.mod,.it,.s3m");
    if (!picked) return;
    const path = `music/${picked.name}`;
    const entries = [...songs, { name: picked.name, kind: "file", path }];
    setSongIdx(entries.length - 1);
    onChange(entries, { [path]: picked.bytes });
  };
  const removeAt = (i) => {
    const entries = songs.filter((_, j) => j !== i);
    setSongIdx(Math.max(0, Math.min(songIdx, entries.length - 1)));
    onChange(entries);
  };
  const renameAt = (i) => {
    const name = prompt("song name", songs[i].name);
    if (name == null || !name.trim()) return;
    const entries = songs.slice();
    entries[i] = { ...entries[i], name: name.trim() };
    onChange(entries);
  };
  const onModelChange = (m) => {
    const entries = songs.slice();
    entries[songIdx] = { ...entries[songIdx], model: m };
    onChange(entries);
  };

  if (!songs.length) {
    return (
      <div className="music-empty">
        <p>no music yet — <code>music(0)</code> plays the default chiptune until you add your own</p>
        <div className="music-empty-actions">
          <button className="tb-btn" onClick={addSong}>+ compose a song (tracker)</button>
          <button className="tb-btn" onClick={importModule}>import .xm / .mod / .it / .s3m</button>
        </div>
      </div>
    );
  }

  return (
    <div className="music-pane-wrap">
      <div className="song-bar" title="music(n) plays the nth entry — order matters">
        {songs.map((s, i) => (
          <button key={i} className={"song-tab " + (i === songIdx ? "sel" : "")}
            onClick={() => setSongIdx(i)} onDoubleClick={() => renameAt(i)}
            title="click to switch · double-click to rename">
            {s.kind === "file" ? "🎵 " : ""}{s.name}
          </button>
        ))}
        <button className="song-add" onClick={addSong} title="compose another song">＋</button>
        <button className="song-add" onClick={importModule} title="import a tracker module">🎵＋</button>
        {songs.length > 0 && (
          <button className="song-del" onClick={() => { if (confirm(`Remove "${songs[songIdx].name}"?`)) removeAt(songIdx); }}
            title="remove the active entry">🗑</button>
        )}
      </div>
      <div className="music-usebar">
        <span className="music-usehint">
          <b>play in game:</b> <code>music({songIdx})</code> plays this entry · entries build into the soundbank by position
        </span>
      </div>
      {active?.kind === "song"
        ? <MusicEditor song={active.model} songName={active.name} onChange={onModelChange} />
        : (
          <div className="module-info">
            <p><b>{active?.name}</b> — an imported tracker module ({((musicFiles[active?.path]?.length ?? 0) / 1024).toFixed(1)} KB).</p>
            <p className="dim">Compiled into the Maxmod soundbank as-is at build time. Edit it in OpenMPT/MilkyTracker and re-import, or compose a new song here.</p>
          </div>
        )}
    </div>
  );
}

// ---- backgrounds pane: the map + mode7 planes ----------------------------------
function BackgroundsPane({ mapPng, mode7Png, setBgFile, setBuildErr }) {
  const slot = async (name) => {
    // multi-pick: a .tmx map needs its tileset image alongside it
    const { pickFiles } = await import("./util/download.js");
    const picked = await pickFiles(".png,.ase,.aseprite,.tmx");
    if (!picked.length) return;
    try {
      const { importImage } = await import("./import/image-import.js");
      const main = picked.find((f) => !/\.png$/i.test(f.name)) ?? picked[0];
      const siblings = {};
      for (const f of picked) siblings[f.name] = f.bytes;
      const out = importImage(main, siblings);
      setBgFile(name, out.bytes);
    } catch (e) { setBuildErr(`${name} import failed: ${e?.message ?? e}`); }
  };
  const Preview = ({ bytes }) => {
    const draw = async (cv) => {
      if (!cv || !bytes) return;
      const { decodePng } = await import("gbalua/compiler/png-tiles.mjs");
      try {
        const { width, height, rgba } = decodePng(bytes);
        cv.width = width; cv.height = height;
        const ctx = cv.getContext("2d");
        const id = ctx.createImageData(width, height);
        id.data.set(rgba);
        ctx.putImageData(id, 0, 0);
        cv.style.width = `${Math.min(400, width * 2)}px`;
      } catch { /* preview only */ }
    };
    return <canvas className="asset-preview" ref={draw} />;
  };
  const Slot = ({ name, label, hint, bytes }) => (
    <div className="bg-slot">
      <div className="bg-slot-head">
        <b>{label}</b>
        <button className="tb-btn" onClick={() => slot(name)}>import .png / .ase / .tmx</button>
        {bytes && <button className="tb-btn" onClick={() => setBgFile(name, null)}>clear</button>}
        <span className="dim">{bytes ? `${(bytes.length / 1024).toFixed(1)} KB` : hint}</span>
      </div>
      {bytes ? <Preview bytes={bytes} /> : null}
    </div>
  );
  return (
    <div className="bg-pane">
      <Slot name="map" label="tile map (map_show)"
        hint="none — 4bpp, 15 colors + transparent; tiles dedupe automatically" bytes={mapPng} />
      <Slot name="mode7" label="mode 7 plane (mode7)"
        hint="none — square, 128/256/512/1024 px per side, up to 255 colors" bytes={mode7Png} />
      <div className="music-hint">
        a .tmx needs its tileset image — pick both files together when prompted (Tiled: embed the tileset in the map)
      </div>
    </div>
  );
}
