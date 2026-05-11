/**
 * IR-level dead-code + circular-import detection.
 *
 * Two warnings that can't live in `warnings.js` because they need the
 * full IR (edges + cross-file graph), not just a function body.
 *
 *   dead-function    — def node with no inbound `calls` edges AND
 *                      not exported through any import edge that
 *                      references its file by path.
 *   circular-import  — cycle in the `imports-file` edge subgraph.
 *                      Attaches a warning to every node in the cycle.
 *
 * Runs once per `analyzeRepo` call, after `resolveSymbols` populated
 * the edges. Mutates `ir.nodes[i].data.warnings` in place — same
 * shape as `warnings.js` outputs so the viewer's existing ⚠ badge
 * code works without changes.
 *
 * Pure read of `ir.nodes` + `ir.edges`. No I/O, no parsing.
 */

/**
 * Top-level entry point — runs both passes against the IR. Idempotent
 * and safe to call twice (warnings de-dupe by kind).
 */
export function attachDeadCodeWarnings(ir) {
  if (!ir?.nodes || !ir?.edges) return;
  attachDeadFunctionWarnings(ir);
  attachCircularImportWarnings(ir);
}

// ---------------------------------------------------------------------------
// dead-function — defs with no inbound calls and no export plausible
// ---------------------------------------------------------------------------

/**
 * Names we never flag as dead even if no caller is visible. These are
 * conventional entry points / framework hooks that get called by
 * runtime infrastructure, not by source code we can see.
 */
const ENTRY_POINT_NAMES = new Set([
  "main",
  "default",
  "index",
  "init",
  "setup",
  "teardown",
  "render",        // React
  "componentDidMount",
  "componentWillUnmount",
  "getServerSideProps",
  "getStaticProps",
  "getStaticPaths",
  "loader",        // Remix
  "action",
  "middleware",
  "handler",       // Next.js / Vercel
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
  "lifespan",      // FastAPI
  "startup",
  "shutdown",
  "__init__",      // Python
  "__main__",
  "__call__",
  "__enter__",
  "__exit__",
  "__repr__",
  "__str__",
  "__eq__",
  "__hash__",
]);

function isEntryPointName(name) {
  if (!name) return false;
  if (ENTRY_POINT_NAMES.has(name)) return true;
  // React component naming (PascalCase) — common entry points for
  // routes / pages that aren't directly called from source.
  if (/^[A-Z][A-Za-z0-9]*$/.test(name)) return true;
  // Underscore-prefix names are conventionally private; if they have
  // no inbound calls inside the repo they really are dead, so DO
  // flag them.
  return false;
}

function attachDeadFunctionWarnings(ir) {
  // Build inbound-call counts per node id.
  const inboundCalls = new Map();
  for (const edge of ir.edges) {
    if (edge.kind !== "calls") continue;
    inboundCalls.set(edge.target, (inboundCalls.get(edge.target) || 0) + 1);
  }

  // Build a set of file paths that are imported by SOMETHING. A def
  // can only be "exported and used" if its parent file appears as a
  // target of an imports-file edge.
  const importedFiles = new Set();
  for (const edge of ir.edges) {
    if (edge.kind !== "imports-file") continue;
    importedFiles.add(edge.target);
  }

  // Also build a set of route-handler targets. Adapters emit
  // `route-handler` edges pointing at handler defs that are called
  // by the framework runtime, not source code.
  const routeHandlers = new Set();
  for (const edge of ir.edges) {
    if (edge.kind !== "route-handler") continue;
    routeHandlers.add(edge.target);
  }

  for (const node of ir.nodes) {
    if (node.kind !== "function" && node.kind !== "class") continue;

    // Python is too noisy at this confidence level — `__init__.py`
    // re-exports, `__all__`, and module-level imports done at runtime
    // (e.g. `getattr(mod, name)`) aren't visible in our IR. Hold off
    // on Python until tree-sitter + a real export-tracking pass land.
    const file = node.data?.file || node.data?.path || "";
    if (file.endsWith(".py") || file.endsWith(".pyi") || file.endsWith(".ipynb")) continue;

    const inbound = inboundCalls.get(node.id) || 0;
    if (inbound > 0) continue;
    if (routeHandlers.has(node.id)) continue;
    if (isEntryPointName(node.data?.name || node.label)) continue;
    // Skip exported defs whose file is imported somewhere. We don't
    // have per-binding resolution, so this is best-effort: the file
    // being imported means the symbol might be used externally.
    const fileId = node.parentId || `file:${file}`;
    if (importedFiles.has(fileId)) continue;
    // Skip tests, examples, scripts, docs — these contain entry-point
    // functions called by runners, build tools, or humans, not source code.
    if (file.match(/\.(test|spec)\.(?:[jt]sx?|py)$/i)) continue;
    if (
      file.includes("/tests/") ||
      file.includes("/test/") ||
      file.includes("/__tests__/") ||
      file.includes("/examples/") ||
      file.includes("/example/") ||
      file.includes("/scripts/") ||
      file.includes("/script/") ||
      file.includes("/docs/") ||
      file.includes("/doc/") ||
      file.includes("/bin/") ||
      file.includes("/benchmarks/") ||
      file.includes("/benchmark/") ||
      file.includes("/demo/")
    ) continue;
    addWarning(node, {
      kind: "dead-function",
      severity: "medium",
      message: "no inbound calls and parent file is never imported — likely dead",
    });
  }
}

