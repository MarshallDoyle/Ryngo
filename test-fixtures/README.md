# codegraph test fixtures

Curated set of small, permissively-licensed real-world projects used to exercise codegraph's static analysis across languages, frameworks, and architectural patterns. Each fixture is referenced by URL and (when used) vendored as a snapshot under `test-fixtures/<name>/` — we do not clone them at install time.

## Goals

- **Coverage:** every supported parser, ORM, framework, and IaC tool gets at least one real-project fixture.
- **Reproducibility:** pin to a specific commit SHA so golden output is stable.
- **Small:** target each fixture under 5 MB. For larger candidates, vendor only `src/` (or equivalent) and keep tests, fixtures, generated files, lockfiles, and node_modules / target / vendor out.
- **Permissive licensing:** MIT or Apache 2.0 only. No AGPL, GPL, or unlicensed code. License text is preserved alongside the snapshot.

## Fixture index

| # | Name | Stack | License | Size (snapshot) | URL |
|---|------|-------|---------|-----------------|-----|
| 1 | `prisma-express-ts-boilerplate` | TypeScript + Express + Prisma + Postgres | MIT | ~40 files / ~1.5k LOC | https://github.com/antonio-lazaro/prisma-express-typescript-boilerplate |
| 2 | `taxonomy` (subset) | TypeScript + Next.js App Router + Prisma | MIT | ~150 files / ~6k LOC (subset) | https://github.com/shadcn-ui/taxonomy |
| 3 | `fastapi-realworld` | Python + FastAPI + SQLAlchemy + Postgres | MIT | ~70 files / ~3k LOC | https://github.com/nsidnev/fastapi-realworld-example-app |
| 4 | `microblog-flask` | Python + Flask + SQLAlchemy | MIT | ~80 files / ~4k LOC | https://github.com/miguelgrinberg/microblog |
| 5 | `chi-rest-example` | Go + Chi | MIT | ~5 files / ~250 LOC | https://github.com/go-chi/chi/tree/master/_examples/rest |
| 6 | `gin-realworld` | Go + Gin + GORM | MIT | ~25 files / ~1.5k LOC | https://github.com/gothinkster/golang-gin-realworld-example-app |
| 7 | `axum-diesel-realworld` | Rust + Axum + Diesel + Postgres | MIT | ~30 files / ~1.5k LOC | https://github.com/Quentin-Piot/axum-diesel-real-world |
| 8 | `spring-petclinic` (subset) | Java + Spring Boot + Spring Data JPA | Apache-2.0 | ~70 files / ~3k LOC (subset) | https://github.com/spring-projects/spring-petclinic |
| 9 | `rails-tutorial-sample` | Ruby + Rails + ActiveRecord | MIT + Beerware | ~150 files / ~3k LOC | https://github.com/learnenough/rails_tutorial_sample_app_7th_ed |
| 10 | `fullstack-turborepo` | Monorepo: Next.js + NestJS + Prisma | MIT | ~80 files / ~3k LOC | https://github.com/ejazahm3d/fullstack-turborepo-starter |
| 11 | `nextjs-fastapi-template` | Polyglot: FastAPI (Python) + Next.js (TS) | MIT | ~120 files / ~5k LOC | https://github.com/vintasoftware/nextjs-fastapi-template |
| 12 | `synthetic` | Hand-authored multi-language IR test bed | MIT (ours) | ~10 files / ~300 LOC | (in this repo) |

> Sizes are approximate post-snapshot counts excluding lockfiles, generated artifacts, and tests we deliberately drop.

---

## 1. `prisma-express-ts-boilerplate` — TypeScript + Express + Prisma + Postgres

- **Repo:** https://github.com/antonio-lazaro/prisma-express-typescript-boilerplate
- **License:** MIT
- **Vendoring strategy:** snapshot `src/` and `prisma/schema.prisma` only. Drop `tests/`, `node_modules`, `package-lock.json`. Keep `package.json` and `tsconfig.json` so type resolution works for golden tests.
- **Codegraph features exercised:**
  - TS module graph: ES module `import` resolution across `controllers/`, `services/`, `validations/`, `middlewares/`, `utils/`.
  - HTTP route IR: `Router.get/post/put/delete()` -> handler -> service edge.
  - Prisma model -> table mapping from `schema.prisma`; `prisma.<model>.create/findMany/...` -> ORM entity edges.
  - Express middleware composition (auth, validation) as decorator-style edges on routes.
  - Zod schema -> request shape inference.
