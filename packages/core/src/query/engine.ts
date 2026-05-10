/**
 * cgql — engine: evaluates a Plan tree against a Store and returns a
 * QueryResult envelope (design/query-language.md §4.5).
 *
 * Entry points:
 *   - `runQuery(ir, queryString, opts?)` — the public API; called by the CLI,
 *     the viewer, the GitHub Action, and any third-party tool.
 *   - `runOnLoaded(store, queryString, opts?)` — called when the caller has
 *     already built a Store (the viewer holds one across queries; downstream
 *     tools like viewer-inspector's "type drill-in" feature reuse it).
 *
 * Determinism (§7.5): rows come back in deterministic-by-construction order
 * — node ids tie-break ascending, paths tie-break (length, source, target,
 * cat, attr-hash). Two runs of the same query against the same IR produce
 * byte-identical output.
 *
 * Soft caps (§9):
 *   - Intermediate row count: 5,000,000. Aborts with CgqlRuntimeError.
 *   - Max path length: 16 (override via opts.maxPathLength).
 */

import type { IR, Node, NodeId } from "../ir/types.js";
import { isExpressionNode } from "../ir/types.js";
import { buildStore, type Store } from "./indexes.js";
import { parse } from "./parser.js";
import { plan, explainPlan, countPlanNodes, isAggregateName } from "./planner.js";
import {
  CGQL_VERSION,
  CgqlPlanError,
  CgqlRuntimeError,
  RESULT_SCHEMA_VERSION,
  type Binding,
  type CellValue,
  type Diagnostic,
  type EdgeRef,
  type Expr,
  type NodeLabel,
  type Path,
  type Plan,
  type ProjectionItem,
  type QueryResult,
  type RunQueryOptions,
  type Subgraph,
} from "./types.js";

// =============================================================================
// Public API
// =============================================================================

export async function runQuery(
  ir: IR,
  queryString: string,
  opts: RunQueryOptions = {},
): Promise<QueryResult> {
  const store = buildStore(ir);
  return runOnLoaded(store, queryString, opts);
}

/**
 * Same as `runQuery` but takes a pre-built Store. The viewer keeps a Store
 * alive across queries; the downstream `viewer-inspector` "type drill-in"
 * feature calls this directly.
 */
export async function runOnLoaded(
  store: Store,
  queryString: string,
  opts: RunQueryOptions = {},
): Promise<QueryResult> {
  const t0 = nowMs();
  const diagnostics: Diagnostic[] = [];
  const maxPathLength = opts.maxPathLength ?? 16;
  const maxRows = opts.maxRows ?? 5_000_000;
  const prChanges = new Set<NodeId>(opts.prChanges ?? []);

  let ast;
  try {
    ast = parse(queryString, opts.params);
  } catch (err) {
    const e = err as { line?: number; col?: number; message: string };
    return errorEnvelope(queryString, "table", [
      { severity: "error", source: "parser", message: e.message, line: e.line, col: e.col },
    ], t0);
  }

  let physicalPlan: Plan;
  try {
    physicalPlan = plan(ast, store, { maxPathLength, diagnostics });
  } catch (err) {
    return errorEnvelope(queryString, "table", [
      { severity: "error", source: "planner", message: (err as Error).message },
    ], t0);
  }

  if (opts.explain) {
    const explainText = explainPlan(physicalPlan);
    return {
      schemaVersion: RESULT_SCHEMA_VERSION,
      cgqlVersion: CGQL_VERSION,
      query: queryString,
      shape: "table",
      columns: ["plan"],
      rows: [[explainText]],
      stats: {
        matchedNodes: 0,
        matchedEdges: 0,
        elapsedMs: nowMs() - t0,
        planNodes: countPlanNodes(physicalPlan),
      },
      diagnostics,
    };
  }

  let rowsOut: Binding[];
  try {
    const exec = new Executor(store, prChanges, maxRows, diagnostics);
    rowsOut = exec.run(physicalPlan);
  } catch (err) {
    return errorEnvelope(queryString, "table", [
      { severity: "error", source: "runtime", message: (err as Error).message },
    ], t0);
  }

  return shapeResult(queryString, ast.ret.items, ast.distinct, physicalPlan, rowsOut, store, t0, diagnostics);
}

// =============================================================================
// Result shaping
// =============================================================================

