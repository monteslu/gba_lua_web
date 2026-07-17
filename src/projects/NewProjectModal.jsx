import { useEffect, useState } from "react";
import { loadExamples } from "../examples.js";

// The scaffold a Blank Project starts from: the three functions every game
// has, ready to type into.
export const BLANK_SOURCE = `-- your game!
function _init()
  -- runs once, when the game starts
end

function _update60()
  -- runs 60 times a second: move things, check buttons
end

function _draw()
  cls(1)   -- clear the screen to dark blue, then draw your frame
end
`;

/**
 * New Project dialog: a scrollable gallery of cloneable starting points.
 * "Blank Project" leads, then every bundled example with its emulator
 * screenshot. Cloning copies the example's files into a new project of your
 * own - the original example is never modified.
 */
export function NewProjectModal({ onClone, onBlank, onClose, dismissable = true }) {
  const [examples, setExamples] = useState([]);
  useEffect(() => { loadExamples().then(setExamples).catch(() => setExamples([])); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && dismissable) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, dismissable]);

  return (
    <div className="modal-back" onClick={(e) => { if (e.target === e.currentTarget && dismissable) onClose(); }}>
      <div className="newproj-box">
        <div className="newproj-head">
          <span className="newproj-title">New Project</span>
          <span className="newproj-sub">start blank, or clone an example to make it yours</span>
          {dismissable && <button className="newproj-close" onClick={onClose} aria-label="close">×</button>}
        </div>
        <div className="newproj-grid">
          <div className="newproj-card">
            <div className="newproj-thumb blank" aria-hidden="true"><span>+</span></div>
            <div className="newproj-name">Blank Project</div>
            <div className="newproj-blurb">Empty _init / _update60 / _draw, ready to type into.</div>
            <button className="newproj-clone" onClick={onBlank}>Create</button>
          </div>
          {examples.map((ex) => (
            <div className="newproj-card" key={ex.id}>
              {ex.thumb
                ? <img className="newproj-thumb" src={`/gba/examples/${ex.id}/thumb.png`} alt={`${ex.name} screenshot`} width="240" height="160" />
                : <div className="newproj-thumb blank" aria-hidden="true" />}
              <div className="newproj-name">{ex.name}</div>
              <div className="newproj-blurb">{ex.blurb ?? ""}</div>
              <button className="newproj-clone" onClick={() => onClone(ex)}>Clone</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
