# synthetic — hand-authored IR coverage fixture

Tiny, hand-written multi-language fixture that exercises specific codegraph
IR features. Each source file targets one feature and ships with a hand-
authored golden IR JSON next to it. Together these are the *unit-test layer*
of codegraph: the first thing every parser, indexer, or adapter is run
against. The integration-layer fixtures (real-world projects) live in the
sibling subdirectories under `test-fixtures/`.

This fixture is part of the codegraph repo and licensed MIT (the project's
own license).

## Layout

```
test-fixtures/synthetic/
  README.md                    # this file
  src/
    01_imports.ts              # plain ES module imports / re-exports / barrel
    _helpers.ts                # companion module imported by 01
    02_routes.ts               # Express-style route declarations + middleware
    03_orm.ts                  # Prisma-style model + queries
    04_dynamic_dispatch.ts     # function-as-arg + interface-method indirection
    05_generics.ts             # generic class + type-parameter resolution
    06_python_fastapi.py       # FastAPI route + Pydantic schema + Depends()
    07_python_sqlalchemy.py    # SQLAlchemy declarative model + relationship()
    08_go_chi.go               # Chi router with nested r.Route + middleware
    09_iac.tf                  # Terraform aws_lambda_function -> aws_dynamodb_table
    10_polyglot_edge/
      api.py                   # FastAPI: GET /widgets/{widget_id}
      web.ts                   # fetch("/widgets/" + id) — cross-language pair
  expected/
    01_imports.ir.json         # golden IR document for 01
    02_routes.ir.json
    03_orm.ir.json
    04_dynamic_dispatch.ir.json
    05_generics.ir.json
    06_python_fastapi.ir.json
    07_python_sqlalchemy.ir.json
    08_go_chi.ir.json
    09_iac.ir.json
    10_polyglot_edge.ir.json
```

The goldens follow the canonical IR document shape (see `spec/ir-schema.md`,
`spec/ir.schema.json`, and `packages/core/src/ir/types.ts`):

```jsonc
{ "schemaVersion": "0.1.0",
  "ir": { "metadata": { … }, "nodes": [ … ], "edges": [ … ],
          "diagnostics": [ … ] /* optional */ } }
```

## What each file proves

| File | Feature | Key IR shapes |
|------|---------|---------------|
| `01_imports.ts` | Named, default, namespace imports; `export *` and `export {…} from`. | Five `import` edges with distinct `symbols[]` arrays; `tags: ["re-export"]` on the `export {…} from` and `tags: ["re-export-star"]` on the `export *`. Three `call` edges from `compute` to `add`/`sub`/`mul` with `callKind: "direct"`. |
| `02_routes.ts` | `app.get/post(path, …chain, handler)` produces a route node + middleware-as-call edges. | One `http-route` edge per handler with `method: "GET"`/`"POST"`, `framework: "express"`. Middleware appears as `call` edges tagged `["middleware"]` from the handler to each middleware function in source order. `req.params.id` and `req.body` lift to `http-input` leaf expressions. |
| `03_orm.ts` | Prisma-style model + `findMany`/`create` lift to ORM edges. | One `db-read` edge with `store: "postgres"`, `entity: "User"`. One `db-write` edge with `op: "create"`. The expression nodes carry both the leaf/sink flavor and the same store/entity for the per-call payload. |
| `04_dynamic_dispatch.ts` | Function-as-arg and interface-method calls produce indirect edges. | `call` edge with `callKind: "dynamic"` from `invoke` to the `Handler` type (function-typed parameter). `call` edge with `callKind: "virtual"` from `dispatch` to the `Processor` type. Diagnostics record the indirection. |
| `05_generics.ts` | Generic class + `new Repo<User>()` resolves T -> User in the value type. | The `call` edge from `makeUserRepo` to the constructor expression carries `valueType.structural` describing `Repo<User>` as a `kind: "generic"` node with one `args: [{kind:"ref", name:"User"}]`. Methods get a `receiverType` of `Repo<T>`. |
| `06_python_fastapi.py` | `@router.get("/widgets/{widget_id}")` + `Depends(get_db)`. | One `http-route` edge with `framework: "fastapi"`. One `call` edge from `read_widget` to `get_db` tagged `["depends"]`. Pydantic class is tagged `["pydantic-model"]`. |
| `07_python_sqlalchemy.py` | Declarative `User`/`Post` with `relationship(...)` + `ForeignKey(...)`. | Two `type` nodes tagged with `table:<name>`. Three `type-flow` edges of role `field-read`: `Post -> User` for the FK (`tags: ["foreign-key", …]`) and the two `relationship()` directions tagged `["relationship", …]`. |
| `08_go_chi.go` | `r.Route("/api", func(r) { r.Get("/health", h); … })` produces nested route IR. | Route literals are the **prefix-joined** paths (`"/api/health"`, `"/api/widgets/{id}"`). Middleware (`r.Use(logger)`) shows up as a `call` edge tagged `["middleware"]` from each handler. `NewRouter` carries `call` edges tagged `["route-register"]`/`["middleware-register"]` to the handlers and the middleware. |
| `09_iac.tf` | `aws_lambda_function.processor` references `aws_dynamodb_table.events.name`. | Two `type` nodes (`kind: "resource"`) for the resources. Two `type-flow` edges of role `field-read`: lambda -> attr-ref expression -> table, with `tags: ["terraform-depends-on", "attribute:name"]` on the cross-resource edge. |
| `10_polyglot_edge/` | Cross-language `fetch("/widgets/" + id)` paired with FastAPI route by URL. | TS side: `fetch` lifts to an expression carrying `leaf: external-api` *and* `sink: network`. Python side: standard `http-route` edge. The polyglot adapter emits a final `call` edge from the TS fetch site to the Python handler with `tags: ["polyglot", "url-match:/widgets/{widget_id}"]` and a diagnostic recording the pairing. |