function shapeResult(
  queryString: string,
  items: ProjectionItem[],
  distinct: boolean,
  physicalPlan: Plan,
  rows: Binding[],
  store: Store,
  t0: number,
  diagnostics: Diagnostic[],
): QueryResult {
  // Subgraph shape — single subgraph row.
  if (physicalPlan.kind === "Subgraph") {
    const merged: Subgraph = { nodes: [], edges: [] };
    const seenN = new Set<string>();
    const seenE = new Set<number>();
    for (const r of rows) {
      const sub = r["_subgraph"];
      if (sub && typeof sub === "object" && "nodes" in (sub as object)) {
        const sg = sub as Subgraph;
        for (const id of sg.nodes) if (!seenN.has(id)) { seenN.add(id); merged.nodes.push(id); }
        for (const e of sg.edges) if (!seenE.has(e.index)) { seenE.add(e.index); merged.edges.push(e); }
      }
    }
    return {
      schemaVersion: RESULT_SCHEMA_VERSION,
      cgqlVersion: CGQL_VERSION,
      query: queryString,
      shape: "subgraph",
      rows: [[merged]],
      stats: {
        matchedNodes: merged.nodes.length,
        matchedEdges: merged.edges.length,
        elapsedMs: nowMs() - t0,
        planNodes: countPlanNodes(physicalPlan),
      },
      diagnostics,
    };
  }

  // Path shape — single column whose runtime values are all `Path`. We
  // detect this by looking at the row data, not the expression; "RETURN p"
  // and "RETURN f" both look like a `var` expression at parse time but
  // only the former binds to a Path at runtime.
  const isPathOnly = items.length === 1 && rows.length > 0 && rows.every((r) => {
    const v = r[items[0]!.alias];
    return v && typeof v === "object" && "nodes" in (v as object) && "edges" in (v as object) && "length" in (v as object);
  });
  if (isPathOnly) {
    const out: CellValue[][] = [];
    const seen = new Set<string>();
    let nodes = 0;
    let edges = 0;
    for (const r of rows) {
      const v = r[items[0]!.alias];
      if (v && typeof v === "object" && "nodes" in (v as object) && "edges" in (v as object)) {
        const p = v as Path;
        const k = pathKey(p);
        if (distinct && seen.has(k)) continue;
        seen.add(k);
        out.push([p]);
        nodes += p.nodes.length;
        edges += p.edges.length;
      }
    }
    return {
      schemaVersion: RESULT_SCHEMA_VERSION,
      cgqlVersion: CGQL_VERSION,
      query: queryString,
      shape: "paths",
      columns: [items[0]!.alias],
      rows: out,
      stats: {
        matchedNodes: nodes,
        matchedEdges: edges,
        elapsedMs: nowMs() - t0,
        planNodes: countPlanNodes(physicalPlan),
      },
      diagnostics,
    };
  }

  // Tabular shape — most queries.
  const columns = items.map((i) => i.alias);
  let outRows: CellValue[][] = rows.map((r) => columns.map((c) => normalizeCell(r[c] ?? null)));
  if (distinct) outRows = dedupRows(outRows);

  const matchedNodes = countMatchedNodes(rows, store);
  const matchedEdges = countMatchedEdges(rows);

  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    cgqlVersion: CGQL_VERSION,
    query: queryString,
    shape: "table",
    columns,
    rows: outRows,
    stats: {
      matchedNodes,
      matchedEdges,
      elapsedMs: nowMs() - t0,
      planNodes: countPlanNodes(physicalPlan),
    },
    diagnostics,
  };
}

// =============================================================================
// Executor
// =============================================================================

class Executor {
  private rowsTotal = 0;

  constructor(
    private readonly store: Store,
    private readonly prChanges: Set<NodeId>,
    private readonly maxRows: number,
    private readonly diagnostics: Diagnostic[],
  ) {}

  run(p: Plan): Binding[] {
    return this.exec(p);
  }

  private exec(p: Plan): Binding[] {
    switch (p.kind) {
      case "Scan": return this.scan(p);
      case "IdLookup": return this.idLookup(p);
      case "Expand": return this.expand(p);
      case "PathExpand": return this.pathExpand(p);
      case "Filter": return this.filter(p);
      case "Project": return this.project(p);
      case "Aggregate": return this.aggregate(p);
      case "Sort": return this.sort(p);
      case "Limit": return this.limit(p);
      case "Subgraph": return this.subgraph(p);
      case "CartesianMatch": return this.cartesianMatch(p);
    }
  }

  // ---------------------------------------------------------------- scan
  private scan(p: Plan & { kind: "Scan" }): Binding[] {
    let candidates: NodeId[];
    if (p.tier === "sink") {
      const flavor = pickStringProp(p.props, "flavor");
      if (flavor) candidates = (this.store.bySinkFlavor.get(flavor as never) ?? []).slice();
      else candidates = collectAll(this.store.bySinkFlavor);
    } else if (p.tier === "source") {
      const flavor = pickStringProp(p.props, "flavor");
      if (flavor) candidates = (this.store.byLeafFlavor.get(flavor as never) ?? []).slice();
      else candidates = collectAll(this.store.byLeafFlavor);
    } else if (p.tier) {
      candidates = (this.store.byTier.get(p.tier as never) ?? []).slice();
    } else {
      candidates = Array.from(this.store.nodes.keys());
    }

    candidates.sort();

    const out: Binding[] = [];
    for (const id of candidates) {
      const n = this.store.nodes.get(id);
      if (!n) continue;
      if (!matchInlineProps(n, p.props, p.tier)) continue;
      this.tick();
      out.push({ [p.rowKey]: n });
    }
    return out;
  }

