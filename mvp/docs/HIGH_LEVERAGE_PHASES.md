# High-leverage phases — design + shipping plan

Three pieces, in priority order. The 20 new warnings ship in this
commit / session (fast, no new infrastructure). The two big lifts —
tree-sitter swap and Go + Rust support — get full designs here so
they're ready to ship as standalone PRs without another planning
round.

```
┌─ Phase 10.next ──── compiler warnings × 20            ~5 hours    ship NOW
├─ Phase 5.1    ──── tree-sitter swap (TS + Python)    ~1–2 days   ship next
├─ Phase 5.4    ──── Go via tree-sitter + go list      ~1 day      after 5.1
└─ Phase 5.5    ──── Rust via tree-sitter + cargo      ~1 day      after 5.4
```

Tree-sitter lands first because Go and Rust **reuse the runtime** —
once `mvp/lib/parsers/tree-sitter-runtime.js` exists, adding any
language is "load grammar + write a query file." Doing Go or Rust
first means writing throwaway grammar-loading code that gets
replaced.

---

## Phase 10.next — 20 compiler warnings (shipping in this PR)

See `mvp/docs/WARNINGS_CATALOG.md` for the menu they were picked from.
All target the existing `data.warnings: [{kind, severity, message}]`
attached to nodes during analyze.

**18 body-regex** (in `mvp/lib/warnings.js`, run per-function):

| kind | sev | signal |
|---|---|---|
| `eval-or-function-ctor` | high | `eval(...)` / `new Function(...)` / Python `exec(...)`  |
| `weak-crypto` | medium | `createHash('md5'\|'sha1')` / `hashlib.(md5\|sha1)` |
| `jwt-no-verify` | high | `jwt.decode(` without a matching `jwt.verify(` |
| `cors-allow-all` | high | header set to `*` or `res.header("Access-Control-Allow-Origin", "*")` |
| `requests-verify-false` | high | Python `verify=False` / JS `rejectUnauthorized: false` |
| `hardcoded-password` | high | string literal assigned to `password`/`passwd`/`pwd` of length ≥ 4 |
| `cookie-no-httponly` | medium | `res.cookie(...)` call without `httpOnly` flag |
| `sort-in-loop` | high | `.sort(` or `sorted(` inside a `for`/`while` body |
| `string-concat-in-loop` | medium | `s += "..."` / `s = s + "..."` inside loop body |
| `sync-io-in-async` | high | async fn whose body has `readFileSync`/`writeFileSync`/`existsSync` |
| `fetch-without-timeout` | medium | `fetch(...)` or `requests.{get\|post\|put\|delete}(...)` with no `timeout` arg |
| `regex-compile-in-loop` | medium | `new RegExp(...)` / `re.compile(...)` inside loop body |
| `loose-equality` | low | JS/TS `==` or `!=` (not `===` / `!==`) outside string contexts |
| `empty-catch` | medium | `catch (...) {}` / Python `except: pass` |
| `swallowed-error` | medium | catch block whose only statement is `console.log(err)` |
| `ts-ignore` | medium | `@ts-ignore` / `@ts-nocheck` / `@ts-expect-error` / `as any` |
| `async-without-await` | low | function declared `async` with no `await` in body |
| `settimeout-not-cleared` | low | `setTimeout(...)` / `setInterval(...)` return not bound to a variable |

**2 IR-level passes** (a small `mvp/lib/dead-code.js` module, run
post-resolver against `ir.nodes` + `ir.edges`):

| kind | sev | signal |
|---|---|---|
| `dead-function` | medium | def node with no inbound `calls` AND not exported (no file imports the path) |
| `circular-import` | high | cycle in the `imports-file` edge subgraph; attaches to every node in the cycle |

These two need the IR's edge graph, not just the function body, so
they don't fit in `warnings.js` — they get their own module that
`analyze.js` calls after `resolveSymbols`.

Acceptance check: the corpus harness still passes (`expects: all
within bounds`); on `expressjs/express`, the security batch lights up
at least a couple of routes that use weak crypto / missing timeouts.

---

## Phase 5.1 — Tree-sitter swap (TS + Python)

### Goal

Replace the regex extractors in `mvp/lib/parsers/ts.js` and
`mvp/lib/parsers/py.js` with **tree-sitter-backed** ones that produce
**the same node ids on every existing fixture** plus richer
signatures (generics, decorators, complex destructuring) and the
JSX edge cases the regex misses.

### Why not `node-tree-sitter`?

It needs native compilation per-platform. Cloud Run builds inside a
slim image and the npm postinstall on `node-tree-sitter` is fragile
across glibc versions. We pick **`web-tree-sitter`** instead —
WASM-backed, no native binaries, same parser quality. Trade-off:
~50 ms slower per file, ~2 MB additional bundle size. The corpus
harness already runs `analyzeRepo` against repos with 5 k+ files
in 90 s; even at 50 ms × 5 k = 250 s we still need to keep things
fast. Mitigation in the perf section below.

