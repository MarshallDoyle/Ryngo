/**
 * Compiler-coverage classifications.
 *
 * Each entry counts a specific category of code construct in an IR. The
 * harness sums these per repo and across the corpus, then diffs against
 * the previous run so adapter / parser improvements show up as concrete
 * jumps ("+423 http-route nodes after Phase 5 shipped").
 *
 * Add new classifications here when you ship a new parser feature. Keep the
 * `id` stable across runs — it's the join key in history.json.
 *
 * Each entry: { id, label, group, count(ir) → number }
 */

const byKind = (ir, kind) => (ir.nodes || []).filter((n) => n.kind === kind).length;
const byEdgeKind = (ir, kind) => (ir.edges || []).filter((e) => e.kind === kind).length;
const byPredicate = (ir, fn) => (ir.nodes || []).filter(fn).length;
const byEdgePredicate = (ir, fn) => (ir.edges || []).filter(fn).length;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

export const CLASSIFICATIONS = [
  // -- Files & structure ---------------------------------------------------
  { id: "file_total", group: "files", label: "File nodes", count: (ir) => byKind(ir, "file") },
  {
    id: "file_analyzable",
    group: "files",
    label: "Analyzable files",
    count: (ir) => byPredicate(ir, (n) => n.kind === "file" && n.data?.analyzable),
  },
  {
    id: "file_with_defs",
    group: "files",
    label: "Files containing ≥1 def",
    count: (ir) => {
      const owners = new Set(
        (ir.nodes || [])
          .filter((n) => n.kind === "function" || n.kind === "class")
          .map((n) => n.parentId),
      );
      return owners.size;
    },
  },

  // -- Definitions ---------------------------------------------------------
  { id: "fn_total", group: "defs", label: "Function defs", count: (ir) => byKind(ir, "function") },
  {
    id: "fn_with_params",
    group: "defs",
    label: "Functions with extracted params",
    count: (ir) =>
      byPredicate(ir, (n) => n.kind === "function" && Array.isArray(n.data?.params)),
  },
  {
    id: "fn_with_typed_params",
    group: "defs",
    label: "Functions with ≥1 typed param",
    count: (ir) =>
      byPredicate(
        ir,
        (n) =>
          n.kind === "function" &&
          Array.isArray(n.data?.params) &&
          n.data.params.some((p) => p.typeDisplay),
      ),
  },
  {
    id: "fn_with_return_type",
    group: "defs",
    label: "Functions with return type",
    count: (ir) => byPredicate(ir, (n) => n.kind === "function" && n.data?.returnType),
  },
  {
    id: "class_total",
    group: "defs",
    label: "Class defs",
    count: (ir) => byKind(ir, "class"),
  },
  {
    id: "class_with_members",
    group: "defs",
    label: "Classes with members",
    count: (ir) =>
      byPredicate(
        ir,
        (n) =>
          n.kind === "class" &&
          ((n.data?.members?.methods?.length || 0) +
            (n.data?.members?.fields?.length || 0)) >
            0,
      ),
  },
  {
    id: "class_methods",
    group: "defs",
    label: "Class methods (sum across classes)",
    count: (ir) =>
      sum(
        (ir.nodes || [])
          .filter((n) => n.kind === "class")
          .map((n) => n.data?.members?.methods?.length || 0),
      ),
  },
  {
    id: "class_fields",
    group: "defs",
    label: "Class fields (sum across classes)",
    count: (ir) =>
      sum(
        (ir.nodes || [])
          .filter((n) => n.kind === "class")
          .map((n) => n.data?.members?.fields?.length || 0),
      ),
  },
  {
    id: "class_with_bases",
    group: "defs",
    label: "Classes with declared base classes",
    count: (ir) =>
      byPredicate(ir, (n) => n.kind === "class" && (n.data?.baseClasses?.length || 0) > 0),
  },

  // -- Notebooks -----------------------------------------------------------
  {
    id: "notebook_files",
    group: "notebooks",
    label: "Notebook files",
    count: (ir) =>
      byPredicate(ir, (n) => n.kind === "file" && (n.data?.ext || "").toLowerCase() === ".ipynb"),
  },
  { id: "cell_total", group: "notebooks", label: "Notebook cells", count: (ir) => byKind(ir, "cell") },

  // -- Imports / packages --------------------------------------------------
  {
    id: "package_nodes",
    group: "imports",
    label: "External package nodes",
    count: (ir) => byKind(ir, "package"),
  },
  {
    id: "imports_file",
    group: "imports",
    label: "imports-file edges",
    count: (ir) => byEdgeKind(ir, "imports-file"),
  },
  {
    id: "imports_package",
    group: "imports",
    label: "imports-package edges",
    count: (ir) => byEdgeKind(ir, "imports-package"),
  },

  // -- Calls & resolution --------------------------------------------------
  { id: "call_edges", group: "calls", label: "calls edges", count: (ir) => byEdgeKind(ir, "calls") },
  {
    id: "call_lexical",
    group: "calls",
    label: "calls resolved lexically",
    count: (ir) =>
      byEdgePredicate(ir, (e) => e.kind === "calls" && e.resolution === "lexical"),
  },
  {
    id: "call_imported",
    group: "calls",
    label: "calls resolved via import",
    count: (ir) =>
      byEdgePredicate(ir, (e) => e.kind === "calls" && e.resolution === "imported"),
  },
  {
    id: "call_name_match",
    group: "calls",
    label: "calls resolved via name-match",
    count: (ir) =>
      byEdgePredicate(ir, (e) => e.kind === "calls" && e.resolution === "name-match"),
  },

  // -- Adapter-emitted nodes ----------------------------------------------
  {
    id: "http_routes",
    group: "adapters",
    label: "HTTP routes (any framework)",
    count: (ir) => byKind(ir, "http-route"),
  },
  {
    id: "http_routes_express",
    group: "adapters",
    label: "Express routes",
    count: (ir) =>
      byPredicate(ir, (n) => n.kind === "http-route" && n.data?.framework === "express"),
  },
  {
    id: "http_routes_fastapi",
    group: "adapters",
    label: "FastAPI routes",
    count: (ir) =>
      byPredicate(ir, (n) => n.kind === "http-route" && n.data?.framework === "fastapi"),
  },
  {
    id: "http_routes_nextjs",
    group: "adapters",
    label: "Next.js routes",
    count: (ir) =>
      byPredicate(
        ir,
        (n) =>
          n.kind === "http-route" &&
          (n.data?.framework === "nextjs-app" || n.data?.framework === "nextjs-pages"),
      ),
  },
  {
    id: "http_routes_django",
    group: "adapters",
    label: "Django routes",
    count: (ir) =>
      byPredicate(ir, (n) => n.kind === "http-route" && n.data?.framework === "django"),
  },
  {
    id: "gql_types",
    group: "adapters",
    label: "GraphQL types (SDL)",
    count: (ir) => byKind(ir, "gql-type"),
  },
  {
    id: "gql_resolvers",
    group: "adapters",
    label: "GraphQL resolvers (Query/Mutation/Subscription)",
    count: (ir) => byKind(ir, "gql-resolver"),
  },
  {
    id: "db_models",
    group: "adapters",
    label: "DB models (any source)",
    count: (ir) => byKind(ir, "db-model"),
  },
  {
    id: "db_read_edges",
    group: "adapters",
    label: "db-read edges",
    count: (ir) => byEdgeKind(ir, "db-read"),
  },
  {
    id: "db_write_edges",
    group: "adapters",
    label: "db-write edges",
    count: (ir) => byEdgeKind(ir, "db-write"),
  },
  {
    id: "env_nodes",
    group: "adapters",
    label: "Env-var leaf nodes",
    count: (ir) => byKind(ir, "env"),
  },
  {
    id: "env_read_edges",
    group: "adapters",
    label: "env-read edges",
    count: (ir) => byEdgeKind(ir, "env-read"),
  },
  {
    id: "route_handler_edges",
    group: "adapters",
    label: "route-handler edges",
    count: (ir) => byEdgeKind(ir, "route-handler"),
  },

  // -- Effects / purity ----------------------------------------------------
  {
    id: "fn_with_effects",
    group: "effects",
    label: "Functions with any effect",
    count: (ir) =>
      byPredicate(ir, (n) => n.kind === "function" && (n.effects?.length || 0) > 0),
  },
  {
    id: "fn_pure",
    group: "effects",
    label: "Functions marked pure",
    count: (ir) => byPredicate(ir, (n) => n.kind === "function" && n.pure === true),
  },
  {
    id: "fn_db_writer",
    group: "effects",
    label: "Functions transitively reaching db-write",
    count: (ir) =>
      byPredicate(
        ir,
        (n) => n.kind === "function" && n.effects?.includes("db-write"),
      ),
  },
  {
    id: "fn_network",
    group: "effects",
    label: "Functions transitively reaching network",
    count: (ir) =>
      byPredicate(
        ir,
        (n) => n.kind === "function" && n.effects?.includes("network"),
      ),
  },

  // -- Diagnostics & adapters that fired ----------------------------------
  {
    id: "diagnostics",
    group: "meta",
    label: "Resolver / adapter diagnostics emitted",
    count: (ir) => (ir.diagnostics?.length || 0),
  },
  {
    id: "adapters_ran",
    group: "meta",
    label: "Adapters that ran (1 per adapter)",
    count: (ir) => (ir.stats?.ranAdapters?.length || 0),
  },
];

export function computeAll(ir) {
  const out = {};
  for (const c of CLASSIFICATIONS) {
    try {
      out[c.id] = c.count(ir) || 0;
    } catch (err) {
      out[c.id] = -1;
    }
  }
  return out;
}
