/**
 * Apply-and-verify — given an intent + the IR snapshot taken when the
 * intent was created + the *current* IR, decide whether the intent has
 * been satisfied and report concrete evidence.
 *
 *   verifyIntent(intent, snapshotIR, currentIR) → {
 *     status:   'satisfied' | 'partial' | 'open',
 *     evidence: [string, …],   // human-readable lines for the UI
 *     diff:     { added: n, removed: n, changedEdges: n }
 *   }
 *
 * Heuristics by intent type:
 *
 *   delete    — affected nodes should be REMOVED in the diff.
 *   refactor  — affected nodes still exist, but their outgoing edges
 *               changed (added or removed). Body changes that don't
 *               surface as edge changes won't be detected — that's OK,
 *               PMs care about structural change anyway.
 *   extract   — affected nodes survive but moved to a different parent
 *               (different file). Detected by parentId comparison.
 *   tests     — a new node appeared with a "test"-shaped name (file path
 *               contains 'test', or def name starts with 'test_' / 'test ').
 *   rename    — an affected node was removed AND a new node appeared with
 *               a similar enough name.
 *
 * No LLM, no fuzzy matching beyond what's spelled out above. Same
 * snapshot + same current IR → same verdict.
 */
import { diffIRs } from "./diff.js";

export function verifyIntent(intent, snapshotIR, currentIR) {
  if (!intent || !snapshotIR || !currentIR) {
    return { status: "open", evidence: ["missing snapshot or current IR"] };
  }
  const kind = intent.meta?.type || "refactor";
  const nodeIds = intent.nodeIds || [];
  if (nodeIds.length === 0) {
    return { status: "open", evidence: ["no affected nodes recorded"] };
  }

  const diff = diffIRs(snapshotIR, currentIR);
  const diffSummary = {
    added: diff.diff.counts.nodes.added,
    removed: diff.diff.counts.nodes.removed,
    changedEdges:
      diff.diff.counts.edges.added + diff.diff.counts.edges.removed,
  };

  // Per-affected-node diff status.
  const byId = new Map(diff.nodes.map((n) => [n.id, n]));
  const statuses = nodeIds.map((id) => {
    const n = byId.get(id);
    return { id, status: n ? n._diff : "missing" };
  });

  if (kind === "delete") {
    return judgeDelete(statuses, diffSummary);
  }
  if (kind === "refactor") {
    return judgeRefactor(nodeIds, snapshotIR, currentIR, diffSummary);
  }
  if (kind === "extract") {
    return judgeExtract(nodeIds, snapshotIR, currentIR, diffSummary);
  }
  if (kind === "tests") {
    return judgeTests(nodeIds, snapshotIR, currentIR, diffSummary);
  }
  if (kind === "rename") {
    return judgeRename(nodeIds, snapshotIR, currentIR, diffSummary);
  }
  // Unknown intent type — fall back to "any change" heuristic.
  return judgeAnyChange(statuses, diffSummary);
}

// ---------------------------------------------------------------------------

function judgeDelete(statuses, diffSummary) {
  const removed = statuses.filter((s) => s.status === "removed");
  const evidence = statuses.map((s) => `${s.id}: ${s.status}`);
  if (removed.length === statuses.length) {
    return { status: "satisfied", evidence, diff: diffSummary };
  }
  if (removed.length > 0) {
    return { status: "partial", evidence, diff: diffSummary };
  }
  return { status: "open", evidence, diff: diffSummary };
}

