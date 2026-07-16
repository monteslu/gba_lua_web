// examples.js — the gallery, staged from the gbalua npm package into
// /gba/examples.json by scripts/stage-toolchain.mjs (the package's exports map
// doesn't expose ./examples/*, so we bundle at stage time instead of
// deep-importing). Single source of truth stays the SDK's own examples.
// `assets: true` entries ship custom art in the SDK; browser builds fall back
// to the built-in sprite until browser asset conversion lands (SDK A2).

let cached = null;

/** @returns {Promise<Array<{id:string,name:string,assets:boolean,source:string}>>} */
export async function loadExamples() {
  if (cached) return cached;
  const r = await fetch("/gba/examples.json");
  if (!r.ok) throw new Error(`fetch examples.json: ${r.status}`);
  cached = await r.json();
  return cached;
}