## Conventions

### Service rooting

Every golden contains exactly one `service` node, whose canonical signature is
`service||test-fixtures/synthetic` (empty `repo`, per spec §6 "empty string
for local analysis"). All other nodes parent up through this service. The
service id is therefore identical across all goldens, which makes
cross-fixture aggregation tests trivial (see "Aggregation tests" below).

### Node IDs

Node IDs are BLAKE3-128 hex digests of the canonical signature string
(lowercase, 32 hex chars), per `spec/ir-schema.md` §6. The signature shapes
follow the table in §6:

- `service|<repo>|<service-path>`
- `module|<service-id>|<repo-relative path>`
- `type|<parent-id>|<fqn>`
- `function|<parent-id>|<name>|<arity>|<param-type-displays-comma-joined>` (+ `|<receiver-type-display>` for methods)
- `expression|<parent-function-id>|<role>|<canonical literal-or-symbol payload>|<lexical-occurrence index>`

The full signature string is also stored on every node as `signature` —
opaque to viewers but invaluable when debugging "why did this id change?".

### Determinism

The goldens are byte-equal across runs. Keys are sorted at every level,
arrays preserve source order, indent is 2 spaces, and every file ends with
a trailing newline. The same canonicalization is what `serializeIR` in
`packages/core/src/ir/io.ts` produces, so analyzer output can be diffed
against these goldens with `diff -u` or any structural JSON differ.

### Metadata `repo` and `commit`

All goldens use `repo: ""` and `commit: "0000000000000000000000000000000000000000"`.
The empty `repo` is the spec's "local analysis" sentinel; the all-zero commit
is a placeholder so determinism is preserved without a real git ref. Tests
that exercise commit-aware behavior should override these fields explicitly.

## How to use

### As a parser/indexer smoke test

Run your indexer against `src/<file>` and structurally compare the output to
`expected/<file>.ir.json`. The goldens are deliberately small so a failing
test can be diffed line-by-line.

```sh
codegraph index --root test-fixtures/synthetic/src \
                --files 01_imports.ts \
                --output - | diff -u expected/01_imports.ir.json -
```

(Real comparison usually goes through a structural differ so unrelated key
ordering doesn't trip the test — but the goldens are key-sorted, so plain
`diff` works for byte-equal mode too.)

### As an adapter-feature checklist

Each row in the table above is a feature an adapter must surface. When a new
adapter lands (or an existing one grows a feature), check that the
corresponding golden's edges/leaves still match its output. If you grow the
IR with a new edge category or leaf flavor, add a synthetic file that
demonstrates it and a golden that anchors the expected shape.

### Aggregation tests

Concatenating all ten goldens' `nodes` and `edges` produces a single coherent
graph (the synthetic service holds modules from many files, but no node or
edge id collides because every signature is parent-id-derived). Tests that
exercise the diff engine, the renderer, or the validator at the document
level can use the union as a richer fixture without authoring more sources.

## Adding a new synthetic case

1. Add a source file under `src/` named `NN_<feature>.ext`. Keep it under
   ~30 LOC where possible.
2. Add a row to the table above.
3. Author the matching `expected/NN_<feature>.ir.json`. Use the canonical
   signature shapes from spec §6 and BLAKE3-128 hex node ids; canonicalize
   the JSON (sorted keys, 2-space indent, trailing newline).
4. Run `diff` between two regenerations of your golden to confirm
   byte-equality.

If a new feature requires additions to the IR schema itself, propose them
upstream first — the synthetic fixture's job is to *exercise* the IR, not
to extend it.
