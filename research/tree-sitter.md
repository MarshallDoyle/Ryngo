# Tree-sitter Strategy for codegraph

> **Scope**: how codegraph uses tree-sitter as the universal fallback parser for
> languages where SCIP indexers don't exist, are immature, or are too slow for
> incremental analysis. This document covers grammar selection, query design,
> resolution heuristics, performance, and runtime deployment (native vs WASM).
>
> **Status**: design / planning. No installs performed. Gaps in tree-sitter
> coverage are documented honestly so adapter authors know where to expect pain.

---

## 1. Two-tier indexing model

codegraph runs a **two-tier indexer** per language. The output of both tiers is
the same canonical Symbol/Reference graph so downstream consumers (framework
adapters, IR, viewer, GitHub Action diff) never need to know which tier
produced the data.

### Tier A — SCIP (preferred)

Run an off-the-shelf SCIP indexer when one exists and is mature enough:

- `scip-typescript` (TS/JS, including JSX/TSX)
- `scip-python` (Python, with pyright-quality inference)
- `scip-java` (Java + Kotlin via the same JVM frontend)
- `scip-go` (Go modules)
- `scip-ruby` (via Sorbet's frontend)
- `scip-clang` (C/C++, with `compile_commands.json`)

SCIP gives us **type-resolved cross-references**: `foo.bar()` resolves to the
exact `bar` definition, not "any symbol named `bar` in scope." codegraph
ingests the SCIP index, normalises symbol monikers to its internal scheme, and
emits resolved edges directly.

### Tier B — Tree-sitter (fallback / always-available)

Run our tree-sitter pipeline:

1. Always, for **purely-syntactic** facts (file structure, class hierarchy
   shape, import lists, route declarations in framework adapters).
2. As the **only** indexer for languages without a usable SCIP backend.
3. To **augment** SCIP output with framework-specific patterns SCIP doesn't
   model (e.g. Express route registrations, Rails `resources :foo`, Django URL
   patterns).

Tier B never produces type-resolved edges with the same confidence as Tier A.
Edges it produces are tagged with a `resolution` field (see §4) so the viewer
can render them differently (solid vs dashed) and the diff action can treat
them with appropriate scepticism.

### When both tiers run on the same file

SCIP wins for any edge it produces. Tree-sitter contributes edges that SCIP
didn't produce (typically framework conventions and dynamic dispatch
heuristics). Conflicts — same source/target/kind — are resolved in favour of
SCIP, with the tree-sitter edge dropped silently.

---

## 2. Language coverage matrix

Legend:

- **SCIP**: mature production-quality indexer exists; codegraph uses it
  as Tier A.
- **SCIP (partial)**: indexer exists but has known gaps codegraph covers with
  Tier B.
- **TS-only**: no usable SCIP indexer; tree-sitter is the only source.
- **Grammar**: the canonical tree-sitter grammar package codegraph bundles or
  requires.