- **Complications it surfaces:**
  - Re-exports through barrel `index.ts` files.
  - Generic `catchAsync(handler)` wrappers — function-passed-as-arg dispatch.
  - Prisma client singleton imported via path alias (`@/config/prisma`) — exercises `tsconfig` paths resolution.

## 2. `taxonomy` (subset) — TypeScript + Next.js App Router + Prisma

- **Repo:** https://github.com/shadcn-ui/taxonomy (archived; pin a SHA)
- **License:** MIT
- **Vendoring strategy:** repo is moderate-sized and contains MDX content. Snapshot `app/`, `components/`, `lib/`, `hooks/`, `types/`, `prisma/schema.prisma`, `next.config.js`, `tsconfig.json`. Drop `content/`, `public/`, `__registry__/`, `styles/`, lockfiles, and any `.mdx` files.
- **Codegraph features exercised:**
  - Next.js App Router file-system routing (`app/(routes)/.../page.tsx`, `layout.tsx`, `route.ts`) -> URL IR.
  - Server Actions and Route Handlers — RPC-style edges from client components to server functions.
  - React Server Components vs Client Components (`"use client"` directive) — boundary edges in IR.
  - Prisma usage from server components and route handlers.
  - NextAuth middleware -> protected-route edges.
- **Complications it surfaces:**
  - Dynamic route segments (`[slug]`, `[...slug]`) and parallel/intercepting routes (`@modal`, `(.)slug`).
  - Imports from `@/components/ui/*` (shadcn/ui sourced into the project) — many fan-in dependencies.
  - Mixed JS/TS, MDX-as-content (we drop MDX from snapshot but document the case).

## 3. `fastapi-realworld` — Python + FastAPI + SQLAlchemy + Postgres

- **Repo:** https://github.com/nsidnev/fastapi-realworld-example-app
- **License:** MIT
- **Vendoring strategy:** snapshot `app/`, `alembic/versions/` (one or two representative migrations), `pyproject.toml`. Drop `tests/`, `postman/`, `scripts/`.
- **Codegraph features exercised:**
  - FastAPI `@router.get/post/...` -> handler -> dependency-injected services.
  - SQLAlchemy declarative models -> table IR; `relationship()` -> foreign-key edges.
  - Alembic migrations -> schema-evolution IR (optional secondary parser).
  - Pydantic schemas -> request/response shape edges; distinguish from SQLAlchemy models.
  - Repository pattern (`app/db/repositories/`) — service-to-repo edges.
- **Complications it surfaces:**
  - Heavy dependency injection via `Depends(...)` — call-graph requires resolving the `Depends` wrapper.
  - Async / sync mix; some routes are `async def`.
  - Forward-reference type hints in models (`"User"`).

## 4. `microblog-flask` — Python + Flask + SQLAlchemy

- **Repo:** https://github.com/miguelgrinberg/microblog
- **License:** MIT
- **Vendoring strategy:** snapshot `app/` (templates included for the templating IR test), `migrations/` (one), `config.py`. Drop `tests/`, `docker/`, `compose.yaml`.
- **Codegraph features exercised:**
  - Flask `@blueprint.route(...)` -> view function edges across `app/main`, `app/auth`, `app/api`, `app/errors`.
  - Application factory pattern (`create_app()`) — registration of blueprints.
  - Flask-SQLAlchemy models with `db.relationship()` and many-to-many association tables.
  - Jinja2 template references from `render_template("...")` — view-to-template edges.
- **Complications it surfaces:**
  - Circular-ish imports resolved through factory pattern (`from app import db` inside functions).
  - Late binding of routes via blueprint registration in `create_app`.
  - Email + background task entry points (`app/tasks.py` + `rq` worker) — secondary process boundaries.

