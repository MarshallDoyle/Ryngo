/**
 * cgql — query language types.
 *
 * Three layers live here:
 *
 *   1. Public surface: `RunQueryOptions`, `QueryResult`, `Path`, `Subgraph`,
 *      `EdgeRef`, `Diagnostic`. The CLI, the viewer, and the GitHub Action
 *      all consume these.
 *   2. AST nodes produced by the parser (§2 of design/query-language.md).
 *   3. Physical plan operators produced by the planner (§7.2).
 *
 * Co-locating them keeps the parser/planner/engine triple in one type universe
 * — no drift, no circular imports.
 */

import type { Edge, EdgeCategory, Node, NodeId, NodeTier } from "../ir/types.js";

// =============================================================================
// Public surface — values returned to callers.
// =============================================================================

export const CGQL_VERSION = "0.1.0";

/** Stable schema version for the result envelope (§4.5). */
export const RESULT_SCHEMA_VERSION = "0.1.0";

/** A reference to an edge by its identity tuple (§4.3 of ir-schema.md). */
export interface EdgeRef {
  sourceId: NodeId;
  targetId: NodeId;
  category: EdgeCategory;
  /**
   * Position of this edge in the canonical edge list. Cheap stand-in for the
   * "attributes-hash" tail of the identity tuple — guarantees uniqueness for
   * parallel edges that share (source, target, category) but differ in their
   * attributes (different `valueType`, different `argIndex`, ...).
   */
  index: number;
}

/** A bound path through the graph (§4.2). */
export interface Path {
  nodes: NodeId[];
  edges: EdgeRef[];
  length: number;
}

/** Deduplicated node/edge set returned by `subgraph(...)` (§4.3). */
export interface Subgraph {
  nodes: NodeId[];
  edges: EdgeRef[];
}

/** Severity tag on a `diagnostics[]` entry (§9). */
export type DiagnosticSeverity = "info" | "warn" | "error";

/** Source bucket on a `diagnostics[]` entry (§9). */
export type DiagnosticSource = "parser" | "planner" | "runtime";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  source: DiagnosticSource;
  message: string;
  /** 1-indexed line/column when the diagnostic comes from the parser. */
  line?: number;
  col?: number;
}

/** Shape discriminator for the result envelope (§4.5). */
export type ResultShape = "table" | "paths" | "subgraph";

/** Values that can appear in a result row. */
export type CellValue =
  | string
  | number
  | boolean
  | null
  | Path
  | Subgraph
  | Node
  | EdgeRef
  | CellValue[];

/** A single bound row before formatting. */
export type ResultRow = Record<string, CellValue>;

/** Stats reported alongside the rows (§4.5). */
export interface QueryStats {
  matchedNodes: number;
  matchedEdges: number;
  elapsedMs: number;
  planNodes: number;
}

/** The envelope every `runQuery` call returns (§4.5). */
export interface QueryResult {
  schemaVersion: string;
  cgqlVersion: string;
  query: string;
  shape: ResultShape;
  /** Present when shape is "table"; column order matches `RETURN`. */
  columns?: string[];
  /** Tabular rows. For `paths`/`subgraph` shapes, each row is the bound value. */
  rows: CellValue[][];
  stats: QueryStats;
  diagnostics: Diagnostic[];
}

/** Options accepted by `runQuery`. */
export interface RunQueryOptions {
  /** Pre-parse parameter substitutions for `$name` references. */
  params?: Record<string, string | number | boolean | null>;
  /** Set of node ids reported as "changed" by an upstream `codegraph diff`. */
  prChanges?: Iterable<NodeId>;
  /** Cap on `*` traversal length when no upper bound is given. Default 16. */
  maxPathLength?: number;
  /** Soft cap on intermediate row count before aborting. Default 5_000_000. */
  maxRows?: number;
  /** When true, skip execution and return the chosen plan tree as JSON. */
  explain?: boolean;
}

// =============================================================================
// AST — produced by the parser.
// =============================================================================

/** Source span used for parser diagnostics. 1-indexed line/col. */
export interface Span {
  line: number;
  col: number;
}

/** A whole `cgql` query. */
export interface QueryAST {
  /** Each `MATCH ... [, MATCH ...]` becomes one entry. */
  matches: MatchClause[];
  /** Initial `WHERE` after all matches. */
  where?: Expr;
  /** Pipelined `WITH` projections. */
  withClauses: WithClause[];
  orderBy?: OrderByClause[];
  limit?: number;
  /** `RETURN` is mandatory; null only during partial parses. */
  ret: ReturnClause;
  /** True if `RETURN DISTINCT`. */
  distinct: boolean;
  /** Original source for diagnostics. */
  source: string;
}

export interface MatchClause {
  /** When set, the whole pattern is bound as a Path. */
  pathVar?: string;
  pattern: Pattern;
}

export interface Pattern {
  /** A pattern is a chain: node, edge, node, edge, node, ... — always odd. */
  nodes: NodePattern[];
  /** edges[i] connects nodes[i] -> nodes[i+1]. */
  edges: EdgePattern[];
}

export interface NodePattern {
  /** Optional binding name. */
  var?: string;
  /** Tier label, or `sink`/`source` sugar (§3.3). */
  label?: NodeLabel;
  /** Inline `{key: value}` filters; equivalent to a WHERE conjunct. */
  inlineFilters: PropFilter[];
}

