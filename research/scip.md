# SCIP Consumption in codegraph

Status: design note (research)
Audience: codegraph contributors building the indexer pipeline
Last reviewed: 2026-05

This document specifies how codegraph ingests SCIP (Sourcegraph Code Intelligence
Protocol) indexes and lifts them into the codegraph IR. SCIP is one of two
front-end source-fact pipelines we run in parallel: tree-sitter (syntactic,
universal, no types) and SCIP (semantic, language-specific, real type info where
the indexer supports it). The two streams converge on a shared IR before the
viewer and Action consume them.

The goal here is not to re-document SCIP — Sourcegraph maintains the canonical
spec — but to pin down (a) which SCIP indexers we trust, (b) exactly how we
shell out to them, (c) how their `index.scip` files map onto codegraph nodes and
edges, and (d) where SCIP runs out of road and we have to fall back to adapters.

Upstream references (all MIT/Apache-2.0 unless noted):

- Spec & protobuf schema: <https://github.com/sourcegraph/scip>
- Symbol grammar: <https://github.com/sourcegraph/scip/blob/main/docs/scip.md>
- CLI tool: <https://github.com/sourcegraph/scip/blob/main/docs/CLI.md>
- TypeScript indexer: <https://github.com/sourcegraph/scip-typescript>
- Python indexer: <https://github.com/sourcegraph/scip-python>
- JVM indexer (Java/Scala/Kotlin): <https://github.com/sourcegraph/scip-java>
- Go indexer: <https://github.com/sourcegraph/scip-go>
- C/C++ indexer: <https://github.com/sourcegraph/scip-clang>
- Ruby indexer: <https://github.com/sourcegraph/scip-ruby>
- Rust SCIP wrapper: <https://github.com/sourcegraph/scip-rust>
- Rust-analyzer native SCIP: <https://rust-lang.github.io/rust-analyzer/rust_analyzer/cli/scip/index.html>
- Announcement / rationale: <https://sourcegraph.com/blog/announcing-scip>

---

## 1. SCIP overview

### 1.1 What it is

SCIP is a language-agnostic protobuf format for *precise* code intelligence —
the same kind of information a language server uses to drive go-to-definition,
find-references, and hover. The schema is small (one `.proto` file at the root
of `sourcegraph/scip`) and the wire format is a serialized `Index` message,
typically named `index.scip` and gzipped on the wire.

License is **Apache-2.0**. That is permissive enough for codegraph (MIT) to
depend on the schema, ship generated bindings, and shell out to the indexer
binaries without re-licensing concerns. Note: a couple of the indexers
themselves are not Apache — `scip-ruby` inherits Sorbet's licensing and
`scip-clang` ships a redistributed Clang. We never link against them; we only
exec them, so this is fine.

### 1.2 Why SCIP, not LSIF

Sourcegraph wrote SCIP after running LSIF in production on ~45k repos and
finding three pain points (paraphrased from the launch post): no machine-readable
schema (LSIF is JSON-Lines with conventions), heavy in-memory graphs because
every entity is referenced by an opaque numeric ID, and incremental indexing is
hard because IDs are global. SCIP fixes this by (a) using protobuf with a
checked-in schema, (b) replacing opaque IDs with human-readable string symbols
that include a package and a descriptor path, and (c) making each `Document` a
self-contained record so per-file indexing is trivial. Reported wins: ~10x
indexing speedup vs lsif-node, ~4-5x smaller files.

For codegraph specifically, the string-symbol property is what matters. We can
use the SCIP symbol moniker directly (or with light normalization) as our
stable node ID — see §3.

### 1.3 The schema, in five messages

We only need to know five protobuf messages. Field numbers in parens.

**`Index`** is the top-level envelope.

- `metadata: Metadata (1)`
- `documents: repeated Document (2)`
- `external_symbols: repeated SymbolInformation (3)` — info about symbols this
  index references but does not define (e.g. `lodash.map` from a TS index that
  imports lodash).

**`Metadata`**: protocol version, indexer name+version, project root URI,
text encoding (`UTF8` / `UTF16`), position encoding.

**`Document`**: one source file.

- `relative_path: string`
- `language: string` (e.g. `"TypeScript"`, `"Go"`)
- `occurrences: repeated Occurrence` — every place a symbol is mentioned
- `symbols: repeated SymbolInformation` — info about symbols *defined* here
- `text: string` (often empty for size; we don't need it because tree-sitter
  already has the source)

