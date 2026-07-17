// manifest.js - project.json: the project's metadata. Deliberately tiny —
// { title } today; build knobs land here if the SDK grows them.

export function defaultManifest(title) {
  return { title: title || "untitled" };
}

/** Parse a project.json string; always returns a complete manifest. */
export function readManifest(text, fallbackTitle) {
  let m = {};
  if (text) { try { m = JSON.parse(text) ?? {}; } catch { /* rebuild below */ } }
  return { ...defaultManifest(fallbackTitle), ...m };
}

export function writeManifest(m) {
  return JSON.stringify(m, null, 2) + "\n";
}

/** Make sure files has a project.json; returns the (parsed) manifest. */
export function ensureManifest(files, title) {
  const m = readManifest(typeof files["project.json"] === "string"
    ? files["project.json"]
    : files["project.json"] ? new TextDecoder().decode(files["project.json"]) : null, title);
  files["project.json"] = writeManifest(m);
  return m;
}
