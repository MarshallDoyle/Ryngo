/**
 * Public surface of `@codegraph/core/query`.
 *
 * Three consumer groups read from here:
 *   - The CLI (`codegraph query`, see packages/cli/src/commands/cmd-query.ts).
 *   - The viewer's query bar (§6 of design/query-language.md).
 *   - Third-party tools and the GitHub Action via `runQuery`.
 *
 * The downstream `viewer-inspector` "type drill-in" feature calls
 * `runOnLoaded` directly so it can amortize Store construction across
 * many small queries triggered from the inspector panel.
 */

export { runQuery, runOnLoaded, buildStore } from "./engine.js";
export type { Store } from "./engine.js";
export { explainPlan } from "./planner.js";

export {
  parse,
  substituteParams,
} from "./parser.js";

export {
  ALL_CLI_FORMATS,
  defaultFormatFor,
  formatResult,
  parseParamsArg,
  type CliFormat,
} from "./cli-integration.js";

export {
  CGQL_VERSION,
  RESULT_SCHEMA_VERSION,
  CgqlParseError,
  CgqlPlanError,
  CgqlRuntimeError,
} from "./types.js";

export type {
  CellValue,
  Diagnostic,
  EdgeRef,
  Path,
  ProjectionItem,
  QueryResult,
  QueryStats,
  ResultRow,
  ResultShape,
  RunQueryOptions,
  Subgraph,
  // AST + plan exposed for advanced consumers / testing.
  Expr,
  Plan,
  QueryAST,
} from "./types.js";
