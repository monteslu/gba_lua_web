// gen-thumbs.mjs — regenerate the example gallery thumbnails: build every
// example in the browser (real pipeline, real assets), run it ~3 seconds on
// the mGBA core, and save the canvas as examples-thumbs/<id>.png (checked in;
// staged into public/gba/examples/<id>/thumb.png by the stage script).
//
//   node test/gen-thumbs.mjs
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(HERE, "examples-thumbs");
await mkdir(OUT, { recursive: true });

const vite = spawn(path.join(HERE, "node_modules", ".bin", "vite"), ["--port", "5281", "--strictPort"], {
  cwd: HERE, stdio: ["ignore", "pipe", "pipe"], detached: true,
});
let out = "";
vite.stdout.on("data", (d) => { out += d; });
await new Promise((res) => { const iv = setInterval(() => { if (/5281/.test(out)) { clearInterval(iv); res(); } }, 200); });

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("[page]", m.text()); });
  await page.goto("http://localhost:5281/", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__gbaluaWeb, { timeout: 20000 });

  const examples = await page.evaluate(() => fetch("/gba/examples.json").then((r) => r.json()));
  for (const ex of examples) {
    console.log(`building ${ex.id}…`);
    // fetch the example's assets in-page and build with them
    const dataUrl = await page.evaluate(async (e) => {
      const assets = {};
      for (const [slot, file] of Object.entries(e.assets ?? {})) {
        const r = await fetch(`/gba/examples/${e.id}/${file}`);
        const bytes = new Uint8Array(await r.arrayBuffer());
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        assets[slot] = { name: file, b64: btoa(s) };
      }
      const r = await window.__gbaluaWeb.build(e.source, assets);
      if (!r.ok) throw new Error(`${e.id} build failed: ${r.log?.slice(-400)}`);
      // starfall sits on a title screen — press Start (RetroPad 3) at frame 60
      const presses = e.id === "starfall" ? [{ pad: 3, at: 60, hold: 5 }] : [];
      return window.__gbaluaWeb.bootShot(r.romBase64, 240, presses);
    }, ex);
    const png = Buffer.from(dataUrl.split(",")[1], "base64");
    await writeFile(path.join(OUT, `${ex.id}.png`), png);
    console.log(`  ${ex.id}.png (${png.length} bytes)`);
  }
} finally {
  await browser.close();
  try { process.kill(-vite.pid, "SIGTERM"); } catch { vite.kill(); }
}
console.log("thumbnails written to examples-thumbs/ — restage to publish them");
