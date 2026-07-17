# gbalua web

A browser IDE for making **Game Boy Advance** games in
[gbalua](https://github.com/monteslu/gba_lua_sdk)'s PICO-8-flavored Lua.
Write code, draw sprites, compose music, build a real `.gba` ROM, and play it
in the emulator — all in a tab. No devkitPro, no server, no install: the real
`arm-none-eabi-gcc` toolchain (cc1 → as → ld → objcopy) runs as WebAssembly
in a Web Worker, and the ROM boots on the mGBA core.

The browser build is **byte-identical** to a `gbalua` CLI build of the same
source and assets — it is the exact same compiler and build driver
(`buildGbaC` from `romdev-platform-gba`, every seam env-injected), just
hosted in a worker instead of node. CI enforces this on every push.

## What's in it

- **Projects.** Saved in the browser (IndexedDB), started blank or cloned
  from a gallery of the SDK's example games (with live emulator-screenshot
  thumbnails). Export/import as a plain `.zip`.
- **Code editor.** Monaco with gbalua completions and **live diagnostics**
  from the real compiler on every keystroke (the compiler *is* the language
  service), plus a problems panel.
- **Build & run.** Play (Ctrl+Enter / Ctrl+R) compiles Lua → C → arm-gcc WASM
  → `.gba` with a live **progress bar** on the emulator, then runs it on the
  mGBA core. Keyboard and any standard-layout **gamepad** drive the pad (a
  mapper handles non-standard controllers); **fullscreen** grabs the controls.
  The toolchain prewarms at startup so the first Play is fast.
- **Sprite editor.** Pencil / eraser / fill / line / rect / eyedropper,
  marquee select with copy/cut/paste, zoom, undo/redo, an 8px + 16px sprite
  grid, and a palette manager that enforces the GBA's 4bpp budget (15 colors
  + transparent). Import PNG or Aseprite; export `sheet.png`.
- **Animation.** Pick a sprite range and preview it cycling at any fps in the
  SDK's three modes (loop / once / pingpong); copy the ready-to-paste
  `spr(anim(...))` line.
- **Music.** A 4-channel step tracker with a Web Audio preview and piano/
  keyboard note entry. Songs serialize to **real FastTracker `.xm`** (via the
  SDK's writer — open them in OpenMPT) and compile into the Maxmod soundbank
  by position: `music(0)` plays your first entry. Import `.xm/.mod/.it/.s3m`
  modules alongside composed songs.
- **Backgrounds.** Import the `map_show()` tilemap and the Mode 7 plane from
  PNG, Aseprite, or Tiled `.tmx` (embedded tilesets).
- **Debugger.** A live hex view of the running game's EWRAM, ~10 Hz refresh,
  click a byte to poke it.
- **Import.** Bring in a project `.zip`, or a PICO-8 `.p8` / `.p8.png` cart —
  code (glyphs neutralized, dialect gaps annotated) and `__gfx__` (the P8
  palette maps 1:1 onto the GBA's 15-color budget) convert into a new project
  to port from.
- **Cheatsheet.** The SDK's full verb reference, rendered in a tab.

## Run it

```sh
npm install    # also stages the WASM toolchain into public/gba (postinstall)
npm run dev    # open the printed localhost URL
```

Clone an example from the New Project gallery, edit, **Ctrl+Enter** to build
& run. Click the game screen for sound and keys (arrows = d-pad, X=A, Z=B,
A/S = L/R shoulders, Enter=Start, Shift=Select) — or plug in a gamepad.
`.gba` downloads the ROM for a flashcart or any emulator.

## How it works

Everything comes from npm packages — this repo is the UI:

| piece | source |
|---|---|
| Lua → C compiler, diagnostics, completions | `gbalua/compiler` (pure JS, runs in-page) |
| asset converters (PNG/Aseprite/Tiled/tracker/XM writer) | `gbalua/compiler` browser-safe modules |
| GBA runtime C sources + default soundbank | `gbalua/gba-sdk` (staged) |
| THE build driver (`buildGbaC`, env-injected) | `romdev-platform-gba/build` |
| `cc1-arm` / `as` / `ld` / `objcopy` WASM + mGBA core | `romdev-platform-gba/wasm` (staged) |
| libtonc + maxmod seeds, crt, ld script, headers | `romdev-platform-gba/share` (staged as one manifest) |

`scripts/stage-toolchain.mjs` (postinstall) stages those artifacts into
`public/gba/`. The build worker fetches them once, compiles each tool's WASM
once, then calls `buildGbaC()` with `env.runTool/share/hash` injected — the
identical pipeline the gbalua CLI and the romdev MCP server run.

## Tests

Playwright drives real headless Chromium:

```sh
npm test    # byte-identity + boot gates, then the full UI drive
```

- `test/browser-build.mjs` — hello AND starfall-with-its-sheet build in the
  browser **byte-identical** to the CLI's ROMs, and the ROM renders on the
  core.
- `test/ui-drive.mjs` — end-to-end through the real UI: gallery, clone, Play,
  diagnostics, sprite tools, animation, tracker (and that the composed song
  links into the ROM), RAM pokes, backgrounds, cheatsheet, zip round-trip,
  p8 import, rename/delete.
- `test/gen-thumbs.mjs` (`npm run thumbs`) — regenerates the gallery
  thumbnails by building + running every example headlessly.

CI runs the same gates plus a tripwire that fails the build if any GameTank
residue sneaks into this GBA-only repo.

## License

MIT
