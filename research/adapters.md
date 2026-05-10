# codegraph — Framework Adapter Catalog

Status: research / planning
Audience: codegraph core contributors
Scope: deterministic, no-LLM, static-analysis only. Every adapter listed here must be implementable without runtime execution, without remote calls, and without ML.

---

## 0. Framing

### 0.1 What an adapter is

A codegraph **adapter** is a stage that runs after the language indexers have produced a per-file symbol graph. Its job is to recognize a *framework pattern* and emit additional **typed IR nodes and edges** that the language indexer cannot infer on its own.

Concretely, an adapter:

1. **Detects** that the framework is in use in this repo or this subtree (lockfile entry, import pattern, config file present, file naming convention).
2. **Walks** a small, well-defined set of AST shapes (decorators, calls to specific identifiers, exported config objects, JSX literals, file-system routes, schema files).
3. **Emits** IR nodes (e.g. `HttpRoute`, `DbTable`, `DbColumn`, `Queue`, `EnvVar`, `IacResource`) and IR edges (`route_handler`, `reads_table`, `writes_table`, `fetches`, `consumes_queue`, `reads_env`, `provisions`).
4. **Records provenance**: every node/edge carries a (file, byte-range, adapter-id, confidence) tuple so the viewer can show "this edge exists because line 47 of api.ts called `fetch('/users')` and `apps/api/src/routes/users.ts` registered `app.get('/users', …)`".

Adapters never modify symbol-graph nodes; they only *augment* the graph. This keeps the language layer dumb and the framework layer composable.

### 0.2 IR vocabulary used in this doc

Node kinds referenced below:

- `HttpRoute { method, path_template, handler_symbol, service }`
- `HttpClientCall { method, url_template, call_site, service }`
- `RpcEndpoint { kind: trpc|grpc|graphql, name, schema_ref }`
- `RpcClientCall { kind, name, call_site }`
- `DbModel { name, source_file, dialect_hint }`
- `DbColumn { model, name, type, nullable }`
- `DbQuery { kind: read|write|migrate, model_ref, call_site }`
- `Queue { name, transport: bullmq|sqs|sns|celery|sidekiq }`
- `QueueProducer { queue_ref, call_site }`
- `QueueConsumer { queue_ref, handler_symbol }`
- `EnvVar { name, default?, type_hint?, source: dotenv|process|schema }`
- `EnvRead { var_ref, call_site }`
- `IacResource { provider, type, logical_name, attributes_subset }`
- `Service { name, kind: web|worker|frontend|infra, root_dir }`

Edge kinds:

- `route_handler` — `HttpRoute → Symbol`
- `fetches` — `HttpClientCall → HttpRoute` (the cross-service edge that justifies the whole project)
- `reads_table` / `writes_table` — `Symbol → DbModel`
- `migrates_table` — `Symbol → DbModel`
- `consumes_queue` / `produces_queue` — `Symbol → Queue`
- `reads_env` — `Symbol → EnvVar`
- `provisions` — `IacResource → IacResource` (intra-IaC)
- `runtime_uses` — `Service → IacResource` (e.g. Lambda function uses an SQS queue)

Path templates (`/users/:id`, `/users/{id}`, `/users/<int:id>`) are normalized to a canonical form (`/users/{param}`) so client and server can be matched even when their syntax differs.

### 0.3 Confidence levels

Adapters tag every emitted edge with one of:

- **exact**: AST-resolvable with no ambiguity (literal string, decorator with literal arg).
- **inferred**: required minor constant-propagation, template-literal join, or single-level alias resolution.
- **heuristic**: pattern match that can plausibly be wrong (regex over a string, fuzzy path join, env-var-derived URL).

The viewer uses confidence to render edges differently (solid / dashed / dotted) and to gate Action's automatic refactors (only `exact` and `inferred` allowed by default).

### 0.4 The "5x harder than it looks" honesty filter

Every adapter section includes a **Reality check** subsection that calls out where the naive description is misleading. Common traps:

- Dynamic route registration (`for (const r of routes) app.get(r.path, r.fn)`).
- Decorators that wrap or replace the handler (so the handler symbol the route points at is no longer the original function).
- Config objects assembled across files (Express `Router` mounted under a prefix that lives in another file; FastAPI `APIRouter(prefix=…)` chained at include time).
- ORM column types defined via a decorator factory whose arguments are themselves expressions.
- Env access through a wrapper module (`config.DATABASE_URL`) where the wrapper itself is the only `process.env` reader.
- Polyglot monorepos where an adapter has to coordinate with another adapter to emit the cross-service edge (the *whole point* of the tool).

If we don't acknowledge these, we'll ship demos that work and a tool that doesn't.

---

## 1. Roadmap (TL;DR)

### P0 — ship with MVP

The MVP must demonstrate the *one thing* codegraph does that a language server doesn't: **cross-file, cross-service IR edges**. Without these, codegraph is a worse `tree-sitter`. The minimum set that produces a believable cross-service graph on a typical TS+Python+Postgres SaaS repo:

| # | Adapter | Why it's P0 |
|---|---------|-------------|
| 1 | **Express** (Node) | The single most common JS HTTP server. Demo currency. |
| 2 | **Fastify** (Node) | Modern Node default; schema-first so cleaner IR than Express. |
| 3 | **FastAPI** (Python) | Modern Python default; decorators are AST-trivial. |
| 4 | **Flask** (Python) | Long-tail Python apps; small adapter, big coverage. |
| 5 | **Next.js** (App + Pages router) | Where 60% of frontend repos live; emits both routes and fetch sites. |
| 6 | **React Router** (data router v6.4+) | Covers the non-Next React universe. |
| 7 | **Prisma** | Schema file is a gift; ORM that costs us nothing to support well. |
| 8 | **Drizzle** | Schema-as-code, TypeScript-native, growing fast. |
| 9 | **SQLAlchemy** (declarative + 2.0 typed) | The Python ORM. |
| 10 | **Django ORM + Django views/urls** | Bundled because Django apps are inseparable. |
| 11 | **Env adapter** (dotenv + `process.env` + `os.environ` + `import.meta.env`) | Required for any IaC↔code edge later. |
| 12 | **HTTP client matcher** (`fetch`, `axios`, `ky`, `requests`, `httpx`) | Without this, the server adapters above have no client to match against — there's no cross-service edge. |

**Rationale.** The P0 set is chosen so that on day one, on a representative Next.js + FastAPI + Postgres + Prisma monorepo, the user sees:

- Frontend page → `fetch('/api/users')` → backend route → handler function → `prisma.user.findMany()` → `User` model.
- Env var `DATABASE_URL` read by the Prisma client and by FastAPI settings.

That single rendered path is the demo. Everything else in P0 widens which stacks produce that demo. Anything that doesn't help produce that demo on day one is P1.

### P1 — v0.2

Stacks codegraph needs to be credible to enterprise / non-JS-mono shops, plus the IaC layer that turns the cross-service graph into a cross-environment graph.

| # | Adapter | Why P1 |
|---|---------|--------|
| 13 | **Koa** | Niche but trivial; fold in once Express adapter exists. |
| 14 | **Hono** | Edge/Cloudflare workloads; easy because typed routing. |
| 15 | **Spring Boot** | Required for Java/Kotlin shops. Big undertaking — see reality check. |
| 16 | **Rails** | Convention-over-config: free routes, free models, free associations. |
| 17 | **ASP.NET Core** | Required for .NET. Attribute routing similar to FastAPI. |
| 18 | **Gin** + **Chi** (Go) | Go HTTP. Both ship together because the AST shape is similar. |
| 19 | **SvelteKit** | File-system routing + `+page.server.ts` data loaders. |
| 20 | **Remix** | File-system routing + loader/action pattern. |
| 21 | **Nuxt** | File-system routing + `useFetch` / `$fetch`. |
| 22 | **tRPC** | Cross-service edges *typed end-to-end* — the most precise edges we'll ever emit. |
| 23 | **GraphQL clients** (Apollo, urql, Relay, gql.tada) | Operation → schema field edges. |
| 24 | **TypeORM** | Java/Nest shops. |
| 25 | **GORM** (Go) | Go ORM monoculture. |
| 26 | **ActiveRecord** | Bundled with Rails adapter. |
| 27 | **Terraform / OpenTofu** | First IaC adapter; HCL is well-defined. |
| 28 | **AWS CDK** | TS/Python CDK is huge in serverless monorepos. |
| 29 | **SST** | The reason TS people build CDK at all today. |
| 30 | **Serverless Framework** | Older but still everywhere. |
| 31 | **CloudFormation** (raw YAML/JSON) | Output of CDK; some teams hand-write. |
| 32 | **Pulumi** | Same shape as CDK, different surface. |
| 33 | **pydantic-settings / viper** | Structured config; complements the env adapter. |

### P2 — later

Stacks where codegraph's value-add per LOC of adapter is lower, or where the work is dominated by handling edge cases.

| # | Adapter | Why P2 |
|---|---------|--------|
| 34 | **BullMQ** | Queue layer. Niche to Node. |
| 35 | **Celery** | Python queues; decorator-based, easy AST-wise. |
| 36 | **Sidekiq** | Ruby queues, paired with Rails adapter. |
| 37 | **SQS / SNS via AWS SDK** | Cloud-queue producers/consumers via SDK calls. Hard because dynamic. |
| 38 | **NextAuth** | Auth adapter; shape is small but the edges (provider → callback URL) are useful. |
| 39 | **Clerk** | SDK-based; mostly env + a few middleware patterns. |
| 40 | **Auth0 SDK** | Same shape as Clerk. |
| 41 | **Supabase** | Both auth and DB; the DB side overlaps with Postgres schema. |
| 42 | **Diesel** (Rust) | Rust ORM; community is small but vocal. |
| 43 | **Koa-router** as a separate beast | If/when we discover Koa adapter doesn't cover it. |

Anything not on these three lists is out of scope for the first year. We will be asked for ten more before we ship one.

---

## 2. P0 — HTTP server adapters

### 2.1 Express (Node)

