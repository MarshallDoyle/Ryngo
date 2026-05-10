/**
 * cgql — query planner.
 *
 * Hand-written recursive translation of `QueryAST` to a `Plan` tree.
 * No cost-based optimizer; just the four heuristics from
 * design/query-language.md §7.2:
 *
 *   1. Push filters down — inline `(:tier {k:v})` becomes `Filter ← Scan(tier)`.
 *   2. Prefer indexed scans — sink/leaf-flavor sugar uses bySinkFlavor /
 *      byLeafFlavor; tier label uses byTier; id equality uses IdLookup.
 *   3. Direct shorter side first — for `(a)-[:cat*]->(b)`, the planner
 *      compares estimated cardinalities of `a` and `b` and runs the path
 *      expansion *backwards* from the smaller side when that wins.
 *   4. Bound unbounded paths — `*` with no upper bound clamps to
 *      `--max-path-length` (default 16) and emits a planner diagnostic.
 *
 * The planner does not run; the engine in engine.ts walks the plan tree.
 * Cost numbers stamped onto each operator are rough cardinality
 * estimates — they show up in `--explain` and steer heuristic 3, nothing
 * else depends on them.
 */

import {
  CgqlPlanError,
  type Diagnostic,
  type Expr,
  type EdgePattern,
  type MatchClause,
  type NodeLabel,
  type NodePattern,
  type OrderByClause,
  type Plan,
  type ProjectionItem,
  type PropFilter,
  type QueryAST,
} from "./types.js";
import type { Store } from "./indexes.js";

// =============================================================================
// Public entry
// =============================================================================

export interface PlanOptions {
  maxPathLength: number;
  diagnostics: Diagnostic[];
}

export function plan(ast: QueryAST, store: Store, opts: PlanOptions): Plan {
  const ctx = new PlanCtx(store, opts);

  // 1. Build a Match plan that joins all MATCH clauses.
  let cur: Plan | undefined;
  for (const m of ast.matches) {
    const next = ctx.planMatch(m);
    cur = cur ? ctx.cartesian(cur, next) : next;
  }

  // Empty match list (e.g. `RETURN 1`) is technically permitted; synthesize
  // a single-row "scan" by scanning all nodes and limiting to 1. In practice
  // nobody writes that — but the engine still needs *some* row stream to
  // project from, so we make one node row.
  if (!cur) {
    cur = {
      kind: "Limit",
      id: ctx.nextId(),
      input: {
        kind: "Scan",
        id: ctx.nextId(),
        rowKey: "_",
        props: [],
        cost: 1,
      },
      n: 1,
      cost: 1,
    };
  }

  // 2. WHERE
  if (ast.where) cur = ctx.filter(cur, ast.where);

  // 3. WITH ... [WHERE ...]  (chain of pipelines)
  for (const w of ast.withClauses) {
    cur = ctx.aggregate(cur, w.items);
    if (w.where) cur = ctx.filter(cur, w.where);
  }

  // 4. ORDER BY
  if (ast.orderBy && ast.orderBy.length > 0) {
    cur = ctx.sort(cur, ast.orderBy);
  }

  // 5. LIMIT
  if (typeof ast.limit === "number") cur = ctx.limit(cur, ast.limit);

  // 6. RETURN
  cur = ctx.project(cur, ast.ret.items, ast.distinct);

  return cur;
}

// =============================================================================
// Planning context
// =============================================================================

class PlanCtx {
  private idCounter = 0;
  constructor(readonly store: Store, readonly opts: PlanOptions) {}

  nextId(): number {
    return this.idCounter++;
  }

