/**
 * Cognitive complexity — nesting-aware variant inspired by SonarSource.
 *
 * See design/complexity-overlay.md §1.2 + §4.1.
 *
 * Reuses the `ControlFlowEvent` stream that cyclomatic operates on (see
 * `./cyclomatic.ts`). The two metrics differ only in the fold: cognitive
 * tracks a depth counter and adds the current depth on top of the base 1 for
 * structures that nest, while flat boolean operators and `else` clauses add 1
 * with no nesting bonus.
 *
 * The §4.1 pseudocode is the spec; this file is its straightforward port.
 * Discrepancies should be resolved against the design doc, not the code.
 */
import type { ControlFlowKind } from "./cyclomatic.js";
import type { FunctionAst } from "./index.js";

/**
 * Compute cognitive complexity for a function from its event stream.
 *
 * Base value is 0 (a function with no control flow has cognitive 0; the
 * "interesting" baseline is the comparison between two functions, not a
 * floor). Returns an integer >= 0.
 */
export function computeCognitive(fn: FunctionAst): number {
  let cog = 0;
  let depth = 0;

  for (const ev of fn.events) {
    if (ev.phase === "enter") {
      const delta = enterCognitive(ev.kind, depth);
      cog += delta.add;
      depth += delta.depthDelta;
    } else if (ev.phase === "exit") {
      if (decreasesDepthOnExit(ev.kind)) depth -= 1;
    }
  }

  return cog;
}

interface EnterDelta {
  /** Points to add to the cognitive total at enter time. */
  readonly add: number;
  /** Depth increment for this construct (0 if it doesn't nest). */
  readonly depthDelta: number;
}

/**
 * Per-event contribution at enter time. Encodes design §1.2 + §4.1:
 *
 *   - Structural breaks (`if`, loops, `switch`, `catch`) add `1 + depth` and
 *     bump depth by 1.
 *   - `else` and `else-if` add 1 flat (no nesting bonus on the else arm
 *     itself; the inner block re-enters via `if` if it nests further).
 *   - Ternary adds `1 + depth` but does not increase depth (ternaries inside
 *     ternaries already get penalised by the boolean-operator rule and we
 *     don't want to double-count).
 *   - Boolean operators and nullish coalescing add 1 flat.
 *   - Recursion and labelled jumps add 1 flat (§1.2 bullets 4 & 5).
 *   - Optional chaining is *not* a cognitive break — it's syntactic sugar
 *     and reads as one branch to a human (cyclomatic still counts it).
 */
function enterCognitive(kind: ControlFlowKind, depth: number): EnterDelta {
  switch (kind) {
    case "if":
    case "for":
    case "while":
    case "do-while":
    case "catch":
      return { add: 1 + depth, depthDelta: 1 };

    case "switch":
      return { add: 1 + depth, depthDelta: 1 };

    case "else":
    case "else-if":
      return { add: 1, depthDelta: 0 };

    // Each `case` arm adds 1 (matches "12-arm switch is gnarlier than
    // if/else"). The switch itself already added `1 + depth` above; we
    // intentionally don't add depth on the case arms since they're siblings
    // inside the switch, not deeper nesting.
    case "case":
      return { add: 1, depthDelta: 0 };

    case "ternary":
      return { add: 1 + depth, depthDelta: 0 };

    case "logical-and":
    case "logical-or":
    case "nullish-coalesce":
      return { add: 1, depthDelta: 0 };

    case "break-label":
    case "continue-label":
    case "recursive-call":
      return { add: 1, depthDelta: 0 };

    case "function-enter":
    case "function-exit":
    case "optional-chain":
      return { add: 0, depthDelta: 0 };
  }
}

/**
 * Constructs whose `enter` bumped depth must drop it on `exit`. Mirrors the
 * `depthDelta: 1` cases in `enterCognitive`.
 */
function decreasesDepthOnExit(kind: ControlFlowKind): boolean {
  switch (kind) {
    case "if":
    case "for":
    case "while":
    case "do-while":
    case "switch":
    case "catch":
      return true;
    default:
      return false;
  }
}
