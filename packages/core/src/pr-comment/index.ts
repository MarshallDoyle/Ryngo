/**
 * `@codegraph/core/pr-comment` — render a sticky PR comment from a `GraphDiff`.
 *
 * Public entry point for the PR-comment renderer. The Action and the CLI
 * (`codegraph diff --format markdown`) both call into this module. The shape
 * of the rendered comment is governed by `design/pr-comment.md`.
 *
 * Determinism note: the renderer is a pure function of `(diff, opts)`. It
 * never reads the clock, never hashes anything, and never iterates `Set`s
 * or `Map`s without an explicit sort. The diff fed in is itself
 * deterministic (per `design/diff-algorithm.md` §8), so the rendered string
 * is suitable for sticky-comment edit-in-place: identical inputs produce
 * byte-identical output.
 */
export { renderPRComment, COMMENT_MARKER } from "./render.js";
export type {
  RenderOptions,
  CommentMode,
  PRMeta,
  SeverityLabel,
} from "./render.js";
