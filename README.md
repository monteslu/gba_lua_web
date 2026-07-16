# gbalua web

Write **Game Boy Advance** games in [gbalua](https://github.com/monteslu/gba_lua_sdk)'s
PICO-8-flavored Lua — and build + play them **entirely in the browser**. No
devkitPro, no server, no install: the real `arm-none-eabi-gcc` toolchain
(cc1 → as → ld → objcopy) runs as WebAssembly in a Web Worker, and the ROM
boots on the mGBA core on a canvas.

The browser build is **byte-identical** to a `gbalua` CLI build of the same
source — it is the same compiler, the same toolchain binaries, and the same
pipeline stages, just hosted in a worker instead of node. CI enforces this.

## Run it

```sh
npm install    # also stages the WASM toolchain into public/gba (postinstall)
npm run dev    # open the printed localhost URL
```

Pick an example, edit, **Ctrl+Enter** to build & run. Click the game screen
for sound and keyboard input (arrows = d-pad, X=A, Z=B, A/S = L/R shoulders,
Enter=Start, Shift=Select). `download .gba` saves the ROM for a flashcart or
any emulator.

## How it works

Everything comes from npm packages — this repo is a thin shell:

| piece | source |
|---|---|
| Lua → C compiler, live diagnostics, completions | `gbalua/compiler` (pure JS, runs in-page; the compiler IS the language service) |
| GBA runtime C sources + default soundbank | `gbalua/gba-sdk` (staged) |
| `cc1-arm` / `as` / `ld` / `objcopy` WASM + mGBA core | `romdev-platform-gba` (staged) |
| libtonc + maxmod prebuilt seeds, crt objects, `gba_cart.ld`, headers | `romdevtools` (staged) |

`scripts/stage-toolchain.mjs` (postinstall) copies those artifacts into
`public/gba/`. The build worker fetches them once, compiles each tool's WASM
to a module once (cc1-arm is 38 MB — the first build pays a one-time compile),
then every build is: `compile()` Lua→C in JS, cc1+as per translation unit,
one link against the prebuilt libtonc/maxmod seeds, objcopy → `.gba`.

Sound works — games that call `music()`/`sfx()` link maxmod + the SDK's
default soundbank, exactly like the CLI.

**Current limitation:** custom art (`--sheet` / `--map` / `--mode7` in the
CLI) isn't wired in the browser yet — builds use the SDK's built-in fallback
sprite. That lands when the SDK's PNG→tile converter becomes browser-safe;
the asset codecs live in the SDK, not here, by design.

## Tests

```sh
npm test
```

Drives a real Chromium via playwright: builds `hello` in the browser worker,
asserts the ROM **bytes equal a CLI build**, then boots it on the mGBA core
and asserts the canvas renders. CI runs the same gates plus a tripwire that
fails the build if any GameTank residue sneaks into this GBA-only repo.

## License

MIT