function judgeRefactor(nodeIds, base, head, diffSummary) {
  const beforeOut = groupOutgoing(base.edges);
  const afterOut = groupOutgoing(head.edges);
  const beforeNodes = new Map(base.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(head.nodes.map((n) => [n.id, n]));

  const evidence = [];
  let satisfiedCount = 0;
  for (const id of nodeIds) {
    if (!afterNodes.has(id)) {
      // Removed entirely — counts as a refactor (structural change).
      evidence.push(`${id}: removed`);
      satisfiedCount++;
      continue;
    }
    const before = beforeOut.get(id) || new Set();
    const after = afterOut.get(id) || new Set();
    const added = setSub(after, before);
    const removed = setSub(before, after);
    if (added.size > 0 || removed.size > 0) {
      evidence.push(
        `${id}: edges +${added.size}/-${removed.size}`,
      );
      satisfiedCount++;
    } else {
      evidence.push(`${id}: unchanged`);
    }
  }
  return finalize(satisfiedCount, nodeIds.length, evidence, diffSummary);
}

function judgeExtract(nodeIds, base, head, diffSummary) {
  const before = new Map(base.nodes.map((n) => [n.id, n]));
  const after = new Map(head.nodes.map((n) => [n.id, n]));
  const evidence = [];
  let satisfiedCount = 0;
  for (const id of nodeIds) {
    const b = before.get(id);
    const a = after.get(id);
    if (!a) {
      evidence.push(`${id}: removed (not extracted)`);
      continue;
    }
    if (b && b.parentId !== a.parentId) {
      evidence.push(
        `${id}: parent ${trim(b.parentId)} → ${trim(a.parentId)}`,
      );
      satisfiedCount++;
    } else {
      evidence.push(`${id}: same parent`);
    }
  }
  return finalize(satisfiedCount, nodeIds.length, evidence, diffSummary);
}

function judgeTests(nodeIds, base, head, diffSummary) {
  // Find new test-looking nodes that didn't exist in base.
  const beforeIds = new Set(base.nodes.map((n) => n.id));
  const newTests = head.nodes.filter((n) => {
    if (beforeIds.has(n.id)) return false;
    if (n.kind === "file") {
      const p = n.data?.path || "";
      return /(^|\/)tests?(\/|$)|\.test\.|\.spec\.|_test\.|test_/i.test(p);
    }
    if (n.kind === "function") {
      const name = n.label || "";
      return /^test[_ ]/i.test(name) || /test$/i.test(name);
    }
    return false;
  });
  const evidence =
    newTests.length === 0
      ? ["no test-shaped nodes added"]
      : newTests
          .slice(0, 6)
          .map((n) => `+ ${n.kind} \`${n.label}\``);
  if (newTests.length > 6)
    evidence.push(`…and ${newTests.length - 6} more`);
  // Heuristic: any new test is enough to call it partial; covering all
  // affected nodes (best-effort by name match) tips it to satisfied.
  let coversAll = true;
  for (const id of nodeIds) {
    const targetName = idToName(id);
    if (!targetName) continue;
    const matched = newTests.some((t) =>
      (t.label || "").toLowerCase().includes(targetName.toLowerCase()),
    );
    if (!matched) {
      coversAll = false;
      break;
    }
  }
  let status = "open";
  if (newTests.length > 0) status = coversAll ? "satisfied" : "partial";
  return { status, evidence, diff: diffSummary };
}

function judgeRename(nodeIds, base, head, diffSummary) {
  const afterIds = new Set(head.nodes.map((n) => n.id));
  const newNodes = head.nodes.filter(
    (n) => !base.nodes.some((b) => b.id === n.id),
  );
  const evidence = [];
  let satisfiedCount = 0;
  for (const id of nodeIds) {
    if (afterIds.has(id)) {
      evidence.push(`${id}: still present (no rename detected)`);
      continue;
    }
    // Look for a new node whose label is similar.
    const original = idToName(id) || "";
    const candidate = newNodes.find((n) => similar(original, n.label || ""));
    if (candidate) {
      evidence.push(
        `${id}: → \`${candidate.label}\` (${candidate.id})`,
      );
      satisfiedCount++;
    } else {
      evidence.push(`${id}: removed but no rename candidate found`);
    }
  }
  return finalize(satisfiedCount, nodeIds.length, evidence, diffSummary);
}

function judgeAnyChange(statuses, diffSummary) {
  const changed = statuses.filter(
    (s) => s.status !== "unchanged" && s.status !== "missing",
  );
  const evidence = statuses.map((s) => `${s.id}: ${s.status}`);
  if (changed.length === statuses.length) {
    return { status: "satisfied", evidence, diff: diffSummary };
  }
  if (changed.length > 0) {
    return { status: "partial", evidence, diff: diffSummary };
  }
  return { status: "open", evidence, diff: diffSummary };
}

// ---------------------------------------------------------------------------

function finalize(satisfied, total, evidence, diffSummary) {
  let status = "open";
  if (satisfied === total && total > 0) status = "satisfied";
  else if (satisfied > 0) status = "partial";
  return { status, evidence, diff: diffSummary };
}

function groupOutgoing(edges) {
  const map = new Map();
  for (const e of edges) {
    if (!map.has(e.source)) map.set(e.source, new Set());
    map.get(e.source).add(`${e.target}@${e.kind}`);
  }
  return map;
}

function setSub(a, b) {
  const out = new Set();
  for (const x of a) if (!b.has(x)) out.add(x);
  return out;
}

function idToName(nodeId) {
  // def:foo.py#bar → 'bar', file:src/x.ts → 'x.ts', cell:nb#3 → null,
  // pkg:react → 'react'
  const after = nodeId.split(":").slice(1).join(":");
  const hash = after.indexOf("#");
  if (hash !== -1) return after.slice(hash + 1) || null;
  const seg = after.split("/").slice(-1)[0];
  return seg || null;
}

function similar(a, b) {
  if (!a || !b) return false;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al === bl) return false; // same name = not a rename
  if (al.includes(bl) || bl.includes(al)) return true;
  // crude levenshtein cheat: equal length + ≤ 2 differing chars
  if (al.length === bl.length) {
    let diff = 0;
    for (let i = 0; i < al.length; i++) if (al[i] !== bl[i]) diff++;
    return diff > 0 && diff <= 2;
  }
  return false;
}

function trim(s) {
  if (!s) return "?";
  return s.length > 32 ? "…" + s.slice(-30) : s;
}
