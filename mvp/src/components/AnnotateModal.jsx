/**
 * Inline modal for adding an annotation to a single node.
 *
 * Props:
 *   target:   { nodeId, nodeLabel, nodeKind } | null
 *   onClose:  () => void
 *   onSubmit: ({ nodeId, text }) => Promise<void>
 *
 * The textarea is auto-focused. ⌘+Enter / Ctrl+Enter submits. Escape cancels.
 */
import { useEffect, useRef, useState } from "react";

export default function AnnotateModal({ target, onClose, onSubmit }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (target && ref.current) ref.current.focus();
  }, [target]);

  useEffect(() => {
    function onKey(e) {
      if (!target) return;
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  if (!target) return null;

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit({ nodeId: target.nodeId, text: trimmed });
      setText("");
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="annotate-backdrop" onMouseDown={onClose}>
      <div
        className="annotate-card"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="annotate-header">
          <strong>Annotate</strong>
          <span className="muted mono">{target.nodeId}</span>
        </div>
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
          }}
          placeholder={`What should change about ${target.nodeLabel}?  (Cmd+Enter to save)`}
          rows={5}
          disabled={busy}
        />
        {err && <div className="annotate-err">{err}</div>}
        <div className="annotate-row">
          <span className="muted">
            Saved to <code>.ryngo/annotations.md</code>; readable by your AI tools.
          </span>
          <div className="annotate-actions">
            <button type="button" className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!text.trim() || busy}
            >
              {busy ? "Saving…" : "Save annotation"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