**Detection signal.**
- `package.json` has `"express"` in `dependencies` or `devDependencies` (any version range).
- File contains `require('express')` or `import express from 'express'` (or `import { Router } from 'express'`).
- Variable assigned from `express()` or `express.Router()` is the *app/router root*. Track this binding through the file.

**IR contributions.**
- For each `app.<verb>(path, …handlers)` and `router.<verb>(path, …handlers)` where verb ∈ `{get, post, put, patch, delete, options, head, all}`:
  - Emit `HttpRoute(method=verb, path_template=normalize(path), service=<service this file belongs to>)`.
  - Emit `route_handler` edge to the *last* handler argument, resolved to a `Symbol` in the codegraph symbol layer. (The earlier args are middleware; we tag them as `middleware` edges.)
- For `app.use(path, router)` and `app.use(router)`:
  - Resolve `router` to a binding emitted earlier; emit a `mount` edge with `prefix=path` (or empty).
  - Final route paths are computed by walking mount chains: a route's `path_template` becomes `join(prefix_chain, route_path)`.
- For `express.Router({ mergeParams: true })` — note the option but no IR change beyond logging.
- Treat `router.route('/x').get(fn).post(fn)` chains as syntactic sugar; emit one route per chained verb.

**Complexity.** **M.** The AST is trivial; the *mount resolution* is what makes this real work. A naive Express adapter fails on every monorepo where `Router` is built in `routes/users.ts`, exported, imported in `routes/index.ts`, and mounted at `/api/v1` in `server.ts`.

**Priority.** **P0.**

**Known gotchas / reality check.**
- **Router composition across files** is the entire job. The adapter must consult the symbol graph to follow `import {usersRouter} from './users'` and re-resolve. Plan a small, dedicated *binding resolver* utility used by Express, Koa, Hono, and Fastify alike.
- **Middleware that wraps the handler** (`app.get('/x', auth, asyncHandler(fn))`). The "real" handler is `fn`, not `asyncHandler(fn)`. Heuristic: if the last argument is a call expression and its callee name matches a curated wrapper allowlist (`asyncHandler`, `wrap`, `tryCatch`, `expressAsyncHandler`), recurse into the first argument.
- **Dynamic route registration** (`routes.forEach(r => app[r.method](r.path, r.handler))`). Cannot resolve statically without constant propagation. Emit `heuristic` route nodes when both `r.method` and `r.path` are object-literal string properties one level back; otherwise emit a `DynamicRouteRegistration` node and stop.
- **Path-to-RegExp quirks.** Express path syntax is its own dialect: `/:id`, `/:id?`, `/:id(\\d+)`, `*`. Normalize to `/{id}`; preserve regex in a `param_constraints` attribute. Unmatched regexes are kept as-is to avoid silent misnormalization.
- **`req.params`, `req.query`, `req.body`** are untyped in Express. We do not attempt to emit a request schema; we only link the route to the handler. (Fastify, FastAPI, etc. give us schemas for free.)
- **`app.all('*', …)`** is a catch-all. Emit but mark `path_template='*'`; the cross-service matcher must not match it greedily against client calls.
- **`express()` mounted as middleware on another `express()` app** — yes, this is legal. Treat sub-apps the same as `Router`.

---

### 2.2 Fastify (Node)

**Detection signal.**
- `"fastify"` in `package.json` deps.
- Imports of `'fastify'` or `'@fastify/...'`.
- Variable assigned from `Fastify(opts)` or `fastify(opts)`.

**IR contributions.**
- Same `HttpRoute` shape as Express, but additionally:
  - If the route is registered with the *object form* (`app.route({ method, url, schema, handler })`), capture `schema` as a *referenced* schema node — request/response shapes attached to the route. Don't try to resolve the schema fully; record the symbol/path so a future "schema diff" feature can trace it.
  - If `schema.body`, `schema.querystring`, `schema.params`, `schema.response` reference symbols (e.g. `import { UserSchema } from '../schemas'`), emit `references_schema` edges.
- For `app.register(plugin, { prefix })`:
  - Plugin is a function; recurse into it the same way Express recurses into a `Router`. Treat the inner `app` parameter as a fresh router root with the given prefix.
- For `fastify-plugin` wrapped plugins, unwrap the call.

**Complexity.** **M.** Less mount-soup than Express in practice (people tend to flatten), but the plugin pattern means recursion depth matters.

**Priority.** **P0.**

**Known gotchas.**
- **Plugin encapsulation.** `app.register` creates a new scope. Routes registered inside a plugin only exist under that plugin's prefix. The adapter must respect this to avoid attaching prefixes to the wrong routes.
- **Schema references emitted as JSON-Schema literals** (object literal in the call) vs. **as imports** vs. **as `$ref` strings**. Treat the literal case as anonymous schemas (no node). Treat imports as schema references. Ignore `$ref` strings; they require resolving Fastify's schema registry, which is dynamic.
- **`autoload` plugin** (`@fastify/autoload`). It registers a directory of plugins automatically. Adapter: when we see `autoload({ dir })`, glob the dir, treat each file as a plugin with a prefix derived from its path. This is a small file-system convention adapter on top of the main one.
- **`addHook('preHandler', …)`** is middleware-equivalent. Don't conflate with the route's handler.

---

### 2.3 Koa (Node)

**Detection signal.**
- `"koa"` and usually `"@koa/router"` or `"koa-router"` in deps.
- `new Koa()`, `new Router()`.

**IR contributions.** Same shape as Express with verb-method calls on a `Router` instance. `app.use(router.routes())` and `app.use(router.allowedMethods())` are the mount idiom.

**Complexity.** **S–M.** Fold into the Express adapter's binding resolver.

**Priority.** **P1.** (Koa shops are now small; not blocking MVP demo.)

**Known gotchas.**
- The handler signature is `(ctx, next)` not `(req, res)`. Doesn't matter for IR but matters when Action wants to refactor a handler.
- `router.use(prefix, …)` mid-router applies a prefix to subsequent routes. Track per-router cursor state.

---

### 2.4 Hono (Node / Edge)

**Detection signal.**
- `"hono"` in deps. Imports from `'hono'`, `'hono/cloudflare-workers'`, etc.
- `new Hono()`.

**IR contributions.**
- `app.<verb>(path, handler)` — same shape.
- `app.route('/api', subApp)` — mount.
- Hono's typed-RPC client (`hc<typeof app>(url)`) is *the* thing to support: when the codebase uses `hc`, the call sites become typed `HttpClientCall`s with a known route. Emit `fetches` edges with **exact** confidence.

**Complexity.** **M.** Standard server side; the client-side `hc` matcher is a separate, optional pass.

**Priority.** **P1.** (P0-adjacent: cheap once Express/Fastify exists.)

**Known gotchas.**
- Hono routes can be registered on a `Hono` instance whose generic parameter is the *combined* type of all routes. The type is interesting but we don't read it; we read the call sites only.
- `app.basePath('/api')` mutates the prefix.

---

### 2.5 FastAPI (Python)

**Detection signal.**
- `fastapi` in `pyproject.toml` / `requirements.txt`.
- `from fastapi import FastAPI, APIRouter` or similar.
- `FastAPI(...)`, `APIRouter(...)` constructors.

**IR contributions.**
- For each `@app.<verb>(path, …)` or `@router.<verb>(path, …)` (verb ∈ `get/post/put/patch/delete/head/options/trace`):
  - Emit `HttpRoute` with `method`, `path_template=normalize(path)`, `handler_symbol=` the decorated function.
  - The decorated function's signature gives us request schema *for free*: each typed parameter (Pydantic model, `Query(...)`, `Path(...)`, `Body(...)`, `Header(...)`, `Cookie(...)`, `Depends(...)`) is recorded.
  - `response_model=` kwarg is captured as a response schema reference.
- For `app.include_router(router, prefix=…, tags=…)`:
  - Resolve `router` to its `APIRouter` definition; recurse and prefix.