## 5. `chi-rest-example` — Go + Chi

- **Repo:** https://github.com/go-chi/chi (use `_examples/rest/main.go` and supporting files)
- **License:** MIT
- **Vendoring strategy:** snapshot just `_examples/rest/`. The whole example is a single self-contained `main.go` (~500 LOC) plus a tiny `go.mod` we author for the snapshot.
- **Codegraph features exercised:**
  - Chi `r.Route`, `r.Get`, `r.Mount`, sub-routers — nested route IR.
  - Middleware chains (`r.Use(...)`).
  - Context-based request scoping via `r.Context()`.
  - Handler funcs as values passed to router (function-as-data).
- **Complications it surfaces:**
  - Single-file pattern — exercises in-file scope resolution rather than cross-file.
  - Uses no ORM — fixture for "HTTP without DB" baseline.
  - Pair this with #6 to cover both no-ORM and ORM Go.

## 6. `gin-realworld` — Go + Gin + GORM

- **Repo:** https://github.com/gothinkster/golang-gin-realworld-example-app
- **License:** MIT
- **Vendoring strategy:** snapshot full repo minus `vendor/` and tests. Already small (~25 files).
- **Codegraph features exercised:**
  - Gin `router.GET/POST/...` and route groups (`router.Group("/api")`).
  - GORM models with `gorm.Model` embedding and `belongsTo` / `hasMany` tags -> ORM edges.
  - Domain-package layout (`users/`, `articles/`, `common/`) — exercises Go package import graph.
  - JWT middleware as Gin handler — middleware-to-route edges.
- **Complications it surfaces:**
  - Struct embedding — codegraph must surface inherited fields/methods.
  - Init-time route registration spread across multiple `RegisterRoutes(...)` functions per package.
  - GORM v1 -> v2 transition tags; older code may use `jinzhu/gorm`. Pin to a recent commit on `master`.

## 7. `axum-diesel-realworld` — Rust + Axum + Diesel + Postgres

- **Repo:** https://github.com/Quentin-Piot/axum-diesel-real-world
- **License:** MIT
- **Vendoring strategy:** snapshot `src/`, `migrations/`, `Cargo.toml`, `diesel.toml`. Drop `Dockerfile*`, `target/`.
- **Codegraph features exercised:**
  - Axum `Router::new().route("/...", get(handler))` — route IR via builder pattern.
  - Tower middleware layers (`.layer(...)`).
  - Diesel schema (`schema.rs`) auto-generated table IR + manual model structs with `#[derive(Queryable, Insertable)]` -> ORM edges.
  - DDD layout: `domain/`, `infrastructure/`, `handlers/` — clear architectural layer edges.
- **Complications it surfaces:**
  - Heavy use of generics and traits (`AppState`, `impl Trait`) — codegraph must avoid drowning in monomorphizations.
  - `mod.rs` re-export tree.
  - Macro-generated Diesel `schema.rs` (parser must accept it as data, not source-of-truth-only).

## 8. `spring-petclinic` (subset) — Java + Spring Boot + Spring Data JPA

- **Repo:** https://github.com/spring-projects/spring-petclinic
- **License:** Apache-2.0
- **Vendoring strategy:** repo is ~3 MB but assets and CSS dominate. Snapshot `src/main/java/`, `src/main/resources/templates/`, `pom.xml`. Drop `src/main/resources/static/`, `src/test/`, `docker-compose.yml`, `.mvn/`.
- **Codegraph features exercised:**
  - `@RestController` / `@Controller` + `@GetMapping` / `@PostMapping` -> route IR.
  - Spring Data JPA: `interface OwnerRepository extends JpaRepository<Owner, Integer>` — derived-query method names (`findByLastName`) become DB-access edges by convention.
  - JPA `@Entity` / `@OneToMany` / `@ManyToOne` -> ORM edges.
  - Thymeleaf template references from controllers (`return "owners/findOwners"`).
  - Spring profiles + `application-*.properties` -> configuration IR.
