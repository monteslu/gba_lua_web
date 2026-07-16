// Editor — Monaco with gbalua intelligence. The COMPILER is the language
// service: completions come straight from the SDK's builtins table, and live
// diagnostics come from running the real compile() on a debounce. No separate
// grammar to maintain — if the SDK gains a verb, the editor knows it on the
// next dependency bump.
import { useRef, useCallback, useEffect } from "react";
import MonacoEditor from "@monaco-editor/react";
import { compile } from "gbalua/compiler/index.js";
import { BUILTINS, CALLBACKS } from "gbalua/compiler/builtins.js";

// Build Monaco completion items from the builtins table once.
function completionItems(monaco) {
  const items = [];
  for (const [name, def] of Object.entries(BUILTINS)) {
    if (!def || typeof def !== "object" || !(def.params || def.special)) continue;
    const params = (def.params || []).map(([kind, opt], i) => (opt ? `[${kind}]` : kind));
    const sig = `${name}(${params.join(", ")})`;
    items.push({
      label: name,
      kind: monaco.languages.CompletionItemKind.Function,
      detail: sig + (def.gbaOnly ? "  · GBA" : ""),
      insertText: def.params?.length ? `${name}($0)` : `${name}()`,
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      documentation: def.gbaOnly ? "GBA hardware verb" : "PICO-8-style builtin",
    });
  }
  for (const cb of CALLBACKS) {
    items.push({
      label: cb,
      kind: monaco.languages.CompletionItemKind.Event,
      detail: `function ${cb}() … end`,
      insertText: `function ${cb}()\n\t$0\nend`,
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      documentation: "gbalua lifecycle callback",
    });
  }
  return items;
}

let registered = false;
function registerLua(monaco) {
  if (registered) return;
  registered = true;
  const items = completionItems(monaco);
  monaco.languages.registerCompletionItemProvider("lua", {
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      return { suggestions: items.map((i) => ({ ...i, range })) };
    },
  });
}

export default function Editor({ value, onChange }) {
  const monacoRef = useRef(null);
  const editorRef = useRef(null);
  const timerRef = useRef(0);

  // live diagnostics: debounce the real compiler, map its diagnostics to markers.
  const lint = useCallback((src) => {
    const monaco = monacoRef.current, editor = editorRef.current;
    if (!monaco || !editor) return;
    let res;
    try { res = compile(src, "main.lua", { target: "gba" }); }
    catch (e) { res = { diagnostics: [{ line: 1, col: 1, severity: "error", message: e.message }] }; }
    const markers = (res.diagnostics || []).map((d) => ({
      severity: d.severity === "warning"
        ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
      message: d.message,
      startLineNumber: d.line || 1, startColumn: d.col || 1,
      endLineNumber: d.line || 1, endColumn: (d.col || 1) + 1,
    }));
    monaco.editor.setModelMarkers(editor.getModel(), "gbalua", markers);
  }, []);

  const handleChange = useCallback((v) => {
    onChange(v ?? "");
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => lint(v ?? ""), 300);
  }, [onChange, lint]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <MonacoEditor
      height="100%"
      language="lua"
      theme="vs-dark"
      value={value}
      onChange={handleChange}
      onMount={(editor, monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;
        registerLua(monaco);
        lint(editor.getValue());
      }}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        tabSize: 2,
        scrollBeyondLastLine: false,
        automaticLayout: true,
      }}
    />
  );
}
