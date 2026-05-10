/**
 * Rails adapter — emits `http-route` nodes from `config/routes.rb` files
 * and `db-model` nodes from ActiveRecord-style class declarations.
 *
 * Detection: any `Gemfile` or `config/routes.rb` exists. Rails repos
 * land in the corpus today as the "ruby" stub language (no parser
 * yet) but the URL conf + model files are scannable as text via
 * `scanUnparsed`.
 *
 * Extracted today:
 *   - routes.rb resource declarations:
 *       get 'signup', to: 'users#new'
 *       post '/login' => 'sessions#create'
 *       resources :books              (→ 7 RESTful routes)
 *       resource  :session            (→ 6 routes, no index)
 *   - models that subclass ApplicationRecord, ActiveRecord::Base, or
 *     a base name containing "Record".
 */

const RESTFUL_RESOURCES = [
  { method: "GET",    suffix: "" },             // index
  { method: "GET",    suffix: "/new" },         // new
  { method: "POST",   suffix: "" },             // create
  { method: "GET",    suffix: "/:id" },         // show
  { method: "GET",    suffix: "/:id/edit" },    // edit
  { method: "PATCH",  suffix: "/:id" },         // update
  { method: "DELETE", suffix: "/:id" },         // destroy
];
const RESTFUL_SINGLE = [
  { method: "GET",    suffix: "/new" },
  { method: "POST",   suffix: "" },
  { method: "GET",    suffix: "" },
  { method: "GET",    suffix: "/edit" },
  { method: "PATCH",  suffix: "" },
  { method: "DELETE", suffix: "" },
];

export default {
  name: "rails",
  apiVersion: 1,

  scanUnparsed(relPath) {
    if (relPath === "Gemfile" || relPath.endsWith("/Gemfile")) return true;
    if (relPath.endsWith("config/routes.rb") || relPath === "config/routes.rb") return true;
    if (relPath.endsWith(".rb")) return true;
    return false;
  },

  async detect(ctx) {
    for (const { relPath } of ctx.allFiles || []) {
      if (
        relPath === "Gemfile" ||
        relPath.endsWith("/Gemfile") ||
        relPath.endsWith("config/routes.rb")
      ) {
        return true;
      }
    }
    return false;
  },

  async analyzeFile(pf, ctx) {
    const fileId = ctx.fileIndex.get(pf.relPath);
    if (!fileId) return null;
    if (!pf.relPath.endsWith(".rb")) return null;
    const text = await ctx.readFile(pf.relPath);
    if (!text) return null;

    const isRoutes =
      pf.relPath === "config/routes.rb" || pf.relPath.endsWith("/config/routes.rb");
    const looksLikeModel = /(?:^|\/)app\/models\//.test(pf.relPath) ||
      /\bclass\s+\w+\s*<\s*(?:ApplicationRecord|ActiveRecord::Base)/.test(text);

    const nodes = [];
    const edges = [];
    const effects = [];

    if (isRoutes) {
      collectRoutesRb(text, pf, fileId, nodes, edges, effects);
    }
    if (looksLikeModel) {
      collectModelsRb(text, pf, fileId, nodes, edges);
    }

    if (nodes.length === 0 && edges.length === 0) return null;
    return { nodes, edges, effects };
  },
};

function collectRoutesRb(text, pf, fileId, nodes, edges, effects) {
  const pushRoute = (method, routePath, line) => {
    if (!routePath.startsWith("/")) routePath = "/" + routePath;
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
        framework: "rails",
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
  };

  // get 'signup', to: 'users#new'  /  post '/login' => 'sessions#create'  /  match '/foo', via: :all
  const verbRe = /(?:^|\n)\s*(get|post|put|patch|delete|head|options|match)\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = verbRe.exec(text)) !== null) {
    const method = m[1].toUpperCase();
    pushRoute(method === "MATCH" ? "ANY" : method, m[2], lineOf(text, m.index));
  }

  // resources :books, only: [...]  /  resources :books
  // Conservative: emit the 7 RESTful routes, prefixed by the resource name.
  const resourcesRe = /(?:^|\n)\s*resources?\s+:(\w+)/g;
  while ((m = resourcesRe.exec(text)) !== null) {
    const name = m[1];
    const isSingle = m[0].trim().startsWith("resource ");
    const set = isSingle ? RESTFUL_SINGLE : RESTFUL_RESOURCES;
    const base = `/${name}`;
    const line = lineOf(text, m.index);
    for (const r of set) {
      pushRoute(r.method, base + r.suffix, line);
    }
  }
}

function collectModelsRb(text, pf, fileId, nodes, edges) {
  const re = /(?:^|\n)class\s+(\w+)(?:\s*<\s*([^\n]+))?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const base = (m[2] || "").trim();
    if (!isActiveRecordBase(base, pf.relPath)) continue;
    const id = `db-model:${name}`;
    const line = lineOf(text, m.index);
    nodes.push({
      id,
      kind: "db-model",
      label: name,
      parentId: fileId,
      data: { name, file: pf.relPath, line, framework: "rails" },
    });
    edges.push({
      source: `def:${pf.relPath}#${name}`,
      target: id,
      kind: "defines-model",
      resolution: "scip-precise",
    });
  }
}

function isActiveRecordBase(base, relPath) {
  if (!base && /(?:^|\/)app\/models\//.test(relPath)) return true; // bare class in app/models/ is implicit AR
  return /(?:^|\b)(?:ApplicationRecord|ActiveRecord::Base|ActiveRecord::Migration|.*Record)\b/.test(base);
}

function lineOf(src, charIndex) {
  let line = 1;
  for (let i = 0; i < charIndex; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}