- **Complications it surfaces:**
  - Annotation-driven dependency injection — call-graph requires interpreting `@Autowired` and constructor injection.
  - Method-name-derived queries (no SQL string to pattern-match).
  - Classpath-scanning beans — every package is implicitly wired.

## 9. `rails-tutorial-sample` — Ruby + Rails + ActiveRecord

- **Repo:** https://github.com/learnenough/rails_tutorial_sample_app_7th_ed
- **License:** MIT + Beerware (dual)
- **Vendoring strategy:** snapshot `app/`, `config/routes.rb`, `config/application.rb`, `db/migrate/`, `db/schema.rb`, `Gemfile`. Drop `test/`, `vendor/`, `node_modules/`, `public/`, `storage/`.
- **Codegraph features exercised:**
  - `config/routes.rb` DSL (`resources :users`, nested `resources`, `root`) -> URL IR.
  - ActiveRecord models: `has_many`, `belongs_to`, `has_secure_password`, `before_save` callbacks -> ORM edges + lifecycle hooks.
  - `db/schema.rb` -> table IR (canonical schema source).
  - Action controllers + ERB views + partial includes (`render "shared/header"`) -> controller-to-view-to-partial edges.
  - Rails concerns (mixins under `app/controllers/concerns/` and `app/models/concerns/`).
- **Complications it surfaces:**
  - Heavy metaprogramming: `has_many` defines accessor methods at runtime — codegraph must teach the parser the convention.
  - Implicit-render controllers (no explicit `render` call -> view path inferred from action name).
  - Strong parameters and helper modules sprinkled across files.

## 10. `fullstack-turborepo` — Monorepo (Next.js + NestJS + Prisma)

- **Repo:** https://github.com/ejazahm3d/fullstack-turborepo-starter
- **License:** MIT
- **Vendoring strategy:** snapshot `apps/api/src/`, `apps/web/src/` (or `app/`), `apps/web/next.config.js`, `packages/`, `prisma/`, root `turbo.json`, root `package.json`, `pnpm-workspace.yaml`. Drop `nginx/`, `Dockerfile`s, lockfiles, tests.
- **Codegraph features exercised:**
  - **Cross-service edges:** the test bed for codegraph's "this Next.js page calls this NestJS endpoint" feature. Match on shared types from `packages/types` or on URL path heuristics.
  - Workspace package resolution via `pnpm-workspace.yaml` and `package.json` `workspaces`.
  - Turbo task graph (`turbo.json`) -> build-graph IR.
  - NestJS controllers + decorators (`@Controller`, `@Get`, `@Body`) on the API side; Next.js App Router on the web side.
  - Prisma schema shared between apps (or duplicated; both cases worth testing).
- **Complications it surfaces:**
  - TS path aliases (`@app/*`, `@web/*`) interacting with workspace package resolution.
  - Same Prisma model used as DB entity in API and as transport type on web.
  - Two `tsconfig.json` files extending a base — codegraph must walk `extends` chain.

## 11. `nextjs-fastapi-template` — Polyglot (FastAPI Python + Next.js TypeScript)

- **Repo:** https://github.com/vintasoftware/nextjs-fastapi-template
- **License:** MIT
- **Vendoring strategy:** snapshot `fastapi_backend/app/`, `nextjs-frontend/src/`, `fastapi_backend/pyproject.toml`, `nextjs-frontend/package.json`, root config. Drop tests, lockfiles, generated OpenAPI clients (we want codegraph to compute the cross-language edge itself, not rely on the generated client as the answer).
- **Codegraph features exercised:**
  - **Polyglot cross-service edges:** Python FastAPI route `@router.get("/items/")` matched to TypeScript `fetch("/api/items/")` or generated client call.
  - SQLAlchemy / SQLModel models on Python side; Zod schemas on TS side. Compare/contrast IR shapes.
  - OpenAPI schema as an intermediate graph anchor.
  - Auth flow spanning both stacks (JWT issued by FastAPI, consumed by Next.js).
- **Complications it surfaces:**
  - Two language toolchains in one repo (`uv`/`poetry` + `pnpm`).
  - The "ground truth" cross-service edge requires either path matching, OpenAPI ingestion, or generated-client recognition — exercises codegraph's matching heuristics.
  - Different ORMs + different validators on each side describing the same domain object.