  private idLookup(p: Plan & { kind: "IdLookup" }): Binding[] {
    const n = this.store.nodes.get(p.nodeId);
    if (!n) return [];
    return [{ [p.rowKey]: n }];
  }

  // ---------------------------------------------------------------- expand
  private expand(p: Plan & { kind: "Expand" }): Binding[] {
    const input = this.exec(p.input);
    const out: Binding[] = [];
    for (const row of input) {
      const fromN = row[p.fromKey] as Node | undefined;
      if (!fromN) continue;
      const seedId = fromN.id;
      for (const ref of this.adjacency(seedId, p.direction, p.categories)) {
        const targetId = otherEnd(ref, seedId, p.direction);
        const tn = this.store.nodes.get(targetId);
        if (!tn) continue;
        if (p.toFilter && !matchNodePattern(tn, p.toFilter)) continue;
        const newRow: Binding = { ...row, [p.toKey]: tn };
        if (p.edgeKey) newRow[p.edgeKey] = ref;
        this.tick();
        out.push(newRow);
      }
    }
    return out;
  }

  private pathExpand(p: Plan & { kind: "PathExpand" }): Binding[] {
    const input = this.exec(p.input);
    const out: Binding[] = [];

    // BFS up to p.max from each seed, collecting *all* paths that end at a
    // node satisfying p.toFilter and have length in [p.min, p.max]. This is
    // correct for small-to-medium graphs (the heuristic-3 reversal already
    // shrinks the search frontier when one side is far smaller).
    for (const row of input) {
      const seed = row[p.fromKey] as Node | undefined;
      if (!seed) continue;
      const startId = seed.id;
      const startN = seed;

      // visited per-path is intentional — we want *paths*, not just shortest
      // distances. The clamp at p.max limits blowup.
      type Frontier = { node: Node; path: Path; visited: Set<NodeId> };
      let frontier: Frontier[] = [{
        node: startN,
        path: { nodes: [startId], edges: [], length: 0 },
        visited: new Set([startId]),
      }];

      // Track final hits.
      const collected: Frontier[] = [];
      if (p.min === 0 && (!p.toFilter || matchNodePattern(startN, p.toFilter))) {
        collected.push(frontier[0]!);
      }

      for (let depth = 1; depth <= p.max; depth++) {
        const next: Frontier[] = [];
        for (const f of frontier) {
          for (const ref of this.adjacency(f.node.id, p.direction, p.categories)) {
            const targetId = otherEnd(ref, f.node.id, p.direction);
            if (f.visited.has(targetId)) continue; // simple-path constraint
            const tn = this.store.nodes.get(targetId);
            if (!tn) continue;
            const newVisited = new Set(f.visited);
            newVisited.add(targetId);
            const newPath: Path = {
              nodes: [...f.path.nodes, targetId],
              edges: [...f.path.edges, ref],
              length: f.path.length + 1,
            };
            const fr: Frontier = { node: tn, path: newPath, visited: newVisited };
            this.tick();
            if (depth >= p.min && (!p.toFilter || matchNodePattern(tn, p.toFilter))) {
              collected.push(fr);
            }
            next.push(fr);
          }
        }
        frontier = next;
        if (frontier.length === 0) break;
      }

      for (const f of collected) {
        const newRow: Binding = { ...row, [p.toKey]: f.node };
        if (p.pathKey) newRow[p.pathKey] = effectivePath(f.path, p.reversed);
        out.push(newRow);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- filter / project
  private filter(p: Plan & { kind: "Filter" }): Binding[] {
    const input = this.exec(p.input);
    const out: Binding[] = [];
    for (const row of input) {
      if (this.evalBool(p.predicate, row)) out.push(row);
    }
    return out;
  }

  private project(p: Plan & { kind: "Project" }): Binding[] {
    const input = this.exec(p.input);
    const out: Binding[] = [];
    const seen = new Set<string>();
    for (const row of input) {
      const newRow: Binding = {};
      for (const item of p.items) {
        newRow[item.alias] = this.evalExpr(item.expr, row);
      }
      if (p.distinct) {
        const k = stableKey(newRow);
        if (seen.has(k)) continue;
        seen.add(k);
      }
      out.push(newRow);
    }
    return out;
  }

  private aggregate(p: Plan & { kind: "Aggregate" }): Binding[] {
    const input = this.exec(p.input);
    const buckets = new Map<string, { key: Binding; rows: Binding[] }>();
    for (const row of input) {
      const groupRow: Binding = {};
      for (const g of p.groupKeys) groupRow[g.alias] = this.evalExpr(g.expr, row);
      const k = stableKey(groupRow);
      const cur = buckets.get(k);
      if (cur) cur.rows.push(row);
      else buckets.set(k, { key: groupRow, rows: [row] });
    }

    // Empty-input / no-grouping case: SQL convention is one row, all-null
    // groups, but with computed aggregates. Cypher matches this when there
    // are no group keys.
    if (buckets.size === 0 && p.groupKeys.length === 0) {
      const row: Binding = {};
      for (const a of p.aggregates) row[a.alias] = this.evalAggregate(a.expr, []);
      return [row];
    }

    const out: Binding[] = [];
    for (const { key, rows } of buckets.values()) {
      const row: Binding = { ...key };
      for (const a of p.aggregates) row[a.alias] = this.evalAggregate(a.expr, rows);
      out.push(row);
    }
    return out;
  }

  private sort(p: Plan & { kind: "Sort" }): Binding[] {
    const rows = this.exec(p.input).slice();
    rows.sort((a, b) => {
      for (const k of p.keys) {
        const va = this.evalExpr(k.expr, a);
        const vb = this.evalExpr(k.expr, b);
        const cmp = compareCells(va, vb);
        if (cmp !== 0) return k.dir === "asc" ? cmp : -cmp;
      }
      return 0;
    });
    return rows;
  }

  private limit(p: Plan & { kind: "Limit" }): Binding[] {
    const input = this.exec(p.input);
    return input.slice(0, p.n);
  }

  private subgraph(p: Plan & { kind: "Subgraph" }): Binding[] {
    const input = this.exec(p.input);
    const seenN = new Set<string>();
    const seenE = new Set<number>();
    const merged: Subgraph = { nodes: [], edges: [] };
    for (const row of input) {
      const v = row[p.sourceCol];
      if (v && typeof v === "object" && "nodes" in (v as object) && "edges" in (v as object)) {
        const arg = v as Path | Subgraph;
        for (const id of arg.nodes) if (!seenN.has(id)) { seenN.add(id); merged.nodes.push(id as never); }
        for (const e of arg.edges) if (!seenE.has(e.index)) { seenE.add(e.index); merged.edges.push(e); }
      } else if (isNodeValue(v)) {
        const id = (v as Node).id;
        if (!seenN.has(id)) { seenN.add(id); merged.nodes.push(id); }
      }
    }
    return [{ _subgraph: merged }];
  }

  private cartesianMatch(p: Plan & { kind: "CartesianMatch" }): Binding[] {
    const left = this.exec(p.left);
    const right = this.exec(p.right);
    const out: Binding[] = [];
    for (const l of left) {
      for (const r of right) {
        // Equi-join semantics on shared bindings: if both sides bound `x` to
        // the same node, keep the row; otherwise drop. (The two-MATCH form
        // `MATCH (a) MATCH (b)` with no overlap is a true cartesian product;
        // overlap-with-mismatch is the expected drop case.)
        let consistent = true;
        for (const k of Object.keys(r)) {
          if (k in l) {
            const lv = l[k];
            const rv = r[k];
            if (!cellsEqual(lv, rv)) { consistent = false; break; }
          }
        }
        if (!consistent) continue;
        this.tick();
        out.push({ ...l, ...r });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- adjacency
  private adjacency(seedId: NodeId, dir: "in" | "out" | "both", categories: string[]): EdgeRef[] {
    const refs: EdgeRef[] = [];
    if (dir === "out" || dir === "both") {
      const out = this.store.outEdges.get(seedId);
      if (out) for (const r of out) if (categories.length === 0 || categories.includes(r.category)) refs.push(r);
    }
    if (dir === "in" || dir === "both") {
      const inE = this.store.inEdges.get(seedId);
      if (inE) for (const r of inE) if (categories.length === 0 || categories.includes(r.category)) refs.push(r);
    }
    return refs;
  }

  // ---------------------------------------------------------------- expressions
  private evalBool(e: Expr, row: Binding): boolean {
    const v = this.evalExpr(e, row);
    return v === true;
  }

  private evalExpr(e: Expr, row: Binding): CellValue {
    switch (e.type) {
      case "lit": return e.value;
      case "list": return e.items.map((it) => this.evalExpr(it, row));
      case "var": return row[e.name] ?? null;
      case "param":
        // Should already have been substituted by the parser.
        return null;
      case "prop": return resolveProp(row[e.base] ?? null, e.path);
      case "unary":
        if (e.op === "NOT") return !this.evalBool(e.arg, row);
        if (e.op === "-") {
          const v = this.evalExpr(e.arg, row);
          return typeof v === "number" ? -v : null;
        }
        return null;
      case "and": return e.args.every((a) => this.evalBool(a, row));
      case "or": return e.args.some((a) => this.evalBool(a, row));
      case "binary": {
        const l = this.evalExpr(e.left, row);
        const r = this.evalExpr(e.right, row);
        switch (e.op) {
          case "=": return cellsEqual(l, r);
          case "<>": return !cellsEqual(l, r);
          case "<": return compareCells(l, r) < 0;
          case "<=": return compareCells(l, r) <= 0;
          case ">": return compareCells(l, r) > 0;
          case ">=": return compareCells(l, r) >= 0;
          case "+": return numericOp(l, r, (a, b) => a + b);
          case "-": return numericOp(l, r, (a, b) => a - b);
          case "*": return numericOp(l, r, (a, b) => a * b);
          case "/": return numericOp(l, r, (a, b) => b === 0 ? null : a / b);
        }
        return null;
      }
      case "regex": {
        const t = this.evalExpr(e.target, row);
        const pat = this.evalExpr(e.pattern, row);
        if (typeof t !== "string" || typeof pat !== "string") return false;
        try {
          return new RegExp(pat).test(t);
        } catch {
          return false;
        }
      }
      case "between": {
        const t = this.evalExpr(e.target, row);
        switch (e.kind) {
          case "STARTS_WITH": {
            const o = this.evalExpr(e.operand!, row);
            return typeof t === "string" && typeof o === "string" && t.startsWith(o);
          }
          case "ENDS_WITH": {
            const o = this.evalExpr(e.operand!, row);
            return typeof t === "string" && typeof o === "string" && t.endsWith(o);
          }
          case "CONTAINS": {
            const o = this.evalExpr(e.operand!, row);
            return typeof t === "string" && typeof o === "string" && t.includes(o);
          }
          case "IN": {
            const o = this.evalExpr(e.operand!, row);
            if (Array.isArray(o)) return o.some((it) => cellsEqual(it as CellValue, t));
            return false;
          }
          case "IS_NULL": return t === null || t === undefined;
          case "IS_NOT_NULL": return !(t === null || t === undefined);
        }
        return false;
      }
      case "fnCall":
        return this.evalFnCall(e, row);
      case "exists":
        return this.evalExists(e, row);
      case "case":
        return this.evalBool(e.when, row) ? this.evalExpr(e.then, row) : this.evalExpr(e.els, row);
    }
  }

  // ---------------------------------------------------------------- aggregates
  private evalAggregate(e: Expr, rows: Binding[]): CellValue {
    if (e.type === "fnCall" && isAggregateName(e.name)) {
      const arg = e.args[0];
      const distinct = e.distinct;
      let values: CellValue[];
      if (e.name === "count" && arg && arg.type === "lit" && arg.value === "*") {
        return rows.length;
      }
      if (!arg) values = rows.map(() => 1);
      else values = rows.map((r) => this.evalExpr(arg, r));

      if (distinct) {
        const seen = new Set<string>();
        const out: CellValue[] = [];
        for (const v of values) {
          const k = JSON.stringify(v);
          if (!seen.has(k)) { seen.add(k); out.push(v); }
        }
        values = out;
      }

      switch (e.name) {
        case "count":
          return values.filter((v) => v !== null && v !== undefined).length;
        case "sum": {
          let s = 0;
          for (const v of values) if (typeof v === "number") s += v;
          return s;
        }
        case "min": {
          let m: CellValue = null;
          for (const v of values) {
            if (v === null || v === undefined) continue;
            if (m === null || compareCells(v, m) < 0) m = v;
          }
          return m;
        }
        case "max": {
          let m: CellValue = null;
          for (const v of values) {
            if (v === null || v === undefined) continue;
            if (m === null || compareCells(v, m) > 0) m = v;
          }
          return m;
        }
        case "avg": {
          let s = 0;
          let c = 0;
          for (const v of values) if (typeof v === "number") { s += v; c++; }
          return c > 0 ? s / c : null;
        }
        case "collect":
          return values;
      }
    }
    // Recurse into expressions that *contain* aggregates (e.g. `effectful * 1.0 / total`).
    if (e.type === "binary") {
      const l = this.evalAggregate(e.left, rows);
      const r = this.evalAggregate(e.right, rows);
      return numericOp(l, r, (a, b) => {
        switch (e.op) {
          case "+": return a + b;
          case "-": return a - b;
          case "*": return a * b;
          case "/": return b === 0 ? Number.NaN : a / b;
          default: return Number.NaN;
        }
      });
    }
    if (e.type === "case") {
      // SUM(CASE WHEN p THEN x ELSE y END) — common pattern (see §8.9).
      let s = 0;
      for (const r of rows) {
        const v = this.evalBool(e.when, r) ? this.evalExpr(e.then, r) : this.evalExpr(e.els, r);
        if (typeof v === "number") s += v;
      }
      return s;
    }
    // Non-aggregate expression in an aggregate position: take the first row's value.
    if (rows.length === 0) return null;
    return this.evalExpr(e, rows[0]!);
  }

  // ---------------------------------------------------------------- function calls
  private evalFnCall(e: Expr & { type: "fnCall" }, row: Binding): CellValue {
    const args = e.args.map((a) => this.evalExpr(a, row));
    switch (e.name) {
      case "length": {
        const v = args[0];
        if (v && typeof v === "object" && "length" in (v as object)) {
          return (v as Path).length;
        }
        return null;
      }
      case "nodes": {
        const v = args[0];
        if (v && typeof v === "object" && "nodes" in (v as object)) {
          return (v as Path).nodes as unknown as CellValue[];
        }
        return [];
      }
      case "edges": {
        const v = args[0];
        if (v && typeof v === "object" && "edges" in (v as object)) {
          return (v as Path).edges as unknown as CellValue[];
        }
        return [];
      }
      case "glob": {
        const s = args[0];
        const pat = args[1];
        if (typeof s !== "string" || typeof pat !== "string") return false;
        return globMatch(s, pat);
      }
      case "hasTag": {
        const node = args[0];
        const tag = args[1];
        if (!isNodeValue(node) || typeof tag !== "string") return false;
        return nodeHasTag(node as Node, tag);
      }
      case "service": {
        const node = args[0];
        if (!isNodeValue(node)) return null;
        return this.findEnclosing(node as Node, "service");
      }
      case "module": {
        const node = args[0];
        if (!isNodeValue(node)) return null;
        return this.findEnclosing(node as Node, "module");
      }
      case "parent": {
        const node = args[0];
        if (!isNodeValue(node)) return null;
        const pid = (node as Node).parentId;
        if (!pid) return null;
        return this.store.nodes.get(pid) ?? null;
      }
      case "pathString": {
        const path = args[0];
        const sep = (args[1] as string | undefined) ?? " -> ";
        if (!path || typeof path !== "object" || !("nodes" in (path as object))) return "";
        const p = path as Path;
        const names: string[] = [];
        for (const id of p.nodes) {
          const n = this.store.nodes.get(id);
          names.push(n?.name ?? id);
        }
        return names.join(sep);
      }
      case "changedInPR":
        return Array.from(this.prChanges) as unknown as CellValue[];
      case "subgraph":
        // Reached only from non-RETURN positions; planner replaces top-level
        // subgraph() with a Subgraph operator.
        return null;
      case "count": case "sum": case "avg": case "min": case "max": case "collect":
        // These should be folded by Aggregate; if reached here, treat as
        // identity over the (currently unavailable) row group.
        return null;
    }
    throw new CgqlPlanError(`Unknown function: ${e.name}`);
  }

  private evalExists(e: Expr & { type: "exists" }, row: Binding): boolean {
    // EXISTS { (a)-[:cat]->() } — bind any free variables that already
    // appear in `row` to their values, then check whether any expansion
    // satisfies the pattern.
    const { pattern } = e;
    if (pattern.nodes.length === 0) return false;
    if (pattern.edges.length === 0) {
      // (a) — true iff `a` resolves to something.
      const v = pattern.nodes[0]!.var ? row[pattern.nodes[0]!.var!] : null;
      return isNodeValue(v) && matchNodePattern(v as Node, pattern.nodes[0]!);
    }
    // Find the first bound node — that's the seed.
    let seedIdx = -1;
    for (let i = 0; i < pattern.nodes.length; i++) {
      const v = pattern.nodes[i]!.var ? row[pattern.nodes[i]!.var!] : null;
      if (isNodeValue(v)) { seedIdx = i; break; }
    }
    if (seedIdx === -1) return false;

    // Walk forward from the seed.
    let frontier: Node[] = [row[pattern.nodes[seedIdx]!.var!] as Node];
    for (let step = seedIdx; step < pattern.edges.length; step++) {
      const edgePat = pattern.edges[step]!;
      const targetPat = pattern.nodes[step + 1]!;
      const next: Node[] = [];
      for (const f of frontier) {
        for (const ref of this.adjacency(f.id, edgePat.direction, edgePat.categories)) {
          const targetId = otherEnd(ref, f.id, edgePat.direction);
          const tn = this.store.nodes.get(targetId);
          if (!tn) continue;
          if (!matchNodePattern(tn, targetPat)) continue;
          if (targetPat.var && row[targetPat.var]) {
            // Constrained: target binding must match.
            const bound = row[targetPat.var];
            if (!cellsEqual(bound, tn)) continue;
          }
          next.push(tn);
        }
      }
      if (next.length === 0) return false;
      frontier = next;
    }
    return frontier.length > 0;
  }

  // ---------------------------------------------------------------- helpers
  private findEnclosing(start: Node, tier: "service" | "module"): Node | null {
    let cur: Node | undefined = start;
    while (cur) {
      if (cur.tier === tier) return cur;
      const pid = cur.parentId;
      if (!pid) return null;
      cur = this.store.nodes.get(pid);
    }
    return null;
  }

  private tick(): void {
    if (++this.rowsTotal > this.maxRows) {
      throw new CgqlRuntimeError(
        `intermediate row count exceeded ${this.maxRows} — narrow the query or pass --max-path-length`,
      );
    }
  }
}

// =============================================================================
// Pure helpers
// =============================================================================

function pickStringProp(props: { key: string; value: { value: unknown } }[], key: string): string | undefined {
  const f = props.find((p) => p.key === key);
  if (!f) return undefined;
  return typeof f.value.value === "string" ? f.value.value : undefined;
}

function collectAll<K, V>(m: Map<K, V[]>): V[] {
  const out: V[] = [];
  for (const v of m.values()) for (const x of v) out.push(x);
  return out;
}

function otherEnd(ref: EdgeRef, seed: NodeId, dir: "in" | "out" | "both"): NodeId {
  if (dir === "out") return ref.targetId;
  if (dir === "in") return ref.sourceId;
  return ref.sourceId === seed ? ref.targetId : ref.sourceId;
}

function effectivePath(p: Path, reversed: boolean): Path {
  if (!reversed) return p;
  return {
    nodes: [...p.nodes].reverse(),
    edges: [...p.edges].reverse(),
    length: p.length,
  };
}

function matchInlineProps(
  n: Node,
  props: { key: string; value: { value: unknown } }[],
  tier: NodeLabel | undefined,
): boolean {
  for (const f of props) {
    if (tier === "sink" && f.key === "flavor") continue; // handled by index
    if (tier === "source" && f.key === "flavor") continue; // handled by index
    if (!testProp(n, f.key, f.value.value, tier)) return false;
  }
  return true;
}

function matchNodePattern(n: Node, pat: { label?: NodeLabel; inlineFilters: { key: string; value: { value: unknown } }[] }): boolean {
  if (pat.label) {
    if (pat.label === "sink") {
      if (!isExpressionNode(n) || !n.sink) return false;
    } else if (pat.label === "source") {
      if (!isExpressionNode(n) || !n.leaf) return false;
    } else {
      if (n.tier !== pat.label) return false;
    }
  }
  return matchInlineProps(n, pat.inlineFilters, pat.label);
}

function testProp(n: Node, key: string, value: unknown, tier: NodeLabel | undefined): boolean {
  // Sink/source sugar: `(:sink {flavor:"db-write"})` already routed via index.
  // Other inline filters fall through to property access.
  if (tier === "sink" && isExpressionNode(n) && n.sink) {
    if (key === "flavor") return n.sink.flavor === value;
    const v = (n.sink as Record<string, unknown>)[key];
    return v === value;
  }
  if (tier === "source" && isExpressionNode(n) && n.leaf) {
    if (key === "flavor") return n.leaf.flavor === value;
    const v = (n.leaf as Record<string, unknown>)[key];
    return v === value;
  }
  // Handle the `tag` property shorthand: `{tag:"sink:db-write"}`.
  if (key === "tag" && typeof value === "string") {
    return nodeHasTag(n, value);
  }
  const v = (n as unknown as Record<string, unknown>)[key];
  return v === value;
}

function resolveProp(base: CellValue, path: string[]): CellValue {
  let cur: unknown = base;
  for (const k of path) {
    if (cur === null || cur === undefined) return null;
    if (typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[k];
  }
  if (cur === undefined) return null;
  return cur as CellValue;
}

function nodeHasTag(n: Node, tag: string): boolean {
  // Synthesized tags per design §3.4.
  if (tag === "pure") return (n as { pure?: boolean }).pure === true;
  if (tag === "effectful") return (n as { pure?: boolean }).pure === false;
  if (tag === "exported") return (n as { exported?: boolean }).exported === true;
  if (tag.startsWith("sink:")) {
    if (!isExpressionNode(n) || !n.sink) return false;
    return n.sink.flavor === tag.slice(5);
  }
  if (tag.startsWith("leaf:")) {
    if (!isExpressionNode(n) || !n.leaf) return false;
    return n.leaf.flavor === tag.slice(5);
  }
  if (tag.startsWith("route:")) {
    // route:any matches functions that have an outgoing http-route edge.
    // route:<METHOD> requires HttpRouteEdge.method match — handled lazily
    // (engine doesn't have store here), so we approximate with node tags.
    const tags = (n as { tags?: string[] }).tags;
    if (!tags) return false;
    if (tag === "route:any") return tags.some((t) => t.startsWith("route:"));
    return tags.includes(tag);
  }
  if (tag.startsWith("lang:")) {
    return (n as { lang?: string }).lang === tag.slice(5);
  }
  // Adapter-emitted tags via node.tags (forward-compat with §3.4).
  const tags = (n as { tags?: string[] }).tags;
  if (Array.isArray(tags) && tags.includes(tag)) return true;
  return false;
}

function compareCells(a: CellValue, b: CellValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "boolean" && typeof b === "boolean") return (a ? 1 : 0) - (b ? 1 : 0);
  if (isNodeValue(a) && isNodeValue(b)) {
    const ai = (a as Node).id;
    const bi = (b as Node).id;
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  }
  return JSON.stringify(a) < JSON.stringify(b) ? -1 : 1;
}

function cellsEqual(a: CellValue, b: CellValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (isNodeValue(a) && isNodeValue(b)) return (a as Node).id === (b as Node).id;
  if (typeof a !== "object" && typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function isNodeValue(v: unknown): boolean {
  return !!v && typeof v === "object" && "id" in (v as object) && "tier" in (v as object);
}

function pathKey(p: Path): string {
  return p.nodes.join(">") + "|" + p.edges.map((e) => e.index).join(",");
}

function dedupRows(rows: CellValue[][]): CellValue[][] {
  const seen = new Set<string>();
  const out: CellValue[][] = [];
  for (const r of rows) {
    const k = stableKeyArray(r);
    if (!seen.has(k)) { seen.add(k); out.push(r); }
  }
  return out;
}

function stableKey(row: Binding): string {
  const keys = Object.keys(row).sort();
  return keys.map((k) => `${k}=${stringify(row[k]!)}`).join("|");
}

function stableKeyArray(arr: CellValue[]): string {
  return arr.map((v) => stringify(v)).join("|");
}

function stringify(v: CellValue): string {
  if (isNodeValue(v)) return `node:${(v as Node).id}`;
  if (v && typeof v === "object" && "nodes" in (v as object) && "edges" in (v as object)) {
    return `path:${(v as Path).nodes.join(">")}`;
  }
  return JSON.stringify(v);
}

function numericOp(a: CellValue, b: CellValue, op: (x: number, y: number) => number | null): number | null {
  if (typeof a !== "number" || typeof b !== "number") return null;
  return op(a, b);
}

function normalizeCell(v: CellValue): CellValue {
  // For tabular output, leave Node objects intact; the formatter chooses
  // display. Nothing to normalize today; reserved.
  return v;
}

function countMatchedNodes(rows: Binding[], _store: Store): number {
  const seen = new Set<string>();
  for (const r of rows) {
    for (const v of Object.values(r)) {
      if (isNodeValue(v)) seen.add((v as Node).id);
      else if (v && typeof v === "object" && "nodes" in (v as object)) {
        for (const id of (v as Path).nodes) seen.add(id);
      }
    }
  }
  return seen.size;
}

function countMatchedEdges(rows: Binding[]): number {
  const seen = new Set<number>();
  for (const r of rows) {
    for (const v of Object.values(r)) {
      if (v && typeof v === "object" && "edges" in (v as object)) {
        for (const e of (v as Path).edges) seen.add(e.index);
      } else if (v && typeof v === "object" && "index" in (v as object) && "category" in (v as object)) {
        seen.add((v as EdgeRef).index);
      }
    }
  }
  return seen.size;
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function errorEnvelope(query: string, shape: "table", diagnostics: Diagnostic[], t0: number): QueryResult {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    cgqlVersion: CGQL_VERSION,
    query,
    shape,
    columns: [],
    rows: [],
    stats: { matchedNodes: 0, matchedEdges: 0, elapsedMs: nowMs() - t0, planNodes: 0 },
    diagnostics,
  };
}

// Tiny glob → RegExp for `glob(s, "**/auth/**")`. Supports *, **, ?.
function globMatch(s: string, pat: string): boolean {
  let re = "^";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]!;
    if (c === "*") {
      if (pat[i + 1] === "*") {
        re += ".*";
        i++;
        if (pat[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\/.+^$|()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  re += "$";
  try {
    return new RegExp(re).test(s);
  } catch {
    return false;
  }
}

// Re-export for the CLI / public surface — consumers import from one module.
export { buildStore } from "./indexes.js";
export type { Store } from "./indexes.js";
export { explainPlan } from "./planner.js";

// `pathPrefixScan` is exported separately by indexes.ts; planner-glob
// integration will route through it once we wire path-prefix predicates
// into the cost model. Until then, it stays available via the indexes module.