export type NodeLabel = NodeTier | "sink" | "source";

export interface EdgePattern {
  var?: string;
  /** Categories accepted; alternation via `|`. Empty = wildcard. */
  categories: string[];
  /** Direction relative to the LHS node. */
  direction: "out" | "in" | "both";
  /** Variable-length range. Undefined = single hop. */
  varLen?: { min: number; max: number };
  inlineFilters: PropFilter[];
}

export interface PropFilter {
  key: string;
  value: Literal;
}

/** Generic key-list (`a.name`, `e.valueType.display`). */
export interface PropAccess {
  type: "prop";
  /** Variable name on the LHS, e.g. `a` in `a.name`. */
  base: string;
  /** Trailing keys; one or more for nested access. */
  path: string[];
  span: Span;
}

export type Expr =
  | PropAccess
  | { type: "var"; name: string; span: Span }
  | { type: "param"; name: string; span: Span }
  | { type: "lit"; value: string | number | boolean | null; span: Span }
  | { type: "list"; items: Expr[]; span: Span }
  | { type: "binary"; op: BinaryOp; left: Expr; right: Expr; span: Span }
  | { type: "unary"; op: "NOT" | "-"; arg: Expr; span: Span }
  | { type: "and"; args: Expr[]; span: Span }
  | { type: "or"; args: Expr[]; span: Span }
  | {
      type: "between";
      target: Expr;
      kind: "STARTS_WITH" | "ENDS_WITH" | "CONTAINS" | "IN" | "IS_NULL" | "IS_NOT_NULL";
      operand?: Expr;
      span: Span;
    }
  | { type: "regex"; target: Expr; pattern: Expr; span: Span }
  | { type: "fnCall"; name: string; args: Expr[]; distinct: boolean; span: Span }
  | { type: "exists"; pattern: Pattern; not: boolean; span: Span }
  | {
      type: "case";
      when: Expr;
      then: Expr;
      els: Expr;
      span: Span;
    };

export type BinaryOp =
  | "=" | "<>" | "<" | "<=" | ">" | ">="
  | "+" | "-" | "*" | "/";

export interface Literal {
  value: string | number | boolean | null;
}

export interface ProjectionItem {
  expr: Expr;
  /** Either the explicit `AS` alias or a derived display name. */
  alias: string;
}

export interface WithClause {
  items: ProjectionItem[];
  where?: Expr;
}

export interface ReturnClause {
  items: ProjectionItem[];
}

export interface OrderByClause {
  expr: Expr;
  dir: "asc" | "desc";
}

// =============================================================================
// Physical plan — produced by the planner.
// =============================================================================

/**
 * Discriminated union over physical operators (§7.2). Each operator has an
 * `id` for `--explain` rendering and an optional `cost` estimate (rows out).
 *
 * The `rowKey` field on producing operators is the binding-name introduced
 * by that step (e.g. `a` for `Scan` of `(a:function)`). Filter / Project
 * operators inherit and rewrite the row schema.
 */
export type Plan =
  | { kind: "Scan"; id: number; rowKey: string; tier?: NodeLabel; props: PropFilter[]; cost: number }
  | { kind: "IdLookup"; id: number; rowKey: string; nodeId: NodeId; cost: number }
  | {
      kind: "Expand";
      id: number;
      input: Plan;
      fromKey: string;
      toKey: string;
      edgeKey?: string;
      direction: "out" | "in" | "both";
      categories: string[];
      toFilter?: NodePattern;
      cost: number;
    }
  | {
      kind: "PathExpand";
      id: number;
      input: Plan;
      fromKey: string;
      toKey: string;
      pathKey?: string;
      direction: "out" | "in" | "both";
      categories: string[];
      min: number;
      max: number;
      toFilter?: NodePattern;
      reversed: boolean;
      cost: number;
    }
  | { kind: "Filter"; id: number; input: Plan; predicate: Expr; cost: number }
  | { kind: "Project"; id: number; input: Plan; items: ProjectionItem[]; distinct: boolean; cost: number }
  | {
      kind: "Aggregate";
      id: number;
      input: Plan;
      groupKeys: ProjectionItem[];
      aggregates: ProjectionItem[];
      cost: number;
    }
  | { kind: "Sort"; id: number; input: Plan; keys: OrderByClause[]; cost: number }
  | { kind: "Limit"; id: number; input: Plan; n: number; cost: number }
  | { kind: "Subgraph"; id: number; input: Plan; sourceCol: string; cost: number }
  | { kind: "CartesianMatch"; id: number; left: Plan; right: Plan; cost: number };

// =============================================================================
// Errors
// =============================================================================

export class CgqlParseError extends Error {
  readonly line: number;
  readonly col: number;
  constructor(message: string, line: number, col: number) {
    super(message);
    this.name = "CgqlParseError";
    this.line = line;
    this.col = col;
  }
}

export class CgqlPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CgqlPlanError";
  }
}

export class CgqlRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CgqlRuntimeError";
  }
}

// =============================================================================
// Internal — engine plumbing types re-exported for the planner/engine pair.
// =============================================================================

/** A row of bound bindings during execution. */
export type Binding = Record<string, CellValue>;

export type { Edge, Node, NodeId, EdgeCategory, NodeTier };
