export function lineLabel(data, line = data?.line) {
  const source = data?.source;
  const file = source?.path || data?.file || data?.path;
  const startLine = line || source?.startLine;
  const endLine = source?.endLine;
  if (!file) return null;
  if (startLine && endLine && endLine !== startLine) return `${file}:${startLine}-${endLine}`;
  return `${file}${startLine ? `:${startLine}` : ""}`;
}

export function emitSourceLine(data, detail = {}) {
  if (typeof window === "undefined") return;
  const source = detail.source || data?.source;
  const file = detail.file || source?.path || data?.file || data?.path;
  const line = Number(detail.line || source?.startLine || data?.line || 1);
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
