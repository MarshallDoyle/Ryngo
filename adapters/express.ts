/**
 * codegraph adapter: Express
 * ---------------------------------------------------------------------------
 * Recognizes Express.js route registrations and emits IR nodes for each route
 * plus an edge from the route to its handler symbol. Handles both `app.<verb>`
 * style and `Router()` sub-mounting.
 *
 * Detection strategy (deterministic, no LLM):
 *   1. `express` listed in package.json deps  ->  candidate repo
 *   2. At least one file imports `express` and calls `express()` or
 *      `express.Router()`  ->  confirmed
 *
 * Per-file analysis is purely AST-based: we walk CallExpressions whose callee
 * matches `<obj>.<verb>(...)` where verb is one of the HTTP methods (or `use`
 * for sub-mounting). The first arg literal is the path; remaining args are
 * middleware/handlers — we link the LAST one as the route handler (Express
 * convention: handler is the terminal function in the chain).
 *
 * Cross-file resolution:
 *   - Resolve `Router()` instances mounted via `app.use('/prefix', router)` so
 *     child routes get their full path.
 *   - Match frontend `fetch('/api/users')` calls discovered by other adapters
 *     to backend routes by exact-or-prefix path + method.
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
} from "@codegraph/ir";

// HTTP verbs Express exposes as method calls. `use` is special — it's either
// middleware or sub-router mounting; we handle that branch explicitly below.
const HTTP_VERBS: ReadonlyArray<HttpMethod> = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
];

/**
 * Per-file scratch state we accumulate during AST walk and then flatten into
 * the AdapterOutput. Kept structurally typed so adapter-sdk can serialize it
 * to JSON between worker processes without a custom codec.
 */
interface ExpressFileState {
  // Local variable name -> kind. Tracks `const app = express()` and
  // `const userRouter = express.Router()`.
  appBindings: Map<string, "app" | "router">;
  // Routes discovered in this file. Path may be partial (relative to a Router)
  // — the cross-file pass joins them with their mount prefix.
  routes: RouteNode[];
  // Edges from route -> handler symbol (file + name). Resolved later.
  edges: IREdge[];
  // Router mount points: `app.use('/api', userRouter)` — joined in pass 2.
  mounts: Array<{ prefix: string; routerVar: string; mountedOn: string }>;
}

