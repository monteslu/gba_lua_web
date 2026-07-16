import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // the staged toolchain under public/gba is served as-is; nothing to configure.
  // gbalua is plain ESM — Vite bundles compiler/index.js + builtins.js into the
  // app and the build worker directly.
  // node: builtins stay external in BOTH bundles: the driver's node fallbacks
  // (worker pool, fs share reads, node:crypto hashing) sit behind lazy
  // `await import()`s that never execute in the browser (every seam is
  // env-injected), but rollup still follows the literal import paths.
  worker: { format: "es", rollupOptions: { external: [/^node:/] } },
  // pre-bundle every gbalua deep import at server start: dev-mode discovery of
  // a new dep mid-session forces a full page reload, which kills in-flight
  // builds (and the playwright evaluate driving them).
  optimizeDeps: {
    include: [
      "gbalua/compiler/index.js",
      "gbalua/compiler/builtins.js",
      "gbalua/compiler/asset-headers.mjs",
      "gbalua/compiler/soundbank.mjs",
      "gbalua/compiler/ase-import.mjs",
      "gbalua/compiler/tmx-import.mjs",
      "gbalua/compiler/png-tiles.mjs",
      "gbalua/compiler/png-encode.mjs",
      "romdev-platform-gba/build/gba-c/gba-c.js",
      "romdev-platform-gba/build/parse-errors.js",
    ],
  },
  // the build driver's node fallbacks (worker pool, fs share reads, node:crypto
  // hashing) live behind lazy `await import()`s that never run in the browser
  // (every seam is env-injected) — keep rollup from trying to bundle them.
  build: { rollupOptions: { external: [/^node:/] } },
});
