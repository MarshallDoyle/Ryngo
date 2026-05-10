export function lineLabel(data, line = data?.line) {
  const file = data?.file || data?.path;
  if (!file) return null;
  return `${file}${line ? `:${line}` : ""}`;
}

export function emitSourceLine(data, detail = {}) {
  if (typeof window === "undefined") return;
  const file = detail.file || data?.file || data?.path;
  const line = Number(detail.line || data?.line || 1);
  if (!file || !Number.isFinite(line)) return;
  window.dispatchEvent(
    new CustomEvent("ryngo:source-line", {
      detail: {
        file,
        line: Math.max(1, line),
        label: detail.label || data?.label,
        nodeId: data?.id,
        kind: detail.kind || data?.kind,
      },
    }),
  );
}