  // ---------------------------------------------------------------- match
  planMatch(m: MatchClause): Plan {
    const { pattern, pathVar } = m;
    const { nodes, edges } = pattern;

    // Single-node pattern: just a Scan.
    if (edges.length === 0) {
      return this.scan(nodes[0]!);
    }

    // For now, support patterns with a single edge — but allow chains by
    // unfolding them into a sequence of Expand operators left-to-right.
    // The "shorter side first" heuristic is applied to the *first* edge.
    let leftIdx = 0;
    let rightIdx = 1;
    let leftPat = nodes[leftIdx]!;
    let rightPat = nodes[rightIdx]!;
    let edgePat = edges[0]!;

    // Heuristic 3: pick the more selective side as the seed.
    const leftCost = estimateNodeCost(leftPat, this.store);
    const rightCost = estimateNodeCost(rightPat, this.store);
    let reversed = false;
    if (rightCost < leftCost) {
      reversed = true;
      [leftPat, rightPat] = [rightPat, leftPat];
      edgePat = invertEdgePattern(edgePat);
    }

    // Build the seed scan.
    const seedKey = leftPat.var ?? `_n${leftIdx}`;
    let cur: Plan = this.scan(leftPat, seedKey);

    // First edge.
    const targetKey = rightPat.var ?? `_n${rightIdx}`;
    cur = this.expandStep(cur, seedKey, targetKey, rightPat, edgePat, pathVar, reversed);

    // Remaining edges (if any) — chain forward without re-applying heuristic 3.
    for (let i = 1; i < edges.length; i++) {
      const ePat = edges[i]!;
      const nPat = nodes[i + 1]!;
      const fromKey = nodes[i]!.var ?? `_n${i}`;
      const toKey = nPat.var ?? `_n${i + 1}`;
      cur = this.expandStep(cur, fromKey, toKey, nPat, ePat, undefined, false);
    }

    return cur;
  }

  // ---------------------------------------------------------------- scan
  scan(pat: NodePattern, rowKeyOverride?: string): Plan {
    const rowKey = rowKeyOverride ?? pat.var ?? "_n0";

    // Heuristic 2: id equality → IdLookup.
    const idFilter = pat.inlineFilters.find((f) => f.key === "id");
    if (idFilter && typeof idFilter.value.value === "string") {
      const lookup: Plan = {
        kind: "IdLookup",
        id: this.nextId(),
        rowKey,
        nodeId: idFilter.value.value as never,
        cost: 1,
      };
      const remaining = pat.inlineFilters.filter((f) => f !== idFilter);
      if (remaining.length > 0) {
        return this.applyInlineFilters(lookup, rowKey, remaining);
      }
      return lookup;
    }

    // Heuristic 2: sink/leaf-flavor sugar.
    if (pat.label === "sink") {
      const flavorFilter = pat.inlineFilters.find((f) => f.key === "flavor");
      const cost = flavorFilter && typeof flavorFilter.value.value === "string"
        ? this.store.bySinkFlavor.get(flavorFilter.value.value as never)?.length ?? 0
        : sumValues(this.store.bySinkFlavor);
      const scan: Plan = {
        kind: "Scan",
        id: this.nextId(),
        rowKey,
        tier: "sink",
        props: pat.inlineFilters,
        cost,
      };
      return scan;
    }
    if (pat.label === "source") {
      const flavorFilter = pat.inlineFilters.find((f) => f.key === "flavor");
      const cost = flavorFilter && typeof flavorFilter.value.value === "string"
        ? this.store.byLeafFlavor.get(flavorFilter.value.value as never)?.length ?? 0
        : sumValues(this.store.byLeafFlavor);
      const scan: Plan = {
        kind: "Scan",
        id: this.nextId(),
        rowKey,
        tier: "source",
        props: pat.inlineFilters,
        cost,
      };
      return scan;
    }

    // Heuristic 2: tier scan.
    const cost = pat.label
      ? this.store.byTier.get(pat.label as never)?.length ?? 0
      : this.store.nodes.size;

    const node: Plan = {
      kind: "Scan",
      id: this.nextId(),
      rowKey,
      props: pat.inlineFilters,
      cost,
    };
    if (pat.label !== undefined) {
      (node as { tier?: NodeLabel }).tier = pat.label;
    }
    return node;
  }

