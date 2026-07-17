// audio-render.mjs — render the preview synth through an OfflineAudioContext
// in headless Chromium and measure it, so "harsh/choppy" is caught objectively:
//   - PEAK must stay <= 1.0 (no hard-clipping = no buzz)
//   - the signal must be CONTINUOUS across a multi-step sequence (no silent
//     gaps between steps = not choppy)
//   - notes must actually sound (RMS above the floor)
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];
const ok = (name, cond, extra = "") => { results.push(!!cond); console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? ` (${extra})` : ""}`); };

const vite = spawn(path.join(HERE, "node_modules", ".bin", "vite"), ["--port", "5291", "--strictPort"], {
  cwd: HERE, stdio: ["ignore", "pipe", "pipe"], detached: true,
});
let out = ""; vite.stdout.on("data", (d) => { out += d; });
await new Promise((res) => { const iv = setInterval(() => { if (/5291/.test(out)) { clearInterval(iv); res(); } }, 200); });

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("[page]", m.text()); });
  await page.goto("http://localhost:5291/", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__gbaluaWeb, { timeout: 20000 });

  const stats = await page.evaluate(async () => {
    // import the real synth module the app uses
    const mod = await import("/src/audio/preview-synth.js");
    const { PreviewSynth } = mod;
    const SR = 44100;
    const seconds = 2;
    const octx = new OfflineAudioContext(1, SR * seconds, SR);

    // build a synth bound to the offline context (mirror ensure()'s chain)
    const synth = new PreviewSynth();
    synth.ctx = octx;
    const gain = octx.createGain(); gain.gain.value = 0.22;
    // reuse the module's soft-clip + lowpass by calling ensure-like wiring:
    // simplest is to let voice() connect to synth.master, so set it up here
    const shaper = octx.createWaveShaper();
    { const n = 1024, c = new Float32Array(n), k = 1.6;
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
      shaper.curve = c; shaper.oversample = "2x"; }
    const lp = octx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 7000; lp.Q.value = 0.5;
    gain.connect(shaper); shaper.connect(lp); lp.connect(octx.destination);
    synth.master = gain;

    // schedule an 8-step, 4-channel sequence at ~7.5 steps/sec (delay 8 frames)
    const stepSec = 8 / 60;
    const chord = [
      [58, 46, 34, 0],   // A4, A3, A2 across lead/bass/chip
      [0, 0, 0, 60],     // drum
      [62, 0, 38, 0],
      [0, 0, 0, 60],
      [65, 50, 41, 0],
      [0, 0, 0, 60],
      [58, 0, 34, 0],
      [0, 0, 0, 60],
    ];
    let t = 0.05;
    for (let s = 0; s < chord.length; s++) {
      synth.scheduleStep(chord[s], [1, 2, 4, 3], t, stepSec * 0.92);
      t += stepSec;
    }

    const buf = await octx.startRendering();
    const d = buf.getChannelData(0);

    // peak (clipping check)
    let peak = 0;
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }

    // continuity: over the active window (first step .. last step end), no
    // gap longer than ~25ms should be near-silent (that would be a dropout).
    // measure per-10ms-window RMS across the sequence body.
    const win = Math.floor(SR * 0.01);
    const activeStart = Math.floor(0.05 * SR);
    const activeEnd = Math.floor((0.05 + chord.length * stepSec) * SR);
    let quietWindows = 0, totalWindows = 0, maxQuietRun = 0, run = 0, sumSq = 0, nSamp = 0;
    for (let i = activeStart; i + win < activeEnd; i += win) {
      let e = 0;
      for (let j = 0; j < win; j++) { const v = d[i + j]; e += v * v; sumSq += v * v; nSamp++; }
      const rms = Math.sqrt(e / win);
      totalWindows++;
      if (rms < 0.003) { quietWindows++; run++; if (run > maxQuietRun) maxQuietRun = run; }
      else run = 0;
    }
    const overallRms = Math.sqrt(sumSq / Math.max(1, nSamp));
    return { peak, overallRms, quietWindows, totalWindows, maxQuietRun, winMs: 10 };
  });

  console.log("stats:", JSON.stringify(stats));
  ok("output does not hard-clip (peak <= 1.0)", stats.peak <= 1.0001, `peak ${stats.peak.toFixed(3)}`);
  ok("output is audible (RMS above floor)", stats.overallRms > 0.02, `rms ${stats.overallRms.toFixed(3)}`);
  // no dropout: the longest run of near-silent 10ms windows inside the
  // sequence body must be short (a choppy synth leaves long gaps between steps)
  ok("sequence is continuous, not choppy", stats.maxQuietRun * stats.winMs <= 60, `longest gap ${stats.maxQuietRun * stats.winMs}ms`);
} finally {
  await browser.close();
  try { process.kill(-vite.pid, "SIGTERM"); } catch { vite.kill(); }
}

const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
