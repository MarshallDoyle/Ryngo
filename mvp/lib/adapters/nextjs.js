/**
 * Next.js adapter — emits `http-route` nodes for App Router (route.ts /
 * page.tsx) and Pages Router (pages/api/*.ts) files.
 *
 * Detection: a `next.config.js`/`next.config.mjs`/`next.config.ts` at the
 * repo root, OR an `app/` directory with `route.ts` files, OR a `pages/api/`
 * directory.
 */

const APP_ROUTE_FILE = /(?:^|\/)app\/.*\/route\.(?:ts|tsx|js|jsx|mjs)$/;
const APP_PAGE_FILE = /(?:^|\/)app\/.*\/page\.(?:tsx?|jsx?)$/;
const PAGES_API_FILE = /(?:^|\/)pages\/api\/.*\.(?:ts|tsx|js|jsx|mjs)$/;

const APP_ROUTE_METHODS = [
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
];

export default {
  name: "nextjs",
  apiVersion: 1,

  async detect(ctx) {
    // Heuristic 1: any next.config.*
    for (const { relPath } of ctx.parsedFiles) {
      if (/^next\.config\.(?:js|mjs|cjs|ts)$/.test(relPath)) return true;
    }
    // Heuristic 2: Next-shaped paths
    for (const { relPath } of ctx.parsedFiles) {
      if (
        APP_ROUTE_FILE.test(relPath) ||
        APP_PAGE_FILE.test(relPath) ||
        PAGES_API_FILE.test(relPath)
      ) {
        return true;
      }
    }
    return false;
  },

  async analyzeFile(pf, ctx) {
    const fileId = ctx.fileIndex.get(pf.relPath);
    if (!fileId) return null;
    const nodes = [];
    const edges = [];
    const effects = [];

    if (APP_ROUTE_FILE.test(pf.relPath)) {
      // App Router: each exported HTTP-method-named function = one route.
      const text = await ctx.readFile(pf.relPath);
      if (!text) return null;
      const segPath = pathFromAppRoute(pf.relPath);
      for (const method of APP_ROUTE_METHODS) {
        const re = new RegExp(
          `\\bexport\\s+(?:async\\s+)?function\\s+${method}\\s*\\(`,
        );
        if (re.test(text)) {
          const id = `route:${pf.relPath}#${method}:${segPath}`;
          nodes.push({
            id,
            kind: "http-route",
            label: `${method} ${segPath}`,
            parentId: fileId,
            data: {
              method,
              path: segPath,
              file: pf.relPath,
              framework: "nextjs-app",
            },
          });
          effects.push({ ownerId: id, sink: "network" });
          edges.push({
            source: fileId,
            target: id,
            kind: "defines-route",
            resolution: "scip-precise",
          });
        }
      }
    } else if (APP_PAGE_FILE.test(pf.relPath)) {
      const segPath = pathFromAppRoute(pf.relPath);
      const id = `route:${pf.relPath}#GET:${segPath}`;
      nodes.push({
        id,
        kind: "http-route",
        label: `PAGE ${segPath}`,
        parentId: fileId,
        data: {
          method: "GET",
          path: segPath,
          file: pf.relPath,
          framework: "nextjs-app",
          isPage: true,
        },
      });
      effects.push({ ownerId: id, sink: "network" });
      edges.push({
        source: fileId,
        target: id,
        kind: "defines-route",
        resolution: "scip-precise",
      });
    } else if (PAGES_API_FILE.test(pf.relPath)) {
      const segPath = pathFromPagesApi(pf.relPath);
      const id = `route:${pf.relPath}#ANY:${segPath}`;
      nodes.push({
        id,
        kind: "http-route",
        label: `ANY ${segPath}`,
        parentId: fileId,
        data: {
          method: "ANY",
          path: segPath,
          file: pf.relPath,
          framework: "nextjs-pages",
        },
      });
      effects.push({ ownerId: id, sink: "network" });
      edges.push({
        source: fileId,
        target: id,
        kind: "defines-route",
        resolution: "scip-precise",
      });
    }

    return { nodes, edges, effects };
  },
};

function pathFromAppRoute(rel) {
  const m = rel.match(/(?:^|\/)app\/(.*)\/(route|page)\.[^.]+$/);
  if (!m) return "/";
  const segs = m[1]
    .split("/")
    .filter(Boolean)
    .map((s) => s.replace(/^\((.*)\)$/, "")) // route groups: (auth) → ''
    .filter(Boolean)
    .map((s) => s.replace(/^\[(\.\.\.)?(\w+)\]$/, ":$2")); // [id] → :id
  return "/" + segs.join("/");
}

function pathFromPagesApi(rel) {
  const m = rel.match(/(?:^|\/)pages\/api\/(.*)\.[^.]+$/);
  if (!m) return "/";
  const segs = m[1]
    .split("/")
    .filter(Boolean)
    .map((s) => s.replace(/^\[(\.\.\.)?(\w+)\]$/, ":$2"))
    .filter((s) => s !== "index");
  return "/api/" + segs.join("/");
}