| Language       | Tier A status                | Tier B grammar                    | Notes / gaps                                                              |
| -------------- | ---------------------------- | --------------------------------- | ------------------------------------------------------------------------- |
| JavaScript     | SCIP (`scip-typescript`)     | `tree-sitter-javascript`          | TS grammar handles JS too; JS-only grammar kept for plain `.js` speed.    |
| TypeScript     | SCIP (`scip-typescript`)     | `tree-sitter-typescript` (TS+TSX) | Two grammars: `typescript` and `tsx`. Pick by extension.                  |
| Python         | SCIP (`scip-python`)         | `tree-sitter-python`              | SCIP relies on pyright; falls back to TS for missing stubs.               |
| Go             | SCIP (`scip-go`)             | `tree-sitter-go`                  | Tier B for Go templates (`tree-sitter-gotmpl`) — no SCIP coverage.        |
| Rust           | SCIP (partial, `scip-rust`)  | `tree-sitter-rust`                | `scip-rust` is rust-analyzer-based; macros expanded only when reachable.  |
| Java           | SCIP (`scip-java`)           | `tree-sitter-java`                | Annotation processors run in SCIP; TS sees the source-as-written only.    |
| Ruby           | SCIP (`scip-ruby`, partial)  | `tree-sitter-ruby`                | Sorbet-typed code only; untyped Ruby is effectively TS-only.              |
| C              | SCIP (`scip-clang`)          | `tree-sitter-c`                   | Requires `compile_commands.json` for SCIP; TS works without it.           |
| C++            | SCIP (`scip-clang`)          | `tree-sitter-cpp`                 | Same caveat. Templates / SFINAE not fully resolved by clangd-SCIP.        |
| PHP            | TS-only                      | `tree-sitter-php` (`php`, `php_only`) | No production SCIP indexer; framework adapters (Laravel, Symfony) carry the load. |
| C#             | TS-only (today)              | `tree-sitter-c-sharp`             | scip-dotnet exists but is alpha; reassess per release. TS for now.        |
| Kotlin         | SCIP via `scip-java` (Gradle) | `tree-sitter-kotlin`              | JVM-Kotlin only. KMP/native, KMP/JS use TS.                               |
| Swift          | TS-only                      | `tree-sitter-swift`               | scip-swift exists but is unstable on non-Xcode projects.                  |
| Scala          | SCIP via `scip-java` (Bloop)  | `tree-sitter-scala`               | Tier A for Scala 2.x with SemanticDB; Scala 3 partial.                    |
| Elixir         | TS-only                      | `tree-sitter-elixir`              | No SCIP indexer. Phoenix routes via Tier B macro pattern matching.        |
| Lua            | TS-only                      | `tree-sitter-lua`                 | No SCIP. Heavy reliance on resolution heuristics (§4).                    |

### Bundled vs required grammars

codegraph **bundles** grammars for the top-tier languages (JS, TS, TSX,
Python, Go, Rust, Java, Ruby, C, C++) as compiled artefacts (native `.node` or
`.dylib`/`.so`/`.dll` for the CLI, `.wasm` for the viewer). These are pinned
to specific grammar versions in `packages/tree-sitter/package.json`.

Less-common grammars (PHP, C#, Kotlin, Swift, Scala, Elixir, Lua, plus
secondary grammars like Go templates, GraphQL, HTML, CSS, YAML, JSON, TOML,
Bash, Markdown, regex, Dockerfile) are **lazy-loaded** on first use. The CLI
downloads pre-built artefacts from a codegraph-hosted CDN (versioned by
grammar tag + ABI). Users can opt out with `--no-download` and supply their
own paths.

### Grammar version pinning

Tree-sitter grammars are not stable. A query that works on
`tree-sitter-python@0.20.4` may produce different node names on `0.21.0`.
codegraph pins each grammar to an exact version per release and runs the full
query corpus against the new version before bumping. The pin lives in
`packages/tree-sitter/grammar-versions.json` and is consumed by both the
native build script and the WASM build pipeline.

---

## 3. Query strategy (`.scm` files)

We extract three kinds of fact per file via tree-sitter queries:

1. **Definitions** — symbols this file introduces (functions, classes,
   methods, variables, types, modules).
2. **References** — places this file uses a name (call sites, type
   annotations, decorator/annotation uses, attribute access).
3. **Imports** — module/package boundaries this file declares (so we can
   later resolve cross-file references).

Each is a separate `.scm` query file per language, captured at well-known
names. The pipeline wires capture name → record kind:

```
@def.function       -> Definition { kind: "function" }
@def.class          -> Definition { kind: "class" }
@def.method         -> Definition { kind: "method", parent: <enclosing class> }
@def.variable       -> Definition { kind: "variable" }
@def.type           -> Definition { kind: "type" }
@ref.call           -> Reference { kind: "call" }
@ref.identifier     -> Reference { kind: "use" }
@ref.attribute      -> Reference { kind: "attribute" }
@ref.type           -> Reference { kind: "type-use" }
@import.module      -> Import { kind: "module" }
@import.symbol      -> Import { kind: "named", local: <alias if present> }
@import.alias       -> Import { kind: "named", alias: <captured node> }
@scope              -> Scope boundary (function, class, block, module)
@name               -> The actual identifier within any of the above
```

