import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const GL_STUB = fileURLToPath(new URL("./src/emu/gl-stub.js", import.meta.url));

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
  // luacretro-web ships raw JSX (no build step in the lib). It is symlinked in
  // via `file:`, so Vite must NOT prebundle it (esbuild's dep scanner would
  // choke on the .jsx entry) and React must resolve to ONE copy across the
  // symlink boundary or hooks blow up with the classic invalid-hook-call.
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      // romdev-core-host declares native-gles/webgl-node as OPTIONAL deps and
      // only reaches them through a lazy `await import()` in glOptionalDep.js,
      // on the HW-render path for the 3D cores (N64/PS1/Dreamcast). mGBA is a
      // software core, so that path never runs in this app — but esbuild and
      // rollup still FOLLOW the literal specifier, and native-gles is a .node
      // binary neither can load. Stub the specifiers; nothing imports them.
      { find: /^native-gles$/, replacement: GL_STUB },
      { find: /^webgl-node$/, replacement: GL_STUB },
    ],
  },
  // pre-bundle every gbalua deep import at server start: dev-mode discovery of
  // a new dep mid-session forces a full page reload, which kills in-flight
  // builds (and the playwright evaluate driving them).
  optimizeDeps: {
    exclude: ["luacretro-web"],
    include: [
      // luacretro-web itself is excluded (raw JSX, symlinked), but its deps are
      // plain ESM in node_modules and Vite discovers them LATE — as imports of
      // an excluded dep. Listing them here prebundles them at server start;
      // without it the first import 504s as an "Outdated Optimize Dep" and the
      // page never boots.
      "romdev-core-host",
      "romdev-core-host/framebuffer.js",
      "@monaco-editor/react",
      "gbalua/compiler/index.js",
      "gbalua/compiler/builtins.js",
      "gbalua/compiler/asset-headers.mjs",
      "gbalua/compiler/soundbank.mjs",
      "gbalua/compiler/ase-import.mjs",
      "gbalua/compiler/tmx-import.mjs",
      "gbalua/compiler/png-tiles.mjs",
      "gbalua/compiler/png-encode.mjs",
      "gbalua/compiler/xm-write.mjs",
      "romdev-platform-gba/build/gba-c/gba-c.js",
      "romdev-platform-gba/build/parse-errors.js",
    ],
  },
  // the build driver's node fallbacks (worker pool, fs share reads, node:crypto
  // hashing) live behind lazy `await import()`s that never run in the browser
  // (every seam is env-injected) — keep rollup from trying to bundle them.
  build: { rollupOptions: { external: [/^node:/] } },
});
