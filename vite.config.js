import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // the staged toolchain under public/gba is served as-is; nothing to configure.
  // gbalua is plain ESM — Vite bundles compiler/index.js + builtins.js into the
  // app and the build worker directly.
  worker: { format: "es" },
});