Files live in `packages/tree-sitter/queries/<lang>/{defs,refs,imports}.scm`.
The runtime concatenates the three into one query per file pass to amortise
parse cost.

### 3.1 Example: JavaScript / TypeScript definitions (`defs.scm`)

Captures top-level functions, arrow functions assigned to variables, classes,
methods, and re-exported declarations. The TS variant adds interface, type
alias, and enum captures by composition.

```scheme
;; ----- Function declarations -----
(function_declaration
  name: (identifier) @name
) @def.function

;; ----- `const foo = () => { ... }` and `const foo = function () { ... }` -----
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)]
  )
) @def.function

;; ----- Classes, including class expressions assigned to a name -----
(class_declaration
  name: (type_identifier) @name
) @def.class

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (class) @def.class
  )
)

;; ----- Methods inside classes -----
(class_body
  (method_definition
    name: (property_identifier) @name
  ) @def.method
)

;; ----- Object-literal methods (e.g. `module.exports = { foo() {} }`) -----
(pair
  key: (property_identifier) @name
  value: [(arrow_function) (function_expression)]
) @def.function

;; ----- Re-exports: `export { foo } from "./bar"` -----
(export_statement
  (export_clause
    (export_specifier
      name: (identifier) @name
    )
  )
  source: (string)? @import.module
) @def.reexport
```

The capture name `@def.function` lives on the *whole declaration node*, while
`@name` is the identifier subtree. This lets the consumer record both the
symbol's range (for "find definition") and the body range (for hover and
diffing).

### 3.2 Example: Python definitions and imports (`defs.scm` + `imports.scm`)

Python's `tree-sitter-python` makes definitions easy because the parse tree
mirrors the syntax closely. The interesting case is decorated functions where
we want the decorator chain captured too — framework adapters use this.

`defs.scm`:

```scheme
;; ----- Functions (sync + async) -----
(function_definition
  name: (identifier) @name
) @def.function

;; ----- Methods are functions whose immediate parent is a class body. -----
;; The pipeline post-processes @def.function captures to promote them to
;; @def.method when the parent chain is class_definition -> block.

;; ----- Classes -----
(class_definition
  name: (identifier) @name
) @def.class

;; ----- Module-level assignments: `FOO = ...` becomes a constant def. -----
(module
  (expression_statement
    (assignment
      left: (identifier) @name
    )
  )
) @def.variable

;; ----- Decorators on the def: capture the decorator path so adapters can
;; spot @app.route, @pytest.fixture, @celery.task, @api_view, etc.
(decorated_definition
  (decorator (_) @ref.decorator)
  definition: (_) @def.target
) @def.decorated
```

`imports.scm`:

```scheme
;; ----- `import foo` and `import foo.bar as baz` -----
(import_statement
  name: (dotted_name) @import.module
)

(import_statement
  name: (aliased_import
    name: (dotted_name) @import.module
    alias: (identifier) @import.alias
  )
)

;; ----- `from foo import bar` and `from foo import bar as baz` -----
(import_from_statement
  module_name: (dotted_name) @import.module
  name: (dotted_name) @import.symbol
)

(import_from_statement
  module_name: (dotted_name) @import.module
  name: (aliased_import
    name: (dotted_name) @import.symbol
    alias: (identifier) @import.alias
  )
)

;; ----- `from foo import *` — flagged so resolution gives up gracefully -----
(import_from_statement
  module_name: (dotted_name) @import.module
  (wildcard_import) @import.wildcard
)

;; ----- Relative imports: capture the dot count for resolution -----
(import_from_statement
  module_name: (relative_import) @import.relative
)
```

### 3.3 Example: Go references and method calls (`refs.scm`)

Go's grammar distinguishes selector expressions from plain identifier uses,
which we exploit to separate `pkg.Func()` from `localFunc()`:

```scheme
;; ----- Plain calls: `foo(...)` -----
(call_expression
  function: (identifier) @name
) @ref.call

;; ----- Method or package calls: `pkg.Func(...)` or `obj.Method(...)` -----
(call_expression
  function: (selector_expression
    operand: (_) @ref.receiver
    field: (field_identifier) @name
  )
) @ref.call

;; ----- Type references in declarations -----
(type_identifier) @ref.type

;; ----- Field access: `obj.Field` (non-call) -----
(selector_expression
  operand: (_) @ref.receiver
  field: (field_identifier) @name
) @ref.attribute
```