// ---------------------------------------------------------------------------
// circular-import — cycles in the imports-file edge subgraph
// ---------------------------------------------------------------------------

function attachCircularImportWarnings(ir) {
  // Build the adjacency list of file → files it imports.
  const adj = new Map();
  for (const edge of ir.edges) {
    if (edge.kind !== "imports-file") continue;
    if (!adj.has(edge.source)) adj.set(edge.source, []);
    adj.get(edge.source).push(edge.target);
  }
  if (adj.size === 0) return;

  // Tarjan's SCC algorithm finds all strongly connected components
  // in linear time. Any SCC with size > 1 is a cycle; a singleton
  // SCC where the node has a self-loop is also a cycle.
  const cycles = tarjanCycles(adj);
  if (cycles.length === 0) return;

  // Pick the canonical "biggest cycle" to surface a single message
  // per file rather than spamming each file with one warning per
  // cycle membership.
  const inCycle = new Map(); // fileId → array of cycle ids it's part of
  for (const cycle of cycles) {
    for (const fileId of cycle) {
      if (!inCycle.has(fileId)) inCycle.set(fileId, []);
      inCycle.get(fileId).push(cycle);
    }
  }

  for (const node of ir.nodes) {
    if (node.kind !== "file") continue;
    const cyclesForThisFile = inCycle.get(node.id);
    if (!cyclesForThisFile?.length) continue;
    // Pick the smallest cycle this file participates in so the
    // message names the minimal repro.
    cyclesForThisFile.sort((a, b) => a.length - b.length);
    const cycle = cyclesForThisFile[0];
    const otherFiles = cycle
      .filter((id) => id !== node.id)
      .map((id) => id.replace(/^file:/, ""))
      .slice(0, 3);
    const message =
      otherFiles.length === 0
        ? "self-importing file"
        : `import cycle with ${otherFiles.join(", ")}${cycle.length > 4 ? ` +${cycle.length - 4} more` : ""}`;
    addWarning(node, {
      kind: "circular-import",
      severity: "high",
      message,
    });
  }
}

/**
 * Tarjan's strongly-connected components. Returns a list of SCCs
 * (each is an array of node ids). Only includes SCCs that represent
 * a real cycle — singletons without a self-loop are dropped.
 */
function tarjanCycles(adj) {
  const index = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const cycles = [];
  let counter = 0;

  // Iterative Tarjan — recursive blows the stack on large repos.
  // Collect all nodes first so we visit every component.
  const allNodes = new Set();
  for (const [from, tos] of adj.entries()) {
    allNodes.add(from);
    for (const to of tos) allNodes.add(to);
  }

  for (const start of allNodes) {
    if (index.has(start)) continue;
    // Per-start iterative DFS using a worklist of (node, iterator) pairs.
    const work = [{ node: start, neighborsIter: (adj.get(start) || [])[Symbol.iterator]() }];
    index.set(start, counter);
    lowlink.set(start, counter);
    counter++;
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const next = frame.neighborsIter.next();
      if (next.done) {
        // backtrack — check SCC
        if (lowlink.get(frame.node) === index.get(frame.node)) {
          const scc = [];
          while (true) {
            const top = stack.pop();
            onStack.delete(top);
            scc.push(top);
            if (top === frame.node) break;
          }
          if (scc.length > 1) {
            cycles.push(scc);
          } else if (scc.length === 1) {
            // self-loop?
            const onlyNode = scc[0];
            if ((adj.get(onlyNode) || []).includes(onlyNode)) {
              cycles.push(scc);
            }
          }
        }
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1];
          lowlink.set(parent.node, Math.min(lowlink.get(parent.node), lowlink.get(frame.node)));
        }
      } else {
        const w = next.value;
        if (!index.has(w)) {
          index.set(w, counter);
          lowlink.set(w, counter);
          counter++;
          stack.push(w);
          onStack.add(w);
          work.push({ node: w, neighborsIter: (adj.get(w) || [])[Symbol.iterator]() });
        } else if (onStack.has(w)) {
          lowlink.set(frame.node, Math.min(lowlink.get(frame.node), index.get(w)));
        }
      }
    }
  }
  return cycles;
}

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

function addWarning(node, warning) {
  if (!node.data) node.data = {};
  if (!Array.isArray(node.data.warnings)) node.data.warnings = [];
  // De-dupe by kind so re-running the pass doesn't multiply messages.
  if (node.data.warnings.some((w) => w.kind === warning.kind)) return;
  node.data.warnings.push(warning);
}
