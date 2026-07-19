// Editor — Monaco with gbalua intelligence.
//
// The language service itself is luacretro-web's; what stays here is the gbalua
// MANIFEST: which builtins table and which compile().
import { LuaEditor } from "luacretro-web/editor";
import { compile } from "gbalua/compiler/index.js";
import { BUILTINS, CALLBACKS } from "gbalua/compiler/builtins.js";

const LANGUAGE = {
  builtins: BUILTINS,
  callbacks: CALLBACKS,
  owner: "gbalua",
  callbackDoc: "gbalua lifecycle callback",
  detailFor: (_name, def) => (def.gbaOnly ? "  · GBA" : ""),
  documentationFor: (_name, def) => (def.gbaOnly ? "GBA hardware verb" : "PICO-8-style builtin"),
};

// the SDK's compile() forces its own target descriptor — nothing to pass.
const compileSrc = (src) => compile(src, "main.lua");

export default function Editor({ value, onChange }) {
  return (
    <LuaEditor
      value={value}
      onChange={onChange}
      language={LANGUAGE}
      compile={compileSrc}
    />
  );
}
