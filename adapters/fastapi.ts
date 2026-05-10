/**
 * codegraph adapter: FastAPI
 * ---------------------------------------------------------------------------
 * Recognizes FastAPI route decorators and emits IR route nodes plus handler
 * edges. Resolves request/response shapes from Pydantic models.
 *
 * NOTE: codegraph's TS-first SDK exposes Python ASTs through the same
 * normalized walker interface — adapter-sdk delegates to a Python parser
 * (libcst / tree-sitter) under the hood. From the adapter's point of view
 * we still receive structurally typed nodes via `file.ast.walk(visitor)`.
 *
 * Detection strategy:
 *   1. requirements.txt / pyproject.toml lists `fastapi`  ->  candidate
 *   2. At least one .py file imports `fastapi` and instantiates `FastAPI()`
 *      or `APIRouter()`  ->  confirmed
 *
 * Per-file analysis:
 *   - Track `app = FastAPI(...)` and `router = APIRouter(prefix=...)` bindings.
 *   - Find decorated functions where the decorator is `<binding>.<verb>(path,
 *     response_model=Model, ...)` and the verb is an HTTP method.
 *   - Pull request body type from the first non-Depends/non-path/non-query
 *     parameter whose annotation is a Pydantic BaseModel subclass.
 *   - Pull response_model from the decorator kwargs.
 *
 * Cross-file resolution:
 *   - Apply APIRouter prefixes to their routes.
 *   - Match include_router(router, prefix='/extra') for additional nesting.
 *   - frontend-fetch -> backend-route matching, same as Express adapter.
 */

import type {
  Adapter,
  RepoContext,
  FileContext,
  AdapterOutput,
} from "@codegraph/adapter-sdk";
import type {
  IRNode,
  IREdge,
  RouteNode,
  HandlerSymbol,
  HttpMethod,
  TypeShape,
} from "@codegraph/ir";

const HTTP_VERBS: ReadonlyArray<HttpMethod> = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
];

interface FastApiFileState {
  // var name -> { kind, prefix }. APIRouter can carry its own prefix arg.
  bindings: Map<string, { kind: "app" | "router"; prefix: string }>;
  routes: RouteNode[];
  edges: IREdge[];
  // include_router(child, prefix='/x') — composed in pass 2.
  includes: Array<{ parentVar: string; childVar: string; extraPrefix: string }>;
}