- `Depends(get_db)` etc. — emit `depends_on` edges to the dependency function symbol. (This is one of FastAPI's wins: dependency edges are explicit.)

**Complexity.** **M.** The decorators are the easiest part of any framework in this list. The dependency graph is a bonus.

**Priority.** **P0.**

**Known gotchas.**
- **Path normalization.** FastAPI uses `/users/{id}` already — closer to canonical than Express. Just strip type converters: `/users/{id:int}` → `/users/{id}` with a `param_type=int` attribute.
- **Multiple `APIRouter`s mounted with overlapping prefixes** — fully supported, just walk includes recursively.
- **`add_api_route(...)` programmatic registration** — exists. Same dynamic-registration heuristic as Express.
- **`@app.get` on a class method** is rare but legal (with `Depends(self_factory)`). Resolve to the method symbol.
- **Mount of WSGI/ASGI sub-apps** (`app.mount('/static', StaticFiles(...))`) — emit a `Mount` node, not a route.
- **Pydantic v1 vs v2.** Both decorate model classes; the IR doesn't care, but the schema adapter (later) does.

---

### 2.6 Flask (Python)

**Detection signal.**
- `flask` in deps; `from flask import Flask, Blueprint`.

**IR contributions.**
- `@app.route('/x', methods=['GET'])` and `@app.get('/x')` (Flask 2.x). Emit one `HttpRoute` per method in the list (default `['GET']`).
- `Blueprint('users', __name__, url_prefix='/users')` + `app.register_blueprint(bp, url_prefix='/api')` — concatenate prefixes.
- `add_url_rule(...)` — programmatic; same dynamic heuristic.

**Complexity.** **S.**

**Priority.** **P0.**

**Known gotchas.**
- **`<int:id>` path converters** — normalize to `{id}`; keep the converter as `param_type=int`.
- **`view_func=` arg** can point at a `MethodView` class; emit `route_handler` to the class with a sub-attribute `dispatch_method=<verb>`.
- **Pluggable views (`MethodView.as_view('users')`).** Required for any non-trivial Flask app. Emit one route per HTTP method the class implements.

---

### 2.7 Django (Python)

**Detection signal.**
- `django` in deps.
- `urls.py` files; `urlpatterns = [...]` at module top level.
- `INSTALLED_APPS` in a `settings.py`.

**IR contributions.**
- Walk `urlpatterns`:
  - `path('users/<int:id>/', views.user_detail)` → `HttpRoute(method=*, path='users/{id}', handler=views.user_detail)`. Method is `*` because Django routes don't carry a method at URL level; method dispatch is in the view.
  - `re_path(r'^users/(?P<id>\d+)/$', …)` → normalize regex named groups to `{id}`; if regex is too gnarly, keep raw.
  - `include('app.urls')` — recurse with prefix concatenation.
- For class-based views (`UserDetail.as_view()`), inspect the class's HTTP method handlers (`get`, `post`, `put`, …) and emit a route per implemented method.
- For Django REST Framework `routers.DefaultRouter().register('users', UserViewSet)` — emit the conventional CRUD routes (`GET /users/`, `GET /users/{id}/`, `POST /users/`, etc.) with `confidence=inferred`.

**Complexity.** **L.** Django's URL-routing surface is small but the *views* surface is big and we need to thread to it.

**Priority.** **P0** (bundled with Django ORM adapter; both ship together because Django apps are inseparable from their ORM).

**Known gotchas.**
- **Settings-based URL prefix** (`ROOT_URLCONF`). The adapter must locate the project's settings module, find `ROOT_URLCONF`, and start traversal there. Multiple settings files (`settings/dev.py`, `settings/prod.py`) — pick the one that is imported by `manage.py` if statically resolvable; otherwise emit routes for each.
- **DRF `ViewSet` with `@action(detail=True)`** — extra routes; recognize the decorator.
- **`urlpatterns += static(...)`** — ignore (static files).
- **Custom URL converters** registered via `register_converter(...)` — record the alias but don't try to interpret.

---

### 2.8 Spring Boot (Java/Kotlin)

**Detection signal.**
- `pom.xml` / `build.gradle(.kts)` references `spring-boot-starter-web` or `spring-boot-starter-webflux`.
- Annotations: `@RestController`, `@Controller`, `@RequestMapping`, `@GetMapping`, `@PostMapping`, etc.

**IR contributions.**
- For each class annotated `@RestController` or `@Controller`:
  - The class-level `@RequestMapping("/users")` (if any) is the prefix.
  - For each method annotated `@<Verb>Mapping("/{id}")`, emit `HttpRoute(method=verb, path=prefix+suffix, handler=method)`.
  - `@RequestParam`, `@PathVariable`, `@RequestBody`, `@RequestHeader` are parameter binders; record but don't fully resolve types yet.
- For functional routing (`RouterFunction<ServerResponse>` in WebFlux):
  - Builder calls `route().GET("/x", ::handler).POST(...)`. Walk the builder.

**Complexity.** **L.** Java/Kotlin AST is bigger; the JVM ecosystem has many routing dialects (Spring MVC vs WebFlux vs Spring Cloud Gateway). The annotation route adapter is mid-sized; functional routing adds a chunk.

**Priority.** **P1.** (Not in MVP because Java repos are not where the demo lands.)

**Reality check / 5x harder:**
- **Annotation aliasing.** Teams routinely create their own meta-annotations (`@MyApiGet("/x")` is itself annotated `@GetMapping`). The adapter must resolve meta-annotations transitively. The Java parser must read annotation classes from the project's source set; for annotations from external jars, we'd need a class-file reader — out of scope. Emit `heuristic` routes when meta-annotations come from unresolved sources.
- **Kotlin's DSL routing** in Ktor (separate framework; Spring shops don't use it but it's in the same ecosystem).
- **Spring's `WebMvcConfigurer.addViewControllers`** for static-mapped routes. Long tail.
- **Conditional `@Profile` controllers** — routes only registered in some environments. We emit them all and tag with `profile=…`.

---

### 2.9 Rails (Ruby)

**Detection signal.**
- `Gemfile` with `rails` gem.
- `config/routes.rb`.
- `app/controllers/`, `app/models/` directory layout.

**IR contributions.**
- Parse `config/routes.rb`:
  - `get '/users', to: 'users#index'` → `HttpRoute(method=GET, path='/users', handler=UsersController#index)`.
  - `resources :users` → emits the standard 7 RESTful routes (`index`, `show`, `new`, `create`, `edit`, `update`, `destroy`) with the conventional paths and methods.
  - `namespace :api do … end`, `scope :v1`, `resources :things do member do … end end` — all compose by walking the DSL.
- Models in `app/models/<name>.rb` with `class Foo < ApplicationRecord` are picked up by the ActiveRecord adapter (P1).

**Complexity.** **M.** Ruby parsing is harder than TS/Python, but Rails routes are tightly conventional, so the adapter is mostly a Ruby-AST pattern matcher with a fixed convention table.

**Priority.** **P1.**

**Known gotchas.**
- **Engine routes** mounted via `mount Spree::Core::Engine, at: '/spree'` — engine is a separate gem; treat as opaque mount unless we have the source.
- **`constraints`** blocks for subdomain or format constraints — record but don't filter.
- **Routes added in initializers** — rare; ignore.
- **The Ruby parser ecosystem.** Whichever we pick (`tree-sitter-ruby` is the obvious choice, alternatives exist) we own the AST quality issues that come with it.

---

### 2.10 ASP.NET Core (C#)

**Detection signal.**
- `.csproj` references `Microsoft.AspNetCore.App` or `Microsoft.NET.Sdk.Web`.
- Attributes: `[ApiController]`, `[Route]`, `[HttpGet]`, etc.
- Or minimal-API style `app.MapGet("/x", handler)` in `Program.cs`.

**IR contributions.**
- Attribute routing: same shape as Spring. Class-level `[Route("api/[controller]")]` → method-level `[HttpGet("{id}")]` → `HttpRoute(method=GET, path='/api/users/{id}')` with `[controller]` token expanded from class name.
- Minimal API: `app.MapGet`, `app.MapPost`, etc. — straight calls, easy.
- Endpoint groups: `app.MapGroup("/api/v1").MapGet(…)` — concatenate prefixes.

**Complexity.** **L.** C# AST + the dual routing systems (attribute + minimal API) means doubled work.

**Priority.** **P1.**

**Known gotchas.**
- **Controller convention.** `[controller]` token is replaced with the controller class name minus the `Controller` suffix. Easy to get wrong if you don't strip the suffix.
- **Areas** (`/Areas/Admin/Controllers/...`) — extra prefix.
- **Source generators** (`AOT`) emit endpoints at compile time — invisible to source AST. Out of scope.

---

### 2.11 Gin (Go)

**Detection signal.**
- `go.mod` with `github.com/gin-gonic/gin`.
- `gin.New()` / `gin.Default()`.

**IR contributions.**
- `r.GET("/users", handler)`, etc. — same shape.
- `r.Group("/api/v1")` returns a sub-router; track the binding and prefix.
- Middleware: `r.Use(...)` — record.

**Complexity.** **M.**

**Priority.** **P1.**

**Known gotchas.**
- Gin's path syntax: `/users/:id` and `/files/*filepath` (wildcard). Normalize.
- Handlers are typically `func(c *gin.Context)`. Resolve the handler symbol; the request shape comes from `c.ShouldBindJSON(&req)` patterns — the schema adapter (later) reads these.

---

### 2.12 Chi (Go)

**Detection signal.**
- `go.mod` with `github.com/go-chi/chi`.
- `chi.NewRouter()`.

**IR contributions.** Identical shape to Gin: `r.Get("/x", handler)`, `r.Route("/api", func(r chi.Router) {...})` for nested groups.

**Complexity.** **S.** Fold into the Gin adapter.

**Priority.** **P1.**

**Known gotchas.**
- Chi uses `{id}` syntax natively — no normalization needed. Pleasant.
- `r.Mount("/api", apiRouter)` — handle like include.

---

## 3. P0 — Frontend routing & data adapters

### 3.1 Next.js (App Router + Pages Router)

This is the single most important *frontend* adapter. It's also the one most likely to break under our hands, because Next.js has reinvented itself three times.

**Detection signal.**
- `"next"` in `package.json` deps.
- Presence of `app/` directory with `page.tsx` / `layout.tsx` / `route.ts` files (App Router).
- Presence of `pages/` directory with `pages/api/*` (Pages Router).
- A repo can have both at once; we emit routes for both, namespaced.

**IR contributions.**

**App Router:**
- File `app/users/[id]/page.tsx` → `Route(kind=page, path='/users/{id}')` with `default export` resolved as the page component symbol.
- File `app/users/[id]/route.ts` exporting `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `OPTIONS`, `HEAD` → one `HttpRoute` per exported verb, `path='/users/{id}'`.
- File `app/users/[id]/layout.tsx` / `loading.tsx` / `error.tsx` / `not-found.tsx` — emit `LayoutComponent`, `LoadingComponent`, etc., with a `wraps` edge to the page.
- Server actions: a function annotated with `'use server'` (file-level or function-level directive). Emit `ServerAction(symbol)`. Calls to a server action from a client component become `RpcClientCall(kind=server-action)` edges.
- Route groups `(marketing)/` and parallel routes `@modal` and intercepted routes `(.)` — recognize the conventions and apply the path-construction rules from Next.js's docs. (This is where most Next.js adapters silently get wrong.)
- Dynamic segments: `[id]`, catch-all `[...slug]`, optional catch-all `[[...slug]]`. Normalize accordingly.

**Pages Router:**
- File `pages/users/[id].tsx` → `Route(kind=page, path='/users/{id}')`.
- File `pages/api/users/[id].ts` exporting `default function handler(req, res)` → one `HttpRoute(method=*)` (the handler is method-discriminated via `req.method`; we emit method=`*` and let the handler analysis fill in).
- `getServerSideProps`, `getStaticProps`, `getStaticPaths` — emit `DataLoader` nodes with edges to the page.

**Cross-cutting:**
- `fetch('/api/users')` calls *anywhere in the project* are emitted by the HTTP-client matcher (§5) and matched against the routes above to produce `fetches` edges.
- `next.config.js` `rewrites`, `redirects` — record so URL matching can account for them. (Often skipped — and that's why so many Next.js navigation tools miss internal routes.)

**Complexity.** **L.** This adapter alone is two engineer-weeks done well, two engineer-months done excellently.

**Priority.** **P0.** Without it the demo dies.

**Reality check / 5x harder than it looks:**
- **Route groups** `(marketing)` are *erased from URLs*. If the adapter naively concatenates segments it'll emit `/(marketing)/about` instead of `/about`. Forgetting this is the #1 bug in third-party Next.js route extractors.
- **Parallel routes** `@modal/page.tsx` are addressed by the parent route, not via their own URL. Emit a `ParallelSlot` node attached to the parent.
- **Intercepted routes** `(.)photo`, `(..)photo`, `(...)photo` are addressable by URL but render in a different layout context. Document; don't try to over-model.
- **`route.ts` co-existing with `page.tsx`** is allowed but routes only the HTTP one. Adapter must dedupe by checking which file is present.
- **Server Actions are not addressable by URL** at the source level. They get a synthetic ID at build time. Treat them as RPC-ish; don't pretend they're HTTP routes.
- **Middleware** (`middleware.ts` at project root, with optional matcher config). Emit a `Middleware` node and a matcher pattern; affects path-matching for client-server matching.
- **`next/dynamic` and `next/link`** — link `href`s give us internal navigation edges. Emit `navigates_to` edges from a component to a route. Worth doing in P0.
- **`useSearchParams`, `useParams`, `useRouter`** — runtime dynamic. Out of scope.
- **`unstable_*` APIs** change every release. Hard-code support cautiously and version-gate.

---

### 3.2 SvelteKit

**Detection signal.**
- `"@sveltejs/kit"` in deps.
- `src/routes/` directory; `+page.svelte`, `+page.server.ts`, `+page.ts`, `+server.ts`, `+layout.svelte` files.

**IR contributions.**
- File-system routing: `src/routes/users/[id]/+page.svelte` → `Route(path='/users/{id}')`.
- `+server.ts` exporting `GET`, `POST`, etc. → `HttpRoute` per verb (same as App Router).
- `+page.server.ts` exporting `load` → `DataLoader` node; calls to remote APIs from inside `load` are HTTP client calls. `actions` export → `FormAction` nodes.
- `[id]`, `[...rest]`, `[id=int]` (param matchers from `src/params/`).

**Complexity.** **M–L.**

**Priority.** **P1.**

**Known gotchas.**
- **`+page.ts` vs `+page.server.ts`** — the former runs on both client and server, the latter is server-only. Affects which env-var and DB edges are valid.
- **`hooks.server.ts`** — middleware analog. Affects all routes.
- **Param matchers** (`src/params/integer.ts`) — record as constraints.

---

### 3.3 Remix

**Detection signal.**
- `"@remix-run/react"` or `"@remix-run/node"` in deps.
- `app/routes/` directory; or `routes.ts` config file (Remix v2 file convention).

**IR contributions.**
- `app/routes/users.$id.tsx` (v2) or `app/routes/users/$id.tsx` (v1) → `Route(path='/users/{id}')`.
- A route file exporting `loader` → server-side data load; `action` → server-side mutation; `default` → component.
- `useFetcher`, `useSubmit`, `Form` action props point at routes — emit `fetches` edges.

**Complexity.** **M.**

**Priority.** **P1.**

**Known gotchas.**
- The v1 vs v2 file convention is a real fork — adapter must detect and pick.
- Nested routes via dot-prefix (`users.$id.tsx`) is its own grammar; not as bad as Next.js groups but still requires parsing.

---

### 3.4 Nuxt

**Detection signal.**
- `"nuxt"` in deps; `nuxt.config.ts`.
- `pages/` and `server/api/` directories.

**IR contributions.**
- `pages/users/[id].vue` → `Route`.
- `server/api/users/[id].ts` exporting `defineEventHandler(async (event) => { … })` → `HttpRoute(method=*)`. Inside the handler, `event.method` may be branched; ignore for now.
- `useFetch('/api/users')` and `$fetch('/api/users')` — HTTP client calls.

**Complexity.** **M.** Vue SFC parsing is a chunk; keep it minimal (we don't need the template AST for routing).

**Priority.** **P1.**

**Known gotchas.**
- **Nuxt auto-imports** (composables, components) make symbol resolution non-trivial. The TS indexer must understand the Nuxt auto-import map.
- **Server middleware** in `server/middleware/` — affects all routes.
- **`server/routes/`** vs **`server/api/`** — both exist; different prefixing rules.

---

### 3.5 React Router (data router v6.4+)

**Detection signal.**
- `"react-router-dom"` (>=6.4) in deps.
- `createBrowserRouter([...])` / `createMemoryRouter` / `RouterProvider` calls.

**IR contributions.**
- Walk the route config object. `{ path: '/users/:id', element: <Users />, loader: usersLoader, action: usersAction }`:
  - `Route(path='/users/{id}')` linked to the element symbol.
  - `loader` and `action` symbols are emitted as data-loader nodes.
- Nested routes via the `children` array; concatenate paths.

**Complexity.** **M.**

**Priority.** **P0.** (Pairs with Next.js to cover the React universe.)

**Known gotchas.**
- **Lazy routes** (`lazy: () => import('./users')`) — resolve the dynamic import to the module symbol when possible.
- **`createRoutesFromElements`** (JSX form) — alternative API; parse JSX `<Route path="/x" element={<X/>}>`.
- **Old non-data router API** (`<BrowserRouter><Routes><Route…></Routes></BrowserRouter>`) is still common in older codebases; support for completeness.

---

### 3.6 tRPC

**Detection signal.**
- `"@trpc/server"` and/or `"@trpc/client"` in deps.
- `t.router({ ... })` calls; `t.procedure.input(...).query(...)` chains.

**IR contributions.**
- For each procedure in a router: `RpcEndpoint(kind=trpc, name='users.list', input_schema_ref, output_schema_ref, resolver_symbol)`.
- The router tree is built by composition; trace `mergeRouters(...)` and `router({ users: usersRouter })` patterns.
- **Client side:** any call of the form `trpc.users.list.useQuery(...)` or `trpc.users.list.query(...)` is an `RpcClientCall(kind=trpc, name='users.list')` matched against the endpoint by name. **Exact** confidence — this is the cleanest cross-service edge in the entire ecosystem.

**Complexity.** **M.**

**Priority.** **P1.**

**Reality check.**
- **The router type is the source of truth.** tRPC's whole pitch is that the *type* of `AppRouter` is what the client uses. We never read types; we read the value-level shape. That's fine — calls like `trpc.users.list.…` mirror the router shape directly. But: tRPC v11 supports "links" and procedures defined in unusual shapes (`procedure.use(…).input(…).query(…)`). Walk the chain robustly.
- **Renamed routers / `mergeRouters`** with non-literal keys — fall back to `heuristic` confidence.
- **Subscriptions** — same shape as queries/mutations.

---

### 3.7 GraphQL clients (Apollo, urql, Relay, gql.tada)

**Detection signal.**
- Any of `@apollo/client`, `urql`, `relay-runtime`, `gql.tada` in deps.
- `gql\`…\`` tagged-template literals or `graphql\`…\`` (Relay).

**IR contributions.**
- For each `gql\`…\`` literal:
  - Parse the GraphQL document statically.
  - Emit `GqlOperation(kind=query|mutation|subscription, name, fields_referenced)`.
- If a schema file exists (`schema.graphql`, `schema.gql`, or generated `gql.tada` types):
  - Emit `GqlSchemaField` nodes.
  - Match operations to schema fields → `references_field` edges.
- Calls like `useQuery(MyQuery)` / `client.query({ query: MyQuery })` — link the call site to the operation node.

**Complexity.** **M–L.** GraphQL parsing adds a dependency; field resolution against a schema is non-trivial.

**Priority.** **P1.**

**Known gotchas.**
- **Schema location is convention-driven.** No reliable way to find it without per-project config. Adapter should accept a `codegraph.toml` `graphql.schema = "…"` hint.
- **Code-generated types** from `graphql-codegen` produce `.generated.ts` files — these are derived and not part of the IR; ignore.
- **String concatenation in `gql` template literals** — common for fragment composition. The adapter must follow `${SomeFragment}` interpolations.

---

## 4. P0 — ORM / DB adapters

### 4.1 Prisma

**Detection signal.**
- `"prisma"` and/or `"@prisma/client"` in deps.
- `prisma/schema.prisma` file.

**IR contributions.**
- Parse `schema.prisma`:
  - `model User { id Int @id; … }` → `DbModel(name='User', dialect=<from datasource>)`.
  - Fields → `DbColumn(name, type, nullable, default, attributes)`.
  - Relations (`posts Post[] @relation(...)`) → `DbRelation` edges.
  - Enums, indexes, `@@unique`, `@@index` — captured.
- For each call `prisma.user.findMany(...)`, `prisma.user.create(...)`, etc.:
  - Emit `DbQuery(kind=read|write, model='User', op='findMany')`.
  - Emit `reads_table` or `writes_table` edge from the call's enclosing function symbol to the `DbModel`.
- `prisma.$queryRaw\`SELECT … FROM users\`` — best-effort SQL parse; emit `DbQuery(kind=raw, sql_text=…)`. If we can match a table name to a known model, link.

**Complexity.** **M.** The `.prisma` schema parser is the bulk; query-call recognition is straightforward.

**Priority.** **P0.**

**Known gotchas.**
- **Multi-schema files** (Prisma `previewFeatures = ["multiSchema"]`). Track schemas per model.
- **`include` / `select` clauses** affect *what fields are read*. Useful later for "this query touches columns X, Y" but P0 just records the model-level read.
- **Prisma extensions** (`$extends({ model: { user: { … } } })`) — these define new methods on the client. Most projects use one or two; treat them as wrappers.
- **`prisma.$transaction([...])`** — recurse into the array.
- **`prisma generate` produces a client at `node_modules/.prisma/client`** — never read it.

---

### 4.2 Drizzle

**Detection signal.**
- `"drizzle-orm"` in deps.
- `drizzle.config.ts` present, or files exporting tables built with `pgTable`, `mysqlTable`, `sqliteTable`.

**IR contributions.**
- For each call `pgTable('users', { id: serial('id').primaryKey(), … })`:
  - `DbModel(name='users')` named by the *string* arg, not the variable.
  - Each property is a `DbColumn`; type derived from the column-builder call (`serial`, `text`, `integer`, `varchar`, etc.).
- Relations defined via `relations(usersTable, ({ many }) => ({ posts: many(postsTable) }))` → relation edges.
- For queries: `db.select().from(usersTable).where(...)` — emit `DbQuery(kind=read, model=<usersTable's table name>)`. Bind the `usersTable` variable to its `DbModel` via the symbol graph.
- `db.insert(usersTable).values(...)` → `DbQuery(kind=write, op=insert)`.
- `db.execute(sql\`…\`)` — best-effort SQL parse; same as Prisma `$queryRaw`.

**Complexity.** **M.** Drizzle's API is wide and fluent; the matching logic must handle long chains.

**Priority.** **P0.**

**Known gotchas.**
- **Query builder chains** can be aliased and stored: `const q = db.select().from(users); … q.where(...)`. The binding resolver must follow.
- **Re-exported tables** (`export * from './schema'`) — common.
- **Drizzle Kit migrations** — generated SQL files, not IR-relevant directly, but useful for schema evolution edges (P2).
- **Custom column types** via `customType<…>` — record the type name; don't try to interpret.

---

### 4.3 TypeORM

**Detection signal.**
- `"typeorm"` in deps.
- `@Entity()`, `@Column()`, `@PrimaryColumn()`, `@OneToMany()`, etc. decorators.

**IR contributions.**
- Class with `@Entity('users')` → `DbModel(name='users' or class-name lowercased)`.
- Each `@Column(...)` decorated property → `DbColumn`.
- Relations via `@OneToMany`, `@ManyToOne`, etc. → relation edges.
- Repository calls `userRepo.find(...)`, `userRepo.save(...)` — emit `DbQuery`. Resolve `userRepo` to its `getRepository(User)` or `dataSource.getRepository(User)` to find the entity.
- `@QueryBuilder` — best-effort.

**Complexity.** **M.**

**Priority.** **P1.**

**Known gotchas.**
- **Inheritance** (`@TableInheritance`, single-table-inheritance) — multiple classes map to one table. Record.
- **`EntityManager.query(rawSql)`** — same raw-SQL fallback.
- **Active Record vs Data Mapper** patterns — both supported in TypeORM. Adapter must handle both: `User.find(...)` (Active Record) and `repo.find(...)` (Data Mapper).

---

### 4.4 SQLAlchemy

**Detection signal.**
- `sqlalchemy` in deps.
- `from sqlalchemy.orm import declarative_base` or `from sqlalchemy.orm import DeclarativeBase`.
- Class inheriting `Base` or `DeclarativeBase`.

**IR contributions.**
- For each declarative model class:
  - `__tablename__ = 'users'` → `DbModel(name='users')`.
  - `Column(...)` and (2.0) `Mapped[T]` + `mapped_column(...)` → `DbColumn(name, type, …)`.
  - `relationship(...)` → relation edges.
- For each query `session.query(User).filter(...)` (1.x) or `session.execute(select(User).where(...))` (2.0) — `DbQuery`.
- `text("SELECT …")` raw — best-effort.

**Complexity.** **L.** SQLAlchemy is the most expressive ORM in the list; the API surface is enormous and the 1.x↔2.0 split doubles the work.

**Priority.** **P0.**

**Reality check / 5x harder:**
- **The 1.x↔2.0 transition.** Real codebases mix styles freely. The adapter must support both. The 2.0 typed style (`Mapped[int]`, `mapped_column`) is the easier of the two for AST analysis; 1.x's positional `Column` is slightly harder because column names sometimes come from the attribute name vs. the first positional arg.
- **`declarative_base` factories.** Many projects make their own `Base = declarative_base()` and re-use it. Trace.
- **Hybrid properties, `column_property`, `validates`** — record as model attributes; not in P0.
- **Core SQL Expression** (`sqlalchemy.sql.expression.select`, `Table('users', metadata, Column(...))`). Common in non-ORM SQLAlchemy projects. Adapter must recognize Core Tables as `DbModel` too.
- **Multi-binding sessions / sharding** (`session.using_bind(...)`) — out of scope.
- **Alembic migrations** — `op.create_table(...)` calls. Emit `DbMigration` nodes that point at models. Useful for schema-change diffing (P1).

---

### 4.5 Django ORM

**Detection signal.**
- `django` in deps; class inheriting `models.Model` in any `app/models.py` or `app/models/*.py`.

**IR contributions.**
- For each `class Foo(models.Model)`:
  - `DbModel(name=<table name from `Meta.db_table` or auto-generated>)`.
  - Fields (`models.CharField`, `models.IntegerField`, `models.ForeignKey`) → `DbColumn` with type.
  - `ForeignKey`, `OneToOneField`, `ManyToManyField` → relation edges. Resolve target by string ('app.Model') or class reference.
- Querysets: `Foo.objects.filter(...)`, `Foo.objects.create(...)`, `.update(...)`, `.delete(...)` → `DbQuery`.
- Migrations in `app/migrations/0001_initial.py` — `migrations.CreateModel(...)`. Useful for schema-evolution edges.

**Complexity.** **M.** Django models are highly conventional, which makes the adapter mostly a decorator-and-class-attribute walker.

**Priority.** **P0.** (Bundled with Django views adapter.)

**Known gotchas.**
- **`Meta` inner class** carries the table name and indexes.
- **Abstract base models** (`class Meta: abstract = True`) — not tables; record but don't emit a `DbModel`.
- **`through` tables** for `ManyToManyField` — implicit join table; record.
- **String references to models** (`ForeignKey('other_app.Model')`) require resolving across apps; needs the `INSTALLED_APPS` map.

---

### 4.6 ActiveRecord (Rails)

**Detection signal.**
- `Gemfile` with `rails` or `activerecord`; `app/models/<name>.rb` with `class X < ApplicationRecord`.
- `db/schema.rb` (or `db/structure.sql`) is the canonical schema.

**IR contributions.**
- Parse `db/schema.rb` — it's a Ruby DSL but well-bounded. `create_table 'users' do |t| t.string :name end` → `DbModel('users')` with columns. Models in `app/models/` map to tables by convention (`User` → `users`).
- Associations (`has_many :posts`, `belongs_to :user`) → relation edges.
- Queries: `User.where(...)`, `User.find(...)`, `User.create(...)` — `DbQuery`.

**Complexity.** **M.** Conventions are the win.

**Priority.** **P1.**

**Known gotchas.**
- **`structure.sql`** is raw SQL — needs an SQL parser if used. Smaller projects use `schema.rb`; larger ones use `structure.sql`.
- **STI (Single Table Inheritance)** — multiple classes, one table.
- **Polymorphic associations** (`belongs_to :commentable, polymorphic: true`) — relation edge has no fixed target; record as polymorphic.

---

### 4.7 GORM (Go)

**Detection signal.**
- `gorm.io/gorm` in `go.mod`.
- Structs with `gorm` tags or `TableName()` methods.

**IR contributions.**
- Struct `type User struct { ID uint; Name string \`gorm:"…"\` }` → `DbModel(name=<from TableName() or convention>)`. Fields → `DbColumn`s with types from struct field types and `gorm:"…"` tags.
- Queries: `db.Where(...).First(&user)`, `db.Create(&user)`, `db.AutoMigrate(&User{})` — `DbQuery`.

**Complexity.** **M.**

**Priority.** **P1.**

**Known gotchas.**
- **Struct embedding** (`type Base struct {…}; type User struct { Base; … }`). Walk embedded fields.
- **`AutoMigrate`** — a write-time schema modifier; emit `DbSchemaWrite`.

---

### 4.8 Diesel (Rust)

**Detection signal.**
- `Cargo.toml` with `diesel`.
- `diesel::table!` macros.
- `schema.rs` file (conventional).

**IR contributions.**
- `table! { users (id) { id -> Integer, name -> Text } }` → `DbModel('users')` with columns.
- Structs deriving `Queryable` / `Insertable` / `AsChangeset` — link to tables via `#[diesel(table_name = users)]`.
- Queries built via the DSL (`users::table.filter(users::id.eq(1)).first(conn)`).

**Complexity.** **L.** Rust macro expansion is the hard part; we can't statically expand `table!` without partial macro support.

**Priority.** **P2.** (Rust ORM users are a small audience; the cost-benefit is worse than the others.)

**Reality check.**
- **Macro expansion.** Without expanding `diesel::table!`, the adapter has to recognize the macro literally and parse its DSL by hand. That's doable (the DSL is bounded) but it's a separate parser.
- **`schema.rs` is generated.** Fine — we can read it directly without macro expansion if we just parse the macro invocations textually.

---

## 5. P0 — HTTP client matcher (the secret-weapon adapter)

This is where codegraph earns its name. None of the server adapters above produce `fetches` edges by themselves — those edges come from matching server-side `HttpRoute` nodes against client-side `HttpClientCall` nodes.

**Detection signal.**
- TS/JS:
  - `fetch(...)` (global).
  - `axios.get(...)`, `axios.post(...)`, `axios(config)`, `axios.create(...)` instances.
  - `ky.get(...)`, `ky.post(...)`, `ky.create(...)`.
  - `got.get(...)` etc.
  - `node-fetch` re-export.
- Python:
  - `requests.get(...)`, `requests.post(...)`, etc.
  - `httpx.get(...)`, `httpx.AsyncClient().get(...)`.
  - `urllib.request.urlopen(...)` (rare, but emit).
  - `aiohttp.ClientSession().get(...)`.
- Go: `http.Get(...)`, `http.NewRequest(...)`, `client.Do(...)` — limited; the URL and method are usually local literals.
- Java: `RestTemplate`, `WebClient`, `HttpClient` (java.net).
- Ruby: `Net::HTTP`, `HTTParty`, `Faraday`.
- C#: `HttpClient.GetAsync(...)`.

**IR contributions.**
- For each call, emit `HttpClientCall(method, url_template, call_site, base_url_hint)`.
- `url_template` resolution:
  - Literal string: `'/api/users'` → exact.
  - Template literal with constant interpolation: `\`/api/users/${userId}\`` → `'/api/users/{param}'` with param name preserved if the variable name is single-token.
  - String concatenation: `'/api/' + path` where `path` is a literal earlier in the same scope — inferred.
  - Anything else (function call, method chain) — emit `url_template='?'` with `confidence=heuristic`, plus a `dynamic_url=true` flag.
- `base_url_hint` from `axios.create({ baseURL: 'https://api.example.com' })`, env var (`process.env.API_URL`), or config object.

**Matching to routes.** A separate "router" pass after both server and client adapters run:
- For each `HttpClientCall(method, url_template, base_url_hint)`:
  - Find candidate `HttpRoute`s where `method` matches (or route is `*`).
  - Match `url_template` to `path_template` after normalization.
  - If `base_url_hint` resolves to a `Service` boundary (via env var → IaC → service map, or via service co-location), restrict to routes in that service.
  - Emit `fetches` edge with confidence = min(client confidence, route confidence).

**Complexity.** **L.** Each language is its own adapter; the matcher is a global pass with non-trivial path-template unification. Plan for a `path_template_match(client_path, server_path) -> bool` function with thorough tests across all path syntaxes (Express, Flask, FastAPI, Rails, etc.).

**Priority.** **P0.** This is *the* adapter. Without it, the demo is "we found routes" — so what.

**Reality check / 5x harder:**
- **Base URL resolution.** Most production apps put the base URL in an env var. The matcher needs the env adapter to know that `process.env.API_URL` is the same identifier referenced in the IaC (e.g., a CDK output). This is the value chain: env adapter → IaC adapter → matcher. Without all three, base URLs are unresolvable and we fall back to "any service with a matching path template" (which is wrong half the time).
- **Wrappers around fetch.** Most repos have `lib/api.ts` that wraps fetch; every call site uses `api.users.get(id)` instead of `fetch('/api/users/'+id)`. Two options: (a) inline the wrapper at call sites by tracing one level (works for simple wrappers); (b) require the wrapper to be tagged (e.g., a JSDoc tag) and emit edges from the wrapper to the route. P0: trace one level deterministically; emit `heuristic` if more.
- **Path-template syntax mismatch.** Client says `/users/${id}`, server says `/users/:id`. The matcher must canonicalize both sides. Edge cases: optional segments, wildcards, regex constraints. Canonicalize as `/users/{}` (positional) to compare structure independently of param name.
- **Method mismatch.** Some clients call `axios({ method: 'POST', url: '/x' })` (object form). Recognize and extract.
- **GraphQL and tRPC do NOT use this matcher.** They have their own (better) matching at the operation/procedure level.

---

## 6. P0 — Env / config adapter

The env adapter is small in code and *huge* in leverage. It glues code to IaC.

**Detection signal.**
- `.env`, `.env.local`, `.env.production`, `.env.example`, `.env.development` files.
- `dotenv` package in deps; `import 'dotenv/config'`; `dotenv.config()`.
- `import.meta.env` (Vite-style) — implies Vite/SvelteKit/Nuxt-Vite/etc.
- `process.env.X` (Node).
- `os.environ['X']` / `os.getenv('X')` (Python).
- `ENV['X']` (Ruby).
- `os.Getenv("X")` (Go).
- Config schemas: `pydantic-settings` `BaseSettings` subclasses; `viper` calls; `zod` env-schema patterns (`createEnv` from `@t3-oss/env-nextjs`); `envalid`.

**IR contributions.**
- For each `.env*` file, emit `EnvVar(name, default_value, source_file=…, environment=<from filename>)`.
- For each AST read of an env var (`process.env.X`, `os.environ['X']`, `os.Getenv("X")`), emit `EnvRead(var_name, call_site)` and `reads_env` edge from the enclosing function symbol.
- For schema-defined env (`createEnv({ server: { DATABASE_URL: z.string().url() } })`), emit `EnvVar(name, type_hint, schema_ref)` with **exact** confidence and a `validated_by_schema` attribute.
- For `pydantic-settings`:
  ```py
  class Settings(BaseSettings):
      database_url: str
      debug: bool = False
  ```
  Emit one `EnvVar` per field.
- For `viper`:
  - `viper.GetString("database.url")` — emit `EnvRead("DATABASE_URL")` if name normalization rule applies (often `DATABASE_URL` ↔ `database.url`); record raw key.

**Complexity.** **S–M.** The set of patterns is wide but each is small. The schema variants (`pydantic-settings`, `t3-env`, `envalid`, `viper`) are individually small adapters that share an output schema.

**Priority.** **P0.**

**Known gotchas.**
- **Wrapper modules.** Many projects re-export env vars: `export const DATABASE_URL = process.env.DATABASE_URL!`. Then 100 places `import { DATABASE_URL } from '@/config'`. The adapter must:
  1. Recognize the wrapper as the `EnvRead` site.
  2. Treat downstream imports as *transitive* env reads via the symbol graph.
  An `EnvRead` edge can come from a transitive symbol; mark `transitive=true`.
- **`process.env.X || 'default'`** — capture the default value as an inferred attribute.
- **`dotenv-flow`, `dotenv-expand`** — same `.env` parsing but with multi-file precedence and variable expansion. Implement expansion (`${OTHER_VAR}` substitution) carefully.
- **Webpack/Vite `define` plugins.** Build-time replacement of `process.env.X` with literals. We treat the source as the truth and ignore the build.
- **Typed env without schema.** `z.object({ DATABASE_URL: z.string() }).parse(process.env)` is a one-off pattern. Recognize the `parse(process.env)` shape.
- **CI env vars.** `.github/workflows/*.yml` references `${{ secrets.X }}` and `env:`. Out of scope for the env adapter; covered by a future CI adapter.

---

## 7. P1 — IaC adapters

IaC adapters turn the cross-service graph into a cross-environment graph: now we know which `IacResource` runs which `Service`, and which env vars flow from where.

### 7.1 Terraform / OpenTofu

**Detection signal.**
- `*.tf` files; `*.tofu`. `terraform { … }` block. `provider "aws" { … }` declarations.

**IR contributions.**
- Use a real HCL parser (hashicorp/hcl is the canonical lib; we'd need a port or to read the language spec and do it ourselves).
- For each `resource "aws_s3_bucket" "logs" { name = "x" }`:
  - `IacResource(provider='aws', type='s3_bucket', logical_name='logs', attributes_subset={name:'x'})`.
- For each `resource` that has `${aws_s3_bucket.logs.arn}` references in attributes: emit `provisions` edges between resources.
- `module "x" { source = "./modules/y" }` — recurse into the module path; emit a namespace.
- Outputs (`output "db_url" { value = … }`) — match against env vars (e.g., a CI step that sets `DATABASE_URL` from a Terraform output ties the IaC to the code).

**Complexity.** **L.** HCL is non-trivial; the resource-graph traversal is a chunk; provider variety means we need at least AWS/GCP/Azure recognition heuristics.

**Priority.** **P1.**

**Reality check.**
- **HCL parser availability.** No high-quality, licensable, embeddable parser exists in every language we'll need. We'll likely write our own subset parser. Plan for it.
- **`for_each` and `count`.** Resources can be cardinality-N. Track but don't try to enumerate values.
- **Locals (`locals { x = … }`)** — basic constant resolution.
- **Provider-specific resource types** are infinite. The adapter must be schema-agnostic at the IR level (just `provider`, `type`, `logical_name`); per-provider semantics live in *enrichment* rules that run optionally.
- **Sensitive values** must be masked in the viewer; the adapter must tag `sensitive=true` attributes appropriately (HCL has a `sensitive = true` flag).

---

### 7.2 Pulumi

**Detection signal.**
- `Pulumi.yaml`, `Pulumi.<stack>.yaml`. `@pulumi/aws`, `@pulumi/gcp`, etc. in deps. Or Python: `pulumi`, `pulumi_aws`, etc.

**IR contributions.**
- TS/Python program builds resources via constructor calls: `new aws.s3.Bucket('logs', {…})`, `aws.s3.Bucket('logs', BucketArgs(...))`.
- Emit `IacResource(provider='aws', type='s3.Bucket', logical_name='logs', attributes_subset)`.
- Resource references via `bucket.arn` → `references` edges. (Pulumi's `Output<T>` makes this resolvable purely as call-graph edges.)

**Complexity.** **M–L.**

**Priority.** **P1.**

**Known gotchas.**
- **Pulumi has multiple SDKs** (TypeScript, Python, Go, .NET, Java, YAML). Each is a separate adapter pass.
- **`Output<T>` and `Input<T>`** types — the IR only cares about value-level constructor calls; type erasure is fine.
- **Component resources** (subclassing `pulumi.ComponentResource`). Recurse into the constructor.
- **Stack references** (`new pulumi.StackReference(...)`) — cross-stack edges; record but don't follow.

---

### 7.3 AWS CDK

**Detection signal.**
- `aws-cdk-lib` in deps. `cdk.json` present. `App`, `Stack`, `Construct` subclasses.

**IR contributions.**
- For each `new SomeConstruct(this, 'LogicalId', props)` inside a `Stack` subclass:
  - `IacResource(provider='aws', type=construct.name, logical_name='LogicalId', attributes_subset=props_keys)`.
- L1 vs L2 vs L3 constructs:
  - L1 (`CfnBucket`) maps directly to a CloudFormation resource.
  - L2 (`Bucket`) is a higher-level wrapper that often instantiates multiple L1 resources internally — we don't recurse into the library; we emit the L2 as the IR resource.
  - L3 (`SomeStack` from a higher-level pattern lib) — same; treat as a unit.
- Cross-construct refs: `bucket.bucketArn`, `lambda.addEnvironment('TABLE_NAME', table.tableName)`.
  - The `addEnvironment(name, value)` pattern is *gold*: it's exactly the `Lambda → EnvVar → Table` chain we want. Emit `runtime_uses` and `reads_env` edges accordingly.

**Complexity.** **L.**

**Priority.** **P1.**

**Reality check.**
- **CDK source vs synth output.** We do not synth. We read the source. That means we never know the final CloudFormation logical IDs (CDK applies a hash to logical IDs). We use the `'LogicalId'` argument as the IR identity; users may need to map via `CfnElement.overrideLogicalId` overrides.
- **Construct libraries from npm** (like `@aws-cdk/aws-lambda-python-alpha`). The construct's source is in `node_modules`; we don't recurse there. We emit the construct as opaque.
- **`Lambda.fromAsset(path.join(__dirname, '../my-fn'))`** — *the* edge that connects IaC to code. Resolve `path.join` with constants to get the function source dir; emit `runs_code` edge from the Lambda to the symbol/file in that dir.
- **`Function.entry`** for `NodejsFunction` (esbuild bundling) — same edge.

---

### 7.4 SST

**Detection signal.**
- `sst.config.ts`. `"sst"` in deps. `new sst.aws.<X>(...)` calls in v3, or `new <X>(this, ...)` in v2-on-CDK.

**IR contributions.**
- v3 (Pulumi-based): mirror the Pulumi adapter, scoped to SST's namespace (`sst.aws.Function`, `sst.aws.Bucket`, `sst.aws.Nextjs`, etc.).
- v2 (CDK-based): mirror the CDK adapter.
- `sst.aws.Nextjs('Web', { path: './packages/web' })` is *the* SST primitive. Emit `runs_code` edge to the `./packages/web` Next.js project; that project's routes (via the Next.js adapter) become hosted under this SST resource.

**Complexity.** **M.** (Less than CDK because the primitives are smaller.)

**Priority.** **P1.**

**Known gotchas.**
- **The v2 → v3 migration.** Two completely different shapes. Detect by config file format.
- **SST Resource bindings** (`link: [bucket, queue]`). Emit `runtime_uses` edges from the function to the linked resources; emit `reads_env` for the auto-generated env vars (`Resource.Bucket.name`).

---

### 7.5 Serverless Framework

**Detection signal.**
- `serverless.yml` / `serverless.ts`.

**IR contributions.**
- Parse `serverless.yml`:
  - `functions:` → `IacResource(type='lambda', logical_name=<key>, handler=<path>)`.
  - `handler: src/users/list.handler` → resolve to the file `src/users/list.{ts,js,py}` and the exported `handler` symbol; emit `runs_code` edge.
  - `events:` (http, sqs, sns, schedule, s3) → emit `IacResource` for the event source and a `triggers` edge.
- `provider:` → environment, region, etc.

**Complexity.** **M.**

**Priority.** **P1.**

**Known gotchas.**
- **Plugin system** (`plugins:`). Plugins can rewrite the config arbitrarily at deploy time. We read source only; we tag the project as `plugins_present=true` so the viewer can warn.
- **Variables (`${self:provider.stage}`, `${env:X}`)** — implement basic substitution.
- **`serverless.ts`** is TS code; mostly people export an object literal. Treat as an AST traversal returning an object; convert to YAML-equivalent IR.

---

### 7.6 CloudFormation (raw YAML/JSON)

**Detection signal.**
- A YAML/JSON file with `AWSTemplateFormatVersion`, or `Resources:` top-level keys with values that have a `Type:` like `AWS::*::*`.

**IR contributions.**
- Each `Resources.Foo: { Type: AWS::S3::Bucket, Properties: {…} }` → `IacResource`.
- `!Ref Foo`, `!GetAtt Foo.Arn` → reference edges.
- `Outputs:` → `IacOutput`.

**Complexity.** **M.**

**Priority.** **P1.**

**Known gotchas.**
- **Intrinsic functions** (`Fn::Sub`, `Fn::Join`, `Fn::ImportValue`) — partial constant resolution.
- **Nested stacks (`AWS::CloudFormation::Stack`)** — recurse into the referenced template.

---

## 8. P1 — Frontend ancillaries (covered above as part of Next/Svelte/Remix/Nuxt; nothing new here)

(Folded into §3; this section intentionally short.)

---

## 9. P1 — Config-schema adapters

### 9.1 pydantic-settings

**Detection signal.**
- `from pydantic_settings import BaseSettings` (v2) or `from pydantic import BaseSettings` (v1).
- Class inheriting `BaseSettings`.

**IR contributions.**
- Each annotated class field → `EnvVar` (the field name, uppercased per the `model_config` `env_prefix`).
- `model_config` for prefix, env file, case sensitivity.
- Usage: `settings = Settings(); settings.database_url` — emit `reads_env` from the call site.

**Complexity.** **S.**

**Priority.** **P0** (we listed it under env/config).

**Known gotchas.**
- **Aliases** (`Field(alias='DATABASE_URL')`) — record both names.
- **Nested settings** (a field of type `class DBSettings(BaseSettings)`) — recurse with prefix.

---

### 9.2 viper (Go)

**Detection signal.**
- `github.com/spf13/viper` in `go.mod`.

**IR contributions.**
- `viper.GetString("foo.bar")`, `viper.GetInt(...)` — emit `EnvRead` with the key.
- `viper.SetDefault("foo.bar", "baz")` — emit a default.
- `viper.SetConfigName(...)` / `viper.AddConfigPath(...)` — record config file lookup.

**Complexity.** **S.**

**Priority.** **P1.**

**Known gotchas.**
- **Key normalization**: viper does case-insensitive, dotted keys. `os.Getenv` reads `FOO_BAR`. Emit both forms.
- **Auto-binding (`viper.AutomaticEnv()`)** — every key becomes implicitly env-readable.

---

## 10. P2 — Message queue adapters

### 10.1 BullMQ

**Detection signal.**
- `"bullmq"` in deps.
- `new Queue('name', { connection })`, `new Worker('name', processor, { connection })`.

**IR contributions.**
- `new Queue('emails')` → `Queue(name='emails', transport='bullmq')`.
- `queue.add(...)` calls → `produces_queue` edge.
- `new Worker('emails', processor)` → `consumes_queue` edge from the processor function.

**Complexity.** **S.**

**Priority.** **P2.**

**Known gotchas.**
- **Queue name aliasing**: queues constructed in a factory function with a parameter name. Static resolution may fail; mark `heuristic`.
- **Flow producer / parent-child jobs** — extra concepts; not in P2.
- **Queue events** (`new QueueEvents('emails')`) — observers, not consumers.

---

### 10.2 Celery (Python)

**Detection signal.**
- `celery` in deps. `Celery('app', broker=...)`. `@app.task` or `@shared_task` decorators.

**IR contributions.**
- Each `@app.task` decorated function → `QueueConsumer(queue=<routing_key or default>, handler=function_symbol)`.
- `task.delay(...)` / `task.apply_async(...)` → `produces_queue` edge.
- Beat schedules in `app.conf.beat_schedule = {…}` → scheduled triggers.

**Complexity.** **S.**

**Priority.** **P2.**

**Known gotchas.**
- **Routing keys vs queue names.** Celery has both; the adapter records both.
- **`task.s(...)`, `task.si(...)`, chains, groups, chords** — composition; emit edges to all referenced tasks.

---

### 10.3 Sidekiq (Ruby)

**Detection signal.**
- `Gemfile` with `sidekiq`. Class including `Sidekiq::Worker` or `Sidekiq::Job`.

**IR contributions.**
- Each worker class → `QueueConsumer(queue=<class-level option or 'default'>, handler=class)`.
- `MyWorker.perform_async(...)` → `produces_queue` edge.
- `sidekiq_options queue: 'critical'` → records queue.

**Complexity.** **S.**

**Priority.** **P2.**

---

### 10.4 SQS / SNS via AWS SDK

**Detection signal.**
- `@aws-sdk/client-sqs`, `@aws-sdk/client-sns` (JS), or `boto3` (Python with `client('sqs')`), or AWS Go SDK.
- Calls like `sqsClient.send(new SendMessageCommand({QueueUrl, MessageBody}))`.

**IR contributions.**
- `SendMessageCommand({QueueUrl: '…' })` → `produces_queue` edge to the queue identified by the URL.
- `ReceiveMessageCommand({QueueUrl})` → `consumes_queue` edge.
- For Lambda functions whose CDK definition includes `addEventSource(new SqsEventSource(queue))` — the queue is the consumer trigger; cross-link via the IaC adapter.

**Complexity.** **L.**

**Priority.** **P2.**

**Reality check.**
- **`QueueUrl` is dynamic.** Almost always it's `process.env.QUEUE_URL` or a CDK construct ref. The adapter cannot resolve URL → queue-name without crossing into the IaC layer. The strategy:
  1. Env adapter records `process.env.QUEUE_URL`.
  2. IaC adapter records the queue resource and the lambda's env var.
  3. The matcher unifies them → emit `produces_queue` to the right queue.
  This is a multi-adapter dance; if any link is missing, mark `heuristic`.
- **Manual pollers** (Node consumer that calls `ReceiveMessageCommand` in a loop) vs Lambda triggers: shape differs. Recognize both.

---

## 11. P2 — Auth adapters

These are mostly small. Their main IR contribution is *what env vars are required* + a few middleware/route patterns.

### 11.1 NextAuth (Auth.js)

**Detection signal.**
- `"next-auth"` or `"@auth/core"` in deps.
- `app/api/auth/[...nextauth]/route.ts` (App Router) or `pages/api/auth/[...nextauth].ts` (Pages Router).
- `NextAuth({ providers: [...] })` call.

**IR contributions.**
- The catch-all route is recognized by the Next.js adapter; the auth adapter *augments* it with provider info.
- For each provider in `providers: [GitHub({…}), Google({…})]`:
  - Emit `AuthProvider(name='github', client_id_env, client_secret_env)`. Discover the env vars from the provider's known config or from the option object passed in.
- `callbacks: { session, jwt, signIn }` — emit `Symbol` edges into user code.

**Complexity.** **S–M.**

**Priority.** **P2.**

**Known gotchas.**
- **NextAuth v4 vs Auth.js v5** — different module names and config shapes. Detect.
- **Database adapter** (`adapter: PrismaAdapter(prisma)`) — links to ORM; emit `uses_db_adapter` edge.

---

### 11.2 Clerk

**Detection signal.**
- `"@clerk/nextjs"`, `"@clerk/clerk-sdk-node"`, etc.
- `<ClerkProvider>` in JSX.
- `clerkMiddleware()` in `middleware.ts`.

**IR contributions.**
- `clerkMiddleware({...})` → `Middleware(provider='clerk')`.
- `auth()` calls in server components → `reads_session` edges.
- Env vars: `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (auto-discovered).

**Complexity.** **S.**

**Priority.** **P2.**

---

### 11.3 Auth0 SDK

**Detection signal.**
- `"@auth0/nextjs-auth0"` or `"auth0"` in deps.

**IR contributions.** Similar to Clerk: middleware + env vars + a couple of route handlers.

**Complexity.** **S.**

**Priority.** **P2.**

---

### 11.4 Supabase

**Detection signal.**
- `"@supabase/supabase-js"`, `"@supabase/ssr"`.

**IR contributions.**
- `createClient(url, key)` → `SupabaseClient(url_env, key_env)`.
- `supabase.from('users').select('*')` — emit `DbQuery(kind=read, model='users')` against a Supabase schema. If we can find a schema file in `supabase/schema.sql`, link.
- `supabase.auth.signIn(...)` — auth ops.

**Complexity.** **M.**

**Priority.** **P2.**

**Known gotchas.**
- **Postgres schema discovery.** Supabase projects often have `supabase/migrations/*.sql`; parse those (subset SQL parser) to learn tables. Without it, `from('users')` is a string with no schema link.
- **RLS policies** in `supabase/policies.sql` — record but don't enforce.

---

## 12. The honest reality-check matrix

For each P0 adapter, this is what we'd actually have to do, ranked by hidden cost.

| Adapter | Surface size | Hidden cost driver | True effort vs naive estimate |
|---|---|---|---|
| Express | small | Router-mount resolution across files | 3x |
| Fastify | small-medium | Plugin encapsulation; schema refs | 2x |
| FastAPI | small | Mostly clean; APIRouter include chains | 1.5x |
| Flask | small | Blueprints + MethodView | 1.5x |
| Django | medium | URL+View+ORM glued together; settings discovery | 4x |
| Next.js | large | App Router corner cases (groups, parallel, intercepts); v12→v13→v14→v15 churn | 5x |
| React Router | medium | JSX vs config form; lazy routes | 2x |
| Prisma | small | `.prisma` parser + relation resolution | 2x |
| Drizzle | medium | Fluent chain resolution; many builder shapes | 3x |
| SQLAlchemy | large | 1.x↔2.0 mix; Core vs ORM; declarative_base factories | 5x |
| Django ORM | medium | String-ref resolution across apps | 2x |
| Env | small | Wrapper-module transitive reads | 2x |
| HTTP client matcher | large | Path-template unification + base-URL + wrappers | 5x |

**Multipliers > 3x are where adapters die.** Plan for them. Do *not* commit to a P0 ship date that doesn't budget 5x time for Next.js, SQLAlchemy, and the HTTP client matcher.

---

## 13. Cross-adapter contracts

Adapters can't be siloed; the cross-service edges that matter come from *combinations*.

The contract:

1. **Each adapter publishes** its IR nodes/edges with provenance and confidence.
2. **No adapter consumes another adapter's IR directly during emit.** Instead, the *matcher* pass runs after all adapters have emitted, and it produces cross-adapter edges:
   - `HttpClientCall × HttpRoute → fetches`
   - `EnvVar (code) × EnvVar (IaC outputs/inputs) → env_provenance`
   - `IacResource (Lambda) × Symbol (handler file) → runs_code`
   - `RpcClientCall × RpcEndpoint → rpc_call`
   - `DbQuery × DbModel → reads_table/writes_table` (often emitted by the same adapter, but the matcher fixes ambiguous cases)
3. **Service inference** is its own pass: a `Service` node is inferred per workspace package, per Dockerfile, per IaC compute resource, etc. `HttpRoute`s, `EnvRead`s, etc. are scoped to their service. The cross-service edge `fetches` requires the source and target to belong to *different* services; otherwise it's intra-service navigation.

This contract is what makes new adapters cheap: a new HTTP server adapter only needs to emit `HttpRoute` correctly, and the matcher does the cross-service work for free.

---

## 14. What we're explicitly not building (in the first year)

- **Type-flow analysis** beyond simple aliasing. We are a static structure tool, not a type checker. If a user's request needs full type inference to answer, we ask the language server.
- **Runtime tracing.** Some shops want OpenTelemetry-derived edges. Out of scope; possibly a separate ingestor later.
- **LLM enrichment.** Hard rule. The whole product positioning is "deterministic, no-LLM."
- **Live IDE plugin.** The Action surface is a CLI/PR-bot first; the IDE is later.
- **C, C++, Objective-C, Swift, Kotlin (non-Spring), Elixir, Erlang, Haskell, OCaml, F#, Scala (non-Spring), PHP, Perl** indexers and adapters. Each is a year of work; not in the first year.
- **Mobile frameworks** (React Native routing, SwiftUI navigation, Jetpack Compose Navigation). Real demand exists; out of first-year scope.
- **CI/CD adapter** (GitHub Actions, GitLab CI). Useful for the env-provenance chain but treat as P2+ once the IaC adapter exists.
- **Browser API edges** (window.fetch is covered; Service Worker registration, IndexedDB schemas, WebRTC signaling) — out of scope.

---

## 15. Adapter authoring guide (one-pager)

For each new adapter, the author must produce:

1. **Adapter manifest** (`adapters/<name>/manifest.toml`): id, version, supported file globs, supported package detectors, declared IR node/edge kinds emitted, declared confidence levels possible.
2. **Detection function** (`detect(workspace) -> bool`).
3. **Emit function** (`emit(file_ast, symbol_graph) -> [IRNode, IREdge]`).
4. **Test corpus**: at least 6 fixtures (repos or repo subsets) the adapter must produce stable IR for; at least 2 of them are real OSS repos (snapshotted, vendored).
5. **Reality-check section**: written in the same honest tone as this doc. List the patterns the adapter does *not* handle and the confidence-level of edges in tricky cases.
6. **Performance budget**: must process 100k LOC in under 2s on commodity hardware (the language indexer's budget is separate). Any adapter that blows the budget needs an optimization pass before ship.

If an adapter author can't produce all six artifacts, the adapter doesn't ship.

---

## 16. Final ordered roadmap

**MVP (P0).** Ship together; demo on a Next.js + FastAPI + Prisma + Postgres + simple `.env` repo:

1. Symbol-graph layer (TS, JS, Python) — *prerequisite, not an adapter*.
2. **Env adapter** (dotenv, process.env, os.environ, import.meta.env, basic schema variants).
3. **HTTP client matcher** (TS/Python).
4. **Express** + **Fastify**.
5. **FastAPI** + **Flask**.
6. **Next.js** (App + Pages).
7. **React Router** (data router).
8. **Prisma** + **Drizzle**.
9. **SQLAlchemy**.
10. **Django** (URLs + ORM together).
11. Service inference + the matcher pass that produces `fetches`, `reads_table`, `runs_code`, `reads_env` cross-service edges.
12. Provenance/confidence rendering in the viewer.

**v0.2 (P1).** Ship in two waves:

Wave A — broaden language coverage:
- **Spring Boot**, **Rails** (with **ActiveRecord**), **ASP.NET Core**, **Gin** + **Chi**, **GORM**, **TypeORM**.

Wave B — ship the IaC layer + remaining frontends:
- **Terraform/OpenTofu**, **AWS CDK**, **SST**, **CloudFormation**, **Serverless Framework**, **Pulumi**.
- **SvelteKit**, **Remix**, **Nuxt**.
- **tRPC**, **GraphQL clients**.
- **pydantic-settings**, **viper**.
- **Koa**, **Hono**.

**v0.3+ (P2).**
- Queue adapters: **BullMQ**, **Celery**, **Sidekiq**, **SQS/SNS via SDK**.
- Auth adapters: **NextAuth**, **Clerk**, **Auth0**, **Supabase**.
- **Diesel**.
- Schema-evolution edges (Prisma migrations, Alembic, Rails migrations).
- CI adapter (`.github/workflows`, GitLab CI) for env-var provenance.

**Post-year-1.**
- Anything new this list grows by request: mobile, C/C++, Elixir, etc.

The discipline is: **don't add an adapter that doesn't help the next demo**. The roadmap above is a path of demos; each step adds a stack the previous demo couldn't render.

---

## 17. Open questions for the team

1. **Adapter authoring language.** TS for adapters or polyglot (each adapter in the language closest to the framework)? Recommendation: TS for everything except where a language-native parser is required (Ruby, Java/Kotlin, Go, C#, Rust).
2. **Confidence threshold for Action.** Should auto-applied refactors require `exact` only, or `exact + inferred`? Recommendation: `exact + inferred`, with `heuristic` highlighted but not auto-applied.
3. **Multi-version support.** Do we support Next.js 12, 13, 14, 15 simultaneously? Recommendation: support N-1 majors per adapter; document supported range in manifest.
4. **Adapter ABI stability.** When an adapter's IR shape evolves (new attributes), can existing IR caches be reused? Recommendation: every adapter manifest carries a hash; cache invalidation is per-adapter.
5. **OSS adapter contributions.** Will we accept third-party adapters into the main repo, or push them to a separate registry? Recommendation: separate registry, with a curated list shipped by default; this keeps the core focused.

---

End of catalog. Treat this as a living doc; revise when we ship each P0 adapter and again when we land the IaC layer.