### Runtime: `mvp/lib/parsers/tree-sitter-runtime.js` (new)

Single shared module. Exports:

```js
export async function getParser(lang)
// Returns a cached Parser instance with the matching grammar loaded.
// First call per (lang) loads the .wasm grammar from disk (~10 ms).
// Subsequent calls return the cached instance (~0 ms).

export async function getQuery(lang, name)
// Returns a cached Query compiled from .scm source. Queries live at
// mvp/lib/parsers/queries/<lang>/<name>.scm and are loaded once.

export function captureNodes(query, tree)
// Iterates query captures, yields { name, node } pairs. The same
// shape we'd get from tree-sitter-cli but adapted to web-tree-sitter
// (which returns flat capture lists).
```

WASM grammars live in `mvp/lib/parsers/grammars/`:
- `tree-sitter-typescript.wasm`  (~500 KB, covers `.ts` + `.tsx`)
- `tree-sitter-javascript.wasm`  (~250 KB)
- `tree-sitter-python.wasm`      (~300 KB)

Total ~1.1 MB added to the deploy image. Cloud Run cold start adds
~80 ms one-time for the WASM compile.

### Queries: `mvp/lib/parsers/queries/`

One `.scm` file per (language, feature). Examples for TS:

`queries/ts/functions.scm`:
```scheme
; Top-level + exported function declarations
(function_declaration
  name: (identifier) @name
  parameters: (formal_parameters) @params
  return_type: (type_annotation)? @return_type
  body: (statement_block) @body) @function

; Arrow / fn-expr assigned to a const at module scope
(variable_declarator
  name: (identifier) @name
  value: [
    (arrow_function
      parameters: (formal_parameters) @params
      return_type: (type_annotation)? @return_type
      body: _ @body)
    (function_expression
      parameters: (formal_parameters) @params
      return_type: (type_annotation)? @return_type
      body: _ @body)
  ]) @function
```

`queries/ts/classes.scm`:
```scheme
(class_declaration
  name: (type_identifier) @name
  (class_heritage)? @bases
  body: (class_body) @body) @class

(method_definition
  name: (property_identifier) @name
  parameters: (formal_parameters) @params
  return_type: (type_annotation)? @return_type) @method

(public_field_definition
  name: (property_identifier) @name
  type: (type_annotation)? @type
  value: _? @default) @field
```

Similar for `imports.scm`, `calls.scm`, `decorators.scm` (Python).

### Drop-in strategy

`mvp/lib/parsers/index.js` already has a backend registry. The swap:

```js
import { extractDefs as extractDefsRegex } from "./ts.js";
import { extractDefs as extractDefsTreeSitter } from "./ts-tree-sitter.js";

export async function parseTs(src, path) {
  // env flag lets us roll back instantly without redeploying
  if (process.env.RYNGO_PARSERS === "regex") {
    return { backend: "regex-ts", ...extractDefsRegex(src) };
  }
  try {
    const result = await extractDefsTreeSitter(src, path);
    return { backend: "tree-sitter-ts", ...result };
  } catch (err) {
    // Tree-sitter parse error → fall back to regex so we never
    // produce an empty IR for a file just because the new parser
    // choked on syntax it doesn't know.
    return { backend: "regex-ts-fallback", ...extractDefsRegex(src), parseError: err.message };
  }
}
```

The IR shape is **identical** — every regex extractor's node id is a
hash of `(kind, path, name)`. Tree-sitter produces the same `(kind,
path, name)` triple for every def we already extract, so existing
node ids are preserved. Diff identity holds across the swap.

### Verification

1. **Same-node-id property test:** add `mvp/test/parser-parity.js`
   that runs both extractors on the corpus fixtures and asserts the
   set of `(kind, path, name)` triples is a **superset** under
   tree-sitter (we expect more, never fewer).
2. **Corpus regression:** `npm run corpus` — every classification
   must stay flat or go up. A `min` violation fails the PR.
3. **Specific upgrades to verify:**
   - JSX function components in `shadcn-ui/ui` were under-extracted
     by regex; tree-sitter should bump `defs` count by 5-15 %.
   - Python class members with decorators (`@property`, `@cached_property`,
     `@classmethod`) were missed by regex; expect a +10 % bump on
     `tiangolo/fastapi`.
   - TS generic functions — `function pipe<A, B>(...)` — regex
     dropped the `<A, B>` and got the param count wrong.

### Performance

Hot path: 5 000 files × 50 ms WASM parse = 250 s, blows the budget.
Three mitigations:

1. **Pool of 4 parsers per language** (one per worker thread). Run
   the parse pass in a `worker_threads` pool. Brings 5 000 files
   down to ~60 s.