**`Occurrence`**: one symbol mention at one source range.

- `range: repeated int32` — packed `[startLine, startCol, endLine?, endCol]`,
  3 ints if start/end are on the same line, 4 otherwise
- `symbol: string` — the moniker (see §3)
- `symbol_roles: int32` — bitset: `Definition=0x1`, `Import=0x2`,
  `WriteAccess=0x4`, `ReadAccess=0x8`, `Generated=0x10`, `Test=0x20`,
  `ForwardDefinition=0x40`
- `syntax_kind: SyntaxKind` — semantic syntax class (Keyword,
  IdentifierFunction, etc.); useful for the viewer, ignored by IR
- `enclosing_range`: range of the surrounding scope (function body, class body)

**`SymbolInformation`**: type-level facts about a symbol.

- `symbol: string`
- `kind: Kind` (Class, Method, Function, Variable, Module, …)
- `display_name: string`
- `documentation: repeated string` (markdown)
- `signature_documentation: Document` (a tiny synthetic doc holding the
  language-specific signature text plus its own occurrences)
- `relationships: repeated Relationship` — implements / overrides / type-defines
- `enclosing_symbol: string`

That is the entire surface area we have to ingest.

### 1.4 Indexers (state of each, May 2026)

Maturity is ours, not Sourcegraph's. "Production" means we are willing to ship
without a tree-sitter fallback for that language; "best-effort" means we run it
and merge what we can, but tree-sitter still has to cover gaps.

| Indexer            | Languages                  | Backed by         | Maturity (2026) | Type info | codegraph stance     |
|--------------------|----------------------------|-------------------|-----------------|-----------|----------------------|
| `scip-typescript`  | TypeScript, JavaScript     | tsc compiler API  | Production      | Full      | Primary              |
| `scip-java`        | Java, Scala, Kotlin        | semanticdb + javac/kotlinc/scalac plugins | Production (Java/Kotlin), beta (Scala) | Full | Primary |
| `scip-go`          | Go                         | `go/packages`     | Production      | Full      | Primary              |
| `scip-python`      | Python                     | Pyright fork      | Production      | Inferred (Pyright) | Primary |
| `rust-analyzer scip` | Rust                     | rust-analyzer     | Production      | Full      | Primary (we drive RA directly, not the `scip-rust` wrapper) |
| `scip-clang`       | C, C++, CUDA               | Clang 21 frontend | Beta            | Full when compdb exists | Best-effort, requires `compile_commands.json` |
| `scip-ruby`        | Ruby                       | Sorbet            | Experimental    | Full only at `# typed: true`+ | Best-effort, opt-in |
| `scip-dotnet`      | C#, VB                     | Roslyn            | Beta            | Full      | Best-effort         |
| `scip-php`         | PHP                        | nikic/php-parser  | Alpha           | Limited   | Tree-sitter primary, SCIP optional |
| `scip-dart`        | Dart                       | dart analyzer     | Beta            | Full      | Best-effort         |

Notes:

- **`scip-typescript`** is the reference implementation. Run from a project
  root that has either `tsconfig.json` or `package.json`. Yarn/pnpm workspaces
  supported. Caches across projects unless `--no-global-caches`.
- **`scip-python`** is a fork of Pyright with SCIP emission bolted on. Type
  quality therefore equals Pyright's (very good, but inference-based — type
  errors in user code degrade quality silently). Requires Python 3.10+ and
  Node 16+ to run.
- **`scip-java`** is multi-modal: javac plugin (preferred), Maven plugin,
  Gradle plugin, sbt plugin. Each has different invocation. We pick the one
  that matches the build system we detect.
- **`scip-go`** auto-detects from `go.mod`, runs `go/packages` under the hood.
  Latest release (v0.2.4) is from April 2026 — actively maintained.
- **Rust** is the messy one. `sourcegraph/scip-rust` is a 100-line shell
  wrapper that defers to rust-analyzer. The actual SCIP emitter lives inside
  rust-analyzer (`rust-analyzer scip <path>`). We invoke rust-analyzer
  directly and ignore `scip-rust`.
- **`scip-clang`** is the only indexer where we cannot just point it at a
  source root. It needs a `compile_commands.json` (Bear, CMake's
  `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`, or Bazel via hedron). For projects
  without one we fall back to tree-sitter.