The `@ref.receiver` capture is intentionally a generic `(_)` node — it can be
an identifier (`pkg`), another selector (`a.b.c`), an index expression
(`arr[i].Method`), or a parenthesised expression. The resolver inspects the
receiver tree and chooses the right strategy (§4).

### 3.4 Query authoring conventions

- **One concept per pattern.** Don't try to alternate over many shapes in a
  single pattern; tree-sitter's matcher is happier with several small
  patterns, and they're easier to debug.
- **Capture the smallest useful node.** `@name` should always land on the
  identifier or property-identifier, never the whole declaration.
- **Put the whole-construct capture last.** `@def.function` on the outer
  `function_declaration` lets consumers walk back to the body when they need
  to.
- **Use `#match?` and `#eq?` predicates sparingly.** They run in the host and
  defeat caching. Push lexical filtering to the consumer where possible.
- **Test queries against fixtures.** Each language's query file ships with a
  `fixtures/` directory and a snapshot test that asserts the captures on a
  representative file. Snapshots regenerate when grammars bump.

---

## 4. Symbol resolution without types

Tree-sitter gives us a parse tree, not a type system. To resolve `foo.bar()`
to a definition we layer four mechanisms, each with progressively more
confidence and progressively less coverage:

1. **Same-file lexical scoping** (high confidence)
2. **Import-aware cross-file matching** (medium)
3. **Project-wide name matching** (low; produces "candidate" edges)
4. **Explicit unresolved markers** (when nothing matches, or matches are
   ambiguous beyond a threshold)

### 4.1 Scope tracking

Per language we define a small **scope tree** built from the parse tree:

- The query file marks scope-introducing nodes with `@scope.module`,
  `@scope.class`, `@scope.function`, `@scope.block`.
- A pass walks captures in document order and threads a scope stack.
- Each definition (`@def.*`) is bound to the innermost enclosing scope.
- Each reference (`@ref.*`) starts a lookup at its enclosing scope and walks
  outward. The first matching binding (by `@name`) wins.

This handles the common cases:

```python
def outer():
    def inner():
        pass
    inner()      # @ref.call resolves to the local `inner` def
inner()          # @ref.call walks past `outer`'s scope, fails locally,
                 # falls through to step 2 (cross-file resolution)
```

Languages with hoisting (JavaScript `function` declarations) or block scoping
(`let`/`const`, Rust `let`, Python's function-only scoping) configure the
scope walker accordingly. Each scope kind has a flag for whether bindings are
visible *before* their declaration node in document order.

### 4.2 Import-aware cross-file matching

When a reference can't be resolved in-file:

1. Look up the unqualified name (`Foo`) or the leftmost segment of a
   dotted/selector chain (`pkg` in `pkg.Func`) in the file's import map.
2. If found, the import points at a target module. Resolve the module to a
   set of candidate files using language-specific rules:
   - Python: `foo.bar` → `foo/bar.py` or `foo/bar/__init__.py`, with
     `sys.path` reconstructed from `pyproject.toml` / `setup.py` /
     `requirements.txt`.
   - JS/TS: follow `package.json` `"exports"` and tsconfig `paths`,
     respecting the algorithm node uses for resolution.
   - Go: package path → directory under `GOPATH`/`go.mod` replace directives.
   - Ruby: `require_relative` is straightforward; bare `require` walks
     `$LOAD_PATH` reconstructed from `Gemfile.lock`.
   - Rust: `use` paths follow `Cargo.toml` workspace + module tree
     (`mod foo;` declarations).
3. In the candidate file(s), look for a top-level definition whose `@name`
   matches the imported symbol. If exactly one matches, emit a resolved
   edge. If several match, emit candidate edges (see §4.4).

This gets us **most of the cross-file edges in real codebases without any
type information**. The crucial input is correct import resolution, which is
why the import query (`imports.scm`) is the most language-specific of the
three.

### 4.3 Project-wide name matching (last resort)

For receivers we couldn't trace (e.g. `obj.method()` where `obj` came from a
function return value, a generic, or a dynamic factory), we fall back to
**name-only matching**:

- Collect all definitions across the project keyed by their unqualified name.
- For an unresolved `@name`, look up candidates in this index.
- If there is **exactly one** candidate project-wide, emit a single
  candidate edge tagged `resolution: "name-unique"`.
- If there are 2 to N candidates (N is a config; default 5), emit one
  candidate edge per target tagged `resolution: "name-ambiguous"` with a
  shared `candidate_group_id`.
- If there are more than N candidates, emit a single **unresolved** edge
  pointing at a synthetic "ambiguous" node tagged `resolution: "skipped"` —
  this prevents the graph blowing up from common names like `get`, `run`,
  `init`.

### 4.4 Explicit unresolved edges

Every reference produced by Tier B carries a `resolution` field. Possible
values:

| Resolution        | Meaning                                                            | Viewer rendering          |
| ----------------- | ------------------------------------------------------------------ | ------------------------- |
| `scip`            | SCIP indexer resolved this. Highest confidence.                    | Solid line.               |
| `scope`           | Same-file lexical lookup (§4.1).                                   | Solid line.               |
| `import`          | Cross-file via import map (§4.2). Single match.                    | Solid line.               |
| `name-unique`     | Project-wide name match, unique (§4.3).                            | Solid, faint.             |
| `name-ambiguous`  | Project-wide name match, ≤N candidates (§4.3).                     | Dashed, all candidates.   |
| `unresolved`      | No candidate or > N candidates.                                    | Dashed to "?" stub node.  |

