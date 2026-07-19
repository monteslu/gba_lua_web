// realtime-audio.mjs — the test that actually catches browser choppiness:
// drive the host's REAL frame loop + ring buffer + pull path under simulated
// realtime, capturing what the ScriptProcessor delivers to the speakers (not
// the core's raw output). Asserts the delivered stream has no underruns (the
// audio-clock pacing keeps the ring fed) — an underrun is a click/stutter.
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

// build the effects ROM (the one that sounded choppy)
const work = await mkdtemp(path.join(tmpdir(), "gbalua-rt-audio-"));
const src = await readFile(path.join(GBALUA, "examples", "effects", "main.lua"), "utf8");
await writeFile(path.join(work, "m.lua"), src);
execFileSync("node", [path.join(GBALUA, "bin", "gbalua.js"), "build", path.join(work, "m.lua"), "-o", path.join(work, "e.gba")], { stdio: "pipe" });
const romB64 = (await readFile(path.join(work, "e.gba"))).toString("base64");

const vite = spawn(path.join(HERE, "node_modules", ".bin", "vite"), ["--port", "5295", "--strictPort"], {
  cwd: HERE, stdio: ["ignore", "pipe", "pipe"], detached: true,
});
let out = ""; vite.stdout.on("data", (d) => { out += d; });
await new Promise((res) => { const iv = setInterval(() => { if (/5295/.test(out)) { clearInterval(iv); res(); } }, 200); });

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("[page]", m.text()); });
  await page.goto("http://localhost:5295/", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__gbaluaWeb, { timeout: 20000 });

  // Simulate realtime: fake the AudioContext with a MANUAL clock; drive the
  // host's rAF loop AND pull the ScriptProcessor at the real 48kHz cadence,
  // interleaved the way the browser does. Capture every delivered sample and
  // flag any underrun (the pull found the ring empty = a stutter).
  const stats = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const { MgbaHost } = await import("/src/emu/mgba-host.js");
    const host = await new MgbaHost().load(bytes);

    // fake audio context @ 48000 with a manual currentTime we advance ourselves
    let onaudio = null;
    const RATE = 48000, BLOCK = 2048;
    const fakeCtx = {
      sampleRate: RATE, state: "running", currentTime: 0,
      resume() {}, suspend() {}, close() {},
      createScriptProcessor() { return { connect() {}, disconnect() {}, set onaudioprocess(f) { onaudio = f; }, get onaudioprocess() { return onaudio; } }; },
      destination: {},
    };
    // stub the constructors _initAudio uses
    globalThis.AudioContext = function () { return fakeCtx; };
    host._initAudio();               // wires ring + resampler + our fake node
    host._primed = false;

    // capture underruns: instrument _pullAudio to count blocks where the ring
    // was too empty (it holds the last sample = a stutter)
    let underrunBlocks = 0, totalBlocks = 0, deliveredNonZero = 0;
    const realPull = host._pullAudio.bind(host);
    host._pullAudio = (outBuf) => {
      const fillBefore = host._ringFill;
      realPull(outBuf);
      totalBlocks++;
      // an underrun: primed but the ring couldn't supply a full block
      if (host._primed && fillBefore < host._resampleStep * outBuf.length * 0.5) underrunBlocks++;
      const L = outBuf.getChannelData(0);
      for (let i = 0; i < L.length; i++) if (Math.abs(L[i]) > 1e-4) { deliveredNonZero++; break; }
    };

    // start the host loop but replace rAF with a manual pump so we control time
    let rafCbs = [];
    globalThis.requestAnimationFrame = (cb) => { rafCbs.push(cb); return rafCbs.length; };
    globalThis.cancelAnimationFrame = () => {};
    host.canvas = { width: 240, height: 160, getContext: () => ({ createImageData: () => ({ data: new Uint8ClampedArray(240 * 160 * 4), width: 240, height: 160 }), putImageData() {}, imageSmoothingEnabled: false }) };
    host.start(host.canvas);

    // Simulate 3 seconds of realtime. The browser interleaves: rAF ~ every
    // 16.67ms produces frames; the audio node pulls a 2048-frame block every
    // 2048/48000 = 42.7ms. Step a virtual clock and fire each at its cadence.
    const durMs = 3000;
    let t = 0, nextRaf = 0, nextPull = 0, out2 = 0;
    const blockMs = (BLOCK / RATE) * 1000;
    while (t < durMs) {
      const next = Math.min(nextRaf, nextPull);
      t = next;
      fakeCtx.currentTime = t / 1000;
      if (t >= nextRaf) {
        const cbs = rafCbs; rafCbs = [];
        for (const cb of cbs) cb(t);
        nextRaf = t + 16.67;         // ~60Hz display
      }
      if (t >= nextPull && onaudio) {
        const buf = { length: BLOCK, getChannelData: (c) => (c === 0 ? scratchL : scratchR) };
        var scratchL = new Float32Array(BLOCK), scratchR = new Float32Array(BLOCK);
        onaudio({ outputBuffer: buf });
        nextPull = t + blockMs;
        out2++;
      }
    }
    host.dispose();
    return { totalBlocks, underrunBlocks, deliveredNonZero, out2 };
  }, romB64);

  console.log("stats:", JSON.stringify(stats));
  ok("audio blocks were delivered", stats.totalBlocks > 40, `${stats.totalBlocks} blocks`);
  ok("music was actually playing", stats.deliveredNonZero > 20, `${stats.deliveredNonZero} non-silent blocks`);
  // the whole point: under realtime pacing, the ring must never underrun
  const underrunPct = 100 * stats.underrunBlocks / Math.max(1, stats.totalBlocks);
  ok("NO audio underruns under realtime pacing (not choppy)", underrunPct < 5, `${stats.underrunBlocks}/${stats.totalBlocks} blocks underran (${underrunPct.toFixed(1)}%)`);
} finally {
  await browser.close();
  try { process.kill(-vite.pid, "SIGTERM"); } catch { vite.kill(); }
  await rm(work, { recursive: true, force: true });
}

const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