- **`scip-ruby`** is best-effort. Ruby code that hasn't been Sorbet-annotated
  produces very thin SCIP. Default to tree-sitter, layer SCIP if we detect
  `# typed: true` files.

### 1.5 What "type info" actually means per indexer

Even within "Full" type info there's a quality gradient:

- **Resolved at compile time** (TS, Java, Kotlin, Scala, Go, C++): SCIP
  carries the exact static type. Method dispatch is precise. Generics are
  monomorphized in `signature_documentation` text.
- **Resolved at type-check time** (Python via Pyright, Ruby via Sorbet): types
  are *inferred*. Where the inference is stuck (untyped third-party packages,
  dynamic patterns), the symbol is still emitted but its type signature may
  be `Unknown` / `T.untyped`.
- **Resolved at hover only** (some Rust trait dispatch): the symbol resolves,
  but trait method dispatch on generic types may point to the trait declaration
  rather than the concrete impl. We treat this as a cross-impl edge in IR with
  a `dispatch=virtual` annotation.

When we lift edges (§4) we record which bucket the type info came from so the
viewer can surface the certainty.

---

## 2. Consuming SCIP from codegraph

### 2.1 Pipeline shape

```
detect language -> select indexer(s) -> spawn subprocess
              -> read index.scip (protobuf)
              -> normalize symbols
              -> emit IR nodes/edges
              -> merge with tree-sitter facts
```

The whole thing lives in `packages/core/src/scip/` (planned). It exports a
single `runScipIndexers(repoRoot, opts) -> AsyncIterable<IRChunk>` so the rest
of the pipeline can stream rather than hold the full Index in memory — the
Sourcegraph monorepo's `index.scip` is hundreds of MB, and we want similar
ceilings to "just work" on a laptop.

### 2.2 Indexer detection

A small registry under `packages/core/src/scip/indexers.ts` declares one entry
per language. Each entry has:

```ts
type IndexerSpec = {
  id: 'scip-typescript' | 'scip-go' | 'scip-python' | ...;
  language: Language;
  detect: (root: string) => Promise<DetectResult | null>;
  // returns null if the indexer is not applicable
  // returns { confidence, projectRoots[] } otherwise
  command: (root: string, opts: RunOpts) => Spawn;
  // -> { argv, env, cwd, expectedOutput }
  postprocess?: (idx: scip.Index) => scip.Index;
  maturity: 'production' | 'beta' | 'experimental';
};
```

Detection is cheap and read-only: presence of `tsconfig.json`, `go.mod`,
`pyproject.toml`, `Cargo.toml`, `pom.xml` / `build.gradle*`, `compile_commands.json`,
etc. A repo can match multiple — see §5.

### 2.3 Spawning the indexer

Indexers are invoked as subprocesses. We never link them in. Resolution order:

1. `CODEGRAPH_SCIP_<LANG>_BIN` env var (escape hatch).
2. A pinned binary under `~/.codegraph/bin/` that we lazy-download from the
   indexer's release page on first use, with checksum.
3. The user's `$PATH`.

We surface (3) only if the user opts in via config; pinned binaries are the
default because reproducibility matters.

Example invocations:

```sh
# TypeScript / JavaScript
scip-typescript index --output index.scip
# (no flags needed for most repos; --no-global-caches for hermeticity)

# Python
scip-python index . --project-name "$REPO" --output index.scip

# Go
scip-go --output index.scip
# auto-detects go.mod, module path, version from git

# Rust (NB: not scip-rust, but rust-analyzer itself)
rust-analyzer scip . --output index.scip --exclude-vendored-libraries

# Java/Kotlin/Scala (one of these, depending on build system)
scip-java index --build-tool=gradle  # or maven, mill, sbt, bazel
# scip-java internally drives the build, attaches a compiler plugin,
# and writes index.scip to the cwd.

# C/C++ (needs compile_commands.json)
scip-clang --compdb-path compile_commands.json -o index.scip
```

We capture stdout/stderr to `~/.codegraph/logs/scip-<lang>-<timestamp>.log`
and tee a brief progress pulse (line count, time elapsed) to the user. Non-zero
exits are surfaced *with* the log path; we do not parse error messages
because they vary by indexer.

