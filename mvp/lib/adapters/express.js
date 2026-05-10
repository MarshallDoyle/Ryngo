/**
 * Express adapter — emits `http-route` nodes per `app.METHOD(path, handler)`
 * site, plus `defines-route` edges from the file to the route.
 *
 * Detection (Phase 6.1, tightened — three precision gates):
 *   1. Project gate: the repo contains at least one file that imports the
 *      `express` package. Decided once in `detect()`.
 *   2. File gate: the file either
 *        a) imports express itself with bindings used as a callable
 *           (`const app = express()` / `const router = Router()`), OR
 *        b) exports a function whose parameter list contains a name from
 *           {app, router, Router} — the middleware-style "routes file"
 *           pattern where `server.js` does `require('./routes')(app)`.
 *   3. Path gate: the route path string MUST start with `/`. Drops the
 *      whole class of `cache.get('key')` / `xhr.use('header')` false
 *      positives that plagued the looser baseline.
 *
 * Plus: we deliberately drop `use` from the HTTP-method list. `app.use()`
 * mounts middleware, not routes, and its first argument is rarely a route
 * path — keeping it in the regex was the single biggest noise source.
 *
 * Baseline impact: corpus-wide Express routes 583 → ~30 (real routes),
 * axios 239 → 0, socket.io 44 → ~0–1, nestjs 25 → 0, while preserving
 * the legit routes in real Express apps.
 *
 * What we deliberately still don't catch:
 *   - Method routing via dynamic dispatch (`app[method](path, fn)`).
 *   - Routes added on chained builders (`builder.route('/x').get(fn)`).
 *   These need real AST analysis; out of scope for the regex floor.
 */

// `use` and `all` removed — `use` mounts middleware (not a route),
// `all` matches any method but rarely takes a path-prefix string.
const HTTP_METHODS = [
  "get", "post", "put", "patch", "delete", "head", "options",
];

// Router subject names accepted when injected as function parameters.
const ROUTER_PARAM_NAMES = new Set(["app", "router", "Router"]);

export default {
  name: "express",
  apiVersion: 1,

  async detect(ctx) {
    // Project gate: the repo imports express *somewhere*. Cheap signal —
    // axios, socket.io, etc. don't actually depend on express in their
    // shipped code, so they fail this gate.
    for (const { parsed } of ctx.parsedFiles) {
      if (parsed.lang !== "ts") continue;
      for (const imp of parsed.imports || []) {
        if (imp.spec === "express" || imp.spec.startsWith("express/")) {
          return true;
        }
      }
    }
    return false;
  },

  async analyzeFile(pf, ctx) {
    if (pf.parsed.lang !== "ts") return null;
    const fileId = ctx.fileIndex.get(pf.relPath);
    if (!fileId) return null;

    const text = await ctx.readFile(pf.relPath);
    if (!text) return null;

    // File gate (a): file imports express directly + has app/router locals.
    const expressBindings = collectExpressBindings(pf.parsed.imports);
    const localRouters = expressBindings.size
      ? collectExpressApps(text, expressBindings)
      : new Set();

    // File gate (b): the "routes file" pattern — a file exporting a
    // function that takes app / router / Router as a parameter, e.g.
    //   module.exports = function(app, passport) { app.get('/', …) }
    // OR
    //   export default function routes(app) { app.get(...) }
    const injectedRouters = collectInjectedRouterParams(text);

    const validRouters = new Set([...localRouters, ...injectedRouters]);
    if (validRouters.size === 0) return null;

    const nodes = [];
    const edges = [];
    const effects = [];

    const routeRe = new RegExp(
      `\\b(\\w+)\\.(${HTTP_METHODS.join("|")})\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`,
      "g",
    );
    let m;
    while ((m = routeRe.exec(text)) !== null) {
      const subject = m[1];
      if (!validRouters.has(subject)) continue;
      const routePath = m[3];
      // Path gate: real Express routes always start with `/`. Kills
      // `cache.get('key')` / `obj.post('event')` style noise.
      if (!routePath.startsWith("/")) continue;
      const method = m[2].toUpperCase();
      const line = lineOf(text, m.index);
      const id = `route:${pf.relPath}#${method}:${routePath}`;
      nodes.push({
        id,
        kind: "http-route",
        label: `${method} ${routePath}`,
        parentId: fileId,
        data: {
          method,
          path: routePath,
          file: pf.relPath,
          line,
          framework: "express",
          owner: subject,
        },
      });
      effects.push({ ownerId: fileId, sink: "network" });
      effects.push({ ownerId: id, sink: "network" });
      edges.push({
        source: fileId,
        target: id,
        kind: "defines-route",
        resolution: "scip-precise",
      });
    }

    if (nodes.length === 0) return null;
    return { nodes, edges, effects };
  },
};

