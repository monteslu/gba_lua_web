// download.js - trigger a browser file download from bytes/text, pick local files.
export function downloadBytes(filename, data, mime = "application/octet-stream") {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Prompt for one local file -> { name, bytes } (null if cancelled). */
export function pickFile(accept = "") {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file"; if (accept) input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, bytes: new Uint8Array(reader.result) });
      reader.readAsArrayBuffer(file);
    };
    input.click();
  });
}

/** Prompt for several local files -> [{ name, bytes }]. */
export function pickFiles(accept = "") {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file"; input.multiple = true;
    if (accept) input.accept = accept;
    input.onchange = async () => {
      const out = [];
      for (const file of input.files ?? []) {
        out.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      }
      resolve(out);
    };
    input.click();
  });
}
