import { NOTE } from "./xm-song.js";

// A horizontal piano keyboard note-picker. White keys are the row; black keys
// (sharps) sit on top between them. Value/onChange are XM note numbers
// (1 = C-0). Clicking selects (and previews via onPreview).
const WHITE = ["C", "D", "E", "F", "G", "A", "B"];
const BLACK = { C: "C#", D: "D#", F: "F#", G: "G#", A: "A#" };
const BLACK_OFFSET = 0.68;

export function Piano({ value, onChange, onPreview, fromOct = 2, toOct = 6, baseOctave = null }) {
  const whites = [];
  const blacks = [];
  let wi = 0;
  for (let oct = fromOct; oct <= toOct; oct++) {
    for (const w of WHITE) {
      const midi = NOTE[w + oct];
      const kbd = baseOctave != null && (oct === baseOctave || oct === baseOctave + 1);
      whites.push({ midi, name: w + oct, index: wi, kbd });
      const sharp = BLACK[w];
      if (sharp) blacks.push({ midi: NOTE[sharp + oct], name: sharp + oct, whiteIndex: wi });
      wi++;
    }
  }
  const nWhite = whites.length;
  const pick = (midi) => { onChange(midi); onPreview?.(midi); };

  return (
    <div className="piano" role="listbox" aria-label="note">
      <div className="piano-keys" style={{ "--n-white": nWhite }}>
        {whites.map((k) => (
          <button key={k.midi}
            className={"pk-white" + (k.midi === value ? " sel" : "") + (k.kbd ? " kbd" : "")}
            title={k.name} aria-label={k.name} onClick={() => pick(k.midi)}>
            <span className="pk-label">{k.name}</span>
          </button>
        ))}
        {blacks.map((k) => (
          <button key={k.midi}
            className={"pk-black" + (k.midi === value ? " sel" : "")}
            title={k.name} aria-label={k.name}
            style={{ left: `calc((${k.whiteIndex} + ${BLACK_OFFSET}) * (100% / var(--n-white)))` }}
            onClick={() => pick(k.midi)} />
        ))}
      </div>
    </div>
  );
}
