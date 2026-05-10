/**
 * Cyclomatic complexity — McCabe count of linearly independent paths.
 *
 * See design/complexity-overlay.md §1.1 + §4.1.
 *
 * Operates on a *language-neutral* sequence of `ControlFlowEvent`s emitted by
 * the per-language indexers. The events describe a pre-order walk of the
 * function body; the visitor in this file is a fold over that sequence.
 *
 * Why events, not a tree? The indexers already walk the AST once to build IR
 * fragments — re-walking a tree-sitter `SyntaxNode` here would mean either
 * leaking the grammar-specific node shape into core (it varies between TS and
 * Python) or paying a second parse. A flat event sequence is the smallest
 * stable contract that captures everything decision-counting needs.
 */
import type { FunctionAst } from "./index.js";

/**
 * Decision-point kinds that increment cyclomatic count by 1.
 *
 * Mirrors the bullets in design §1.1 verbatim. The indexers map their
 * grammar-specific AST nodes onto this closed enum; future grammars only need
 * to add a new mapping, not a new event kind.
 *
 * Re-exported by `cognitive.ts`; the two metrics share the same event stream.
 */
export type ControlFlowKind =
  // Entered when the function body's prologue starts. Used by cognitive's
  // depth tracking; cyclomatic ignores it.
  | "function-enter"
  | "function-exit"
  // Branching constructs.
  | "if"
  | "else-if"
  | "else"
  | "for"
  | "while"
  | "do-while"
  | "switch"
  | "case"
  | "catch"
  | "ternary"
  // Boolean-operator branches inside conditions.
  | "logical-and"
  | "logical-or"
  | "nullish-coalesce"
  | "optional-chain"
  // Cognitive-only events; cyclomatic ignores them (recursion and labelled
  // jumps are not classical decision points). Listed here so the event union
  // is closed.
  | "break-label"
  | "continue-label"
  | "recursive-call";

/**
 * One step of a pre-order traversal of a function body. `enter` fires before
 * the children, `exit` after. Leaf-style events (e.g. `logical-and`,
 * `recursive-call`) emit only `enter`; the visitor is robust to a missing
 * `exit` for those.
 */
export interface ControlFlowEvent {
  readonly kind: ControlFlowKind;
  readonly phase: "enter" | "exit";
}

/**
 * Compute McCabe cyclomatic complexity for a function from its event stream.
 *
 * Base count is 1 (the straight-line path through the body). Each decision
 * point listed in design §1.1 increments by 1.
 *
 * Returns an integer >= 1. Pure function — no I/O, no allocation past the
 * counter.
 */
export function computeCyclomatic(fn: FunctionAst): number {
  let count = 1;
  for (const ev of fn.events) {
    if (ev.phase !== "enter") continue;
    if (incrementsCyclomatic(ev.kind)) count += 1;
  }
  return count;
}

/**
 * Single source of truth for "does this AST construct add a path?" The set is
 * deliberately closed: anything not listed here (function-enter, recursion,
 * labelled jumps, plain blocks) does not affect cyclomatic complexity.
 */
export function incrementsCyclomatic(kind: ControlFlowKind): boolean {
  switch (kind) {
    case "if":
    case "else-if":
    case "for":
    case "while":
    case "do-while":
    case "case":
    case "catch":
    case "ternary":
    case "logical-and":
    case "logical-or":
    case "nullish-coalesce":
    case "optional-chain":
      return true;
    case "function-enter":
    case "function-exit":
    case "else":
    case "switch":
    case "break-label":
    case "continue-label":
    case "recursive-call":
      return false;
  }
}
