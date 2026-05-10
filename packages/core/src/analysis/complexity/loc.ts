/**
 * Lines of code (LOC) — physical line span of a node.
 *
 * See design/complexity-overlay.md §1.3.
 *
 * We count physical lines (`endLine - startLine + 1`), not logical
 * statements. Blank lines and comments are *not* subtracted: design §1.3
 * explicitly defers that, and any line-stripping rule fights JSDoc-heavy
 * codebases.
 *
 * For function and expression nodes, the line range comes from the AST node;
 * for module nodes (files), it comes from the file itself. This module is
 * agnostic about that — both arrive as `{ startLine, endLine }`.
 */

/**
 * Minimum shape this metric needs. Both `startLine` and `endLine` are 1-based
 * inclusive (the convention used everywhere else in codegraph; see
 * `spec/ir.types.ts#SourceLoc`).
 */
export interface LineRange {
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Physical line count for a single range. Returns 0 if the input is missing
 * or malformed (negative, swapped) — the metric is best-effort, never throws.
 */
export function computeLoc(range: LineRange | null | undefined): number {
  if (!range) return 0;
  const { startLine, endLine } = range;
  if (
    !Number.isFinite(startLine) ||
    !Number.isFinite(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    return 0;
  }
  return endLine - startLine + 1;
}
