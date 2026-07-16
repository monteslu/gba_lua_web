// examples.js — the gallery, staged from the gbalua npm package into
// /gba/examples.json by scripts/stage-toolchain.mjs (the package's exports map
// doesn't expose ./examples/*, so we bundle at stage time instead of
// deep-importing). Single source of truth stays the SDK's own examples.
// `assets` maps slot -> file name ({sheet: "shmup_sheet.png"}); the files are
// staged under /gba/examples/<id>/ and fetched on demand so an example builds
// with its REAL art, matching the SDK CI's --sheet/--mode7 flags.

let cached = null;

/** @returns {Promise<Array<{id:string,name:string,assets:Record<string,string>,source:string}>>} */
export async function loadExamples() {
  if (cached) return cached;
  const r = await fetch("/gba/examples.json");
  if (!r.ok) throw new Error(`fetch examples.json: ${r.status}`);
  cached = await r.json();
  return cached;
}

/**
 * Fetch an example's staged asset files as pipeline-ready assets.
 * @param {{id:string, assets:Record<string,string>}} example
 * @returns {Promise<{sheet?:{name,bytes}, map?:{name,bytes}, mode7?:{name,bytes}}>}
 */
export async function loadExampleAssets(example) {
  const out = {};
  for (const [slot, file] of Object.entries(example.assets ?? {})) {
    const r = await fetch(`/gba/examples/${example.id}/${file}`);
    if (!r.ok) throw new Error(`fetch example asset ${file}: ${r.status}`);
    out[slot] = { name: file, bytes: new Uint8Array(await r.arrayBuffer()) };
  }
  return out;
}
