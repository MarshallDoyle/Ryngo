# codegraph — Incremental Analysis Design

Status: design draft (v0.1)
Audience: codegraph core contributors, adapter authors, CI integrators
Scope: end-to-end design for incremental re-indexing of a monorepo on every PR push, with a target of < 30s warm-cache run on a 10K-file repo (changed-files-only path), and a sensible cold-start path that still finishes within typical CI budgets.

This document specifies:

1. The on-disk cache layout under `.codegraph/cache/` and the keying scheme.
2. The "what to re-analyze" decision: per-file content hashing, reverse-dependency closure, and adapter-aware invalidation.
3. How tree-sitter incremental parsing and SCIP indexer outputs slot into the cache.
4. Parallelism: worker pool sizing and the parallel-then-merge pipeline.
5. Version-driven cache invalidation (codegraph version, adapter versions, config).
6. CI integration with `actions/cache` (key recipe, restore-keys ladder, warm vs cold timings).
7. Cold-start fallback: full re-index path for first-run.
8. Pseudocode for the core invalidation algorithm.

The design is deterministic and LLM-free — every decision derives from content hashes, file paths, declared adapter behaviors, and a few well-defined version stamps.

---

## 0. Glossary

- **IR fragment** — the per-file intermediate representation produced by codegraph: nodes (symbols, routes, models, etc.) and edges (intra-file references). One IR fragment per source file.
- **Symbol table** — global, post-merge: every public symbol declared anywhere in the repo, keyed by stable ID.
- **Cross-resolution** — the merge step that turns local "I import `./foo`" edges into global symbol-to-symbol edges across files and packages.
- **Adapter** — a pluggable rule pack that recognizes framework patterns (Express routes, Prisma models, NestJS modules, etc.) and contributes nodes/edges/invalidation rules.
- **Manifest** — the per-run JSON file that records which files were analyzed, their hashes, the cache key, and the adapter set used. Lives at `.codegraph/cache/manifest.json`.

---

## 1. Goals and non-goals

### 1.1 Goals

- A warm CI run touching ~50 files in a 10K-file monorepo finishes in **< 30s** wall-clock.
- A cold CI run on a 10K-file monorepo is **bounded**, **parallel**, and **deterministic** — typically 3–8 minutes depending on adapter mix; always < 15 min.
- The cache is **safe to share across branches** (key includes content, version, and adapter versions; no branch-specific state leaks in).
- Cache invalidation is **conservative-correct**: never skip re-analysis of a file whose result could have changed. Better to redo work than emit a stale graph.
- The system degrades gracefully: a corrupt or partial cache is detected and falls back to cold-start without manual intervention.

### 1.2 Non-goals

- We do not attempt to incrementally update the *output graph* when only the call-graph topology changes downstream of an unchanged file. We re-merge cross-resolution from scratch every run; only the per-file work is cached. (Per-file work dominates total time at any reasonable repo size, and merging a flat list of edges is cheap.)
- We do not attempt distributed caching beyond what `actions/cache` provides.
- No watch/daemon mode in scope here — this design targets one-shot CLI invocations from CI. A daemon mode could reuse the same cache, but is out of scope.

---

## 2. High-level pipeline

```
                      +--------------------+
                      |  changed-file set  |   <- from `git diff --name-only`
                      |  (or "all" cold)   |      against PR base, or full scan
                      +----------+---------+
                                 |
                                 v
                      +--------------------+
                      | 1. Discovery       |  walk repo, apply ignore rules
                      |   + content hash   |  blake3(content) -> contentHash
                      +----------+---------+
                                 |
                                 v
                      +--------------------+
                      | 2. Cache lookup    |  per-file: do we have a fragment
                      |                    |  whose key matches?
                      +----+-----------+---+
                           | hit       | miss
                           v           v
                  +-----------+   +--------------------+
                  | reuse     |   | 3a. Parse (TS)     |   tree-sitter incremental
                  | fragment  |   | 3b. Run SCIP       |   if SCIP-backed lang
                  +-----+-----+   | 3c. Adapter pass   |   per file/per adapter
                        |         +----------+---------+
                        |                    |
                        v                    v
                      +--------------------+
                      | 4. Reverse-dep     |  re-analyze importers, etc.
                      |    closure         |  iterate to fixed-point
                      +----------+---------+
                                 |
                                 v
                      +--------------------+
                      | 5. Cross-resolution|  global symbol merge
                      |    + edge stitching|  parallel-fan-in
                      +----------+---------+
                                 |
                                 v
                      +--------------------+
                      | 6. Output graph    |  serialize, write report
                      |    + manifest      |  update .codegraph/cache/...
                      +--------------------+
```

Steps 1–3 are **per-file and embarrassingly parallel**. Step 4 is iterative but bounded (typically 1–3 hops). Step 5 is the merge — it sees every fragment but only does cheap edge-stitching work. Step 6 writes outputs and updates the cache manifest atomically.

---

## 3. Cache layout