Concurrency: one indexer process per language by default. Memory is the
constraint, not CPU — `scip-clang` recommends 2 GB/core, `scip-java`'s javac
plugin can spike to a few GB on large codebases. We expose
`--scip-parallelism N` and default to `min(cpus/2, 4)`.

Timeouts: we default to no wall-clock timeout (large monorepos legitimately
take 30+ min) but we do enforce a "stuck" timeout — if no progress is observed
in stderr for 5 min and the process is below 5% CPU, we kill it.

### 2.4 Reading `index.scip`

We use auto-generated TypeScript bindings from `scip.proto`, regenerated in
CI from a pinned upstream commit. The bindings are a single file we check in
under `packages/core/src/scip/proto/scip.ts` (we don't take a runtime dep on
the codegen tooling).

Reading is streaming: we use length-delimited protobuf parsing (the format is
not natively streaming, but `Index` is a `repeated Document` and almost all
indexers emit documents in source order, so we can do a two-pass approach):

1. **Pass 1 (skim)**: read `metadata` + `external_symbols` + `Document`
   headers (relative_path + symbol list). Build the symbol → defining-document
   map.
2. **Pass 2 (lift)**: stream `Document.occurrences` and emit IR. We already
   know whether each symbol is locally defined or external, so we can
   classify edges on the fly.

For very large indexes we shell out to `scip print --json index.scip` and
parse line-delimited JSON. This is slower per byte but trivially streamable;
we use it only when the protobuf path would exceed a memory budget.

### 2.5 Mapping records to IR

| SCIP record | IR projection |
|-------------|---------------|
| `Metadata` | recorded once on the IR root; tells us the indexer + version for provenance |
| `Document` | becomes an IR `File` node, keyed by `relative_path` |
| `SymbolInformation` (in `Document.symbols`) | becomes an IR `Symbol` node (Class / Function / Method / Variable / …) |
| `SymbolInformation` (in `external_symbols`) | becomes a `ExternalSymbol` node — same shape, marked `external=true` |
| `Occurrence` with `Definition` role | back-edge from File → Symbol with `kind=defines`; locks the symbol's primary range |
| `Occurrence` with `Import` role | edge File → ExternalSymbol with `kind=imports` |
| `Occurrence` with `ReadAccess` / `WriteAccess` / neither | edge from enclosing-symbol → target-symbol with `kind=references`, plus `access` annotation |
| `Relationship.is_implementation` | edge Symbol → Symbol with `kind=implements` |
| `Relationship.is_reference` | edge with `kind=type-reference` (used for "this type appears in this signature") |
| `Relationship.is_type_definition` | edge with `kind=defines-type` (interface or alias declaration) |
| `SyntaxKind` | dropped from IR; passed through to viewer for highlighting |
| `signature_documentation` | extracted as a string and stuck on the Symbol's `signature` field; see §4 |
| `documentation` (markdown) | first-paragraph excerpt → Symbol.docstring; full md retained on viewer side |

Range packing: SCIP uses zero-indexed `[startLine, startCol, endLine, endCol]`
with optional 3-int form when start and end share a line. We always normalize
to four ints in IR and convert to the codegraph `Span` type
(`{file, startLine, startCol, endLine, endCol}`, all 1-indexed for UI parity
with editors). The conversion is the responsibility of the SCIP loader — every
other producer of IR sees 1-indexed spans.

Encoding: SCIP supports `UTF8`, `UTF16`, and `UTF32` text encodings, and the
`PositionEncoding` field tells us which one column offsets are in. Most
indexers emit UTF-16 (for editor parity), but `scip-go` emits UTF-8. We
normalize all positions to UTF-8 byte offsets internally, using the source
text from the on-disk file (not `Document.text`, which is usually empty).

### 2.6 Caching

Two layers:

1. **Indexer cache**: keyed on `(indexer-id, indexer-version, repo-state-hash,
   build-config-hash)`. If hit, we re-use the existing `index.scip` and skip
   the subprocess entirely.
2. **IR cache**: keyed on `(index.scip content hash, codegraph-loader-version)`.
   If hit, we deserialize precomputed IR chunks instead of re-walking the
   protobuf.

Cache lives under `~/.codegraph/cache/scip/`. Both layers are
content-addressed and safe to share across worktrees.

---

## 3. Symbol mapping → codegraph node IDs

### 3.1 SCIP's symbol grammar

The string is structured. From the spec:

```
<symbol>      ::= <scheme> ' ' <package> ' ' <descriptor>+ | 'local ' <local-id>
<package>     ::= <manager> ' ' <package-name> ' ' <version>
<descriptor>  ::= <name><suffix>
<suffix>      ::= '/' | '#' | '.' | '().' | '[]' | '(' <name> ')' | ':'
```

| Suffix  | Meaning             | Example                        |
|---------|---------------------|--------------------------------|
| `/`     | Namespace / package | `lodash/`                      |
| `#`     | Type / class        | `Map#`                         |
| `.`     | Term (var, const, field) | `defaultValue.`           |
| `().`   | Method / function   | `Map#get().`                   |
| `[T]`   | Type parameter      | `Container#[T]`                |
| `(p)`   | Parameter           | `fn().(p)`                     |
| `:`     | Meta (annotations, decorators) | `@deprecated:`     |

Empty package fields are placeholders `.` (literal dot). Spaces in any field
are escaped as `'  '` (double space).

### 3.2 Examples per indexer

```
# TypeScript: lodash's `map` function
scip-typescript npm lodash 4.17.21 `lodash/map.`

# Python: requests.Session.get
scip-python pypi requests 2.31.0 `requests/sessions.py`/Session#get().

# Go: net/http's ServeMux.Handle
scip-go go github.com/golang/go go1.22.0 net/http/ServeMux#Handle().

# Java: java.util.HashMap.put (boxed-collection shim)
scip-java maven jdk 17 java/util/HashMap#put().

# Rust: std::collections::HashMap::new
rust-analyzer cargo std 1.78.0 collections/HashMap#new().

# Local (file-scoped): always `local <integer>`
local 4
```

### 3.3 Mapping rule for codegraph IDs

We want a stable, content-addressed node ID that survives re-indexing and
collapses cross-language synonyms. The rule:

```
codegraph_id(symbol) :=
  if symbol.startsWith('local ')
    then `${file_relative_path}:${local_id}`         # file-scoped, document-unique
    else canonicalize(symbol)
```

`canonicalize` normalizes the SCIP symbol in three steps:

1. **Strip the version** from the package triple. We retain the manager and
   package-name but replace the version with `*`. Rationale: codegraph nodes
   should not change when a dependency bumps. Version is preserved separately
   on the node as metadata.
2. **Lowercase the manager**, leave package name as-is. (`NPM` and `npm` are
   the same registry.)
3. **Collapse standard-library packages** to a single canonical name per
   language. `scip-go`'s `go github.com/golang/go go1.22.0` becomes
   `scip-go go std *`. `scip-java`'s `maven jdk 17` becomes
   `scip-java maven jdk *`. This is a small lookup table maintained alongside
   the indexer registry.

The descriptor chain is left verbatim. We do *not* try to harmonize across
languages (e.g. unify `Map#get().` with Python's `dict.__getitem__`) — that
is the adapter layer's job, not the symbol layer.

### 3.4 Why not just hash the symbol?

We considered using `sha256(symbol)` as the ID. Two reasons we don't:

1. **Debuggability**. Reading `dump.json` and seeing `lodash/map.` is much
   nicer than `sha256:7f3a…`. The indexer team specifically called this out
   as a SCIP-vs-LSIF win and we don't want to throw it away.
2. **Round-tripping to upstream tools**. `scip print`, `scip lint`, and the
   upstream test fixtures all expect raw symbols. Keeping them lets us cross-
   check our IR against `scip print --json` byte-for-byte.

We do hash the canonicalized symbol for *short IDs* in the viewer URL bar,
but the canonical form is the source of truth.

### 3.5 Local symbols

`local 4` is a SCIP convention for "this symbol is meaningful only inside
this `Document`". It's used for parameters, locally-scoped vars, etc. We
treat them as first-class IR nodes — we just key them by
`(document.relative_path, local_id)` rather than by the global moniker.
Cross-document edges to local symbols are by definition impossible, which the
loader asserts as a sanity check.

---

## 4. Type info on edges and nodes

The big payoff of SCIP over tree-sitter is real type information. We surface
it in three places:

### 4.1 `Symbol.signature_documentation`

`SymbolInformation.signature_documentation` is a sub-`Document` whose `text`
holds the language-specific signature (e.g. TS `function map<T,U>(arr: T[],
fn: (t: T) => U): U[]`) and whose `occurrences` slice that string into
referenceable spans. We:

- Take the raw `text` and stick it on `IR.Symbol.signatureText`.
- Walk the sub-document's occurrences. Every occurrence whose target is a
  *type symbol* becomes an edge `Symbol -[:has-type-ref]-> TypeSymbol` with
  a `position` annotation pointing into `signatureText`. This is what powers
  "click on the `T[]` in this signature → jump to definition of `T[]`" in the
  viewer.

If `signature_documentation` is absent (some indexers don't emit it), we fall
back to extracting the signature from tree-sitter's syntactic span — but
without the type-symbol cross-references.

### 4.2 `Occurrence` → edge type annotations

A `references` edge in IR carries a `typeAt` annotation when SCIP gives us
enough info to fill it in. Sources, in priority order:

1. The target symbol's `signature_documentation.text` (return type at the
   call site, etc.).
2. The target symbol's `Kind` (Method, Field, Function — coarse, but always
   present).
