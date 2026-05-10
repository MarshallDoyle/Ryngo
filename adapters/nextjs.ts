/**
 * codegraph adapter: Next.js (App Router)
 * ---------------------------------------------------------------------------
 * Recognizes the Next.js 13+ App Router conventions:
 *   - File path IS the route. `app/users/[id]/route.ts` -> `/users/:id`.
 *   - HTTP method handlers are exported functions named GET/POST/PUT/...
 *   - `app/users/[id]/page.tsx` exports a default React component -> a
 *     "page-route" node (rendered HTML, not JSON API).
 *   - Server Actions: functions whose body (or whose enclosing module) starts
 *     with the directive `'use server'`. They're invoked from client code as
 *     ordinary function calls but execute on the server — we model them as
 *     route-like nodes so cross-stack edges still work.
 *
 * Detection strategy:
 *   1. `next` listed in package.json deps  AND
 *   2. An `app/` directory exists at the project root (or under `src/`)
 *
 * Per-file analysis:
 *   - If file is under app/ AND named route.ts/route.tsx/page.tsx, derive
 *     the route path from the file path (stripping `app/` and the filename,
 *     converting `[seg]` to `:seg`, `[[...slug]]` to `*splat`, ignoring
 *     `(group)` segments which don't affect the URL).
 *   - For route files: scan for exported GET/POST/etc. and emit a route per
 *     export, edge to the function symbol.
 *   - For page files: emit a page-route node, edge to the default export.
 *   - For ANY file: detect `'use server'` directives and emit server-action
 *     nodes; also detect `fetch(...)` calls and emit client-call nodes
 *     consumed by Express/FastAPI/this adapter's cross-file pass.
 *
 * Cross-file resolution:
 *   - Match in-repo `fetch('/api/users')` to backend route nodes — works
 *     across adapters (Next.js fetch matched to its own API route, or to
 *     an Express/FastAPI route if the same repo has a separate backend).
 *   - Wire Server Action references: when a client component imports a
 *     `'use server'` function, emit a frontend-fetch-equivalent edge.
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
  PageRouteNode,
  ServerActionNode,
  ClientCallNode,
  HttpMethod,
} from "@codegraph/ir";
import * as path from "node:path";

const HTTP_METHOD_EXPORTS = new Set<HttpMethod>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
]);

interface NextFileState {
  routes: RouteNode[];
  pages: PageRouteNode[];
  actions: ServerActionNode[];
  clientCalls: ClientCallNode[];
  edges: IREdge[];
}

export const nextjsAdapter: Adapter = {
  name: "nextjs",

  detect(repo: RepoContext): boolean {
    const pkg = repo.readPackageJson?.();
    if (!pkg) return false;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (!("next" in deps)) return false;
    // App Router lives at `app/` or `src/app/`. If neither exists this is
    // a pages/ project — we don't claim to handle pages-router here.
    return repo.hasDir?.("app") || repo.hasDir?.("src/app") || false;
  },

  analyzeFile(file: FileContext): AdapterOutput {
    const state: NextFileState = {
      routes: [],
      pages: [],
      actions: [],
      clientCalls: [],
      edges: [],
    };

    const appRel = appRelativePath(file.path);
    const isRouteFile =
      appRel !== null && /(^|\/)route\.(ts|tsx|js|jsx)$/.test(appRel);
    const isPageFile =
      appRel !== null && /(^|\/)page\.(tsx|jsx)$/.test(appRel);

    // ----- Route files: emit one route per HTTP-method export ----------------
    if (isRouteFile && appRel) {
      const routePath = filePathToRoute(appRel);

      for (const exp of file.ast.getExports()) {
        if (!HTTP_METHOD_EXPORTS.has(exp.name as HttpMethod)) continue;
        // exp.declaration is the FunctionDeclaration / VariableDeclarator
        // bound to GET/POST/etc.
        const handlerSymbol = file.symbolFor(exp.declaration);

        const routeId = file.makeNodeId(
          "route",
          `${exp.name} ${routePath}`
        );

        // Pull request/response shapes from the handler's signature when
        // typed. Next.js handlers have signature
        //   `(req: Request, ctx: { params: { ... } }) => Response | NextResponse`
        // The `ctx.params` shape gives us URL params for free.
        const params = file.ts?.getNextRouteParamShape(exp.declaration);
        const requestBody = file.ts?.getNextRouteBodyShape(exp.declaration);
        const responseType = file.ts?.getNextRouteResponseShape(exp.declaration);

        const node: RouteNode = {
          id: routeId,
          kind: "route",
          framework: "nextjs",
          method: exp.name as HttpMethod,
          path: routePath,
          // Next.js doesn't use the app/router distinction Express has;
          // path is final right out of the gate.
          ownerKind: "app",
          ownerVar: "app",
          file: file.path,
          loc: exp.declaration.loc,
          params,
          requestBody,
          responseType,
        };
        state.routes.push(node);

        state.edges.push({
          kind: "route-handler",
          from: routeId,
          to: handlerSymbol.id,
          attrs: {
            method: node.method,
            path: node.path,
            params,
            requestBody,
            responseType,
          },
        });
      }
    }

    // ----- Page files: emit a page-route ------------------------------------
    if (isPageFile && appRel) {
      const routePath = filePathToRoute(appRel);
      const def = file.ast.getDefaultExport();
      if (def) {
        const pageId = file.makeNodeId("page-route", routePath);
        const componentSymbol = file.symbolFor(def);
        const pageNode: PageRouteNode = {
          id: pageId,
          kind: "page-route",
          framework: "nextjs",
          path: routePath,
          file: file.path,
          loc: def.loc,
          // Next 13+: pages can be async server components that fetch data.
          // We flag whether this one is async so the UI can render an icon.
          async: def.async === true,
        };
        state.pages.push(pageNode);

        state.edges.push({
          kind: "page-component",
          from: pageId,
          to: componentSymbol.id,
        });
      }
    }

    // ----- Server Actions ('use server') ------------------------------------
    // Two flavors:
    //   (a) module-level: file's first directive is 'use server' — every
    //       exported async function is a server action.
    //   (b) function-level: a function's first statement is 'use server'.
    const moduleUseServer = file.ast.getModuleDirectives().includes("use server");

    file.ast.walk({
      FunctionDeclaration(node) {
        const fnUseServer =
          node.body?.directives?.some((d: any) => d.value === "use server") ??
          false;
        if (!moduleUseServer && !fnUseServer) return;
        if (!node.async) return; // Server actions must be async.

        const sym = file.symbolFor(node);
        const actionId = file.makeNodeId("server-action", sym.qualifiedName);
        state.actions.push({
          id: actionId,
          kind: "server-action",
          framework: "nextjs",
          file: file.path,
          loc: node.loc,
          name: node.id?.name ?? "<anon>",
          // Same shape extraction as routes — server actions have typed args
          // and a typed return.
          params: file.ts?.getFunctionParamShapes(node),
          responseType: file.ts?.getFunctionReturnShape(node),
        });
        state.edges.push({
          kind: "action-handler",
          from: actionId,
          to: sym.id,
        });
      },

      // Same pattern for `export const foo = async () => { 'use server' ... }`.
      // Omitted for brevity — real adapter handles all FunctionExpression
      // and ArrowFunctionExpression cases as well.

      // ----- fetch() calls: emit client-call nodes for cross-stack matching.
      // Other adapters (Express, FastAPI) AND this adapter's own
      // resolveCrossFile consume these.
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "fetch") {
          return;
        }
        const [urlArg, optsArg] = node.arguments;
        if (!urlArg) return;

        // Only handle string-literal URLs deterministically. For dynamic
        // URLs (template strings, variables) we either skip or emit with
        // a "dynamic" marker — adapter-sdk's `tryEvalString` does best-
        // effort constant folding for template literals.
        const url = file.tryEvalString(urlArg);
        if (!url) return;

        // Extract method from options object literal. Default GET if absent.
        let method: HttpMethod = "GET";
        if (optsArg && optsArg.type === "ObjectExpression") {
          const methodProp = optsArg.properties.find(
            (p: any) =>
              p.type === "Property" &&
              p.key.type === "Identifier" &&
              p.key.name === "method"
          );
          if (
            methodProp?.value.type === "Literal" &&
            typeof methodProp.value.value === "string"
          ) {
            method = methodProp.value.value.toUpperCase() as HttpMethod;
          }
        }

        state.clientCalls.push({
          id: file.makeNodeId("client-call", `${method} ${url}`),
          kind: "client-call",
          file: file.path,
          loc: node.loc,
          method,
          url,
        });
      },
    });

    return {
      nodes: [...state.routes, ...state.pages, ...state.actions, ...state.clientCalls],
      edges: state.edges,
    };
  },

  resolveCrossFile(allOutputs, ctx) {
    const allRoutes: RouteNode[] = [];
    const allClientCalls: ClientCallNode[] = [];
    const allActions: ServerActionNode[] = [];
    const passthroughNodes: IRNode[] = [];
    const finalEdges: IREdge[] = [...flatMap(allOutputs, (o) => o.edges)];

    for (const out of allOutputs) {
      for (const n of out.nodes) {
        if (n.kind === "route") allRoutes.push(n as RouteNode);
        else if (n.kind === "client-call") allClientCalls.push(n as ClientCallNode);
        else if (n.kind === "server-action") allActions.push(n as ServerActionNode);
        else passthroughNodes.push(n);
      }
    }

    // Pull in routes from OTHER adapters too — Next.js `fetch('/api/x')`
    // might hit an Express server in the same monorepo.
    const externalRoutes = ctx
      .collectNodes("route")
      .filter((r: RouteNode) => r.framework !== "nextjs");
    const matchableRoutes: RouteNode[] = [...allRoutes, ...externalRoutes];

    // ----- 1. fetch() -> route matching ------------------------------------
    for (const call of allClientCalls) {
      const match = matchRoute(call, matchableRoutes);
      if (!match) continue;
      finalEdges.push({
        kind: "frontend-fetch",
        from: call.id,
        to: match.id,
        attrs: { method: match.method, path: match.path },
      });
    }

    // ----- 2. Server Action invocations ------------------------------------
    // When a client component imports a server-action symbol and calls it,
    // adapter-sdk's symbol resolver gives us the import edge for free. We
    // upgrade those import edges to "action-call" edges so the graph shows
    // a client -> server boundary the same way fetch does.
    for (const action of allActions) {
      const callers = ctx.findCallersOf(action.id);
      for (const caller of callers) {
        finalEdges.push({
          kind: "action-call",
          from: caller.id,
          to: action.id,
          attrs: { name: action.name, responseType: action.responseType },
        });
      }
    }

    return {
      nodes: [...allRoutes, ...allActions, ...allClientCalls, ...passthroughNodes],
      edges: finalEdges,
    };
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * If `filePath` is under `app/` or `src/app/`, return the path relative to
 * that root. Otherwise null.
 */