The cache lives at the repo root in `.codegraph/cache/`. It is **gitignored**; in CI it is restored via `actions/cache` keyed on the recipe in §10.

```
.codegraph/
  cache/
    manifest.json                # cache-wide metadata (see §3.2)
    fragments/
      <hashPrefix2>/<contentHash>.frag.json   # IR fragments, content-addressed
    asts/
      <hashPrefix2>/<contentHash>.ast.bin     # tree-sitter binary AST snapshots
    scip/
      <hashPrefix2>/<contentHash>.scip.pb     # SCIP per-file extracts (when applicable)
    adapters/
      <adapterId>/<adapterVersion>/
        <hashPrefix2>/<contentHash>.json      # adapter-specific per-file output
    indices/
      importGraph.json           # last run's file->file import graph (for fast closure)
      symbolIndex.json           # last run's global symbol map
    locks/
      manifest.lock              # advisory lock during writes
```

### 3.1 Why content-addressed?

Files are stored under `<contentHash>` rather than under their path. Two consequences:

- **Branch-safe sharing**: file `src/foo.ts` on branch A and on branch B with identical contents share a fragment. No collisions, no per-branch cache pollution.
- **Cheap renames**: a rename without content change is a manifest update only — no re-parse, no re-adapter pass.

The trade-off is that the cache can grow over time (orphaned fragments for files that no longer exist anywhere). We GC opportunistically: every run, if `cache/fragments/` exceeds a soft cap (default 2 GiB), we delete the oldest 25% by `mtime`. Adapters' output trees are cleaned alongside.

`<hashPrefix2>` is the first two hex chars of the hash, used as a sharding directory to keep any single directory under ~10K entries.

### 3.2 `manifest.json`

Single JSON file, written atomically (write to `manifest.json.tmp`, fsync, rename). Holds *small* metadata only — large data lives in the per-file files.

```json
{
  "schemaVersion": 1,
  "codegraphVersion": "0.4.2",
  "configHash": "b7e9...",
  "adapterSet": [
    { "id": "express", "version": "0.4.2", "configHash": "1c8a..." },
    { "id": "prisma",  "version": "0.4.2", "configHash": "9f01..." }
  ],
  "createdAt": "2026-05-08T12:00:00Z",
  "lastRunAt":  "2026-05-08T14:20:00Z",
  "files": {
    "src/server/router.ts": {
      "contentHash": "blake3:7e02...",
      "fragmentKey": "blake3:7e02...:codegraph-0.4.2:adapters-h-7c1d:cfg-h-b7e9",
      "size": 4123,
      "mtime": 1715169600,
      "language": "ts",
      "imports": ["src/server/handlers/users.ts", "express"],
      "adapters": ["express"]
    },
    ...
  },
  "globalSentinels": {
    "schema.prisma": "blake3:abc1...",
    "tsconfig.base.json": "blake3:def2...",
    "package.json": "blake3:ee03...",
    "pnpm-lock.yaml": "blake3:1234..."
  }
}
```

The `fragmentKey` is the canonical lookup key used at step 2. It composes everything that could change a fragment's content (see §6 for the formal definition).

`globalSentinels` are files whose content invalidates many or all fragments — see §5.3.

### 3.3 Atomicity & corruption recovery

- All writes go through a temp-file + rename. Readers ignore `*.tmp`.
- A startup self-check verifies that `manifest.json` parses and that `schemaVersion` matches the running binary. On mismatch, the *cache* is treated as cold but `actions/cache` may still have restored useful per-file fragments — those are still valid because their keys embed the codegraph version, so we can re-build the manifest by walking `fragments/` (slower than warm, faster than cold).
- A fragment whose file is missing (e.g. partial cache restore) is treated as a miss for that file; the run continues.

---

## 4. Per-file caching

### 4.1 Hashing

We use **blake3** for content hashing: ~3 GB/s single-threaded on commodity hardware, dramatically faster than SHA-256 and well-suited to walking 10K files. Hash inputs:

- Raw file bytes (no normalization — line endings matter; the parser sees what's on disk).
- A small header `b"codegraph-content-v1\n"` mixed in to future-proof against algorithm bumps.

We do **not** hash file paths — paths are tracked in the manifest, not in the content hash, because two files with identical content should share a fragment.

### 4.2 What's in a fragment?

Each fragment is a JSON object (msgpack also viable; we pick JSON for debuggability) with a stable shape:

```jsonc
{
  "schema": 1,
  "language": "ts",
  "contentHash": "blake3:7e02...",
  "parser": { "name": "tree-sitter-typescript", "version": "0.21.1" },
  "nodes": [
    { "id": "sym:export:UserRouter", "kind": "class", "loc": [12, 0, 88, 1] },
    { "id": "sym:export:registerRoutes", "kind": "function", "loc": [90, 0, 110, 1] }
  ],
  "edges": [
    { "from": "sym:export:UserRouter", "to": "imp:./handlers/users.ts:UsersHandler", "kind": "uses" }
  ],
  "imports": [
    { "specifier": "./handlers/users.ts", "kind": "relative", "symbols": ["UsersHandler"] },
    { "specifier": "express", "kind": "package", "symbols": ["Router"] }
  ],
  "adapterContributions": {
    "express": { "routes": [{ "method": "GET", "path": "/users", "handler": "UsersHandler.list" }] }
  },
  "diagnostics": []
}
```

Importantly, fragments contain only **local** information. Anything that depends on another file (e.g. resolving `./handlers/users.ts` to a real symbol ID) is left as an unresolved reference and resolved at step 5.

### 4.3 AST and SCIP caches

Tree-sitter ASTs are reusable across runs *only* when the content hash matches and the parser version matches. We cache the serialized binary tree (`tree-sitter` provides `Tree::root_node` traversal but no built-in serialize; we serialize a compact node-typed representation). On a content hit we still need the AST only when an adapter wants to walk the tree; if the fragment alone is sufficient, we can skip loading the AST entirely. In practice most fragment-only consumers (cross-resolution, output) don't need the AST, so we **lazy-load** ASTs.

SCIP indexer outputs (e.g. `scip-typescript`, `scip-python`) are large per-package blobs, not per-file. We post-process a SCIP run into per-file slices and store under `cache/scip/<contentHash>.scip.pb`. The slicing is purely a function of content and the SCIP indexer version — see §7.

---

## 5. What invalidates a file's fragment?

A fragment's identity (its `fragmentKey`) is the conjunction of every input that would change its bytes. If any of these change, we must re-derive.

### 5.1 The fragment key

```
fragmentKey =
    contentHash
  + ":" + codegraphVersion
  + ":" + adapterSetHash         // see §6
  + ":" + configHash             // codegraph.config.{json,ts} hashed
  + ":" + parserKey              // tree-sitter language version, scip indexer version
```

If any component changes, the key changes, and a lookup miss forces re-derivation. Because fragments are stored under `contentHash`, but the *fragment key* is what we look up in the manifest, two runs with different codegraph versions on identical content will store two fragments at the same content path — that's wrong, so we actually store fragments under a path that includes the full key:

```
cache/fragments/<hashPrefix2>/<contentHash>.<keySuffixHash>.frag.json
```

where `keySuffixHash = blake3(codegraphVersion + adapterSetHash + configHash + parserKey)[:16]` — short enough to keep filenames manageable, long enough to make collisions astronomically unlikely.

### 5.2 Cross-file invalidation: import edges and reverse-deps

A file's fragment is local — but the **graph it participates in** is not. When `src/lib/util.ts` changes, files that import it must be re-cross-resolved (because the symbols they were referencing may have been renamed, removed, or their type signatures changed).

Concretely we maintain `cache/indices/importGraph.json`: a map from each file to its declared importers (the *reverse* of the import edges). On a re-run:

1. Compute the **changed set** Δ = files whose `contentHash` differs from manifest.
2. Compute the **closure** Δ* = Δ ∪ (1-hop importers of Δ for "shape-changing" reasons; see below) ∪ (transitive importers when an adapter declares it).

The 1-hop expansion is the default. Going beyond 1 hop is only needed when:

- An adapter declares it (e.g. Prisma model removal cascades through every consumer of any type touched, but that's modelled as a *global* sentinel, not as a transitive walk).
- A "shape-changing" diff occurred — the file's *exported surface* changed. We detect this by comparing the previous fragment's `nodes` (where `kind` is exported) to the new one. If only function bodies changed, downstream files don't need re-cross-resolution. If exports changed, 1-hop importers need their cross-resolution redone, but **not** their fragments re-derived (their content didn't change).

This last distinction matters. The closure has two flavours:

- **Re-derive** (re-parse, re-adapter, re-fragment): the file's own content changed.
- **Re-resolve** (keep fragment, redo cross-resolution edges only): an imported file's exported surface changed.

Re-resolve is dramatically cheaper — it's a hash-table lookup per import, no parsing, no adapters. On a typical PR touching 5 source files with stable exports, the re-resolve set is empty and we do the minimum work.

### 5.3 Global sentinels

Some files invalidate many others. The adapter set declares them; at minimum:

| Sentinel | Effect |
|---|---|
| `package.json` (root + per-package) | If `dependencies`/`devDependencies` change, package-import resolution can flip; re-resolve all files in affected package. |
| `pnpm-lock.yaml` / `package-lock.json` / `yarn.lock` | If transitive resolutions change, re-resolve everything that imports the affected packages. (Coarse: re-resolve all.) |
| `tsconfig*.json` | Path mappings change → re-resolve everything in the project. |
| `schema.prisma` | All Prisma-tagged consumers re-derive (Prisma adapter generates types from schema). |
| `codegraph.config.*` | Bumps `configHash` → invalidates everything via fragment-key mismatch. |

Sentinels are tracked in `manifest.globalSentinels`. On startup, we hash each one and compare. A change here can short-circuit straight to "treat as cold" if too pervasive — see §13 for the policy.

---

## 6. Adapter-aware invalidation

Adapters are the place where framework-specific knowledge lives. They contribute three things to incrementality:

1. **A version string** — bumps invalidate every fragment that involves the adapter.
2. **A configuration hash** — adapter-specific config (e.g. "treat `**/*.controller.ts` as Express handlers") changes hash, same effect.
3. **An invalidation declaration** — the adapter tells codegraph what cross-file relationships it cares about.

### 6.1 The adapter invalidation API

Each adapter exports a static description:

```ts
interface AdapterInvalidationSpec {
  id: string;                   // "express"
  version: string;              // "0.4.2"
  configHash: string;           // hash of adapter-relevant config

  // What file patterns activate this adapter on a given file?
  matches(file: FilePath): boolean;

  // Files whose change forces re-derive on every consumer of this adapter.
  // Returns absolute paths; matched against changed set on each run.
  globalSentinels(): FilePath[];

  // Given the set of files this adapter contributed to, which files must be
  // re-analyzed if file F changed? Default: just F + 1-hop importers.
  // Adapters can broaden this (e.g. Prisma -> all consumers).
  reanalysisClosure(changed: FilePath, importGraph: ImportGraph): FilePath[];
}
```

The host calls `reanalysisClosure` per adapter for each file in Δ and unions the results into Δ*. Adapters cannot *narrow* the closure — they can only widen it. (This preserves the conservative-correct guarantee.)

### 6.2 Express adapter

- `matches(file)`: file declares an `express.Router()` or contains decorators registered as Express handlers per config.
- `globalSentinels()`: none beyond the host's defaults.
- `reanalysisClosure(F)`:
  - If F is a route file (has `router.get(...)` etc.) → return F + handler files referenced from F + 1-hop importers of F.
  - If F is a handler file → return F + route files that import it + 1-hop importers of F.
  - Otherwise: F + 1-hop importers (default).

The handler-finding step uses the previous run's import graph; a freshly-touched handler whose route reference doesn't exist yet falls back to the 1-hop default and gets discovered on the next iteration of the fixed-point loop (§9).

### 6.3 Prisma adapter

- `matches(file)`: file imports from `@prisma/client` or is `schema.prisma`.
- `globalSentinels()`: every `schema.prisma` in the repo.
- `reanalysisClosure(F)`:
  - If F is `schema.prisma` → return **all** files that match this adapter (i.e. all consumers). The Prisma client is regenerated from the schema, so any consumer's symbol IDs may shift.
  - Else: F + 1-hop importers.

This is the canonical "schema sentinel" pattern — coarse but correct, and the fact that schema changes are rare keeps it cheap in practice.

### 6.4 NestJS adapter (illustrative)

- `matches(file)`: contains `@Module`, `@Controller`, `@Injectable`.
- `globalSentinels()`: none.
- `reanalysisClosure(F)`:
  - If F is a `@Module` → return F + every file referenced in `imports`/`providers`/`controllers` arrays (parsed from previous fragment) + 1-hop importers.
  - Else default.

### 6.5 Composing adapters

For a file F changed in Δ, the final closure contribution is the **union** over all adapters that match F:

```
Δ*(F) = ⋃ adapter.reanalysisClosure(F, importGraph)  for adapter where adapter.matches(F)
```

Then Δ* is the union of Δ*(F) for all F in Δ, plus the closures of any global sentinels that changed:

```
Δ_final = Δ ∪ ⋃_{F ∈ Δ} Δ*(F) ∪ ⋃_{S ∈ changedSentinels} sentinelClosure(S)
```

This is computed iteratively (see §9) because newly-included files can themselves bring in new transitive dependencies via adapters.

---

## 7. SCIP and tree-sitter incrementality

### 7.1 Tree-sitter

Tree-sitter supports incremental parsing within a single editor session via `Tree::edit` + `parser.parse(text, oldTree)`. Across processes (CI), there's no living `oldTree`. We get the same effect a different way:

- **Cache the AST per content hash.** A content hit → AST hit → adapters walk the cached AST without re-parsing. Cold miss → full parse, then write AST.
- The within-session `Tree::edit` advantage doesn't apply to CI (each file is parsed at most once per run from cold), so we don't need it.

In a future watch-mode daemon we'd keep the in-memory `oldTree` for true incremental within a session. Out of scope here.

### 7.2 SCIP indexers

SCIP indexers (`scip-typescript`, `scip-python`, `scip-java`, etc.) are **whole-package** tools — you can't ask `scip-typescript` to "just re-do this one file." Two options:

1. **Re-run on cache miss, slice on cache hit.** Run the SCIP indexer once per project; slice its output by file path; store each slice under `cache/scip/<contentHash>.scip.pb`. On warm runs, if every file in a project hits the cache, skip the SCIP run entirely.
2. **Re-run always, cache the slices.** Always run SCIP; intersect produced slices with the changed set; only re-process new slices.

We use option (1) with a guard: if **any** file in a SCIP-managed project is a re-derive miss, we re-run SCIP for that project and re-slice. Otherwise the SCIP run is skipped for that project. This puts the SCIP cost at "first run + after changes in that project" only.

The granularity is per **SCIP project** (typically per `tsconfig.json` for TS, per package for Python). We track project membership in the manifest:

```jsonc
"scipProjects": {
  "packages/api/tsconfig.json": {
    "indexer": "scip-typescript",
    "indexerVersion": "0.4.0",
    "lastRunFiles": ["packages/api/src/index.ts", "..."],
    "lastRunHash": "blake3:..."   // hash of (sorted file paths + their content hashes)
  }
}
```

If `lastRunHash` matches a freshly computed value at the start of a run, we know every file in the project hit the cache and skip the SCIP run. Else we re-run.

### 7.3 Where adapters fit on top of SCIP

Adapters consume both tree-sitter ASTs and SCIP outputs. Adapter outputs are themselves cached per file (§3, `cache/adapters/...`). The adapter cache key embeds adapter version + adapter config + content hash + (if used) the SCIP slice hash for that file. So an adapter version bump invalidates only that adapter's per-file outputs — fragments and SCIP slices remain valid.

---

## 8. Parallelism

### 8.1 Where the parallelism is

| Stage | Parallelism |
|---|---|
| 1. Discovery + hash | `O(workers)` reading disk; hashes are CPU-bound — saturates cores. |
| 2. Cache lookup | Trivial; in-memory map after manifest load. |
| 3. Parse + adapter (per file) | Embarrassingly parallel. |
| 4. Reverse-dep closure | Iterative but cheap (set ops + import-graph walks). |
| 5. Cross-resolution | Largely parallel: bucket by symbol-namespace, resolve within bucket. |
| 6. Output + manifest write | Single-writer (atomic rename). |

### 8.2 Worker pool sizing

Default: `min(N_cores, max(2, N_files / 50))` with a floor of 4 and a ceiling of 32. Rationale:

- Small repos (< 200 files): cores aren't the bottleneck, syscall overhead is. Cap at 4–8.
- Medium repos (1K–10K files): saturate cores.
- Very large repos: 32 is the soft cap because beyond that, contention on shared structures (symbol table merges, manifest writes) outweighs gains. Override via `--workers N`.

CI runners are typically 2-vCPU (free) to 4-vCPU (paid). The same heuristic applies; we observe in practice that 4 workers is the practical sweet spot for free GitHub runners and 8–16 for self-hosted.

### 8.3 Memory pressure

Each worker holds at most one file's text, AST, and fragment at a time. Peak memory is roughly `workers * max_file_size * O(10)` (the constant accounts for AST overhead). For a 10K-file TS monorepo with `max_file_size ≈ 1 MiB` and 16 workers, that's ~160 MiB — comfortably below CI runner limits.

The merge step (§5) needs to hold the symbol table in memory. Sized in practice at ~50–100 MiB for a 10K-file repo (a few hundred thousand symbols).

### 8.4 Deterministic output

Parallelism is a hazard for determinism. We enforce:

- **Sorted fragment iteration** at the merge step (sort by file path, not by completion order).
- **Stable symbol IDs** (derived from `(filePath, kind, name, declarationLoc)` — no run-order dependency).
- **Deterministic edge ordering** in the output graph (sorted lexicographically).

This way, two runs on the same input produce byte-identical outputs regardless of worker scheduling. That's necessary for the `lastRunHash` check (§7.2) and for diffable output.

---

## 9. The core invalidation algorithm

Given:

- `prevManifest` — the previous run's `manifest.json`, or empty for cold.
- `files` — the set of all current files in the repo (after ignore rules).
- `adapters` — loaded adapter set.

Pseudocode (intent: faithful, not optimal):

```python
def incremental_run(prev_manifest, files, adapters, config):
    # ---- Step 1: discovery & content hashing (parallel)
    current = parallel_map(files, lambda f: (f, blake3_file(f)))
    current_hashes = dict(current)

    # ---- Step 2: detect global sentinel changes
    global_sentinels = collect_global_sentinels(prev_manifest, current_hashes, adapters)
    sentinel_invalidation = expand_sentinel_closure(global_sentinels, adapters, current_hashes)

    # ---- Step 3: detect changed set Δ
    delta = set()
    for f, h in current_hashes.items():
        prev = prev_manifest.files.get(f)
        if prev is None or prev.contentHash != h:
            delta.add(f)
        elif fragment_key(f, h, config, adapters) != prev.fragmentKey:
            # Same content but key changed (codegraph upgrade, adapter upgrade)
            delta.add(f)

    # Also: files that existed before but no longer exist - mark for removal
    removed = set(prev_manifest.files) - set(current_hashes)

    # ---- Step 4: compute closure Δ_final iteratively (fixed-point)
    closure_rederive = set(delta) | sentinel_invalidation.rederive
    closure_reresolve = set(sentinel_invalidation.reresolve)
    import_graph = prev_manifest.importGraph or {}

    while True:
        added = set()
        for f in closure_rederive:
            for adapter in adapters:
                if adapter.matches(f):
                    for g in adapter.reanalysis_closure(f, import_graph):
                        if g in current_hashes and g not in closure_rederive:
                            # Adapter says re-analyze g. Decide rederive vs reresolve:
                            if has_export_surface_change(f, prev_manifest):
                                closure_reresolve.add(g)
                            else:
                                # Adapter wants more than reresolve - upgrade
                                closure_rederive.add(g)
                                added.add(g)
        if not added:
            break

    # ---- Step 5: per-file work (parallel, embarrassingly)
    fragments = {}
    asts = {}
    for f in files:
        if f in closure_rederive:
            content = read(f)
            ast = parse_or_load_ast(f, current_hashes[f])
            frag = build_fragment(f, content, ast, adapters, config)
            write_cache_fragment(f, frag)
            fragments[f] = frag
            asts[f] = ast
        else:
            # Cache hit: load the existing fragment.
            frag = load_cache_fragment(f, prev_manifest.files[f].fragmentKey)
            fragments[f] = frag

    # ---- Step 6: SCIP per-project (skip if all hits)
    for proj in scip_projects(files):
        if any_member_in(proj, closure_rederive) or scip_indexer_version_changed(proj):
            run_scip(proj)
            slice_and_cache(proj)

    # ---- Step 7: cross-resolution (merge)
    symbol_table = build_symbol_table(fragments)         # parallel by namespace
    edges = resolve_imports(fragments, symbol_table)     # parallel by file
    graph = stitch(symbol_table, edges)

    # ---- Step 8: write output + manifest
    write_output_graph(graph)
    new_manifest = build_manifest(current_hashes, adapters, config, import_graph_from(fragments))
    atomic_write(".codegraph/cache/manifest.json", new_manifest)

    return RunResult(rederived=len(closure_rederive),
                     reresolved=len(closure_reresolve),
                     hits=len(files) - len(closure_rederive))
```

Notes on complexity:

- The fixed-point loop in step 4 terminates in at most O(d) iterations where d is the longest "adapter-mediated" reachability chain. In practice this is 1–2 for most adapters and bounded above by the import-graph diameter for transitive cases.
- Step 5 dominates total time and is fully parallel.
- Step 7 (cross-resolution) is O(|edges| + |symbols|) with good cache locality; it's effectively a hash-join.

### 9.1 Conservative-correct shortcuts

A few safe simplifications used in the real implementation:

- **First run / cold cache** → set `closure_rederive = files`, skip the closure computation entirely.
- **Codegraph or any adapter version changed** → same.
- **`codegraph.config.*` changed** → same. Cheaper than trying to figure out which fragments are still valid.
- **Manifest schema mismatch** → same.

These shortcuts trade precision for simplicity. We accept the cost because (a) they're rare, (b) they're correctness-preserving (we never under-invalidate), and (c) the cold path itself is reasonably fast (§13).

---

## 10. CI cache key recipe (GitHub Actions)

### 10.1 Key components

The cache key must change when, and only when, the cache contents are no longer reusable. We compose it from:

- `runner.os` — different OSes can have different binary blobs (tree-sitter native modules).
- `codegraph` version — pinned in package manifest; bumps invalidate everything.
- The set + versions of installed adapters — taken from the lockfile.
- Repo-level config files that influence cache layout (lockfile; tsconfig roots; `codegraph.config.*`).

### 10.2 Recipe

```yaml
- name: Restore codegraph cache
  uses: actions/cache@v4
  with:
    path: |
      .codegraph/cache
    key: codegraph-${{ runner.os }}-${{ hashFiles('**/pnpm-lock.yaml', 'codegraph.config.*', '**/tsconfig*.json', '.codegraph/version') }}-${{ github.run_attempt }}
    restore-keys: |
      codegraph-${{ runner.os }}-${{ hashFiles('**/pnpm-lock.yaml', 'codegraph.config.*', '**/tsconfig*.json', '.codegraph/version') }}-
      codegraph-${{ runner.os }}-
```

Notes:

- `.codegraph/version` is a one-line file emitted by the codegraph binary on first install (`codegraph --print-version > .codegraph/version`) so adapter and core versions are reflected without listing them by hand.
- `github.run_attempt` is appended to the *primary* key so re-runs of a failed workflow get a fresh save slot, but the `restore-keys:` ladder still recovers the previous attempt's cache.
- `pnpm-lock.yaml` covers package & adapter version drift. Equivalent for npm/yarn: `package-lock.json` / `yarn.lock`.
- `tsconfig*.json` is included because it shifts SCIP project membership.

### 10.3 Restore-keys ladder rationale

`actions/cache` will pick the longest-prefix `restore-key` match. Layered:

1. Exact key — full hit, ideal warm path.
2. Same lockfile + config, different attempt — recovers from a re-run.
3. Same OS, anything else — last-resort partial reuse. Most fragments will still be content-valid; the manifest may be partly stale. Codegraph detects this via the schema/version check and rebuilds the manifest from the fragment files (slower than warm, much faster than cold).

### 10.4 Save policy

```yaml
- name: Save codegraph cache
  if: always()
  uses: actions/cache/save@v4
  with:
    path: .codegraph/cache
    key: codegraph-${{ runner.os }}-${{ hashFiles(...) }}-${{ github.run_attempt }}
```

We always save, even on failure. A failed run still produces a partial cache (everything before the failure point), and a half-cache is strictly better than no cache.

---

## 11. Warm vs cold timings (modeled)

These numbers are first-principles estimates, not benchmarks; they set expectations and let us reason about whether the < 30s warm goal is achievable.

Assumptions:

- 10K source files, average 8 KB each (~80 MB total).
- TypeScript-heavy monorepo, 1 SCIP project of ~5K files, rest non-SCIP.
- 4-vCPU GitHub runner.
- blake3 ~3 GB/s/core; tree-sitter ~5 MB/s/core for TS; SCIP `scip-typescript` ~500 files/s on this hardware.
- Disk IO: SSD ~500 MB/s sequential read.

| Stage | Cold | Warm (50 changed files, no shape changes) |
|---|---|---|
| Discovery + hash | ~2.5s (80 MB / 4 cores at 3 GB/s sustained, IO-bound) | ~2.5s (must still hash all files) |
| Cache lookup | ~0.5s (manifest parse) | ~0.5s |
| Per-file parse + adapter | ~80s (10K * 8 KB / 5 MB/s / 4 cores ≈ 4s wall, but adapters add ~10x) | ~1s (50 files only) |
| SCIP run + slice | ~10s (5K files / 500 fps) | ~0s (all hits) |
| Cross-resolution | ~3s (10K fragments, sequential merge) | ~3s (always done) |
| Output + manifest | ~1s | ~1s |
| **Total** | **~95s** (call it 1.5–2 min cold) | **~8s** |

The warm 8s comfortably beats the < 30s target. The cold 95s is well under our 15-min ceiling and within typical CI budgets even before accounting for worker scaling on larger runners.

If only test fixtures changed (e.g. 200 files all in `tests/`, no shape changes): warm ≈ 12s. Worst-case warm (a `schema.prisma` change with 800 Prisma consumers): warm ≈ 25s — still inside the budget.

The two non-negotiable warm-path costs are **discovery + hash** (must hash every file to know what's stale) and **cross-resolution** (always done). Together they floor warm runs at ~6s on this hardware. That's the budget reality we design around.

---

## 12. Cold-start fallback

Cold = no cache (first run, or `actions/cache` miss with no usable `restore-keys` hit). Path:

1. **Manifest check**: `cache/manifest.json` missing or unreadable → cold.
2. **Walk** the repo applying ignore rules: `.gitignore`, `.codegraphignore`, plus built-in defaults (`node_modules/`, `dist/`, etc.).
3. **Parallel hash** all files. (Necessary anyway to populate the new manifest; cold doesn't skip this.)
4. **Mark all files as `closure_rederive`.**
5. Run the rest of the pipeline (steps 5–8 in the algorithm) exactly as on warm, but with a fully populated re-derive set.
6. Write the manifest at the end.

The cold path is *the same code path* as warm — we just feed it `closure_rederive = files`. This is important for testing and for ensuring no drift between warm and cold output.

### 12.1 Partial-cache fallback

A specifically diagnosed middle case: `actions/cache` restored *some* fragments and asts (e.g. via a `restore-keys` partial match) but the manifest is missing or schema-bumped. Path:

1. Detect: fragment files exist but manifest doesn't parse / mismatches schema.
2. **Reconstruct the manifest** by walking `cache/fragments/` and reading each fragment's header. This is roughly `fragment_count * 1 ms` ≈ 10s for 10K fragments — much better than a full cold re-derive.
3. From the reconstructed manifest, run the warm algorithm.

This bridge case keeps `restore-keys` useful even when the primary key has shifted. The reconstruction logic is bounded and deterministic and falls back to full cold on any inconsistency.

---

## 13. Edge cases and policies

### 13.1 Symlinks

Treated as their target's content. We hash the target, not the link itself. Symlinks pointing outside the repo are skipped (logged once per run).

### 13.2 Generated files

Files marked `linguist-generated` in `.gitattributes`, or matching configured generated-file patterns, are still parsed and indexed (they may contain real symbols), but flagged in the fragment so adapters can decide whether to ignore them.

### 13.3 Binary or huge files

Skipped with a diagnostic if `size > config.maxFileSizeBytes` (default 5 MiB). Binary detection is the standard "first 8 KB has a NUL byte" heuristic.

### 13.4 Encoding

UTF-8 only. Files that aren't valid UTF-8 are skipped with a diagnostic. (We could add latin-1 fallback but it complicates the deterministic story; YAGNI for v0.1.)

### 13.5 File deletions

A file present in `prevManifest.files` but absent from current discovery is removed from the cache index but its fragment file is *not* deleted (cheap; cleaned by GC eventually). The output graph correctly reflects the removal because fragments are sourced from `current_hashes`, not from the manifest.

### 13.6 File renames

Detected when content hash matches but path changes. Handled as a manifest update only — no re-derive. The import graph is updated to reflect the new path. Adapter outputs that are path-sensitive (e.g. an adapter that bakes file paths into route IDs) bust their cache; the framework signals this via a `pathSensitive: true` declaration on the adapter, which makes us treat a rename as a re-derive for that adapter only.

### 13.7 Concurrent runs

The advisory lock at `cache/locks/manifest.lock` prevents two codegraph processes from clobbering each other's manifest. CI runners shouldn't hit this (one run per workflow), but local-dev users can. Lock acquisition has a 60s timeout; on timeout we run with `--no-cache-write` and warn.

### 13.8 Cache size growth

The opportunistic GC (§3.1) keeps cache size bounded. CI users who care about cache upload size can set `CODEGRAPH_CACHE_MAX_BYTES` to a tighter value (default 2 GiB).

### 13.9 Adapter-declared cache busts

An adapter can declare "my v0.4.2 fixed a bug; bust all my cached outputs even if version string didn't change" via an internal `cacheBustEpoch` integer. The adapter's `configHash` mixes this in.

---

## 14. Observability

The CLI emits, on each run, a small JSON summary to stderr (structured logs):

```json
{
  "run": "2026-05-08T14:20:00Z",
  "mode": "warm",
  "files_total": 9874,
  "files_changed": 7,
  "files_rederived": 12,
  "files_reresolved": 38,
  "files_hit": 9824,
  "scip_projects_run": 0,
  "duration_ms": 7912,
  "cache_size_mb": 412.3
}
```

A `--profile` flag adds per-stage timings. A `--explain <file>` flag prints the chain of reasons that file was (or wasn't) re-analyzed:

```
src/server/router.ts: rederive (content hash changed: 7e02... -> 9af1...)
src/server/handlers/users.ts: reresolve (express adapter pulled in by importer src/server/router.ts)
src/server/handlers/posts.ts: hit (no change)
```

This is the debugging surface for "why did my run take 90s when I only changed one file?" — usually answer is a sentinel changed.

---

## 15. Open questions / future work

- **Persistent merge state.** Right now cross-resolution runs from scratch every time. If profiling shows it dominating warm runs, we can persist the symbol table and incrementally update only the entries owned by re-derived files. Not in v0.1 — the hash-join is fast enough.
- **Distributed cache.** A team-shared cache in S3/GCS keyed similarly to the GitHub Actions recipe. Out of scope; doable as a CLI plugin.
- **Watch / daemon mode.** The pieces here (content-addressed cache, fragment determinism) make a daemon mode straightforward — keep ASTs and fragments warm in memory, drop content-hashing cost. Not in v0.1.
- **Adapter sandboxing.** Adapters currently run in-process. A future safe-mode could run untrusted adapters in a subprocess; cache keys are unaffected by this change.
- **More precise "shape change" detection.** Today we compare exported-symbol sets between fragments. We could also include exported *signatures* (typed surface) for languages where SCIP gives us types cheaply, narrowing re-resolve to "type signature actually changed." Pure win when implemented.

---

## 16. Summary

The design is built around a few load-bearing choices:

- **Content-addressed per-file fragments**, keyed by a composite of `(contentHash, codegraphVersion, adapterSetHash, configHash, parserKey)`. Branch-safe, rename-cheap, and immune to "spooky action at a distance" from version drift.
- **Two-level closure**: re-derive (own content changed) vs re-resolve (importer's exports changed). Most warm runs only re-derive a handful of files.
- **Adapter-declared invalidation**, with a strict "may widen, may not narrow" rule. Express, Prisma, NestJS each have a few-line declaration that's correct-by-construction.
- **Global sentinels** for the rare-but-broad cases (lockfile drift, schema changes, config changes).
- **Per-SCIP-project run-or-skip**, never per-file SCIP. Slice and cache its output.
- **Embarrassingly parallel per-file work, then a cheap merge.** Worker pool sized as a function of cores and file count.
- **GitHub Actions cache key tied to lockfile + codegraph version + tsconfig**, with a `restore-keys` ladder that gracefully degrades to partial-cache fallback.
- **Cold path is the warm path with everything in the re-derive set** — same code, no separate fast-path bug surface.

With these in place, the < 30s warm goal on a 10K-file monorepo is achievable, the cold path is bounded, and every cache decision is a function of values we can hash — no LLM, no ambient state, fully deterministic.
