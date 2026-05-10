/**
 * Right-click popover for Ryngo node actions.
 *
 * Props:
 *   ctx:       { x, y, nodeId, nodeLabel, nodeKind } | null
 *   onClose:   () => void
 *   onAnnotate: (ctx) => void
 *   onIntent:  (ctx, kind) => void   // kind: 'refactor' | 'delete' | 'tests' | 'extract'
 *   onPin:     (ctx) => void
 *   pinned:    boolean   // if true the "Pin to cart" menu item flips to "Unpin"
 */
import { useEffect, useRef } from "react";

export default function ContextMenu({
  ctx,
  onClose,
  onAnnotate,
  onIntent,
  onPin,
  pinned,
}) {
  const ref = useRef(null);

  useEffect(() => {
    if (!ctx) return;
    function onDoc(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    // Defer the listener registration so the very click that opened the
    // menu doesn't immediately close it.
    const t = setTimeout(() => {
      document.addEventListener("mousedown", onDoc);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctx, onClose]);

  if (!ctx) return null;

  // Clamp inside the viewport so the menu doesn't render off-screen.
  const W = 220;
  const H = 268;
  const left = Math.min(ctx.x, window.innerWidth - W - 8);
  const top = Math.min(ctx.y, window.innerHeight - H - 8);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left, top, width: W }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="ctx-header">
        {iconForKind(ctx.nodeKind)}{" "}
        <span className="ctx-label">{ctx.nodeLabel}</span>
      </div>
      <button className="ctx-item" onClick={() => onAnnotate(ctx)}>
        <span>📝</span> Annotate…
      </button>
      <div className="ctx-section">Mark intent</div>
      <button
        className="ctx-item"
        onClick={() => onIntent(ctx, "refactor")}
      >
        <span style={{ color: "#fbbf24" }}>↻</span> Refactor this
      </button>
      <button className="ctx-item" onClick={() => onIntent(ctx, "delete")}>
        <span style={{ color: "#f87171" }}>✕</span> Delete this
      </button>
      <button className="ctx-item" onClick={() => onIntent(ctx, "tests")}>
        <span style={{ color: "#86efac" }}>✓</span> Add tests for this
      </button>
      <button className="ctx-item" onClick={() => onIntent(ctx, "extract")}>
        <span style={{ color: "#a5d8ff" }}>↗</span> Extract this
      </button>
      <div className="ctx-section">Cart</div>
      <button className="ctx-item" onClick={() => onPin(ctx)}>
        <span>{pinned ? "★" : "☆"}</span>{" "}
        {pinned ? "Unpin from cart" : "Pin to cart"}
      </button>
    </div>
  );
}

function iconForKind(kind) {
  switch (kind) {
    case "file":
      return "📄";
    case "function":
      return "ƒ";
    case "class":
      return "C";
    case "cell":
      return "▢";
    case "package":
      return "📦";
    default:
      return "·";
  }
}
