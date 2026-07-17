// ProjectSettings — the project.json editor, same shape/role as the GameTank
// web IDE's settings tab. A friendly front-end for the project's metadata
// (name, game title, ROM filename) so you don't hand-edit JSON. `project` is
// the parsed manifest; onChange gets the updated object; onRename updates the
// project's display name (the sidebar entry).
export function ProjectSettings({ project, onChange, projectName, onRename }) {
  const p = project || {};
  const set = (k, v) => {
    const next = { ...p };
    if (v === "" || v === undefined) delete next[k];
    else next[k] = v;
    onChange(next);
  };

  return (
    <div className="settings">
      <div className="settings-inner">
        <h2>Project settings</h2>
        <p className="settings-sub">
          Saved as <code>project.json</code>, carried along by exports and forks.
        </p>

        <label className="settings-field">
          <span className="settings-label">Project name</span>
          <input type="text" value={projectName ?? ""} onChange={(e) => onRename?.(e.target.value)} />
          <span className="settings-hint">how it appears in the projects list on the left</span>
        </label>

        <label className="settings-field">
          <span className="settings-label">Game title</span>
          <input type="text" value={p.title ?? ""} placeholder={projectName || "My GBA Game"}
            onChange={(e) => set("title", e.target.value)} />
          <span className="settings-hint">shown on the gallery card / in exports</span>
        </label>

        <label className="settings-field">
          <span className="settings-label">ROM file name</span>
          <input type="text" value={p.romname ?? ""} placeholder={`${projectName || "game"}.gba`}
            onChange={(e) => set("romname", e.target.value)} />
          <span className="settings-hint">the name used when you download the <code>.gba</code></span>
        </label>

        <div className="settings-note">
          <b>Number model:</b> gbalua always uses 16.16 fixed-point (±32767.99, sub-pixel
          precision) — the GBA's 32-bit ARM has the headroom, so there's no smaller/faster
          mode to choose. There's no cart banking to configure either; a GBA ROM is one flat image.
        </div>
      </div>
    </div>
  );
}