3. `syntax_kind` on the occurrence (IdentifierFunction, IdentifierType, …) —
   only used when the target is `external` and we have no `SymbolInformation`
   for it.

The annotation has the shape:

```ts
type EdgeTypeAnnotation = {
  source: 'scip-signature' | 'scip-kind' | 'scip-syntaxkind' | 'tree-sitter';
  text: string;       // signature or kind name
  resolved: boolean;  // true for the first two, false for the latter two
};
```

The viewer dims unresolved annotations. The Action layer treats only
`resolved=true` annotations as load-bearing.

### 4.3 `documentation` markdown

We split it on the first blank line: the first paragraph (often a docstring
summary) goes on the IR Symbol node; the full markdown is preserved in a
side-table keyed by symbol ID, loaded lazily by the viewer. Action layer
ignores docstrings entirely — they're an explanatory channel, not a fact.

### 4.4 `relationships` → edges

`SymbolInformation.relationships` gives us the OOP-y edges (`is_implementation`,
`is_reference_overrides`, `is_type_definition`, `is_implementation_of`).
We translate each to an explicit edge type:

| `Relationship` flag      | IR edge kind         |
|--------------------------|----------------------|
| `is_implementation`      | `implements`         |
| `is_reference`           | `type-references`    |
| `is_type_definition`     | `defines-type`       |
| `is_definition`          | (collapsed into the existing `defines` edge from File → Symbol) |

This is where SCIP outclasses tree-sitter most clearly — tree-sitter has no
notion of "this method overrides that method on a base class".

---

## 5. Cross-language SCIP

### 5.1 Multiple indexers, one repo

Polyglot repos (e.g. a TS frontend + Go backend + Python data jobs in one
git repo) are the common case. We handle them by:

1. Running detection over the whole repo, producing a list of `(indexer,
   project-roots)` pairs. A project root is the directory the indexer should
   `cwd` to — TS uses `tsconfig.json` location, Go uses `go.mod` location,
   etc. One repo can yield multiple roots per indexer (TS workspaces).
2. Spawning each indexer in parallel within the parallelism budget.
3. Each produces its own `index.scip`. We do NOT use `scip` CLI's merge
   capability — we merge in IR space because we want to reject
   conflicting facts deterministically (see below).

Output layout under `~/.codegraph/work/<repo-hash>/`:

```
scip/
  ts/
    web/index.scip
    admin/index.scip
  go/
    services-api/index.scip
  python/
    data/index.scip
```

### 5.2 Merging in IR space

Each `index.scip` is loaded into its own IR shard. We then merge shards under
these rules:

