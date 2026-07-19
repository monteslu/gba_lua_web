// browser-build.mjs — the acceptance gates, in a REAL browser:
//   1. BYTE-IDENTICAL: build hello in the browser worker (actual WASM arm-gcc),
//      build the same source with the gbalua CLI, assert equal bytes.
//   2. BOOT SMOKE: run the browser-built ROM 120 frames on the mGBA core and
//      assert the canvas isn't blank.
//   3. ASSETS BYTE-IDENTICAL: build starfall WITH its sprite sheet in the
//      browser vs `gbalua build --sheet` — proves the browser asset path
//      (SDK asset-headers in a worker) matches the CLI exactly.
// Run: node test/browser-build.mjs   (starts vite dev internally)
import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const GBALUA = path.dirname(require.resolve("gbalua/package.json"));

const source = await readFile(path.join(GBALUA, "examples", "hello", "main.lua"), "utf8");
const sfSource = await readFile(path.join(GBALUA, "examples", "starfall", "main.lua"), "utf8");
const sfSheetPath = path.join(GBALUA, "examples", "starfall", "shmup_sheet.png");
const sfSheet = await readFile(sfSheetPath);

// ── CLI reference builds (the byte-identical baselines) ───────────────────────
const work = await mkdtemp(path.join(tmpdir(), "gbalua-web-test-"));
const cliRomPath = path.join(work, "cli.gba");
const srcPath = path.join(work, "main.lua");
await writeFile(srcPath, source);
execFileSync("node", [path.join(GBALUA, "bin", "gbalua.js"), "build", srcPath, "-o", cliRomPath], { stdio: "pipe" });
const cliRom = await readFile(cliRomPath);
console.log(`CLI ROM: ${cliRom.length} bytes`);

const sfRomPath = path.join(work, "sf.gba");
const sfSrcPath = path.join(work, "sf.lua");
await writeFile(sfSrcPath, sfSource);
execFileSync("node", [path.join(GBALUA, "bin", "gbalua.js"), "build", sfSrcPath,
  "--sheet", sfSheetPath, "-o", sfRomPath], { stdio: "pipe" });
const sfCliRom = await readFile(sfRomPath);
console.log(`CLI starfall ROM (--sheet): ${sfCliRom.length} bytes`);

// ── start vite dev ────────────────────────────────────────────────────────────
// spawn the vite bin directly (not via npx — killing the npx wrapper strands
// the real vite child and leaks the port), detached so we can kill the group.
const viteBin = path.join(HERE, "node_modules", ".bin", "vite");
const vite = spawn(viteBin, ["--port", "5273", "--strictPort"], {
  cwd: HERE, stdio: ["ignore", "pipe", "pipe"], detached: true,
});
const killVite = () => { try { process.kill(-vite.pid, "SIGTERM"); } catch { try { vite.kill(); } catch { /* gone */ } } };
let viteOut = "";
vite.stdout.on("data", (d) => { viteOut += d; });
vite.stderr.on("data", (d) => { viteOut += d; });
const ready = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), 30000);
  const iv = setInterval(() => {
    if (/localhost:5273/.test(viteOut.replace(/\x1b\[[0-9;]*m/g, ""))) { clearTimeout(t); clearInterval(iv); resolve(true); }
  }, 200);
});
if (!ready) { killVite(); throw new Error("vite dev did not start:\n" + viteOut); }

let failed = false;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("[page]", m.text()); });
  await page.goto("http://localhost:5273/", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__gbaluaWeb, { timeout: 15000 });

  // gate 1: byte-identical
  console.log("building in the browser (first build compiles the 38MB cc1 wasm — be patient)…");
  const r = await page.evaluate((src) => window.__gbaluaWeb.build(src), source);
  if (!r.ok) throw new Error("browser build failed:\n" + r.log);
  const webRom = Buffer.from(r.romBase64, "base64");
  console.log(`browser ROM: ${webRom.length} bytes`);
  if (!webRom.equals(cliRom)) {
    failed = true;
    console.error(`FAIL: browser ROM differs from CLI ROM (${webRom.length} vs ${cliRom.length} bytes)`);
  } else {
    console.log("PASS: browser ROM is byte-identical to the CLI ROM");
  }

  // gate 2: boot smoke on the mGBA core
  const smoke = await page.evaluate(
    (b64) => window.__gbaluaWeb.bootSmoke(b64, 120),
    r.romBase64,
  );
  if (smoke.pixelSum <= 0) {
    failed = true;
    console.error("FAIL: emulator canvas is blank after 120 frames");
  } else {
    console.log(`PASS: emulator renders (pixel sum ${smoke.pixelSum})`);
  }

  // gate 3: assets byte-identical (starfall + its sheet, sound + sheet path)
  console.log("building starfall with its sprite sheet in the browser…");
  const r3 = await page.evaluate(
    ({ src, sheetB64 }) => window.__gbaluaWeb.build(src, { sheet: { name: "shmup_sheet.png", b64: sheetB64 } }),
    { src: sfSource, sheetB64: sfSheet.toString("base64") },
  );
  if (!r3.ok) throw new Error("browser starfall build failed:\n" + r3.log);
  const sfWebRom = Buffer.from(r3.romBase64, "base64");
  console.log(`browser starfall ROM: ${sfWebRom.length} bytes`);
  if (!sfWebRom.equals(sfCliRom)) {
    failed = true;
    console.error(`FAIL: starfall browser ROM differs from CLI --sheet ROM (${sfWebRom.length} vs ${sfCliRom.length} bytes)`);
  } else {
    console.log("PASS: starfall (sheet + sound) browser ROM is byte-identical to the CLI ROM");
  }
} finally {
  await browser.close();
  killVite();
  await rm(work, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("all browser gates green");