The React Flow viewer renders `name-ambiguous` and `unresolved` edges with a
dashed stroke and a hover-tooltip that explains why ("3 candidates: `Foo.run`,
`Bar.run`, `Baz.run`"). The GitHub Action diff treats unresolved edges as
informational only — it does not flag a "broken reference" if an unresolved
edge stops resolving across the diff.

This is the central honesty contract of Tier B: **the graph never lies about
how confident it is.** When the viewer shows a dashed line, the user knows
not to trust it the way they'd trust a solid one.

### 4.5 Heuristics that improve resolution quality

A few heuristics earn their keep across most of the languages we target:

- **Constructor / class-call disambiguation.** `Foo()` where `Foo` resolves
  to a class definition becomes a `@ref.construct` edge, not a plain call.
  This matters for adapters that draw class instantiation graphs.
- **Method-on-self.** `self.bar()` (Python), `this.bar()` (JS/TS, Java),
  `(receiver T) Bar()` patterns (Go) — when the enclosing scope is a method
  and the receiver matches the conventional self/this binding, we resolve
  `bar` against the enclosing class's method definitions only. This is far
  more accurate than the project-wide fallback.
- **Re-export chasing.** When a name is imported from a module that itself
  re-exports it from somewhere else, follow the chain up to a configurable
  depth (default 5). Stop on cycles.
- **Builtin filtering.** Each language ships a `builtins.txt` (e.g.
  `print`, `len`, `range` for Python; `console`, `Object`, `Array` for JS).
  References to builtins are emitted as `@ref.builtin` and don't go through
  resolution.
- **Test-only dampening.** Definitions in files matching the language's test
  conventions (`*_test.go`, `test_*.py`, `*.test.ts`, `*Spec.scala`...) are
  weighted lower in name-ambiguous candidate ranking, so a production call
  to `run` doesn't preferentially match a test helper.

### 4.6 Known gaps codegraph won't pretend to solve

Tier B will produce wrong or missing edges in these cases. We document them
rather than paper over:

- **Dynamic dispatch.** `getattr(obj, name)()` in Python,
  `obj[methodName]()` in JS, `Send(MethodInfo)` in C# — no static analysis
  resolves these. Tier B emits an `unresolved` edge from the call site to a
  synthetic "dynamic" node. Adapters (e.g. for Django, Rails) can pattern-
  match common idioms and supply resolved edges where the framework's
  conventions make the target inferrable.
- **Reflection / metaprogramming.** Ruby `define_method`, Elixir macro
  expansion, Rust proc-macros, Python `__getattr__` overrides. Tier B sees
  the source-as-written. SCIP indexers don't always do better; only Rust's
  rust-analyzer-based indexer expands macros, and only when configured.
- **Generic type parameter resolution.** `coll.map(fn)` where `coll`'s
  element type comes from a generic parameter — without types we can't pick
  the right `map` definition. Falls into name-ambiguous.
- **Star/wildcard imports.** Python `from foo import *`, Ruby `include`-as-
  import patterns, Java static imports. We mark the import as wildcard and
  refuse to resolve through it (rather than guessing).
- **Build-system-generated code.** Protobuf stubs, GraphQL codegen output,
  ORM accessor generation. Adapters know about these and can emit resolved
  edges; the core resolver doesn't.

---

## 5. Performance: incremental parsing and caching

Tree-sitter is fast (~100x faster than re-running a typical compiler
frontend) but a full re-parse of a large monorepo is still seconds-to-minutes
depending on language. codegraph has three layers of caching.

### 5.1 Parse-tree cache, keyed by file content hash

For every file we index:

1. Compute `sha256(file_contents)` (truncated to 128 bits, base32-encoded for
   path-friendliness).
2. Look up the parsed tree in the on-disk cache at
   `.codegraph/cache/trees/<lang>/<hash>.bin` — we serialise the parse tree
   using tree-sitter's official `Tree::edit` + tree-walker into a compact
   binary node sequence (see §5.4 for caveats on tree serialisation).
3. On hit, deserialise. On miss, parse and write.

The query results (definitions, references, imports) are cached at the same
key, in `.codegraph/cache/queries/<lang>/<query_version>/<hash>.json`. The
`query_version` is a hash of the `.scm` files plus the grammar version, so a
query change or grammar bump invalidates the right slice automatically.

### 5.2 Incremental parsing across edits

When codegraph runs in watch mode (CLI `--watch` or the language-server
adapter), we use tree-sitter's incremental parsing API. The flow:

1. On file open, parse from scratch and store `Tree` in memory.
2. On edit, compute the byte offset / row / column of the edit and call
   `tree.edit(...)`.
3. Re-parse with the edited tree as the previous tree; tree-sitter reuses
   subtrees that didn't change.
4. Run queries on the new tree. We do *not* rerun queries against unchanged
   subtrees — the query engine's cursor naturally skips them — but we do
   need to diff capture sets to figure out which definitions/refs went away
   and which appeared. The capture set diff is keyed by `(node_id, capture)`
   where `node_id` is stable across reuse.

The win is real: typical IDE-style edits re-parse 95%+ of a file from cache
and re-query only the changed function body.

### 5.3 Indexing parallelism

The CLI parses files in parallel using a worker pool (size = `num_cpus` by
default). The work unit is a single file. The output goes through a single-
writer "graph builder" that owns the symbol table. The builder is the
serialisation point — it's I/O-bound (writing to the on-disk graph store), so
we batch writes by language and commit every N files (default 256).

### 5.4 Cache invalidation rules

Caches drop entries when:

- The grammar version changes (grammar binary hash is part of the cache key
  prefix).
- The query files change (query hash is part of the cache key prefix).
- The codegraph version itself changes for a major release where the symbol
  format changed (cache key prefix includes a "schema epoch" integer).

We deliberately **do not** invalidate on file-mtime changes — content hashing
makes that unnecessary and is robust against `git checkout` shuffling mtimes
without changing content.

#### Note on tree serialisation

Tree-sitter's `Tree` struct is not officially serialisable. We don't actually
persist the tree object; we persist the **query results** (definitions,
references, imports as plain records) keyed by content hash. The "parse
tree cache" described above is in-memory only and lives for the duration of
a single CLI run or watch session. On disk, only query output is cached. This
keeps the cache format independent of grammar internals.

### 5.5 Big-file fallback

Some files in the wild are pathological for tree-sitter (multi-megabyte
generated bundles, vendored library blobs). We hard-cap parsing at:

- 4 MiB file size (configurable).
- 30 second wall-clock parse budget (configurable).
- Recovery from the parser's own error nodes with a count cap — files with
  more than 1000 ERROR nodes get treated as "garbage in" and excluded.

Excluded files appear in the graph as nodes with no internal structure, so
references *to* them still resolve at the file level.

---

## 6. WASM vs native runtime

codegraph runs tree-sitter in two distinct contexts. Each picks the runtime
that fits its constraints.

### 6.1 CLI / GitHub Action: native bindings

For the CLI (and by extension the GitHub Action, which runs the CLI in a
container), we use **native tree-sitter bindings**:

- Node.js: `tree-sitter` package (binds to libtree-sitter.so/dylib) with
  per-grammar packages (`tree-sitter-python`, `tree-sitter-go`, ...) compiled
  to platform `.node` artefacts via prebuild-install.
- Rust (if we end up writing the indexer in Rust for speed): the official
  `tree-sitter` crate plus per-grammar crates.

Why native here:

- Faster parsing (no WASM call overhead, no SIMD-availability gotchas).
- Native query API has full `#match?` / `#predicate` support without the
  WASM bridge round-trip.
- We can use the C-level `ts_parser_set_timeout_micros` for the big-file
  fallback (§5.5); the WASM build doesn't expose this cleanly.
- Distribution is fine: prebuild-install handles cross-platform binary
  artefacts; we're already going to ship platform binaries for the native
  CLI.

### 6.2 Browser viewer: WASM

The React Flow viewer wants to do **on-the-fly preview parsing** — when the
user hovers a definition, we want to highlight call sites on screen, and
when the user pastes code into a "what-would-this-look-like" sandbox, we
parse client-side. We use **WASM tree-sitter**:

- `web-tree-sitter` (the official WASM build of libtree-sitter).
- Per-grammar `.wasm` artefacts loaded lazily.
- All the same `.scm` query files — they run unchanged against either
  runtime, which is half the appeal of doing this consistently.

Why WASM here:

- No way to ship a native binary into a browser.
- Query execution in WASM is fast enough for human-interactive use (sub-
  100ms for files under 100 KB on a modern laptop).
- We don't need the timeout / parallelism features in the browser — files
  are small and one-at-a-time.
- The viewer never does cross-file resolution itself; it consumes the graph
  IR produced by the CLI. WASM tree-sitter is only used for live preview
  / explainer views, not for re-indexing.

### 6.3 Sharing the grammar version pin across runtimes

Both runtimes consume the same `grammar-versions.json`. The CI build
pipeline:

1. Reads the pin file.
2. Builds native artefacts (per platform × per grammar) via prebuild.
3. Builds WASM artefacts (per grammar) via the
   `tree-sitter-cli build --wasm` workflow.
4. Publishes both sets to the codegraph CDN with the same tag.

The runtime loader picks the artefact set matching its environment. Because
the queries and version pin are shared, tree-sitter behaviour is consistent
between CLI and viewer — a definition the CLI captures will be the same
definition the viewer captures on the same source.

### 6.4 Bundle-size budget for the viewer

Each `.wasm` grammar is roughly 0.3–1.5 MiB after Brotli. We can't ship all
14 in the initial viewer bundle. The viewer:

- Loads the `tree-sitter` core WASM (~250 KiB) up front.
- Lazy-loads per-grammar WASMs when a file of that language is opened.
- Caches loaded grammars in `IndexedDB` keyed by version hash for fast
  re-load.

---

## 7. Build / packaging plan

```
packages/
  tree-sitter/
    grammar-versions.json        # the pin
    package.json                 # native deps
    queries/
      javascript/
        defs.scm
        refs.scm
        imports.scm
        scopes.scm
        builtins.txt
      typescript/  ...
      python/  ...
      go/  ...
      rust/  ...
      java/  ...
      ruby/  ...
      c/  ...
      cpp/  ...
      php/  ...
      csharp/  ...
      kotlin/  ...
      swift/  ...
      scala/  ...
      elixir/  ...
      lua/  ...
    fixtures/
      <lang>/
        sample.<ext>
        expected.snapshot.json
    src/
      runtime-native.ts          # node binding loader
      runtime-wasm.ts            # web-tree-sitter loader
      query-runner.ts            # shared between runtimes
      scope-walker.ts            # §4.1
      resolver.ts                # §4.2-4.4
      cache.ts                   # §5.1
      cli-entry.ts               # used by indexer pipeline
```

The `runtime-native.ts` and `runtime-wasm.ts` files implement the same
internal `Runtime` interface. Above them, `query-runner.ts`, `scope-walker.ts`
and `resolver.ts` are runtime-agnostic and shared verbatim between CLI and
viewer bundles.

---

## 8. Testing strategy

For each language we maintain three test layers:

1. **Snapshot tests** in `fixtures/<lang>/` — small representative files
   plus the expected definitions/references/imports JSON. Regenerate on
   intentional grammar/query changes; review the diff in PR.
2. **Round-trip tests** — for languages where we have *both* SCIP and
   tree-sitter pipelines, run both on the same fixture and assert the
   tree-sitter output is a strict subset (modulo `resolution` field) of
   SCIP. Catches drift when grammars change shape.
3. **Real-repo smoke tests** — index a handful of public OSS repos in CI
   (django, gin, react, rails, tokio, ...). Don't assert on edge counts —
   that's brittle — but assert that:
   - Indexing completes without crashes.
   - Top-level public APIs are present as definitions.
   - Known cross-file calls resolve to the right file (curated whitelist).

The third bucket is what catches most real-world regressions; the first two
are fast and run on every PR.

---

## 9. Open questions / future work

- **Macro-heavy Rust code.** `scip-rust` does the right thing when
  rust-analyzer can expand macros, but in workspaces with many proc-macro
  crates the indexer can be slow. We may want a fast-path that skips macro
  expansion for the common case where the macro doesn't introduce new
  symbols (e.g. `#[derive(Debug)]`). This is a Tier-A concern, not Tier B,
  but mentioning it because the tree-sitter fallback sees nothing.
- **Treesitter for SQL.** Most DAOs / repositories have SQL embedded in
  string literals. `tree-sitter-sql` exists; we don't currently plan to
  parse it, but the framework adapters could use it to extract table
  references. Non-MVP.
- **C# Roslyn-based SCIP.** If a stable scip-dotnet ships, demote
  C# from TS-only to SCIP. The query files don't go away — they remain the
  fallback for projects that can't run a SCIP indexer in CI.
- **Templating languages** (ERB, Jinja, Liquid, Vue/Svelte SFC). These have
  their own grammars. We can capture template-side identifier uses and
  match them against the host language's defs (e.g. an `<%= user.name %>`
  in ERB → `name` reference on whatever `user` resolves to in Ruby). This
  is adapter-territory; the tree-sitter base supplies the parses and the
  adapter does the cross-language matching.
