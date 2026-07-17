// examples.js — the gallery, staged from the gbalua npm package into
// /gba/examples.json by scripts/stage-toolchain.mjs. Single source of truth
// stays the SDK's own examples. Each entry: { id, name, blurb, thumb,
// assets: {slot: file}, source }. Asset files + thumb.png are staged under
// /gba/examples/<id>/.

let cached = null;

export async function loadExamples() {
  if (cached) return cached;
  const r = await fetch("/gba/examples.json");
  if (!r.ok) throw new Error(`fetch examples.json: ${r.status}`);
  cached = await r.json();
  return cached;
}

/**
 * An example's files, project-shaped (main.lua + sheet.png/mode7.png/...),
 * ready for createProject().
 * @param {{id:string, assets:Record<string,string>, source:string}} example
 */
export async function loadExampleFiles(example) {
  const files = { "main.lua": example.source };
  const SLOT_FILE = { sheet: "sheet.png", map: "map.png", mode7: "mode7.png" };
  for (const [slot, file] of Object.entries(example.assets ?? {})) {
    const r = await fetch(`/gba/examples/${example.id}/${file}`);
    if (!r.ok) throw new Error(`fetch example asset ${file}: ${r.status}`);
    files[SLOT_FILE[slot] ?? file] = new Uint8Array(await r.arrayBuffer());
  }
  return files;
}