export const fastapiAdapter: Adapter = {
  name: "fastapi",

  detect(repo: RepoContext): boolean {
    // FastAPI projects ship with one of these manifest files. We accept
    // either; pyproject is preferred for modern projects.
    const reqs = repo.readFile?.("requirements.txt") ?? "";
    const pyproject = repo.readFile?.("pyproject.toml") ?? "";
    return /(^|\n)\s*fastapi\b/i.test(reqs) || /\bfastapi\b/.test(pyproject);
  },

  analyzeFile(file: FileContext): AdapterOutput {
    // Skip non-Python files quickly. The orchestrator may still hand us .ts
    // files in a polyglot repo; bail fast.
    if (!file.path.endsWith(".py")) return { nodes: [], edges: [] };

    const state: FastApiFileState = {
      bindings: new Map(),
      routes: [],
      edges: [],
      includes: [],
    };

    file.ast.walk({
      // ----- Bind `app = FastAPI(...)` / `router = APIRouter(prefix=...)` --
      Assign(node) {
        // Single-target only; tuple-unpacking isn't idiomatic for app/router.
        if (node.targets.length !== 1 || node.targets[0].type !== "Name") return;
        const name = node.targets[0].id;
        const value = node.value;
        if (value.type !== "Call") return;

        const callee = stringifyCallee(value.func);
        if (callee === "FastAPI" || callee === "fastapi.FastAPI") {
          state.bindings.set(name, { kind: "app", prefix: "" });
        } else if (callee === "APIRouter" || callee === "fastapi.APIRouter") {
          // APIRouter accepts a `prefix` kwarg; capture it so child routes
          // see the right path even before include_router runs.
          const prefix = getKwarg(value, "prefix") ?? "";
          state.bindings.set(name, { kind: "router", prefix });
        }
      },

      // ----- include_router calls — capture extra prefix nesting -----------
      Expr(node) {
        if (node.value.type !== "Call") return;
        const call = node.value;
        if (call.func.type !== "Attribute") return;
        if (call.func.attr !== "include_router") return;
        if (call.func.value.type !== "Name") return;

        const parentVar = call.func.value.id;
        const firstArg = call.args[0];
        if (!firstArg || firstArg.type !== "Name") return;
        const childVar = firstArg.id;
        const extraPrefix = getKwarg(call, "prefix") ?? "";

        if (state.bindings.has(parentVar)) {
          state.includes.push({ parentVar, childVar, extraPrefix });
        }
      },

      // ----- Decorated function defs: the bread and butter ----------------
      FunctionDef(node) {
        for (const dec of node.decorator_list) {
          // We only care about `<binding>.<verb>(...)` decorators.
          if (dec.type !== "Call") continue;
          if (dec.func.type !== "Attribute") continue;
          if (dec.func.value.type !== "Name") continue;

          const ownerVar = dec.func.value.id;
          const verb = dec.func.attr.toLowerCase();
          const binding = state.bindings.get(ownerVar);
          if (!binding) continue;
          if (!HTTP_VERBS.includes(verb as HttpMethod)) continue;

          // First positional arg is the path string.
          const pathArg = dec.args[0];
          if (!pathArg || pathArg.type !== "Constant" || typeof pathArg.value !== "string") {
            continue;
          }
          const localPath = pathArg.value;

          // response_model kwarg — usually a Pydantic model name. We resolve
          // it to a TypeShape via the file's type service if available.
          const responseModelExpr = getKwargExpr(dec, "response_model");
          const responseType = responseModelExpr
            ? file.py?.resolveTypeFromExpr(responseModelExpr)
            : undefined;

          // Status code & tags are useful metadata but not required.
          const statusCode = getKwargLiteral(dec, "status_code");
          const tags = getKwargListLiterals(dec, "tags");

          // ----- Walk the function signature for params + body -------------
          // FastAPI's parameter conventions:
          //   - Path params: name appears in path template AND function arg
          //     (e.g. path="/users/{id}" + def fn(id: int))
          //   - Query params: function args with primitive type and no Body()
          //   - Body params: function args annotated with a Pydantic model,
          //     OR explicitly wrapped with `Body(...)`
          //   - Dependencies: `Depends(...)` — skipped for routing IR.
          const pathParamNames = extractPathParamNames(localPath);
          const params: RouteNode["params"] = [];
          let requestBody: TypeShape | undefined;

          for (const arg of node.args.args) {
            const argName = arg.arg;
            const annotation = arg.annotation;
            if (!annotation) continue;
            if (isDependsAnnotation(annotation)) continue;

            const shape = file.py?.resolveTypeFromExpr(annotation);
            if (!shape) continue;

            if (pathParamNames.has(argName)) {
              params.push({ in: "path", name: argName, type: shape });
            } else if (shape.kind === "pydantic-model") {
              // First Pydantic-typed arg becomes the request body. FastAPI
              // technically allows multiple Body() args (they get merged into
              // a JSON object) — we model the first only for simplicity.
              if (!requestBody) requestBody = shape;
              else params.push({ in: "body", name: argName, type: shape });
            } else {
              params.push({ in: "query", name: argName, type: shape });
            }
          }

          const routeId = file.makeNodeId(
            "route",
            `${verb.toUpperCase()} ${localPath}`
          );

          const handlerSymbol: HandlerSymbol = file.symbolFor(node);

          const routeNode: RouteNode = {
            id: routeId,
            kind: "route",
            framework: "fastapi",
            method: verb.toUpperCase() as HttpMethod,
            path: localPath, // composed with prefix in pass 2
            ownerKind: binding.kind,
            ownerVar: ownerVar,
            file: file.path,
            loc: node.loc,
            params,
            requestBody,
            responseType,
            statusCode,
            tags,
          };
          state.routes.push(routeNode);

          state.edges.push({
            kind: "route-handler",
            from: routeId,
            to: handlerSymbol.id,
            attrs: {
              method: routeNode.method,
              path: routeNode.path,
              params: routeNode.params,
              requestBody: routeNode.requestBody,
              responseType: routeNode.responseType,
            },
          });
        }
      },
    });

    return {
      nodes: state.routes,
      edges: state.edges,
      private: {
        bindings: Array.from(state.bindings.entries()),
        includes: state.includes,
      },
    };
  },

  resolveCrossFile(allOutputs, ctx) {
    // ----- 1. Build a global routerVar -> effective-prefix map ------------
    // Each binding has its own prefix; include_router can add MORE prefix
    // when mounting one router onto another (or onto the app).
    //
    // Strategy: collect all bindings + includes, then iterate to fixed point
    // computing each router's full prefix when reachable from an `app`.
    const bindings = new Map<string, { kind: "app" | "router"; prefix: string }>();
    const includes: Array<{ parentVar: string; childVar: string; extraPrefix: string }> = [];

    for (const out of allOutputs) {
      for (const [name, b] of (out.private?.bindings ?? [])) bindings.set(name, b);
      for (const inc of out.private?.includes ?? []) includes.push(inc);
    }

    // routerVar -> list of full prefixes it is reachable at from an `app`.
    // (List because a router could be included from multiple parents.)
    const fullPrefixes = new Map<string, string[]>();
    for (const [name, b] of bindings) {
      if (b.kind === "app") fullPrefixes.set(name, [""]);
      else fullPrefixes.set(name, []); // populated by traversal below
    }

    // BFS: walk includes, propagating prefixes from parents to children.
    // Multiple passes handle chained includes (app -> r1 -> r2).
    let changed = true;
    let safety = 0;
    while (changed && safety++ < 32) {
      changed = false;
      for (const inc of includes) {
        const parentPrefixes = fullPrefixes.get(inc.parentVar) ?? [];
        const childOwn = bindings.get(inc.childVar)?.prefix ?? "";
        const childPrefixes = fullPrefixes.get(inc.childVar) ?? [];
        for (const p of parentPrefixes) {
          const composed = joinPath(joinPath(p, inc.extraPrefix), childOwn);
          if (!childPrefixes.includes(composed)) {
            childPrefixes.push(composed);
            fullPrefixes.set(inc.childVar, childPrefixes);
            changed = true;
          }
        }
      }
    }

    // ----- 2. Materialize each route at its effective full path(s) -------
    const finalRoutes: RouteNode[] = [];
    const finalEdges: IREdge[] = [...flatMap(allOutputs, (o) => o.edges)];

    for (const out of allOutputs) {
      for (const route of out.nodes.filter(isRouteNode)) {
        if (route.ownerKind === "app") {
          // App-owned route: app's prefix is always "" so just take its own
          // path; bindings prefix on FastAPI() itself is rarely set.
          finalRoutes.push({
            ...route,
            path: joinPath(bindings.get(route.ownerVar)?.prefix ?? "", route.path),
          });
          continue;
        }
        const prefixes = fullPrefixes.get(route.ownerVar);
        if (!prefixes || prefixes.length === 0) {
          // Unreachable router (defined but never include_router'd). Emit
          // it anyway with its own prefix so it shows up in the graph;
          // downstream consumers can flag it as "orphan".
          finalRoutes.push({
            ...route,
            path: joinPath(bindings.get(route.ownerVar)?.prefix ?? "", route.path),
            orphan: true,
          });
          continue;
        }
        for (const prefix of prefixes) {
          finalRoutes.push({ ...route, path: joinPath(prefix, route.path) });
        }
      }
    }

    // ----- 3. frontend-fetch -> backend-route matching --------------------
    const fetchNodes = ctx.collectNodes("client-call");
    for (const fetchNode of fetchNodes) {
      const match = matchRoute(fetchNode, finalRoutes);
      if (!match) continue;
      finalEdges.push({
        kind: "frontend-fetch",
        from: fetchNode.id,
        to: match.id,
        attrs: { method: match.method, path: match.path },
      });
    }

    return { nodes: finalRoutes, edges: finalEdges };
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** "fastapi.FastAPI" or "FastAPI" — flatten Attribute chain into dotted str. */
function stringifyCallee(node: any): string {
  if (node.type === "Name") return node.id;
  if (node.type === "Attribute") return `${stringifyCallee(node.value)}.${node.attr}`;
  return "<unknown>";
}

/** Get a kwarg's string-literal value from a Call node, or undefined. */
function getKwarg(call: any, name: string): string | undefined {
  const kw = call.keywords?.find((k: any) => k.arg === name);
  if (!kw) return undefined;
  if (kw.value.type === "Constant" && typeof kw.value.value === "string") {
    return kw.value.value;
  }
  return undefined;
}

/** Get a kwarg's raw expression node (for type-resolving response_model). */
function getKwargExpr(call: any, name: string): any | undefined {
  return call.keywords?.find((k: any) => k.arg === name)?.value;
}

function getKwargLiteral(call: any, name: string): any {
  const kw = call.keywords?.find((k: any) => k.arg === name);
  if (!kw || kw.value.type !== "Constant") return undefined;
  return kw.value.value;
}

function getKwargListLiterals(call: any, name: string): string[] | undefined {
  const kw = call.keywords?.find((k: any) => k.arg === name);
  if (!kw || kw.value.type !== "List") return undefined;
  return kw.value.elts
    .filter((e: any) => e.type === "Constant" && typeof e.value === "string")
    .map((e: any) => e.value);
}

/** Extract `{name}` placeholders from a path template like "/users/{id}". */
function extractPathParamNames(path: string): Set<string> {
  const out = new Set<string>();
  for (const m of path.matchAll(/\{([^}:]+)(?::[^}]+)?\}/g)) {
    out.add(m[1]);
  }
  return out;
}

