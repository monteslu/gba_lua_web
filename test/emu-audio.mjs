// emu-audio.mjs — boot the "effects" example ROM in the mGBA core and measure
// the audio the core actually produces. Catches "sounds like shit" objectively:
//   - the core emits a STEADY stream (~sampleRate/fps samples per video frame)
//   - the stream is audible (RMS above floor) and doesn't clip (peak <= 1.0)
//   - no long internal silent runs (dropouts)
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
const results = [];
const ok = (name, cond, extra = "") => { results.push(!!cond); console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? ` (${extra})` : ""}`); };

// build the effects example (it plays music(0)) with the CLI so we have a ROM
const work = await mkdtemp(path.join(tmpdir(), "gbalua-emu-audio-"));
const src = await readFile(path.join(GBALUA, "examples", "effects", "main.lua"), "utf8");
// ensure it makes sound: the example calls music(0)
const srcWithMusic = /\bmusic\s*\(/.test(src) ? src : src.replace("function _init()", "function _init()\n  music(0)");
const srcPath = path.join(work, "main.lua");
const romPath = path.join(work, "effects.gba");
await writeFile(srcPath, srcWithMusic);
execFileSync("node", [path.join(GBALUA, "bin", "gbalua.js"), "build", srcPath, "-o", romPath], { stdio: "pipe" });
const romB64 = (await readFile(romPath)).toString("base64");
console.log("built effects ROM with music(0)");

const vite = spawn(path.join(HERE, "node_modules", ".bin", "vite"), ["--port", "5293", "--strictPort"], {
  cwd: HERE, stdio: ["ignore", "pipe", "pipe"], detached: true,
});
let out = ""; vite.stdout.on("data", (d) => { out += d; });
await new Promise((res) => { const iv = setInterval(() => { if (/5293/.test(out)) { clearInterval(iv); res(); } }, 200); });

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("[page]", m.text()); });
  await page.goto("http://localhost:5293/", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__gbaluaWeb, { timeout: 20000 });

  const stats = await page.evaluate((b64) => window.__gbaluaWeb.audioProbe(b64, 400), romB64);
  console.log("stats:", JSON.stringify(stats));

  // the GBA core outputs ~sampleRate/fps ≈ 32768/59.7 ≈ 549 stereo frames per
  // video frame; assert the core is steadily producing audio
  ok("core produces a steady audio stream", stats.framesPerVideoFrame > 400, `${stats.framesPerVideoFrame.toFixed(0)} frames/vf`);
  ok("emulator audio is audible (music playing)", stats.rms > 0.01, `rms ${stats.rms.toFixed(4)}`);
  ok("emulator audio does not clip", stats.peak <= 1.0001, `peak ${stats.peak.toFixed(3)}`);
  // after the intro, no dropout longer than ~40ms (a real playback dropout is
  // much longer + repeated; short runs are the tune's own rhythmic rests).
  // 40ms @ 65536 stereo ≈ 5200 samples.
  ok("no long internal silence after intro (no dropouts)", stats.maxSilentRun < 5200, `longest run ${stats.maxSilentRun} samples after ${(stats.firstSound / 2 / 65536).toFixed(2)}s intro`);

  // the resampler must PRESERVE PITCH: push a 440Hz sine at the core rate
  // (65536), pull at a 48000 context, and confirm the output is still ~440Hz
  // (a broken/no-resample path would shift it by 65536/48000 = 1.37x).
  const pitch = await page.evaluate(async () => {
    const { MgbaHost } = await import("/src/emu/mgba-host.js");
    const h = new MgbaHost();
    h.sampleRate = 65536;
    // fake a 48000 context + wire the ring exactly like _initAudio
    h._audioCtx = { sampleRate: 48000, state: "running", resume() {}, close() {} };
    h._resampleStep = 65536 / 48000;
    h._resamplePos = 0;
    h._ringCap = 65536; h._ring = new Float32Array(h._ringCap * 2); h._resetRing();
    // fill ~0.4s of a 440Hz sine at 65536
    const N = Math.floor(65536 * 0.4);
    const s16 = new Int16Array(N * 2);
    for (let i = 0; i < N; i++) { const v = Math.round(Math.sin(2 * Math.PI * 440 * i / 65536) * 20000); s16[i * 2] = v; s16[i * 2 + 1] = v; }
    h._pushAudio(s16, N);
    h._primed = true;
    // pull it into a 48000 output buffer and count zero-crossings -> frequency
    const outN = Math.floor(48000 * 0.3);
    const outL = new Float32Array(outN);
    const fake = { length: 512, getChannelData: (c) => (c === 0 ? subL : subR) };
    let subL, subR, pos = 0;
    while (pos + 512 <= outN) {
      subL = new Float32Array(512); subR = new Float32Array(512);
      h._pullAudio(fake);
      outL.set(subL, pos); pos += 512;
    }
    let crossings = 0;
    for (let i = 1; i < pos; i++) if (outL[i - 1] < 0 && outL[i] >= 0) crossings++;
    return (crossings / (pos / 48000));   // Hz
  });
  ok("resampler preserves pitch (65536->48000)", Math.abs(pitch - 440) < 20, `${pitch.toFixed(0)}Hz (want ~440)`);
} finally {
  await browser.close();
  try { process.kill(-vite.pid, "SIGTERM"); } catch { vite.kill(); }
  await rm(work, { recursive: true, force: true });
}

const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