2. **Cache compiled WASM globally.** The `getParser` cache persists
   across `analyzeRepo` calls, so the second repo on the same Cloud
   Run instance pays zero WASM init cost.
3. **Skip tree-sitter on files > 200 KB**. Fall back to regex; the
   marginal value of perfect AST on a 200 KB single-file dump is
   small and the parse cost balloons quadratically with file size.

### Files

```
mvp/lib/parsers/tree-sitter-runtime.js   ── new, ~120 LOC
mvp/lib/parsers/grammars/*.wasm          ── new, ~1.1 MB total
mvp/lib/parsers/queries/ts/*.scm         ── new, ~5 files
mvp/lib/parsers/queries/py/*.scm         ── new, ~5 files
mvp/lib/parsers/ts-tree-sitter.js        ── new, ~250 LOC
mvp/lib/parsers/py-tree-sitter.js        ── new, ~250 LOC
mvp/lib/parsers/index.js                 ── edit, ~30 LOC of dispatch
mvp/test/parser-parity.js                ── new, ~150 LOC property test
mvp/lib/parsers/ts.js                    ── kept as `regex-ts` fallback
mvp/lib/parsers/py.js                    ── kept as `regex-py` fallback
package.json                             ── add web-tree-sitter dep
Dockerfile                               ── copy grammars/ into image
```

### Unblocks

Every 🟡 warning in the catalog (~30 of them) becomes feasible:
- `function-defined-in-loop` (need to know `function` vs arrow vs
  method without false positives)
- `mutation-of-param` (need to know if name is a param)
- `shadowed-variable` / `unused-variable` (scope-aware)
- `unreachable-code` (control-flow aware)
- `async-iter-with-await-in-loop` (need to distinguish `for await`
  from `for`)
- `react-missing-key` (JSX node detection)
- … and ~25 more

---

## Phase 5.4 — Go support

### Approach: hybrid `go list` + tree-sitter

Pure `go list -deps -json ./...` gives us packages and imports but
**not function bodies**. Pure tree-sitter Go grammar gives us
functions but not cross-package edges or real types. Combine them:

- **`go list -deps -json ./...`** → produces `mvp/lib/parsers/go-packages.json`
  per repo: package list, files per package, imports per package,
  module path.
- **tree-sitter Go grammar** → per-file def extraction (functions,
  methods, structs, interfaces).
- **`go doc -json`** *(optional, only when `gopls` is installed)* →
  upgrade signatures from "syntactic" to "resolved" types.

### Detection

```js
async function detectGoProject(rootDir) {
  return await fs.access(path.join(rootDir, "go.mod"))
    .then(() => true)
    .catch(() => false);
}
```