/** True when an annotation expression is a `Depends(...)` wrapper. */
function isDependsAnnotation(ann: any): boolean {
  // `arg: SomeType = Depends(get_db)` — annotation is on the assigned default,
  // but FastAPI also accepts `arg: Annotated[SomeType, Depends(...)]`.
  if (ann.type === "Subscript" && ann.value?.type === "Name" && ann.value.id === "Annotated") {
    const tup = ann.slice;
    if (tup?.type === "Tuple") {
      return tup.elts.some(
        (e: any) =>
          e.type === "Call" && e.func?.type === "Name" && e.func.id === "Depends"
      );
    }
  }
  return false;
}

function isRouteNode(n: IRNode): n is RouteNode {
  return n.kind === "route";
}

function joinPath(prefix: string, sub: string): string {
  if (!prefix) return sub;
  const a = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const b = sub.startsWith("/") ? sub : "/" + sub;
  return a + b;
}

function flatMap<T, U>(arr: T[], fn: (t: T) => U[]): U[] {
  const out: U[] = [];
  for (const t of arr) out.push(...fn(t));
  return out;
}

/** Same matching strategy as Express — `{id}` param syntax accepted too. */
function matchRoute(fetchNode: any, routes: RouteNode[]): RouteNode | undefined {
  const exact = routes.find(
    (r) => r.method === fetchNode.method && r.path === fetchNode.url
  );
  if (exact) return exact;

  return routes.find((r) => {
    if (r.method !== fetchNode.method) return false;
    // FastAPI uses {param} syntax; also accept :param for cross-stack matching.
    const pattern = r.path
      .replace(/\{[^}]+\}/g, "[^/]+")
      .replace(/:[A-Za-z_]\w*/g, "[^/]+");
    return new RegExp(`^${pattern}$`).test(fetchNode.url);
  });
}
