// useResizableColumns - persisted, draggable widths for the IDE's three-column
// shell (sidebar | editor | emulator). Stored as PERCENTAGES of the window
// width so the layout scales; both edge columns are px-clamped so they never
// balloon or crush.
import { useState, useCallback, useRef, useEffect } from "react";

const KEY = "gbalua-ide-cols";
export const SIDEBAR_PX = { min: 140, max: 340 };
export const EMU_PX = { min: 300, max: 560 };   // 240-wide canvas scales up
const DEFAULT = { sidebarPct: 180 / 1440, emuPct: 400 / 1440 };

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null");
    if (v && typeof v.sidebarPct === "number" && typeof v.emuPct === "number") return v;
  } catch { /* ignore */ }
  return DEFAULT;
}
function save(v) {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode */ }
}
const clamp = (px, { min, max }) => Math.max(min, Math.min(max, px));

export function useResizableColumns() {
  const [pct, setPct] = useState(load);
  const winW = useWindowWidth();
  const sidebarPx = clamp(pct.sidebarPct * winW, SIDEBAR_PX);
  const emuPx = clamp(pct.emuPct * winW, EMU_PX);

  const drag = useRef(null);

  const onMove = useCallback((e) => {
    const d = drag.current;
    if (!d) return;
    const w = window.innerWidth || 1440;
    if (d.which === "sidebar") {
      const px = clamp(d.startPx + (e.clientX - d.startX), SIDEBAR_PX);
      setPct((p) => ({ ...p, sidebarPct: px / w }));
    } else {
      // emulator handle is on the LEFT edge of the emu column, so dragging
      // RIGHT shrinks it.
      const px = clamp(d.startPx - (e.clientX - d.startX), EMU_PX);
      setPct((p) => ({ ...p, emuPct: px / w }));
    }
  }, []);

  const onUp = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    setPct((p) => { save(p); return p; });
  }, [onMove]);

  const px = useRef({ sidebar: sidebarPx, emu: emuPx });
  px.current = { sidebar: sidebarPx, emu: emuPx };

  const start = useCallback((which) => (e) => {
    e.preventDefault();
    drag.current = { which, startX: e.clientX, startPx: px.current[which] };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [onMove, onUp]);

  useEffect(() => () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  }, [onMove, onUp]);

  return { sidebarPx, emuPx, startSidebarDrag: start("sidebar"), startEmuDrag: start("emu") };
}

function useWindowWidth() {
  const [w, setW] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1440));
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}