  // Wrap a plan with inline filters as a Filter operator.
  applyInlineFilters(input: Plan, rowKey: string, filters: PropFilter[]): Plan {
    if (filters.length === 0) return input;
    let pred: Expr | undefined;
    const span = { line: 1, col: 1 };
    for (const f of filters) {
      const left: Expr = { type: "prop", base: rowKey, path: [f.key], span };
      const right: Expr = { type: "lit", value: f.value.value, span };
      const conj: Expr = { type: "binary", op: "=", left, right, span };
      pred = pred ? { type: "and", args: [pred, conj], span } : conj;
    }
    return { kind: "Filter", id: this.nextId(), input, predicate: pred!, cost: input.cost };
  }

  // ---------------------------------------------------------------- expand
  expandStep(
    input: Plan,
    fromKey: string,
    toKey: string,
    toPat: NodePattern,
    edgePat: EdgePattern,
    pathVar: string | undefined,
    reversed: boolean,
  ): Plan {
    // Heuristic 4: clamp unbounded *.
    let varLen = edgePat.varLen;
    if (varLen) {
      let max = varLen.max;
      if (max < 0 || max === undefined) {
        max = this.opts.maxPathLength;
        this.opts.diagnostics.push({
          severity: "warn",
          source: "planner",
          message: `Unbounded variable-length path clamped to *${varLen.min}..${max}; pass --max-path-length to override.`,
        });
      }
      varLen = { min: varLen.min, max };
    }

    if (varLen) {
      const out: Plan = {
        kind: "PathExpand",
        id: this.nextId(),
        input,
        fromKey,
        toKey,
        direction: edgePat.direction,
        categories: edgePat.categories,
        min: varLen.min,
        max: varLen.max,
        toFilter: toPat,
        reversed,
        cost: input.cost * 8, // crude: branching factor times path length
      };
      if (pathVar !== undefined) (out as { pathKey?: string }).pathKey = pathVar;
      return out;
    }

    const single: Plan = {
      kind: "Expand",
      id: this.nextId(),
      input,
      fromKey,
      toKey,
      direction: edgePat.direction,
      categories: edgePat.categories,
      toFilter: toPat,
      cost: input.cost * 4,
    };
    if (edgePat.var !== undefined) (single as { edgeKey?: string }).edgeKey = edgePat.var;
    return single;
  }

  // ---------------------------------------------------------------- match join
  cartesian(left: Plan, right: Plan): Plan {
    return {
      kind: "CartesianMatch",
      id: this.nextId(),
      left,
      right,
      cost: left.cost * right.cost,
    };
  }

  // ---------------------------------------------------------------- pipeline ops
  filter(input: Plan, predicate: Expr): Plan {
    return { kind: "Filter", id: this.nextId(), input, predicate, cost: input.cost };
  }

  aggregate(input: Plan, items: ProjectionItem[]): Plan {
    const groupKeys = items.filter((i) => !containsAggregate(i.expr));
    const aggregates = items.filter((i) => containsAggregate(i.expr));
    if (aggregates.length === 0) {
      // No aggregates → behave like a Project.
      return { kind: "Project", id: this.nextId(), input, items, distinct: false, cost: input.cost };
    }
    return {
      kind: "Aggregate",
      id: this.nextId(),
      input,
      groupKeys,
      aggregates,
      cost: Math.max(1, Math.floor(input.cost / 4)),
    };
  }

  sort(input: Plan, keys: OrderByClause[]): Plan {
    return { kind: "Sort", id: this.nextId(), input, keys, cost: input.cost };
  }

  limit(input: Plan, n: number): Plan {
    return { kind: "Limit", id: this.nextId(), input, n, cost: Math.min(n, input.cost) };
  }

