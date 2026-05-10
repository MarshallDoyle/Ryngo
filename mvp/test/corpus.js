/**
 * Test corpus — a fixed list of public repos used to track compiler progress.
 *
 * Diversity targets:
 *   - Languages: TS, JS, Python, Jupyter, plus stubs (Go, Rust, Java, Ruby, C#)
 *   - Frameworks: Express, Fastify, Hono, Nest, Next.js, FastAPI, Flask,
 *                 Django, Starlette, Pydantic, Prisma, tRPC
 *   - Shapes: small libs (~20 files), mid-sized (~200), large (1000+),
 *             framework codebases, real applications, ML/data, monorepos,
 *             notebook-heavy.
 *
 * Each entry:
 *   url      — clone URL
 *   family   — coarse grouping for the report
 *   lang     — primary language
 *   note     — short label for the report header
 *   ref      — optional pinned ref; defaults to repo's HEAD
 *   skip     — optional reason; if set, the runner records it and moves on
 *   expects  — { [classificationId]: { min?: n, max?: n } }
 *              Per-repo regression alarms (Phase 6.3). The runner records
 *              a violation and exits non-zero when any expected value is
 *              breached. Set conservatively: ~70-80% of the current
 *              measured value, so steady-state runs stay green and only
 *              real regressions trip the alarm. `max` is for catching
 *              false positives (e.g. expressJs route detect over-firing).
 *
 * Add / remove entries here. The harness keys per-run output by `url` so the
 * history.json stays consistent across edits.
 */