function appRelativePath(filePath: string): string | null {
  const norm = filePath.replace(/\\/g, "/");
  for (const root of ["app/", "src/app/"]) {
    const idx = norm.indexOf("/" + root);
    if (idx >= 0) return norm.slice(idx + root.length + 1);
    if (norm.startsWith(root)) return norm.slice(root.length);
  }
  return null;
}

/**
 * Convert an app-relative file path to a Next.js URL route.
 * Examples:
 *   "users/[id]/route.ts"               -> "/users/:id"
 *   "users/[id]/page.tsx"               -> "/users/:id"
 *   "(marketing)/about/page.tsx"        -> "/about"        (group ignored)
 *   "blog/[...slug]/page.tsx"           -> "/blog/*slug"
 *   "blog/[[...slug]]/page.tsx"         -> "/blog/*slug?"  (optional catch-all)
 */
function filePathToRoute(appRel: string): string {
  // Strip the trailing route.ts / page.tsx — they don't appear in the URL.
  const dir = path.posix.dirname(appRel);
  if (dir === "." || dir === "") return "/";

  const segments = dir.split("/").flatMap((seg) => {
    // (group) segments are organizational only.
    if (seg.startsWith("(") && seg.endsWith(")")) return [];
    // Optional catch-all: [[...slug]] -> *slug?
    let m = seg.match(/^\[\[\.\.\.(\w+)\]\]$/);
    if (m) return ["*" + m[1] + "?"];
    // Catch-all: [...slug] -> *slug
    m = seg.match(/^\[\.\.\.(\w+)\]$/);
    if (m) return ["*" + m[1]];
    // Dynamic: [id] -> :id
    m = seg.match(/^\[(\w+)\]$/);
    if (m) return [":" + m[1]];
    return [seg];
  });

  return "/" + segments.join("/");
}

function flatMap<T, U>(arr: T[], fn: (t: T) => U[]): U[] {
  const out: U[] = [];
  for (const t of arr) out.push(...fn(t));
  return out;
}

function matchRoute(call: ClientCallNode, routes: RouteNode[]): RouteNode | undefined {
  const exact = routes.find(
    (r) => r.method === call.method && r.path === call.url
  );
  if (exact) return exact;

  return routes.find((r) => {
    if (r.method !== call.method) return false;
    // Accept :param, {param}, *splat in route patterns.
    const pattern = r.path
      .replace(/\*\w+\??/g, ".*")
      .replace(/\{[^}]+\}/g, "[^/]+")
      .replace(/:[A-Za-z_]\w*/g, "[^/]+");
    return new RegExp(`^${pattern}$`).test(call.url);
  });
}