  project(input: Plan, items: ProjectionItem[], distinct: boolean): Plan {
    // Special case: RETURN subgraph(...)  →  Subgraph operator.
    if (items.length === 1) {
      const it = items[0]!;
      if (it.expr.type === "fnCall" && it.expr.name === "subgraph") {
        const arg = it.expr.args[0];
        if (!arg) {
          throw new CgqlPlanError("subgraph() requires one argument");
        }
        // For a path-binding arg, we store its var name; for arbitrary expr,
        // the engine will dispatch on its type.
        const sourceCol = arg.type === "var"
          ? arg.name
          : arg.type === "prop"
            ? arg.base
            : "_subgraph_arg";
        return { kind: "Subgraph", id: this.nextId(), input, sourceCol, cost: 1 };
      }
    }
    // Aggregating RETURN — delegate to Aggregate.
    if (items.some((i) => containsAggregate(i.expr))) {
      const groupKeys = items.filter((i) => !containsAggregate(i.expr));
      const aggregates = items.filter((i) => containsAggregate(i.expr));
      const agg: Plan = {
        kind: "Aggregate",
        id: this.nextId(),
        input,
        groupKeys,
        aggregates,
        cost: Math.max(1, Math.floor(input.cost / 4)),
      };
      if (distinct) {
        return { kind: "Project", id: this.nextId(), input: agg, items, distinct, cost: agg.cost };
      }
      return agg;
    }
    return { kind: "Project", id: this.nextId(), input, items, distinct, cost: input.cost };
  }
}

// =============================================================================
// Helpers
// =============================================================================

function sumValues<K, V>(m: Map<K, V[]>): number {
  let n = 0;
  for (const v of m.values()) n += v.length;
  return n;
}

function estimateNodeCost(pat: NodePattern, store: Store): number {
  // Most selective wins: id > sink/leaf-flavor > tier > all.
  if (pat.inlineFilters.find((f) => f.key === "id")) return 1;
  if (pat.label === "sink") {
    const f = pat.inlineFilters.find((x) => x.key === "flavor");
    if (f && typeof f.value.value === "string") {
      return store.bySinkFlavor.get(f.value.value as never)?.length ?? 0;
    }
    return sumValues(store.bySinkFlavor);
  }
  if (pat.label === "source") {
    const f = pat.inlineFilters.find((x) => x.key === "flavor");
    if (f && typeof f.value.value === "string") {
      return store.byLeafFlavor.get(f.value.value as never)?.length ?? 0;
    }
    return sumValues(store.byLeafFlavor);
  }
  if (pat.label) {
    return store.byTier.get(pat.label as never)?.length ?? 0;
  }
  return store.nodes.size;
}

function invertEdgePattern(e: EdgePattern): EdgePattern {
  // Reverse direction so the planner can scan from the cheaper side.
  let dir: EdgePattern["direction"] = e.direction;
  if (dir === "out") dir = "in";
  else if (dir === "in") dir = "out";
  // "both" stays "both"
  const out: EdgePattern = {
    categories: e.categories,
    direction: dir,
    inlineFilters: e.inlineFilters,
  };
  if (e.var !== undefined) out.var = e.var;
  if (e.varLen !== undefined) out.varLen = e.varLen;
  return out;
}

function containsAggregate(e: Expr): boolean {
  if (e.type === "fnCall") {
    if (isAggregateName(e.name)) return true;
    return e.args.some(containsAggregate);
  }
  if (e.type === "binary") return containsAggregate(e.left) || containsAggregate(e.right);
  if (e.type === "and" || e.type === "or") return e.args.some(containsAggregate);
  if (e.type === "unary") return containsAggregate(e.arg);
  if (e.type === "regex") return containsAggregate(e.target) || containsAggregate(e.pattern);
  if (e.type === "between") return containsAggregate(e.target) || (e.operand ? containsAggregate(e.operand) : false);
  if (e.type === "case") return containsAggregate(e.when) || containsAggregate(e.then) || containsAggregate(e.els);
  if (e.type === "list") return e.items.some(containsAggregate);
  return false;
}