/**
 * Walk a file's import list and return the set of local names that came
 * from the `express` package — namely the default-import name (e.g. `express`),
 * any namespace alias, and named imports (like `Router`, `Request`, etc.).
 */
function collectExpressBindings(imports) {
  const bindings = new Set();
  for (const imp of imports || []) {
    const isExpress =
      imp.spec === "express" || imp.spec.startsWith("express/");
    if (!isExpress) continue;
    for (const local of Object.keys(imp.bindings || {})) {
      bindings.add(local);
    }
  }
  return bindings;
}

/**
 * Find local variables in the file that hold an Express app or router.
 *
 * Catches the four common patterns:
 *   const app    = express()
 *   const app    = express()           (any binding name)
 *   const router = express.Router()
 *   const router = Router()            (when Router is named-imported)
 *   const app    = SomeFn()            ← intentionally NOT caught — too vague
 *
 * Also handles `app = express()` (re-assignment) and `let/var` for completeness.
 */
function collectExpressApps(text, expressBindings) {
  const out = new Set();
  // Lookbehind excludes member access (`obj.app = …`) and chained ids
  // (`fooapp = …` shouldn't be split as `app`). Otherwise this matches
  // any assignment shape: `var X = …`, `, Y = …`, bare `app = …`, etc.
  const re1 = /(?<![.\w$])(\w+)\s*=\s*(\w+)\s*\(/g;
  let m;
  while ((m = re1.exec(text)) !== null) {
    if (expressBindings.has(m[2])) out.add(m[1]);
  }

  const re2 = /(?<![.\w$])(\w+)\s*=\s*(\w+)\.Router\s*\(/g;
  while ((m = re2.exec(text)) !== null) {
    if (expressBindings.has(m[2])) out.add(m[1]);
  }

  if (expressBindings.has("Router")) {
    const re3 = /(?<![.\w$])(\w+)\s*=\s*Router\s*\(/g;
    while ((m = re3.exec(text)) !== null) out.add(m[1]);
  }

  // The express binding itself can be the app (rare but valid):
  //   import app from 'express';   app.get(...)
  // We still allow this — if `expressBindings` says `app`, we trust it.
  for (const b of expressBindings) {
    if (b === "express" || b === "Router") continue; // skip module-level names
    out.add(b);
  }

  return out;
}

/**
 * Identify function-parameter names that look like injected Express
 * apps / routers. Catches the "routes file" pattern where the routing
 * subject is passed in by the file that owns the express() instance:
 *
 *   module.exports = function(app, passport) { app.get('/', …) }
 *   module.exports = (app) => { app.get('/', …) }
 *   export default function routes(app) { app.get('/', …) }
 *   export const wire = (router) => router.get('/', …)
 *
 * We only count parameters whose name is in ROUTER_PARAM_NAMES. That's
 * the convention; anything else would be a file-local naming choice we
 * can't guess.
 */
function collectInjectedRouterParams(text) {
  const out = new Set();
  // Function declarations + expressions: `function(...)` / `function name(...)`
  const fnRe = /\bfunction\s*(?:\w+\s*)?\(([^)]*)\)/g;
  // Arrow functions with parens: `(...)=>` (one or more params)
  const arrowRe = /(?<![=<])\(([^)]*)\)\s*=>/g;
  // Single-param arrow without parens: `app =>` (also covered when it
  // comes after a paren we already process; this regex catches the bare
  // form `app => { ... }`).
  const singleArrowRe = /(?:^|[^.\w$])(\w+)\s*=>/g;

  let m;
  while ((m = fnRe.exec(text)) !== null) collectParamNames(m[1], out);
  while ((m = arrowRe.exec(text)) !== null) collectParamNames(m[1], out);
  while ((m = singleArrowRe.exec(text)) !== null) {
    const n = m[1];
    if (ROUTER_PARAM_NAMES.has(n)) out.add(n);
  }
  return out;
}

function collectParamNames(paramText, out) {
  if (!paramText) return;
  for (const raw of paramText.split(",")) {
    const t = raw.trim().split(/[:=\s]/)[0]; // strip type / default
    const clean = t.replace(/^\.\.\./, "");
    if (ROUTER_PARAM_NAMES.has(clean)) out.add(clean);
  }
}

function lineOf(src, charIndex) {
  let line = 1;
  for (let i = 0; i < charIndex; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}
