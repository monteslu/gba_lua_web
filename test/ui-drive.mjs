// ui-drive.mjs — exercise the whole IDE through the real UI in headless
// Chromium: projects, gallery, editor+diagnostics, sprite editor, frames,
// music tracker, backgrounds, RAM debugger, zip round-trip, p8 import.
// PASS/FAIL per feature; screenshots to $SCRATCH (or .).
//   node test/ui-drive.mjs
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRATCH = process.env.SCRATCH || ".";
const results = [];
const ok = (name, cond, extra = "") => {
  results.push([!!cond, name]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? ` (${extra})` : ""}`);
};

const vite = spawn(path.join(HERE, "node_modules", ".bin", "vite"), ["--port", "5283", "--strictPort"], {
  cwd: HERE, stdio: ["ignore", "pipe", "pipe"], detached: true,
});
let vout = "";
vite.stdout.on("data", (d) => { vout += d; });
await new Promise((res) => { const iv = setInterval(() => { if (/5283/.test(vout)) { clearInterval(iv); res(); } }, 200); });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });
const shot = (n) => page.screenshot({ path: `${SCRATCH}/${n}.png` });

try {
  await page.goto("http://localhost:5283/", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__gbaluaWeb, { timeout: 20000 });

  // ---- 1. first run: New Project gallery with thumbnails ---------------------
  await page.waitForSelector(".newproj-grid", { timeout: 15000 });
  const cards = await page.$$eval(".newproj-card", (cs) => cs.length);
  const thumbs = await page.$$eval("img.newproj-thumb", (im) => im.length);
  ok("new-project gallery shows blank + 8 examples", cards === 9, `${cards} cards`);
  ok("examples have emulator-screenshot thumbnails", thumbs === 8, `${thumbs} thumbs`);
  await shot("drive-1-gallery");

  // ---- 2. clone hello -> project opens, sidebar lists it ---------------------
  await page.click(".newproj-card:has-text('hello') button:has-text('Clone')");
  await page.waitForSelector(".side-list li.active", { timeout: 10000 });
  const projName = await page.$eval(".proj-name", (i) => i.value);
  ok("cloning an example creates+opens a project", projName === "hello", projName);

  // ---- 3. Play through the real button ---------------------------------------
  await page.waitForSelector("button.play:not([disabled])", { timeout: 300000 });   // prewarm
  await page.click("button.play");
  // the building overlay + progress bar appears and the bar advances
  await page.waitForSelector(".emu-overlay.building .emu-fill", { timeout: 10000 });
  const w0 = await page.$eval(".emu-overlay.building .emu-fill", (el) => el.style.width);
  await page.waitForFunction(() => {
    const el = document.querySelector(".emu-overlay.building .emu-fill");
    return el && parseInt(el.style.width) > 5;
  }, { timeout: 60000 }).catch(() => {});
  const wMid = await page.$eval(".emu-overlay.building .emu-fill", (el) => el.style.width).catch(() => "gone");
  ok("build shows a progress bar that advances", w0 !== undefined && (wMid === "gone" || parseInt(wMid) >= parseInt(w0)), `${w0} -> ${wMid}`);
  await page.waitForFunction(() => document.querySelector(".build-msg")?.textContent?.includes("built"), { timeout: 300000 });
  await page.waitForTimeout(1200);
  const pixelSum = await page.$eval(".emu-screen", (cv) => {
    const c = document.createElement("canvas");
    c.width = cv.width; c.height = cv.height;
    const x = c.getContext("2d");
    x.drawImage(cv, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
    return s;
  });
  ok("Play builds and the emulator renders", pixelSum > 0, `pixelSum ${pixelSum}`);
  await shot("drive-2-playing");

  // ---- 4. live diagnostics + problems panel ----------------------------------
  const goodSource = await page.evaluate(() => window.__gbaluaWeb.getSource());
  await page.evaluate(() => window.__gbaluaWeb.setSource("this is not lua"));
  await page.waitForFunction(() => document.querySelector(".status")?.classList.contains("err"), { timeout: 5000 });
  const problems = await page.$$eval(".problems li.error", (l) => l.length);
  ok("live diagnostics: bad code -> error status + problems list", problems > 0, `${problems} problems`);
  const playDisabled = await page.$eval("button.play", (b) => b.disabled);
  ok("Play is gated on errors", playDisabled);
  await page.evaluate((s) => window.__gbaluaWeb.setSource(s), goodSource);
  await page.waitForFunction(() => document.querySelector(".status")?.classList.contains("ok"), { timeout: 5000 });

  // ---- 5. sprite editor: blank sheet, draw, palette, undo ---------------------
  await page.click(".pane-tabs .tab:has-text('sprites')");
  await page.click("button:has-text('new blank sheet')");
  await page.waitForSelector(".sprite-canvas", { timeout: 5000 });
  // add a color and draw a line of pixels
  await page.$eval(".pswatch.add input[type=color]", (i) => {
    i.value = "#ff4488";
    i.dispatchEvent(new Event("input", { bubbles: true }));
    i.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const cv = await page.$(".sprite-canvas");
  const box = await cv.boundingBox();
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 80, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  let palCount = await page.$$eval(".palette-grid .pswatch:not(.trans):not(.add)", (s) => s.length);
  ok("pencil paints with a new color (palette grows)", palCount === 1, `${palCount} colors`);
  // rect tool
  await page.click(".sprite-toolbar .tool[title^='Rectangle']");
  await page.mouse.move(box.x + 200, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 140, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  // select + copy + paste
  await page.click(".sprite-toolbar .tool[title^='Select']");
  await page.mouse.move(box.x + 190, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 310, box.y + 150, { steps: 5 });
  await page.mouse.up();
  await page.click(".sprite-toolbar .tool[title^='Copy']");
  await page.click(".sprite-toolbar .tool[title^='Paste']");
  await page.mouse.click(box.x + 380, box.y + 300);
  await page.waitForTimeout(300);
  const undoOn = await page.$eval(".sprite-toolbar .tool[title^='Undo']", (b) => !b.disabled);
  ok("line/rect/select/copy/paste tools work (undo armed)", undoOn);
  await shot("drive-3-sprites");

  // ---- 6. frames: does NOT auto-animate on open, animates on play -------------
  await page.click(".pane-tabs .tab:has-text('frames')");
  await page.waitForSelector(".frame-preview", { timeout: 5000 });
  // the label must be stable (paused) for a beat — no motion on open
  const labelA = await page.$eval(".frame-label", (el) => el.textContent);
  await page.waitForTimeout(900);
  const labelB = await page.$eval(".frame-label", (el) => el.textContent);
  ok("frames pane does NOT auto-animate on open", labelA === labelB && /range/.test(labelA), `"${labelA}" stayed "${labelB}"`);
  // press play -> it animates
  await page.click(".frame-toolbar .m-play");
  await page.waitForFunction(() => /spr\(\d+\)/.test(document.querySelector(".frame-label")?.textContent ?? ""), { timeout: 4000 }).catch(() => {});
  const playingLabel = await page.$eval(".frame-label", (el) => el.textContent);
  ok("frames pane animates only after pressing play", /spr\(\d+\)/.test(playingLabel), playingLabel);
  await page.click(".frame-toolbar .m-play");   // pause again
  const snippet = await page.$eval(".frame-usebar code", (el) => el.textContent);
  ok("frames pane offers the anim() snippet", /spr\(anim\(0, \d+, \d+, \d+\), x, y\)/.test(snippet), snippet);
  // affine (sprr) toggle -> the snippet switches to a hardware affine call
  await page.click(".frame-toolbar .fx-check input");
  await page.waitForTimeout(200);
  const affineSnippet = await page.$eval(".frame-usebar code", (el) => el.textContent);
  ok("frames pane affine toggle emits sprr()", /sprr\(\d+, x, y/.test(affineSnippet), affineSnippet);
  await page.click(".frame-toolbar .fx-check input");   // off

  // ---- 7. music tracker ---------------------------------------------------------
  await page.click(".pane-tabs .tab:has-text('music')");
  await page.click("button:has-text('compose a song')");
  await page.waitForSelector(".music-grid", { timeout: 5000 });
  // place three notes by clicking cells
  const cells = await page.$$(".mg-row .mg-cell");
  await cells[0].click();
  await cells[5].click();
  await cells[10].click();
  await page.waitForTimeout(200);
  const placed = await page.$$eval(".mg-cell.on", (c) => c.length);
  ok("tracker places notes on the grid", placed === 3, `${placed} notes`);
  // the song builds into the ROM: play and confirm build succeeds with music
  const src2 = await page.evaluate(() => window.__gbaluaWeb.getSource());
  await page.evaluate((s) => window.__gbaluaWeb.setSource(s.replace("function _init()", "function _init()\n  music(0)")),
    src2.includes("_init") ? src2 : "function _init()\n  music(0)\nend\n" + src2);
  await page.waitForTimeout(700);
  // music(0) pulls in maxmod + the composed soundbank (~+26KB over a bare
  // hello build, which is 68568 bytes)
  const r2 = await page.evaluate(() => window.__gbaluaWeb.buildCurrent());
  ok("build embeds the composed song (maxmod links)", r2.ok && r2.rom?.length > 85000,
    `${r2.rom?.length ?? 0} bytes`);
  await shot("drive-4-tracker");

  // ---- 8. RAM debugger -----------------------------------------------------------
  await page.click(".pane-tabs.bottom .tab:has-text('RAM')");
  await page.waitForSelector(".ram-grid", { timeout: 5000 });
  const bytesShown = await page.$$eval(".ram-byte", (b) => b.length);
  ok("RAM viewer shows the running game's EWRAM", bytesShown >= 256, `${bytesShown} bytes on screen`);
  // poke: click the first byte, type a value
  await page.click(".ram-byte");
  await page.fill(".ram-edit", "7f");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const poked = await page.evaluate(() => {
    const host = window.__gbaluaWeb.getHost();
    return host ? host.readRam(0, 1)[0] : -1;
  });
  ok("clicking a byte pokes the running machine", poked === 0x7f, `read back 0x${poked.toString(16)}`);
  await shot("drive-5-ram");

  // ---- 9. backgrounds pane on the mode7 example -----------------------------------
  await page.click(".side-new");
  await page.click(".newproj-card:has-text('mode7') button:has-text('Clone')");
  await page.waitForFunction(() => document.querySelector(".proj-name")?.value === "mode7", { timeout: 10000 });
  await page.click(".pane-tabs .tab:has-text('backgrounds')");
  await page.waitForSelector(".bg-pane", { timeout: 5000 });
  const bgPreviews = await page.$$eval(".asset-preview", (c) => c.length);
  ok("mode7 example ships its plane (backgrounds preview)", bgPreviews === 1, `${bgPreviews} preview`);
  await shot("drive-6-backgrounds");

  // ---- 9b. Mode 7 designer: live camera + generated call --------------------------
  await page.click(".pane-tabs .tab:has-text('mode 7')");
  await page.waitForSelector(".m7-canvas", { timeout: 5000 });
  const m7canvasBefore = await page.$eval(".m7-canvas", (cv) => {
    const c = document.createElement("canvas"); c.width = cv.width; c.height = cv.height;
    const x = c.getContext("2d"); x.drawImage(cv, 0, 0);
    return x.getImageData(0, 100, 240, 1).data.reduce((a, b) => a + b, 0);
  });
  // drag the angle slider and confirm the plane re-renders + the call updates
  const angleSlider = await page.$(".m7-field:has-text('angle') input");
  await angleSlider.focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  const m7canvasAfter = await page.$eval(".m7-canvas", (cv) => {
    const c = document.createElement("canvas"); c.width = cv.width; c.height = cv.height;
    const x = c.getContext("2d"); x.drawImage(cv, 0, 0);
    return x.getImageData(0, 100, 240, 1).data.reduce((a, b) => a + b, 0);
  });
  ok("mode 7 designer re-renders the plane as the camera moves", m7canvasBefore !== m7canvasAfter, `${m7canvasBefore} -> ${m7canvasAfter}`);
  const m7code = await page.$eval(".m7-pane .fx-snippet code", (el) => el.textContent);
  ok("mode 7 designer emits mode7_cam()", /mode7_cam\(\d+, \d+, [-\d.]+/.test(m7code), m7code.replace(/\n/g, " ").slice(0, 60));
  await shot("drive-6b-mode7");

  // ---- 9c. Palette pane: BGR555 picker + snippet ----------------------------------
  await page.click(".pane-tabs .tab:has-text('palette')");
  await page.waitForSelector(".pal-pane", { timeout: 5000 });
  // move the R slider; the spr_col snippet must update
  const rSlider = await page.$(".pal-slider input[type=range]");
  await rSlider.focus();
  for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(150);
  const palCode = await page.$eval(".pal-pane .fx-snippet code", (el) => el.textContent);
  ok("palette pane emits a runtime palette call", /(spr_col|pal)\(\d+, \d+, \d+, \d+\)/.test(palCode), palCode);

  // ---- 9d. Effects lab: each effect tab emits its call ----------------------------
  await page.click(".pane-tabs .tab:has-text('effects')");
  await page.waitForSelector(".fx-pane", { timeout: 5000 });
  const fxChecks = [
    ["Blend", /blend\(\d+, [\d.]+\)/],
    ["Fade", /fade\([\d.]+/],
    ["Mosaic", /mosaic\(\d+\)/],
    ["Window", /window\(\d+, \d+, \d+, \d+\)/],
    ["Backdrop", /backdrop\(rgb15\(/],
    ["HGradient", /hgradient|rgb15/],
  ];
  let fxOk = true, fxDetail = "";
  for (const [tab, re] of fxChecks) {
    await page.click(`.fx-tab:has-text('${tab}')`);
    await page.waitForTimeout(120);
    const code = await page.$eval(".fx-pane .fx-snippet code", (el) => el.textContent).catch(() => "");
    if (!re.test(code)) { fxOk = false; fxDetail = `${tab}: "${code.slice(0, 40)}"`; }
  }
  ok("effects lab: all 6 effect tabs emit their SDK call", fxOk, fxDetail);
  await shot("drive-6d-effects");

  // ---- 10. cheatsheet tab ----------------------------------------------------------
  await page.click(".pane-tabs .tab:has-text('cheatsheet')");
  await page.waitForSelector(".cheatsheet-body h2, .cheatsheet-body h3", { timeout: 10000 });
  const cheatLen = await page.$eval(".cheatsheet-body", (el) => el.textContent.length);
  ok("cheatsheet renders the SDK doc", cheatLen > 2000, `${cheatLen} chars`);

  // ---- 11. zip export -> import round trip -----------------------------------------
  const dl = page.waitForEvent("download");
  await page.click("button:has-text('export')");
  const download = await dl;
  const zipPath = path.join(tmpdir(), "gbalua-drive-export.zip");
  await download.saveAs(zipPath);
  ok("project exports as .zip", /\.zip$/.test(download.suggestedFilename()), download.suggestedFilename());
  const fc1 = page.waitForEvent("filechooser");
  await page.click("button:has-text('import')");
  await (await fc1).setFiles(zipPath);
  await page.waitForFunction(() => document.querySelectorAll(".side-list li").length >= 3, { timeout: 10000 });
  const names = await page.$$eval(".side-list .side-item", (b) => b.map((x) => x.textContent));
  ok("zip re-imports as a new project", names.filter((n) => /mode7/.test(n)).length >= 2, names.join(", "));

  // ---- 12. PICO-8 .p8 import --------------------------------------------------------
  const p8 = `pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function _init()
 x=0
end
function _update()
 x=x+1
end
function _draw()
 cls()
 spr(1,x,60)
end
__gfx__
${"00000000880000880000000000000000".padEnd(128, "0")}
${"0".repeat(128)}
`;
  const p8Path = path.join(tmpdir(), "testcart.p8");
  await writeFile(p8Path, p8);
  const fc2 = page.waitForEvent("filechooser");
  await page.click("button:has-text('import')");
  await (await fc2).setFiles(p8Path);
  await page.waitForFunction(() => document.querySelector(".proj-name")?.value === "testcart", { timeout: 10000 });
  const p8src = await page.evaluate(() => window.__gbaluaWeb.getSource());
  ok("p8 import creates a project with a porting banner", /imported from a PICO-8 cart/.test(p8src));
  const hasSheet = await page.$eval(".pane-tabs .tab:nth-child(2)", (t) => t.textContent);
  ok("p8 __gfx__ became the sprite sheet", /^sprites/.test(hasSheet.trim()), hasSheet.trim());

  // ---- 13. rename + delete -----------------------------------------------------------
  await page.fill(".proj-name", "renamed-cart");
  await page.waitForTimeout(700);
  const sideHas = await page.$$eval(".side-list .side-item", (b) => b.map((x) => x.textContent));
  ok("rename persists to the sidebar", sideHas.includes("renamed-cart"), sideHas.join(", "));
  await page.hover(".side-list li.active");
  await page.click(".side-list li.active .side-del");
  await page.waitForSelector(".confirm-box", { timeout: 5000 });
  await page.click(".confirm-danger");
  await page.waitForTimeout(600);
  const afterDelete = await page.$$eval(".side-list .side-item", (b) => b.map((x) => x.textContent));
  ok("delete (with confirm) removes the project", !afterDelete.includes("renamed-cart"), afterDelete.join(", "));

  await shot("drive-7-final");
} finally {
  const realErrors = pageErrors.filter((e) => !/favicon|Failed to load resource/.test(e));
  ok("no page errors during the whole drive", realErrors.length === 0, realErrors.slice(0, 2).join(" | ").slice(0, 200));
  await browser.close();
  try { process.kill(-vite.pid, "SIGTERM"); } catch { vite.kill(); }
}

const fails = results.filter(([p]) => !p).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
