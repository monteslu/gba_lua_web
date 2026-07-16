// CheatsheetPane — the SDK's docs/CHEATSHEET.md, rendered read-only in a side
// drawer. Tiny markdown subset (headings, code, tables, bold) — enough for the
// cheatsheet, no renderer dependency.
import { useState, useEffect } from "react";

let cache = null;

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function mdToHtml(md) {
  const lines = md.split("\n");
  const out = [];
  let inCode = false, inTable = false;
  const closeTable = () => { if (inTable) { out.push("</table>"); inTable = false; } };
  for (const line of lines) {
    if (line.startsWith("```")) {
      closeTable();
      out.push(inCode ? "</pre>" : "<pre>");
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(escapeHtml(line)); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { closeTable(); out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); continue; }
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;          // separator row
      if (!inTable) { out.push("<table>"); inTable = true; }
      const cells = line.trim().replace(/^\||\|$/g, "").split("|");
      out.push(`<tr>${cells.map((c) => `<td>${inline(c.trim())}</td>`).join("")}</tr>`);
      continue;
    }
    closeTable();
    if (line.trim() === "") { out.push(""); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  closeTable();
  if (inCode) out.push("</pre>");
  return out.join("\n");
}

export default function CheatsheetPane({ onClose }) {
  const [html, setHtml] = useState(cache);
  useEffect(() => {
    if (cache) return;
    fetch("/gba/cheatsheet.md")
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
      .then((md) => { cache = mdToHtml(md); setHtml(cache); })
      .catch((e) => setHtml(`<p>failed to load cheatsheet: ${escapeHtml(String(e.message))}</p>`));
  }, []);
  return (
    <div className="cheatsheet">
      <div className="cheatsheet-head">
        <strong>gbalua cheatsheet</strong>
        <button onClick={onClose}>close</button>
      </div>
      <div className="cheatsheet-body"
        dangerouslySetInnerHTML={{ __html: html ?? "<p>loading…</p>" }} />
    </div>
  );
}
