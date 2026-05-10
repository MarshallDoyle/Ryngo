/**
 * Stack-layer classifier (Phase 4.4 Slice B).
 *
 * Classifies every file in an IR into one of six stack layers so the
 * macro view can group them under FE / BE / Data / Infra / Tests /
 * Config super-nodes. Pure function; no parser or adapter changes
 * required — this just reads what the IR already exposes.
 *
 * Heuristic precedence (first match wins):
 *   1. **Adapter signals** — file is the parent of an `http-route` →
 *      backend; parent of a `db-model` → data. Highest confidence.
 *   2. **Path patterns** — `infra/`, `tests/`, `pages/`, `app/`,
 *      `server/`, `api/`, `models/`, `prisma/`, etc. The user's repo
 *      structure usually tells us before any imports do.
 *   3. **Imports** — package edges that strongly imply a layer
 *      (`react/vue/svelte` → frontend; `express/fastapi/django` →
 *      backend; `@prisma/client/sequelize/sqlalchemy` → data).
 *   4. **File extension** — final fallback.
 *
 * Layers:
 *   - frontend, backend, data, infra, tests, config, other
 *
 * Returned shape:
 *   {
 *     byFile: Map<fileId, layerName>,
 *     layers: { [layerName]: { files: fileId[], routes, dbModels, env, ... } },
 *     totalFiles: number,
 *     dominantLayer: layerName | null   // when one layer is >90% of files,
 *                                       // useful as a "fall back to file view" hint
 *   }
 */

export const LAYER_ORDER = [
  "frontend",
  "backend",
  "data",
  "infra",
  "tests",
  "config",
  "other",
];

export const LAYER_LABEL = {
  frontend: "Frontend",
  backend: "Backend",
  data: "Data",
  infra: "Infra",
  tests: "Tests",
  config: "Config",
  other: "Other",
};

const FE_PACKAGES = new Set([
  "react", "react-dom", "vue", "@vue/runtime-core", "@vue/runtime-dom",
  "svelte", "next", "preact", "solid-js", "@angular/core", "lit",
  "@remix-run/react", "@nuxt/core", "astro", "@stencil/core",
]);

const BE_PACKAGES = new Set([
  "express", "fastify", "koa", "hono", "@nestjs/core", "@nestjs/common",
  "fastapi", "starlette", "flask", "django", "sanic", "tornado",
  "aiohttp", "bottle", "uvicorn", "gunicorn", "hypercorn",
  "@hapi/hapi", "restify", "sails", "loopback", "feathers",
]);

const DATA_PACKAGES = new Set([
  "@prisma/client", "prisma", "mongoose", "sequelize", "typeorm",
  "drizzle-orm", "kysely", "knex", "objection", "mongodb", "redis",
  "ioredis", "pg", "mysql2", "better-sqlite3", "sqlite3",
  "sqlalchemy", "alembic", "peewee", "tortoise-orm", "asyncpg",
  "psycopg2", "pymongo", "elasticsearch", "@elastic/elasticsearch",
]);

// Path tokens checked as substrings of the relative path. Order matters
// inside each layer — more specific tokens listed first.
const PATH_RULES = [
  // Infra (highest specificity)
  ["infra", ["/infra/", "infrastructure/", "/terraform/", "/k8s/", "/kubernetes/", "/.github/workflows/", "/helm/"]],
  ["infra", ["dockerfile", "docker-compose", ".dockerignore"]],

  // Tests — must come before frontend/backend so a backend test isn't
  // misclassified as backend.
  ["tests", ["/__tests__/", "/tests/", "/test/", ".test.", ".spec.", "/cypress/", "/playwright/", "/e2e/"]],

  // Data
  ["data", ["/prisma/", "/migrations/", "/schemas/", "/schema/", "/models/", "/db/", "/database/"]],

  // Backend
  ["backend", ["/server/", "/api/", "/apps/api/", "/backend/", "/services/", "/handlers/", "/routes/", "/controllers/", "/middleware/", "/middlewares/"]],

  // Frontend
  ["frontend", ["/pages/", "/app/", "/components/", "/views/", "/screens/", "/widgets/", "/client/", "/web/", "/frontend/", "/src/web/"]],
];

const FE_EXTENSIONS = new Set([".jsx", ".tsx", ".vue", ".svelte", ".html", ".css", ".scss", ".sass", ".less"]);
const CONFIG_EXTENSIONS = new Set([".json", ".yml", ".yaml", ".toml", ".lock", ".xml", ".ini", ".env", ".cfg"]);
const INFRA_EXTENSIONS = new Set([".tf", ".tfvars", ".hcl"]);

