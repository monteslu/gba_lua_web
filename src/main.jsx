import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./style.css";
import { installTestHook } from "./test-hook.js";

installTestHook();
createRoot(document.getElementById("root")).render(<App />);
