/**
 * Tier-2.5 effect tracking.
 *
 * Adapters tag specific nodes with sinks (`db-write`, `network`, `env-read`,
 * `fs-write`, `exec`, `log`). This module walks the call graph in reverse
 * and propagates those tags to every transitive caller.
 *
 * Mutates the IR in place: each node gets `effects: string[]` (deduped),
 * and a `pure` boolean is computed (`pure === !effects.length`).
 *
 * Why on the IR (not in the projection): downstream consumers (the viewer's
 * effect badges, the verify heuristics, the LLM topology summary) all need
 * the same answer. Compute once, read everywhere.
 */

const ALL_SINKS = new Set([
  "db-read",
  "db-write",
  "network",
  "env-read",
  "fs-read",
  "fs-write",
  "exec",
  "log",
]);

/**
 * Apply the seed effects then propagate. `seedEffects` is the output of
 * `runAdapters().effects` — `[{ ownerId, sink }]`.
 */
export function annotateEffects(ir, seedEffects) {
  const effectsByNode = new Map();
  for (const { ownerId, sink } of seedEffects || []) {
    if (!ALL_SINKS.has(sink)) continue;
    if (!effectsByNode.has(ownerId)) effectsByNode.set(ownerId, new Set());
    effectsByNode.get(ownerId).add(sink);
  }

  // Build reverse-call adjacency: target → sources via `calls` edges.
  const callers = new Map();
  for (const e of ir.edges || []) {
    if (e.kind !== "calls") continue;
    if (!callers.has(e.target)) callers.set(e.target, []);
    callers.get(e.target).push(e.source);
  }

  // BFS from each seeded node up the caller chain.
  const queue = [...effectsByNode.keys()];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    const myEffects = effectsByNode.get(id);
    if (!myEffects) continue;
    const upstream = callers.get(id) || [];
    for (const src of upstream) {
      const key = `${src}::${[...myEffects].sort().join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!effectsByNode.has(src)) effectsByNode.set(src, new Set());
      let changed = false;
      for (const eff of myEffects) {
        if (!effectsByNode.get(src).has(eff)) {
          effectsByNode.get(src).add(eff);
          changed = true;
        }
      }
      if (changed) queue.push(src);
    }
  }

  // Stamp effects + pure flag on every node.
  for (const node of ir.nodes || []) {
    const eff = effectsByNode.get(node.id);
    if (eff && eff.size) {
      node.effects = [...eff].sort();
    }
    if (node.kind === "function" || node.kind === "class" || node.kind === "cell") {
      node.pure = !node.effects?.length;
    }
  }
}