export const expressAdapter: Adapter = {
  name: "express",

  /**
   * Repo-level detection. Cheap — only reads package.json. We deliberately do
   * NOT scan source here; the orchestrator will only call analyzeFile if this
   * returns true, so we want to bail fast on irrelevant repos.
   */
  detect(repo: RepoContext): boolean {
    const pkg = repo.readPackageJson?.();
    if (!pkg) return false;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return "express" in deps;
  },

  /**
   * Per-file pass. Receives a parsed AST (TypeScript or Babel — adapter-sdk
   * normalizes) plus a FileContext with helpers for symbol resolution.
   *
   * We do a single top-down walk and rely on the SDK's `ast.walk(visitor)`
   * helper. For brevity, the visitor signatures below are illustrative — the
   * real SDK uses tagged-union node types from @codegraph/ir.
   */
  analyzeFile(file: FileContext): AdapterOutput {
    const state: ExpressFileState = {
      appBindings: new Map(),
      routes: [],
      edges: [],
      mounts: [],
    };

    file.ast.walk({
      // Match `const x = express()` and `const x = express.Router()`.
      VariableDeclarator(node) {
        const init = node.init;
        if (!init || init.type !== "CallExpression") return;

        // `express()` -> app
        if (init.callee.type === "Identifier" && init.callee.name === "express") {
          if (node.id.type === "Identifier") {
            state.appBindings.set(node.id.name, "app");
          }
          return;
        }
        // `express.Router()` or `Router()` -> router
        const isRouter =
          (init.callee.type === "MemberExpression" &&
            init.callee.property.type === "Identifier" &&
            init.callee.property.name === "Router") ||
          (init.callee.type === "Identifier" && init.callee.name === "Router");
        if (isRouter && node.id.type === "Identifier") {
          state.appBindings.set(node.id.name, "router");
        }
      },

      // Match `app.get(...)`, `router.post(...)`, `app.use(...)`, etc.
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression") return;
        const obj = node.callee.object;
        const prop = node.callee.property;
        if (obj.type !== "Identifier" || prop.type !== "Identifier") return;

        const binding = state.appBindings.get(obj.name);
        if (!binding) return; // Not one of our app/router objects.

        const verb = prop.name.toLowerCase();

        // ---- Sub-router mounting: `app.use('/api', userRouter)` ----------
        if (verb === "use") {
          const [pathArg, routerArg] = node.arguments;
          if (
            pathArg?.type === "StringLiteral" &&
            routerArg?.type === "Identifier" &&
            state.appBindings.get(routerArg.name) === "router"
          ) {
            state.mounts.push({
              prefix: pathArg.value,
              routerVar: routerArg.name,
              mountedOn: obj.name,
            });
          }
          // We intentionally don't emit middleware-only `app.use(fn)` calls
          // as routes — middleware tracking is a separate concern.
          return;
        }

        // ---- HTTP method routes -----------------------------------------
        if (!HTTP_VERBS.includes(verb as HttpMethod)) return;

        const [pathArg, ...handlerArgs] = node.arguments;
        if (pathArg?.type !== "StringLiteral") return;

        // Express convention: the LAST callable arg is the route handler;
        // anything before it is middleware. We don't currently emit edges
        // for middleware, but a future pass could (it's the same shape).
        const handler = handlerArgs[handlerArgs.length - 1];
        if (!handler) return;

        // Resolve handler -> symbol. Could be:
        //   - inline arrow: `(req, res) => {...}` — we synthesize an anon symbol
        //   - identifier: `getUser` — resolve via file's symbol table
        //   - member: `controllers.user.get` — resolve dotted path
        const handlerSymbol = resolveHandlerSymbol(handler, file);

        const routeId = file.makeNodeId(
          "route",
          `${verb.toUpperCase()} ${pathArg.value}`
        );

        const routeNode: RouteNode = {
          id: routeId,
          kind: "route",
          framework: "express",
          method: verb.toUpperCase() as HttpMethod,
          path: pathArg.value,
          // Whether this route lives on an `app` (final path) or a `router`
          // (path is relative — needs prefix from a mount in pass 2).
          ownerKind: binding,
          ownerVar: obj.name,
          file: file.path,
          loc: node.loc,
          // Best-effort param/body extraction from handler signature.
          // The SDK gives us types via the LSP service when TS info exists.
          params: extractTypedParams(handler, file),
          requestBody: extractTypedBody(handler, file),
          responseType: extractTypedResponse(handler, file),
        };
        state.routes.push(routeNode);

        state.edges.push({
          kind: "route-handler",
          from: routeId,
          to: handlerSymbol.id,
          // Edge "type info" carried alongside method/path — useful for
          // downstream consumers that want to render endpoint summaries
          // without re-walking the route node.
          attrs: {
            method: routeNode.method,
            path: routeNode.path,
            params: routeNode.params,
            requestBody: routeNode.requestBody,
            responseType: routeNode.responseType,
          },
        });
      },
    });

    return {
      nodes: state.routes,
      edges: state.edges,
      // The mounts table is private state we ferry to resolveCrossFile.
      // adapter-sdk threads `private` through unchanged.
      private: { mounts: state.mounts },
    };
  },

  /**
   * Cross-file pass. Runs once after every file has been analyzed.
   *
   * Two jobs:
   *   1. Compose Router-relative paths with their mount prefixes.
   *   2. Match frontend fetch() calls (emitted by other adapters as
   *      `client-call` nodes) to backend routes.
   */
  resolveCrossFile(allOutputs, ctx) {
    // ----- 1. Router prefix resolution -------------------------------------
    // Build a map: routerVar -> list of mount prefixes it's mounted at.
    // (A router can be mounted multiple times — rare, but legal.)
    const mountPrefixes = new Map<string, string[]>();
    for (const out of allOutputs) {
      const mounts = out.private?.mounts ?? [];
      for (const m of mounts) {
        const arr = mountPrefixes.get(m.routerVar) ?? [];
        arr.push(m.prefix);
        mountPrefixes.set(m.routerVar, arr);
      }
    }

    // For each route owned by a router, fan it out into one full-path route
    // per mount prefix. App-owned routes pass through unchanged.
    const finalRoutes: RouteNode[] = [];
    const finalEdges: IREdge[] = [...flatMap(allOutputs, (o) => o.edges)];

    for (const out of allOutputs) {
      for (const route of out.nodes.filter(isRouteNode)) {
        if (route.ownerKind === "app") {
          finalRoutes.push(route);
          continue;
        }
        const prefixes = mountPrefixes.get(route.ownerVar) ?? [""];
        for (const prefix of prefixes) {
          finalRoutes.push({
            ...route,
            path: joinPath(prefix, route.path),
          });
        }
      }
    }

    // ----- 2. frontend-fetch -> backend-route matching --------------------
    // Other adapters (Next.js, generic-client) emit `client-call` nodes with
    // a URL + method. We match by exact path first, then by parameterized
    // path (`/users/:id` vs `/users/123`).
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
// Helpers (kept local — these are illustrative, the real SDK provides most).
// ---------------------------------------------------------------------------

/**
 * Resolve a handler argument node to a HandlerSymbol. For inline functions
 * we synthesize an anonymous symbol pinned to the call site; for identifiers
 * we ask the file's symbol table.
 */
function resolveHandlerSymbol(node: any, file: FileContext): HandlerSymbol {
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
    return file.synthesizeAnonSymbol(node, "express-handler");
  }
  if (node.type === "Identifier") {
    return file.resolveSymbol(node.name) ?? file.synthesizeUnresolved(node.name);
  }
  if (node.type === "MemberExpression") {
    return file.resolveDottedPath(node) ?? file.synthesizeUnresolved("<member>");
  }
  return file.synthesizeUnresolved("<unknown>");
}

/**
 * Pull `req.params` / `req.query` types from the handler's first parameter
 * if it's typed (e.g. `Request<{id: string}>`). Returns undefined when there
 * is no usable type info — we never guess.
 */
function extractTypedParams(handler: any, file: FileContext) {
  return file.ts?.getRequestParamShape(handler);
}
function extractTypedBody(handler: any, file: FileContext) {
  return file.ts?.getRequestBodyShape(handler);
}
function extractTypedResponse(handler: any, file: FileContext) {
  return file.ts?.getResponseShape(handler);
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

/**
 * Match a client-call node to a backend route. Tries exact match, then
 * pattern match (`/users/:id` regex).
 */
function matchRoute(fetchNode: any, routes: RouteNode[]): RouteNode | undefined {
  // Exact + method match.
  const exact = routes.find(
    (r) => r.method === fetchNode.method && r.path === fetchNode.url
  );
  if (exact) return exact;

  // Parameterized fallback: turn `/users/:id` into a regex.
  return routes.find((r) => {
    if (r.method !== fetchNode.method) return false;
    const pattern = r.path.replace(/:[A-Za-z_]\w*/g, "[^/]+");
    return new RegExp(`^${pattern}$`).test(fetchNode.url);
  });
}