export function classifyFiles(ir) {
  if (!ir || !Array.isArray(ir.nodes)) {
    return emptyClassification();
  }

  // -- Pre-index ----------------------------------------------------------
  const fileNodes = ir.nodes.filter((n) => n.kind === "file");
  const importsByFile = new Map(); // fileId → Set<pkgName>
  for (const e of ir.edges || []) {
    if (e.kind !== "imports-package") continue;
    if (!e.source.startsWith("file:") && !e.source.startsWith("cell:")) continue;
    const ownerFile = e.source.startsWith("cell:")
      ? `file:${e.source.replace(/^cell:/, "").split("#")[0]}`
      : e.source;
    if (!importsByFile.has(ownerFile)) importsByFile.set(ownerFile, new Set());
    importsByFile.get(ownerFile).add(e.target.replace(/^pkg:/, ""));
  }

  // Files that emit adapter outputs — strongest signal.
  const fileEmitsRoute = new Set();
  const fileEmitsDbModel = new Set();
  const fileEmitsEnv = new Set();
  for (const n of ir.nodes) {
    if (n.kind === "http-route" && n.parentId) fileEmitsRoute.add(n.parentId);
    if (n.kind === "db-model" && n.parentId) fileEmitsDbModel.add(n.parentId);
  }
  for (const e of ir.edges || []) {
    if (e.kind === "env-read" && e.source.startsWith("file:")) {
      fileEmitsEnv.add(e.source);
    }
  }

  // -- Classify -----------------------------------------------------------
  const byFile = new Map();
  for (const f of fileNodes) {
    byFile.set(f.id, classifyOneFile(f, importsByFile, fileEmitsRoute, fileEmitsDbModel));
  }

  // -- Bucket + per-layer stats -------------------------------------------
  const layers = {};
  for (const layer of LAYER_ORDER) {
    layers[layer] = {
      files: [],
      routes: 0,
      dbModels: 0,
      envReads: 0,
      defs: 0,
      cells: 0,
    };
  }
  for (const f of fileNodes) {
    const layer = byFile.get(f.id);
    layers[layer].files.push(f.id);
  }

  // Stats: walk other node kinds, attribute to their parent file's layer.
  for (const n of ir.nodes) {
    if (n.kind === "http-route" && n.parentId) {
      const layer = byFile.get(n.parentId);
      if (layer) layers[layer].routes++;
    } else if (n.kind === "db-model" && n.parentId) {
      const layer = byFile.get(n.parentId);
      if (layer) layers[layer].dbModels++;
    } else if (
      (n.kind === "function" || n.kind === "class") &&
      n.parentId
    ) {
      const layer = byFile.get(n.parentId);
      if (layer) layers[layer].defs++;
    } else if (n.kind === "cell" && n.parentId) {
      const layer = byFile.get(n.parentId);
      if (layer) layers[layer].cells++;
    }
  }
  for (const id of fileEmitsEnv) {
    const layer = byFile.get(id);
    if (layer) layers[layer].envReads++;
  }

  // -- Dominant-layer detection (>= 90% of files in one layer) ------------
  let dominantLayer = null;
  if (fileNodes.length > 0) {
    let max = 0;
    let maxLayer = null;
    for (const layer of LAYER_ORDER) {
      if (layers[layer].files.length > max) {
        max = layers[layer].files.length;
        maxLayer = layer;
      }
    }
    if (max / fileNodes.length >= 0.9 && maxLayer && maxLayer !== "other") {
      dominantLayer = maxLayer;
    }
  }

  return {
    byFile,
    layers,
    totalFiles: fileNodes.length,
    dominantLayer,
  };
}

function classifyOneFile(file, importsByFile, fileEmitsRoute, fileEmitsDbModel) {
  // 1. Adapter signals — strongest.
  if (fileEmitsRoute.has(file.id)) return "backend";
  if (fileEmitsDbModel.has(file.id)) return "data";

  const path = (file.data?.path || "").toLowerCase();
  const ext = (file.data?.ext || "").toLowerCase();

  // 2. Path-based rules.
  for (const [layer, tokens] of PATH_RULES) {
    for (const t of tokens) {
      if (path.includes(t)) return layer;
    }
  }

  // 3. Import-based.
  const imports = importsByFile.get(file.id) || new Set();
  for (const imp of imports) {
    if (FE_PACKAGES.has(imp)) return "frontend";
    if (BE_PACKAGES.has(imp)) return "backend";
    if (DATA_PACKAGES.has(imp)) return "data";
    // Match scoped framework variants (`@prisma/*`, `@nestjs/*`, etc.)
    if (imp.startsWith("@prisma/") || imp.startsWith("@nestjs/")) {
      return imp.startsWith("@prisma/") ? "data" : "backend";
    }
    if (imp.startsWith("@vue/") || imp.startsWith("@angular/")) {
      return "frontend";
    }
  }

  // 4. Extension fallbacks.
  if (FE_EXTENSIONS.has(ext)) return "frontend";
  if (INFRA_EXTENSIONS.has(ext)) return "infra";
  if (CONFIG_EXTENSIONS.has(ext)) return "config";

  // 5. Source-file extensions without an obvious layer → backend by
  //    default (it's the most common landing for "code that runs").
  //    Notebooks default to "other" since they cross axes.
  if (ext === ".py" || ext === ".go" || ext === ".rs" || ext === ".java"
    || ext === ".rb" || ext === ".cs" || ext === ".php" || ext === ".kt"
    || ext === ".swift" || ext === ".cpp" || ext === ".c") {
    return "backend";
  }
  if (ext === ".ts" || ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    return "backend";
  }

  return "other";
}

function emptyClassification() {
  const layers = {};
  for (const layer of LAYER_ORDER) {
    layers[layer] = { files: [], routes: 0, dbModels: 0, envReads: 0, defs: 0, cells: 0 };
  }
  return { byFile: new Map(), layers, totalFiles: 0, dominantLayer: null };
}