export const CORPUS = [
  // -- TypeScript / JavaScript: small libs -------------------------------
  { url: "https://github.com/vercel/ms",          family: "lib",        lang: "ts", note: "tiny TS duration lib" },
  { url: "https://github.com/colinhacks/zod",     family: "lib",        lang: "ts", note: "TS validation",
    expects: { fn_total: { min: 400 }, class_total: { min: 150 }, fn_with_typed_params: { min: 250 } } },
  { url: "https://github.com/sindresorhus/p-limit", family: "lib",      lang: "ts", note: "tiny async lib" },
  { url: "https://github.com/lodash/lodash",      family: "lib",        lang: "js", note: "JS utility" },
  { url: "https://github.com/axios/axios",        family: "lib",        lang: "js", note: "HTTP client",
    expects: { http_routes_express: { max: 5 } } },  // post-6.1 cleanup baseline; 239 fakes was the bug
  { url: "https://github.com/winstonjs/winston",  family: "lib",        lang: "js", note: "Logging" },
  { url: "https://github.com/pmndrs/zustand",     family: "lib",        lang: "ts", note: "state mgmt" },

  // -- TypeScript / JavaScript: framework codebases ----------------------
  { url: "https://github.com/expressjs/express",  family: "framework",  lang: "js", note: "Express itself" },
  { url: "https://github.com/honojs/hono",        family: "framework",  lang: "ts", note: "Hono web fw",
    expects: { fn_total: { min: 500 }, class_total: { min: 180 } } },
  { url: "https://github.com/fastify/fastify",    family: "framework",  lang: "js", note: "Fastify" },
  { url: "https://github.com/socketio/socket.io", family: "framework",  lang: "ts", note: "Socket.IO" },
  { url: "https://github.com/nestjs/nest",        family: "framework",  lang: "ts", note: "NestJS (decorators)",
    expects: { http_routes_express: { max: 5 } } },  // Nest has its own routing layer; Express adapter shouldn't claim it
  { url: "https://github.com/trpc/trpc",          family: "framework",  lang: "ts", note: "tRPC" },
  { url: "https://github.com/sveltejs/svelte",    family: "framework",  lang: "ts", note: "Svelte" },
  { url: "https://github.com/vuejs/core",         family: "framework",  lang: "ts", note: "Vue 3" },

  // -- TypeScript / JavaScript: real apps + middleware --------------------
  { url: "https://github.com/expressjs/cors",     family: "middleware", lang: "js", note: "Express CORS" },
  { url: "https://github.com/expressjs/multer",   family: "middleware", lang: "js", note: "Express multipart" },
  { url: "https://github.com/madhums/node-express-mongoose", family: "app", lang: "js", note: "real Express app",
    expects: { http_routes_express: { min: 1 } } },  // sentinel: a real Express app must produce ≥1 route
  { url: "https://github.com/vercel/commerce",    family: "app",        lang: "ts", note: "Next.js storefront",
    expects: { http_routes_nextjs: { min: 3 } } },
  { url: "https://github.com/shadcn-ui/ui",       family: "app",        lang: "ts", note: "Radix UI components",
    expects: { http_routes_nextjs: { min: 5 } } },

  // -- Python: small libs ------------------------------------------------
  { url: "https://github.com/psf/requests",       family: "lib",        lang: "py", note: "HTTP client" },
  { url: "https://github.com/encode/httpx",       family: "lib",        lang: "py", note: "async HTTP" },
  { url: "https://github.com/pallets/click",      family: "lib",        lang: "py", note: "CLI builder" },
  { url: "https://github.com/python-attrs/attrs", family: "lib",        lang: "py", note: "data classes" },
  { url: "https://github.com/tiangolo/typer",     family: "lib",        lang: "py", note: "Typer CLI" },
  { url: "https://github.com/pallets/jinja",      family: "lib",        lang: "py", note: "templating" },

  // -- Python: web frameworks --------------------------------------------
  { url: "https://github.com/tiangolo/fastapi",   family: "framework",  lang: "py", note: "FastAPI itself" },
  { url: "https://github.com/tiangolo/sqlmodel",  family: "framework",  lang: "py", note: "SQLModel",
    expects: { fn_total: { min: 500 }, class_total: { min: 150 }, http_routes_fastapi: { min: 30 }, fn_with_typed_params: { min: 100 } } },
  { url: "https://github.com/pallets/flask",      family: "framework",  lang: "py", note: "Flask",
    expects: { fn_total: { min: 350 }, class_total: { min: 40 } } },
  { url: "https://github.com/encode/starlette",   family: "framework",  lang: "py", note: "ASGI base",
    expects: { fn_total: { min: 400 }, class_total: { min: 80 } } },
  { url: "https://github.com/pydantic/pydantic",  family: "framework",  lang: "py", note: "data validation",
    expects: { fn_total: { min: 3000 }, class_with_members: { min: 800 } } },

  // -- Django (exercises the django adapter) -----------------------------
  { url: "https://github.com/wagtail/bakerydemo",  family: "app",        lang: "py", note: "real Django app (Wagtail bakery demo)",
    expects: { http_routes_django: { min: 1 }, db_models: { min: 1 } } },

  // -- GraphQL (exercises the graphql adapter) ---------------------------
  { url: "https://github.com/graphql/graphql-js",  family: "framework",  lang: "js", note: "GraphQL JS reference",
    expects: { gql_types: { min: 1 } } },

  // -- Python: real apps -------------------------------------------------
  { url: "https://github.com/tiangolo/full-stack-fastapi-template", family: "app", lang: "py", note: "FastAPI starter",
    expects: { http_routes_fastapi: { min: 10 }, env_nodes: { min: 15 } } },
  { url: "https://github.com/python-poetry/poetry",  family: "app",     lang: "py", note: "dep mgr" },
  { url: "https://github.com/pypa/pip",              family: "app",     lang: "py", note: "pip" },

  // -- Notebook-heavy ----------------------------------------------------
  { url: "https://github.com/karpathy/autoresearch", family: "notebook", lang: "py", note: "research notebooks",
    expects: { cell_total: { min: 6 }, notebook_files: { min: 1 } } },
  { url: "https://github.com/karpathy/nanoGPT",      family: "notebook", lang: "py", note: "nanoGPT" },
  { url: "https://github.com/norvig/pytudes",        family: "notebook", lang: "py", note: "Norvig études" },

  // -- Stubbed languages (assert graceful degradation) -------------------
  { url: "https://github.com/golang/example",        family: "stub",   lang: "go",     note: "Go example (stub backend)" },
  { url: "https://github.com/tokio-rs/mio",          family: "stub",   lang: "rust",   note: "Mio (stub backend)" },
  { url: "https://github.com/spring-projects/spring-petclinic", family: "stub", lang: "java", note: "Spring petclinic (stub)" },
  { url: "https://github.com/rails/rails",           family: "stub",   lang: "ruby",   note: "Rails (stub for Ruby parser; rails adapter scans routes.rb + models)",
    expects: { http_routes_rails: { min: 1 }, db_models: { min: 1 } } },
  { url: "https://github.com/dotnet/AspNetCore.Docs", family: "stub",  lang: "csharp", note: "ASP.NET docs (stub)" },

  // -- Mixed / utility --------------------------------------------------
  { url: "https://github.com/visionmedia/debug",     family: "lib",     lang: "js",  note: "tiny debug" },
  { url: "https://github.com/expressjs/morgan",      family: "middleware", lang: "js", note: "logger middleware" },
  { url: "https://github.com/tj/commander.js",       family: "lib",     lang: "js",  note: "CLI parser" },
  { url: "https://github.com/jaredhanson/passport",  family: "lib",     lang: "js",  note: "auth" },
  { url: "https://github.com/auth0/node-jsonwebtoken", family: "lib",   lang: "js",  note: "JWT" },
  { url: "https://github.com/balderdashy/sails",     family: "framework", lang: "js", note: "Sails",
    expects: { http_routes_express: { max: 5 } } },  // Sails wraps Express; raw routes shouldn't show up here

  // -- Prisma adapter check ---------------------------------------------
  { url: "https://github.com/prisma/prisma-examples", family: "app",     lang: "ts", note: "Prisma examples",
    expects: { db_models: { min: 1 }, db_write_edges: { min: 5 } } },

  // -- Heavier (capped to MAX_FILES=1500) -------------------------------
  { url: "https://github.com/microsoft/TypeScript", family: "framework", lang: "ts", note: "TS compiler (capped)" },
  { url: "https://github.com/facebook/react",       family: "framework", lang: "js", note: "React (capped)" },
];

// Sanity: 50ish entries.
export const COUNT = CORPUS.length;