## 12. `synthetic/` — hand-authored IR coverage fixture

A tiny, hand-written fixture we own and ship in this repo. Each file targets a specific IR feature; the fixture has hand-written expected IR JSON next to it for golden-test diffing.

- **License:** MIT (codegraph project's own license).
- **Layout:**

```
test-fixtures/synthetic/
  README.md                  # what each file proves
  src/
    01_imports.ts            # plain ES module import / re-export / barrel
    02_routes.ts             # Express-style route declarations + middleware chain
    03_orm.ts                # Prisma-style model + query usage
    04_dynamic_dispatch.ts   # function-as-arg, method on a typed interface
    05_generics.ts           # generic class + type-parameter resolution
    06_python_fastapi.py     # FastAPI route + Pydantic schema + Depends
    07_python_sqlalchemy.py  # SQLAlchemy declarative model + relationship
    08_go_chi.go             # Chi router + middleware + handler
    09_iac.tf                # Terraform: aws_lambda_function -> aws_dynamodb_table
    10_polyglot_edge/
      api.py                 # FastAPI: GET /widgets/:id
      web.ts                 # fetch("/widgets/" + id) — expected cross-language edge
  expected/
    01_imports.ir.json       # golden IR for 01
    02_routes.ir.json
    ...                      # one .ir.json per source file (or per logical group)
```

- **What each file proves:**
  - `01_imports.ts` — `import { x } from "./y"`, `export *`, default export, namespace import.
  - `02_routes.ts` — `app.get("/foo", auth, handler)` produces a route node with middleware edges.
  - `03_orm.ts` — `prisma.user.findMany({ where: ... })` produces a DB-access edge to the `User` model declared above in the same file.
  - `04_dynamic_dispatch.ts` — `function call(fn: Handler) { fn(...) }` — expected: edge marked as "indirect / function-typed".
  - `05_generics.ts` — `class Repo<T>` + `new Repo<User>()` — type-param resolution test.
  - `06_python_fastapi.py` — `@app.get("/x")` + `Depends(get_db)` produces route + dependency edge.
  - `07_python_sqlalchemy.py` — declarative `class User(Base)` with `Column` and `relationship("Post")` — table IR + FK edge.
  - `08_go_chi.go` — `r.Route("/api", func(r) { r.Get("/x", h) })` — nested-route IR.
  - `09_iac.tf` — `aws_lambda_function.foo` references `aws_dynamodb_table.bar.name` — IaC resource graph edge.
  - `10_polyglot_edge/` — minimal Python+TS pair where the only signal is the URL string; tests cross-language edge inference.

- **How to use:** `synthetic/` is the first thing every parser should pass. Treat it as the unit-test layer; fixtures 1–11 are the integration layer.

---

## Adding a new fixture

1. Find a project under MIT or Apache-2.0 with a clear `LICENSE` file.
2. Pin to a specific commit SHA. Record the SHA in this README and in `test-fixtures/<name>/.source`.
3. Vendor only the source tree we need; never check in lockfiles, `node_modules`, `target/`, `vendor/`, generated clients, or large static assets.
4. Copy the upstream `LICENSE` file into the snapshot directory verbatim and add a `NOTICE.md` recording origin URL + SHA + the subset taken.
5. Add an entry to the table above and a section below it.
6. Add a golden-IR snapshot under `expected/<name>.ir.json` (start with a coarse-grained one and tighten as the parser stabilizes).

## Open questions / TODO

- Pick exact commit SHAs for fixtures 1, 3, 6, 7, 9, 10, 11 once we cut the first snapshot.
- Decide whether `taxonomy` archived status is acceptable — it's archived but stable, which is actually good for golden tests. Re-evaluate if we need a more current Next.js sample.
- Decide whether to include a Terraform-only fixture in addition to `synthetic/09_iac.tf`. Candidate: a small AWS Lambda + DynamoDB sample under MIT.
- Consider adding a Kubernetes manifest fixture (separate from IaC) once codegraph supports it.