export function isAggregateName(name: string): boolean {
  return name === "count" || name === "min" || name === "max" || name === "sum" || name === "avg" || name === "collect";
}

/** Render a plan tree as the indented string `--explain` prints (§5.3). */
export function explainPlan(p: Plan, indent = ""): string {
  const lines: string[] = [];
  const head = (label: string, info: string) =>
    `${indent}${label.padEnd(14, " ")} ${info}   cost ~ ${p.cost}`;

  switch (p.kind) {
    case "Scan": {
      const info = p.tier
        ? `(${p.rowKey}:${p.tier})${propsTail(p.props)}`
        : `(all nodes)${propsTail(p.props)}`;
      lines.push(head("Scan", info));
      break;
    }
    case "IdLookup": {
      lines.push(head("IdLookup", `${p.rowKey} = "${p.nodeId}"`));
      break;
    }
    case "Expand": {
      lines.push(head("Expand", `${p.fromKey} -[${p.categories.join("|")}]-> ${p.toKey}`));
      lines.push(explainPlan(p.input, indent + "  "));
      break;
    }
    case "PathExpand": {
      const dir = p.direction === "in" ? "<-" : p.direction === "out" ? "->" : "-";
      lines.push(head("PathExpand", `${p.fromKey} -[${p.categories.join("|") || "*"}*${p.min}..${p.max}]${dir} ${p.toKey}${p.reversed ? " (reversed)" : ""}`));
      lines.push(explainPlan(p.input, indent + "  "));
      break;
    }
    case "Filter": {
      lines.push(head("Filter", "predicate"));
      lines.push(explainPlan(p.input, indent + "  "));
      break;
    }
    case "Project": {
      lines.push(head("Project", `[${p.items.map((i) => i.alias).join(", ")}]${p.distinct ? " DISTINCT" : ""}`));
      lines.push(explainPlan(p.input, indent + "  "));
      break;
    }
    case "Aggregate": {
      lines.push(head("Aggregate", `groupBy=[${p.groupKeys.map((i) => i.alias).join(",")}] agg=[${p.aggregates.map((i) => i.alias).join(",")}]`));
      lines.push(explainPlan(p.input, indent + "  "));
      break;
    }
    case "Sort": {
      lines.push(head("Sort", p.keys.map((k) => `${k.dir}`).join(",")));
      lines.push(explainPlan(p.input, indent + "  "));
      break;
    }
    case "Limit": {
      lines.push(head("Limit", String(p.n)));
      lines.push(explainPlan(p.input, indent + "  "));
      break;
    }
    case "Subgraph": {
      lines.push(head("Subgraph", p.sourceCol));
      lines.push(explainPlan(p.input, indent + "  "));
      break;
    }
    case "CartesianMatch": {
      lines.push(head("CartesianMatch", ""));
      lines.push(explainPlan(p.left, indent + "  "));
      lines.push(explainPlan(p.right, indent + "  "));
      break;
    }
  }
  return lines.join("\n");
}

function propsTail(props: PropFilter[]): string {
  if (props.length === 0) return "";
  return ` {${props.map((f) => `${f.key}:${formatLit(f.value.value)}`).join(", ")}}`;
}

function formatLit(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

/** Walk every operator in the plan; used by stats.planNodes. */
export function countPlanNodes(p: Plan): number {
  switch (p.kind) {
    case "Scan":
    case "IdLookup":
      return 1;
    case "Expand":
    case "PathExpand":
    case "Filter":
    case "Project":
    case "Aggregate":
    case "Sort":
    case "Limit":
    case "Subgraph":
      return 1 + countPlanNodes(p.input);
    case "CartesianMatch":
      return 1 + countPlanNodes(p.left) + countPlanNodes(p.right);
  }
}
