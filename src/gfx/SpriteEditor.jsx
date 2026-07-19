// SpriteEditor — the GBA binding for luacretro-web's shared pixel editor.
//
// The editor body (tools, undo, selection, clipboard, palette budget) is
// shared. What is GBA-specific and stays here: the surface descriptor (16×16
// spr(n) sprites over an 8px minor grid, 15 colors for 4bpp) and the
// PNG/Aseprite codecs, which come from the gbalua SDK and so cannot live in the
// shared layer.
import { useCallback, useState } from "react";
import { PixelEditor } from "luacretro-web/gfx";
import {
  sheetFromPng, sheetToPng, sheetFromAse, newSheet, enforcePalette,
} from "./sheet-model.js";
import { pickFile, downloadBytes } from "../util/download.js";

// GBA sprites are 16x16, numbered left-to-right, top-to-bottom across the
// sheet. The 16px sprite-cell grid is the prominent guide; a faint 8px minor
// grid sits under it (the hardware tile size).
const SURFACE = {
  cellW: 16,
  cellH: 16,
  maxColors: 15,      // 4bpp: 15 opaque + transparent
  sheetW: 128,
  sheetH: 128,
  cellLabel: "16×16 sprites",
  grids: [
    { step: 8, color: "rgba(255,255,255,0.10)" },     // 8px minor
    { step: 16, color: "rgba(120,200,255,0.4)" },     // 16px sprite cells
  ],
};

export function SpriteEditor({ sheet, onChange }) {
  const [msg, setMsg] = useState("");
  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(""), 4000); };

  const onImport = useCallback(async () => {
    const picked = await pickFile(".png,.ase,.aseprite,image/png");
    if (!picked) return;
    try {
      const isAse = /\.(ase|aseprite)$/i.test(picked.name);
      const raw = isAse ? sheetFromAse(picked.bytes) : sheetFromPng(picked.bytes);
      const { img, reduced } = enforcePalette(raw);
      onChange(img);
      flash(`imported ${img.width}×${img.height}${reduced ? ` (${reduced} colors snapped to the 15-color budget)` : ""}`);
    } catch (e) { flash(`import failed: ${e.message}`); }
  }, [onChange]);

  const onExport = useCallback(() => {
    if (sheet) downloadBytes("sheet.png", sheetToPng(sheet), "image/png");
  }, [sheet]);

  return (
    <PixelEditor
      sheet={sheet}
      onChange={onChange}
      surface={SURFACE}
      onImport={onImport}
      onExport={onExport}
      message={msg}
      onNew={() => onChange(newSheet())}
    />
  );
}
