import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./style.css";
import { installTestHook } from "./test-hook.js";

// Monaco spawns per-language web workers (TS/JSON/CSS/HTML) by default and
// throws when it can't resolve them under Vite. We use Monaco purely for Lua
// editing — our diagnostics come from the gbalua compiler, not a Monaco
// language service — so point every worker at a tiny no-op stub. Silences the
// "Monaco initialization: error" console noise and skips loading worker
// bundles we'd never use.
const NOOP_WORKER = URL.createObjectURL(new Blob(["self.onmessage=()=>{}"], { type: "text/javascript" }));
self.MonacoEnvironment = { getWorkerUrl: () => NOOP_WORKER };

installTestHook();
createRoot(document.getElementById("root")).render(<App />);