- **Files**: a file should be claimed by exactly one indexer. If two claim
  the same path (e.g. a `.ts` file inside a Go module's `embed` directive),
  we prefer the indexer whose language matches the file's extension and
  warn on the other.
- **Symbols**: external symbols can legitimately be defined by another shard
  — e.g. a TS file imports a generated Python protobuf binding via a JSON
  schema, no wait, that doesn't happen in the same repo. The actual case:
  generated code where indexer A treats file X as external and indexer B
  defines X. We resolve the external reference to the definition, and emit
  a `cross-language-reference` edge.
- **External symbols not resolved by any shard**: kept as-is, with the
  defining package recorded in the symbol moniker. The Action layer
  determines whether they are "ours we just don't index" (e.g. a vendored
  dep) vs "third-party".

Conflicts (two indexers defining the same symbol moniker) are logged and
flagged as a bug in the indexer registry — this should never happen because
the moniker schemes are different per language. If it does happen (e.g.
hypothetical `scip-php` and `scip-typescript` both claiming a `.php` file
through a Twig wrapper), we keep the higher-priority indexer's version and
record the conflict.

### 5.3 Single-language polyglot via `scip-java`

`scip-java` is a special case: one indexer covers Java, Scala, and Kotlin in
the same JVM build. It emits one `index.scip` with multi-language
`Document.language` values. We handle this transparently — the loader looks
at `Document.language` per file, not at the indexer that produced the index.

---

## 6. Limitations — where SCIP stops and adapters take over

SCIP is excellent at *intra-process, intra-language, statically-resolvable*
references. It says nothing about:

### 6.1 Cross-service communication

If a TS frontend calls `fetch('/api/users')` and a Go handler is registered
on `mux.Handle("/api/users", ...)`, neither indexer knows the other exists.
SCIP can tell us:

- the TS code calls `fetch` (reference to `lib.dom.d.ts:fetch`)
- the Go code registers a handler (reference to `net/http.ServeMux.Handle`)

It cannot tell us those two are the same logical edge. That's the **HTTP
adapter** — a routing-table extractor that runs over the IR after SCIP
ingestion and synthesizes `service-call` edges based on URL + method
matching. Same story for gRPC (handled by a `proto`-aware adapter that reads
`.proto` files), GraphQL, message queues, etc.

### 6.2 Environment variables and runtime config

SCIP shows `process.env.DATABASE_URL` as a property access on
`process.env` — it has no idea that `DATABASE_URL` is a load-bearing
configuration knob set by Kubernetes. The **config adapter** does that, by
diffing `.env*` files, `values.yaml`, `terraform/*.tf`, and runtime
manifests against the symbol `process.env.X` references found in SCIP.

### 6.3 Reflection and dynamic dispatch

- Java reflection (`Class.forName("com.foo.Bar")`) is opaque to
  `scip-java`; the string is just a string.
- Python's `__getattr__`, decorators that rewrite signatures, and `eval`
  are handled by Pyright on a best-effort basis but commonly fall back to
  `Unknown`.
- Go interfaces dispatch correctly (the compiler resolves them statically),
  but `reflect.Type.MethodByName` does not.

The **dynamic-dispatch adapter** is a planned Action-layer pass that uses
heuristics (string-literal table lookup, decorator pattern matching) to
synthesize "soft" edges with low confidence.

### 6.4 Build-system facts

SCIP indexes assume a build configuration; they don't tell you *what* that
configuration was. "This file is only compiled when feature X is enabled"
is invisible. The **build adapter** reads `Cargo.toml` features,
`build.gradle` source-sets, `tsconfig.json` `include`/`exclude`,
`pyproject.toml` extras, and tags each File node accordingly.

### 6.5 Framework-specific routing

- Express / Fastify / Koa route registrations
- Django URL configs
- Spring `@RequestMapping`
- Rails routes.rb
- Next.js / Remix file-system routing

These show up to SCIP as method calls on framework objects. The route
strings are arguments. The **framework-routing adapter** has per-framework
extractors that mine those calls and produce typed `route` nodes pointing
to the handler symbols. Because routes are framework-specific, this *cannot*
be a SCIP feature; it has to be adapter code.

### 6.6 SQL and ORM relationships

`db.query("SELECT * FROM users WHERE id = $1")` is a string literal to SCIP.
The **SQL adapter** parses string literals at known DB call sites and
synthesizes `reads-table` / `writes-table` edges. Likewise for ORMs
(`Model.find(id)` → SQL → table edges).

### 6.7 What we get from SCIP, by contrast

A reasonable rule of thumb: SCIP is responsible for everything that the
language compiler/type-checker can prove. Everything that requires reading
JSON config, parsing string arguments, or correlating across processes is
an adapter's job. The codegraph IR is the meeting point.

---

## 7. Tooling we use

### 7.1 The `scip` CLI

`scip` is Sourcegraph's official Go-built tool for working with SCIP files,
distributed under Apache-2.0. We pin a known-good version
(`v0.7.x` as of writing) and ship it under `~/.codegraph/bin/`. We use it
for:

- **`scip print --json index.scip`** — JSON dump for streaming parse fallback
  (§2.4) and for golden tests.
- **`scip stats index.scip`** — quick sanity numbers (#documents, #symbols,
  #occurrences). We surface these in the CLI as a post-index summary.
- **`scip lint index.scip`** — schema-level validation. Run automatically
  after every indexer invocation; non-fatal but warned.
- **`scip snapshot --to <dir> index.scip`** — produces caret-annotated
  source listings, used by our golden-test fixtures (`test-fixtures/scip/*`)
  to make sure our IR loader matches Sourcegraph's reference interpretation.
- **`scip expt-convert index.scip --to-sqlite index.db`** (experimental) —
  ad-hoc SQL inspection during development. Not used in the runtime path.

We do *not* use `scip merge` (we merge in IR space, §5).

### 7.2 `scip-cli` (community)

There's a smaller community tool sometimes referenced as `scip-cli` for
quick `print` / `inspect` workflows. It overlaps with what `scip print`
already does, so we don't take a dependency on it. If a contributor finds it
helpful for debugging locally, that's fine — we just don't ship it.

### 7.3 Our internal CLI surface

`packages/cli` exposes a few SCIP-specific subcommands for debugging:

```sh
codegraph scip detect            # which indexers would run on this repo
codegraph scip run --lang=ts     # run one indexer, print path to index.scip
codegraph scip dump <file>       # pretty-print a SCIP file (calls scip print)
codegraph scip diff <a> <b>      # diff two SCIP files at the IR layer
codegraph scip lift <file>       # lift a SCIP file to IR JSON without merging
```

These are not promises — they're meant for the contributors writing adapters
and the test fixtures. They live under `packages/cli/src/commands/scip/`.

### 7.4 Test fixtures

Under `test-fixtures/scip/` we keep:

- a tiny TS/Go/Python/Java/Rust each, with hand-written `index.scip` and the
  expected lifted-IR JSON
- `scip snapshot` outputs of the same, used to detect drift when we update
  the protobuf schema
- a `polyglot/` fixture exercising the merge path

CI re-runs `codegraph scip lift` against each fixture and diffs against the
checked-in golden. Indexer version bumps are gated on these tests passing
(or being explicitly updated with rationale in the PR).

---

## 8. Open questions (tracked, not blocking)

- **Incremental SCIP**. SCIP indexes are file-granular but not currently
  incremental at the Document level on the indexer side. We can fake
  incrementality by running the indexer on subtrees and merging, but for
  truly incremental builds we'd need indexer cooperation. Track upstream
  for `scip-typescript` and `scip-java` which both have interest in this.
- **Streaming protobuf**. `Index` is not natively streamable — the
  `external_symbols` field is at the end of the message. We work around it
  with the two-pass approach in §2.4. If upstream ever splits external
  symbols into a sidecar file, we can drop the workaround.
- **Position encoding**. We always normalize to UTF-8 byte offsets
  internally. If the viewer ever needs UTF-16 (for editor parity), that's a
  conversion at the viewer boundary, not in the IR.
- **`scip-php` / `scip-dart` maturity**. These are alpha / beta enough that
  we don't want them on the primary path yet. Revisit in 6 months.
- **Vendored dependencies**. `--exclude-vendored-libraries` (rust-analyzer)
  and equivalents elsewhere — should this be the default for codegraph?
  Probably yes for the viewer (less noise), probably no for security
  analysis (you want to see the vendored code). Make it a config flag.
- **Generated code**. `Occurrence.symbol_roles & Generated` flags
  generated code. We currently treat it as normal IR but tag the file node.
  Whether to *suppress* generated code in the viewer is a UX decision still
  open.

---

## 9. Summary

SCIP is the right shape for codegraph: an Apache-2.0, schema'd, indexer-
neutral protobuf format with a human-readable symbol grammar, backed by
production-quality indexers for TypeScript, Java/Kotlin, Go, Python, and
Rust as of 2026. We shell out to indexers per language, parse `index.scip`
in two passes, and lift records into our IR with the symbol moniker as the
node ID. Type info (signatures, relationships, kinds) becomes edge
annotations. Polyglot repos are handled by parallel indexer invocations and
IR-space merging.

What SCIP cannot do — cross-service calls, config-driven behavior, framework
routing, ORM/SQL, dynamic dispatch — is exactly the territory of the
adapter layer. The line between SCIP-derived facts and adapter-derived
facts is sharp on purpose: SCIP is what the compiler can prove, adapters
are the rest.