If no `go.mod`, skip the `go list` step; treat `.go` files via
tree-sitter only. (Useful for example repos that aren't full modules.)

### Subprocess wrapper

`mvp/lib/parsers/go-list.js` (new):

```js
import { spawn } from "node:child_process";

/**
 * Run `go list -deps -json ./...` in the given dir. Returns parsed
 * package metadata. Falls back to null when `go` isn't on PATH.
 */
export async function goListAll(rootDir) {
  try {
    const out = await runWithTimeout("go", ["list", "-deps", "-json", "./..."], {
      cwd: rootDir,
      timeoutMs: 30_000,
    });
    return parseGoListNdjson(out);  // go list emits NDJSON, not a single array
  } catch (err) {
    if (err.code === "ENOENT") return null;  // go not installed
    throw err;
  }
}
```

NDJSON parsing: `go list` outputs JSON objects separated by newlines
between them — split on `^\}\n\{` and reparse.

### IR mapping

Go package `github.com/foo/bar/baz` → IR node id `pkg:github.com/foo/bar/baz`
Go file `internal/server/main.go` → `file:internal/server/main.go`
Go function `Foo` in package `baz` → `def:internal/server/main.go#Foo`

Adapter `mvp/lib/adapters/go-http.js` (new, optional):
Detect `net/http` import → routes from `http.HandleFunc(...)` /
`mux.HandleFunc(...)` / `gin.GET(...)`.

### Files

```
mvp/lib/parsers/go-list.js          ── new, ~120 LOC
mvp/lib/parsers/go-tree-sitter.js   ── new, ~200 LOC
mvp/lib/parsers/queries/go/*.scm    ── new, 4 files
mvp/lib/parsers/grammars/tree-sitter-go.wasm   ── new, ~400 KB
mvp/lib/parsers/index.js            ── add Go dispatch
mvp/lib/adapters/go-http.js         ── new, optional ~80 LOC
mvp/test/corpus.js                  ── add 3 Go repos with `expects`
```

### Corpus additions

| repo | why |
|---|---|
| `gin-gonic/gin` | router framework — exercises the http adapter |
| `cosmos/cosmos-sdk` | large repo, exercise scale |
| `prometheus/prometheus` | mid-size, lots of packages |

Expected baseline: ≥ 500 defs on gin, ≥ 5000 defs on cosmos-sdk,
≥ 30 packages on prometheus. Codify as `expects` blocks.

### Risk

Cloud Run doesn't have `go` installed by default. Either:
- Add Go to the Dockerfile (~150 MB extra), OR
- Skip the `go list` step in production; rely on tree-sitter alone.

Recommendation: tree-sitter-only in v1, add Go toolchain in
Dockerfile in v2 if cross-package edges become important. The
tree-sitter-only IR is already richer than today's stub.

---

## Phase 5.5 — Rust support

### Approach: hybrid `cargo metadata` + tree-sitter

Same shape as Go. Skip `rust-analyzer scip` for v1 — it's heavy
(~200 MB binary), needs cargo-installed projects, and the SCIP parser
adds an npm dependency. Tree-sitter + `cargo metadata` covers 90 %.

### Detection

```js
async function detectRustProject(rootDir) {
  return await fs.access(path.join(rootDir, "Cargo.toml"))
    .then(() => true)
    .catch(() => false);
}
```

### `cargo metadata --format-version 1`

JSON output with packages, dependencies, target kinds. We extract:
- Workspace members → multiple `pkg:` nodes
- Each crate's `src/` files → tree-sitter parsed
- `Cargo.lock` for dep version pinning

### Tree-sitter Rust

`grammars/tree-sitter-rust.wasm` (~500 KB). Queries:
- `functions.scm` — `fn` declarations + impl methods
- `structs.scm` — struct + enum declarations with field types
- `traits.scm` — trait declarations + impl blocks (these become trait edges)
- `imports.scm` — `use` statements
- `macros.scm` — `macro_rules!` and proc macros (best-effort)

### IR mapping

Rust crate `tokio-rs/mio` → `pkg:mio`
File `src/lib.rs` → `file:src/lib.rs`
Function `poll` in `src/lib.rs` → `def:src/lib.rs#poll`
Impl method `fn read` on `struct File` → `def:src/lib.rs#File::read`

Trait edges: `impl Future for X` produces `implements:File→Future`
edges in the IR.

### Files

```
mvp/lib/parsers/rust-cargo.js          ── new, ~100 LOC
mvp/lib/parsers/rust-tree-sitter.js    ── new, ~280 LOC
mvp/lib/parsers/queries/rust/*.scm     ── 5 files
mvp/lib/parsers/grammars/tree-sitter-rust.wasm  ── ~500 KB
mvp/test/corpus.js                     ── add 3 Rust repos
```

### Corpus additions

| repo | why |
|---|---|
| `tokio-rs/mio` | already in corpus; flip from stub to real |
| `rust-lang/rustlings` | small + idiomatic; baseline check |
| `BurntSushi/ripgrep` | mid-size, lots of traits |

### Risk

Rust's macro system means some declarations only exist at macro
expansion time (e.g. `#[derive(Debug)]` generates an impl). Tree-sitter
sees the call site but not the expansion. We accept this — these
generated functions aren't authored, so missing them in the IR is OK.
Adapter for `serde`/`derive` patterns can come later if needed.

---

## Shipping order — total timeline

| Phase | Effort | Ships in |
|---|---|---|
| Phase 10.next — 20 warnings | ~5 h | this PR |
| Phase 5.1.0 — tree-sitter runtime + queries (TS) | ~6 h | PR 2 |
| Phase 5.1.1 — TS swap with regex fallback | ~3 h | PR 3 |
| Phase 5.1.2 — Python tree-sitter swap | ~6 h | PR 4 |
| Phase 5.1.3 — Worker-pool perf | ~4 h | PR 5 |
| Phase 5.4 — Go via tree-sitter + go list | ~8 h | PR 6 |
| Phase 5.5 — Rust via tree-sitter + cargo metadata | ~8 h | PR 7 |
| Warning unlock pass — implement 30 🟡 warnings | ~6 h | PR 8 |

Each PR is independently mergeable and ships behind a feature flag
(`RYNGO_PARSERS=regex|tree-sitter`) until the corpus shows zero
regressions.

---

## Verification rubric (applies to every PR)

1. **Build:** `npx vite build` clean at 538+ modules.
2. **Corpus:** `npm run corpus` — `expects: all repos within
   declared bounds`, `anomalies: none`.
3. **Property tests:** the new parser-parity test (Phase 5.1+)
   never produces a NARROWER set of node ids than the regex baseline.
4. **Smoke:** server boots, `/api/health` 200, `/api/stats/public`
   200, sample analyze returns IR with the new fields populated.
5. **No surprise diff:** `git diff` is contained to the file map
   listed for that phase.