- **Improving name-ambiguous ranking.** Currently uniform; we could weight
  by directory proximity (a call from `app/foo/x.py` ranks `app/foo/` defs
  higher), recency of edit, or import-graph distance. Worth measuring on a
  benchmark corpus before adding complexity.

---

## 10. Summary

- Tree-sitter is codegraph's universal fallback parser, with **per-language
  `.scm` queries** for definitions, references, and imports.
- Six languages get **SCIP as Tier A** (TS/JS, Python, Java/Kotlin/Scala
  via JVM, Go, Ruby, C/C++); the rest are **TS-only**.
- Without types, we resolve references via **lexical scoping → import-aware
  cross-file matching → project-wide name matching → explicit unresolved**,
  and surface the confidence level in the `resolution` field on every edge.
- The viewer renders low-confidence edges as dashed lines so the graph is
  honest about what it knows.
- **Native bindings for the CLI/Action**, **WASM for the browser viewer**,
  with shared queries and a shared grammar-version pin.
- **Content-hash caching** of query results plus tree-sitter incremental
  parsing in watch mode keep re-index costs proportional to actual change.
- Known gaps (dynamic dispatch, metaprogramming, generic dispatch, wildcard
  imports, generated code) are documented and surfaced via `unresolved`
  edges rather than papered over with bogus resolutions.
