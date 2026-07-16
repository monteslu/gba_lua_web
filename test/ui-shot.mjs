import { spawn } from "node:child_process";
import path from "node:path";
import { chromium } from "playwright";
const HERE = process.cwd();
const vite = spawn(path.join(HERE, "node_modules", ".bin", "vite"), ["--port", "5277", "--strictPort"], { cwd: HERE, stdio: ["ignore", "pipe", "pipe"], detached: true });
let out = "";
vite.stdout.on("data", (d) => out += d);
await new Promise((res) => { const iv = setInterval(() => { if (/5277/.test(out)) { clearInterval(iv); res(); } }, 200); });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto("http://localhost:5277/");
await page.waitForFunction(() => !!window.__gbaluaWeb, { timeout: 15000 });
await page.waitForTimeout(2500);  // monaco paint
// click Build & Run through the real UI
await page.click("button.primary");
await page.waitForFunction(() => document.querySelector(".progress")?.textContent?.includes("built"), { timeout: 180000 });
await page.waitForTimeout(1500);  // let the emu draw a few frames
const dir = process.env.SCRATCH || ".";
await page.screenshot({ path: dir + "/ui.png" });
// second shot: the assets view (starfall has a real sheet to show)
await page.selectOption("select", "starfall");
await page.waitForTimeout(800);
await page.click(".view-tabs button:nth-child(2)");
await page.waitForTimeout(800);
await page.screenshot({ path: dir + "/ui-assets.png" });
// third shot: the cheatsheet drawer
await page.click("text=cheatsheet");
await page.waitForTimeout(800);
await page.screenshot({ path: dir + "/ui-cheatsheet.png" });
await browser.close();
try { process.kill(-vite.pid, "SIGTERM"); } catch { vite.kill(); }
console.log("ui screenshot saved");
