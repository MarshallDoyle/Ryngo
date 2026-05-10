/**
 * HelpOverlay — keyboard-shortcut cheat sheet (Phase 4.3).
 *
 * Opened by pressing `?` (or via the `?` button in the header).
 * Closes on Escape or backdrop click. Modal so focus is contained.
 */
import { useEffect } from "react";

const SHORTCUTS = [
  { keys: ["?"], desc: "Open / close this help" },
  { keys: ["⌘", "K"], desc: "Fuzzy-find a node by name" },
  { keys: ["⌘", "/"], desc: "Toggle light / dark theme" },
  { keys: ["Esc"], desc: "Back / clear selection / close overlay" },
  { keys: ["g", "g"], desc: "Go to graph view" },
  { keys: ["g", "d"], desc: "Go to dashboard" },
  { keys: ["g", "h"], desc: "Clear focus stack (home)" },
  { keys: ["["], desc: "Back in focus history" },
  { keys: ["]"], desc: "Forward in focus history" },
  { keys: ["L"], desc: "Switch to Layers view" },
  { keys: ["F"], desc: "Switch to Files view" },
];

export default function HelpOverlay({ onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="help-backdrop" onClick={onClose}>
      <div
        className="help-card"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="help-header">
          <span className="help-title">Keyboard shortcuts</span>
          <button type="button" className="help-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <ul className="help-list">
          {SHORTCUTS.map((s, i) => (
            <li key={i}>
              <span className="help-keys">
                {s.keys.map((k, j) => (
                  <kbd key={j} className="help-key">
                    {k}
                  </kbd>
                ))}
              </span>
              <span className="help-desc">{s.desc}</span>
            </li>
          ))}
        </ul>
        <div className="help-footer">
          Combine <kbd className="help-key">g</kbd> with the next key — e.g. press{" "}
          <kbd className="help-key">g</kbd> then <kbd className="help-key">d</kbd> for the dashboard.
        </div>
      </div>
    </div>
  );
}
