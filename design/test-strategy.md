# codegraph Test Strategy

Status: design doc, normative.
Audience: contributors, reviewers, release managers.
Scope: every package in the monorepo (`packages/core`, `packages/cli`, `packages/viewer`, `packages/action`, every `adapters/*`).

This document is opinionated. It picks one tool per slot and explains why. If you want to argue for a different tool, open a design issue — do not silently add a second runner.

---

## 0. Goals and non-goals

### Goals

1. Catch regressions in IR shape and content before they ship.
2. Guarantee byte-for-byte determinism of IR output for any given input.
3. Keep contributor friction low: one command (`pnpm test`) runs the right thing in the right place.
4. Make adapter authors productive: adding a language is mostly "drop fixtures, write a snapshot test, push."
5. Keep CI under 10 minutes wall-clock for the default matrix.

### Non-goals

1. 100% line coverage. We pick targeted percentages per layer (see §5).
2. Mocking out tree-sitter, the TypeScript compiler, or any other language tool. Those are integration boundaries, not units.
3. Visual snapshot coverage of every viewer screen. We pick a few load-bearing flows and accept churn elsewhere.
4. Running real-world repos in unit-test scope. They live in a separate, opt-in tier.

---

## 1. Test categories

Eight tiers, in roughly increasing cost. Each tier has a clear question it answers and a clear place it lives.

### 1.1 Unit tests

**Question:** does this function or module behave per its contract?

**Location:** colocated with source as `*.test.ts` next to the file under test. No separate `__tests__` directory — the closer the test file is to the source file, the more likely it gets updated alongside it.

**Examples:**

- `packages/core/src/ir/normalize.test.ts` covers `normalize.ts`.
- `packages/core/src/diff/hash.test.ts` covers structural hashing.
- `adapters/typescript/src/symbols/resolveImport.test.ts`.

**What belongs here:** pure functions, small classes, data transforms, parsers for our own config files, error-formatting helpers. Anything where the inputs and outputs fit in a screen.

**What does not belong here:** anything that needs a fixture repo on disk, anything that exercises a real language toolchain end-to-end, anything that asserts on rendered output. Those are §1.3, §1.5, or §1.6.

### 1.2 Snapshot / golden tests for IR

**Question:** for this synthetic input, is the IR exactly what we expect?

**Location:** `packages/core/__fixtures__/ir/<case>/` and adapter equivalents. Each case is a directory containing:

```
__fixtures__/ir/empty-class/
  input/                  # tiny synthetic source tree
    src/Empty.ts
  expected.ir.json        # hand-authored, checked in
  README.md               # one paragraph: what this case proves
```

**Why hand-authored, not generated:** the whole point of a golden test is that a human committed to "this is correct." If we generate the snapshot from current behavior, the test only proves "current behavior matches itself," which is worth nothing the first time it runs.

**Update protocol:** when IR shape changes intentionally, run `pnpm test:ir --update-snapshots`. The diff in code review is the audit trail. PRs that touch `expected.ir.json` files require an explicit reviewer ack on the IR change; CODEOWNERS gates this.

**Determinism requirement:** see §4. If a snapshot test is flaky, that is always a bug in the producer, never a bug in the test.

**Sizing:** keep each fixture under ~30 lines of source. A 200-line fixture is an end-to-end test pretending to be a snapshot test, and it will fight you forever.

**Anti-patterns we explicitly reject:**

- "Auto-generate the snapshot the first run, freeze on the second." This pattern is popular and wrong. It guarantees the test passes the first time it runs, regardless of whether the producer is correct. A snapshot you didn't read line-by-line is not a snapshot, it's a checksum.
- "Snapshot the whole IR for one giant fixture." Hard to review, hard to update, every IR-shape change rewrites the entire 4000-line file. Many small cases > one huge case.
- "Snapshot only the summary stats (node count, edge count)." Reduces the surface area of what the test can catch to almost zero. If the only thing you care about is the count, write `expect(ir.nodes).toHaveLength(7)` and skip the snapshot machinery.

### 1.3 Adapter tests

**Question:** does this adapter, run on its dedicated fixture subset, produce the expected nodes and edges?

**Location:** `adapters/<lang>/__fixtures__/` for synthetic input, `adapters/<lang>/test/adapter.test.ts` for the harness.

**Shape of the test:**

```ts
const cases = loadAdapterCases('adapters/typescript/__fixtures__');
for (const c of cases) {
  test(c.name, async () => {
    const ir = await runAdapter(c.inputDir);
    const expected = await loadJson(c.expectedPath);
    expect(canonicalize(ir)).toEqual(canonicalize(expected));
  });
}
```

**What each adapter must cover at minimum:**

1. The "empty file" case — adapter on an empty source produces a valid IR with no nodes, no edges.
2. The "single function" case — one function, one node.
3. The "import edge" case — file A imports file B, edge with the right `kind`.
4. The "framework hook" case if the adapter has framework adapters layered on it (see `adapters/typescript/react/`, etc.).
5. One "weird syntax" case per known parser quirk. As bugs come in, each fix lands with a new fixture.

**No mocking.** Adapter tests run the real parser on real source. If tree-sitter is slow, that is a §1.8 concern, not an excuse to mock.

**Naming convention for fixtures:** `<feature>-<variant>` in kebab-case. `import-named`, `import-default`, `import-namespace`, `import-side-effect`. The directory name appears in test output; make it skim-readable.

**Per-adapter coverage scoreboard.** Each adapter's `__fixtures__/COVERAGE.md` lists the syntactic constructs the adapter claims to handle, with one fixture per construct. A new adapter feature without a corresponding row in `COVERAGE.md` fails review. This is the real measure of adapter completeness, not line coverage (see §5).

### 1.4 Diff tests

**Question:** given two IRs, does the diff algorithm produce the expected edit script?

**Location:** `packages/core/__fixtures__/diff/<case>/` with:

```
__fixtures__/diff/rename-function/
  before.ir.json
  after.ir.json
  expected.diff.json
```

**Why pairs of IRs, not pairs of source repos:** the diff algorithm operates on IR. Mixing parsing into diff tests turns every diff regression into a parsing investigation. Keep them separate.

**Categories of cases worth covering:**

- Pure additions (new nodes only).
- Pure deletions.
- Renames (node identity preserved, label changed).
- Edge-only changes (node set unchanged, edges differ).
- Reorderings (must be no-ops thanks to canonical ordering — see §4).
- Cross-file moves.
- Identity collisions (rare, but the algorithm has to make a choice and we want to lock it in).

**Property-based tests** (§8) live alongside these.

### 1.5 End-to-end tests

**Question:** does the full pipeline — discover → parse → normalize → diff → render — work on a realistic repo?

**Location:** `e2e/` at the repo root, separate from package tests. Fixture data in `e2e-fixtures/` (see §3).

**Tooling:** Vitest, but tagged so they're skipped by default in `pnpm test`. Run with `pnpm test:e2e` or in the dedicated CI job.

**What an E2E asserts:**

1. The pipeline exits 0 on a real, non-trivial repo.
2. Total node count is within an expected range (range, not exact — small upstream churn shouldn't break the test).
3. Specific known-load-bearing nodes exist (e.g. for the `e2e-fixtures/express` case, assert that `app.listen` resolves to the right module).
4. Output IR validates against the JSON schema in `spec/ir.schema.json`.
5. Run twice, byte-identical output (determinism check).

**What an E2E does not assert:** exact node counts, exact edge sets, specific internal IDs. Those are inherently brittle on real repos.

### 1.6 Viewer tests

**Question:** does the viewer render correctly and respond to interaction?

Two layers, two tools:

**Component tests — Vitest + @testing-library/react.** Fast, run in jsdom, cover component logic: props → DOM, interaction → state change, accessibility roles. Live in `packages/viewer/src/**/*.test.tsx`.

**Visual regression — Playwright.** A small set of "key screens" — graph layout for a known fixture, expanded vs collapsed nested-node states, the diff overlay, the legend. Each screen has a `.png` baseline checked into `packages/viewer/visual/__baselines__/`. Playwright runs the viewer against a known IR fixture, takes a screenshot, compares pixel-level with a tolerance.

**What we don't do:** snapshot every component's HTML. That's churn theater — each markup tweak rewrites a snapshot, the reviewer rubber-stamps it, the test caught nothing. Use component tests with explicit role/text assertions instead.

**Concrete list of "key screens" we baseline:**

1. The default graph view on a known small fixture (≈12 nodes, force-directed layout, seeded RNG).
2. The same graph with a node expanded to show nested children (regression-prone — see `design/nested-nodes.md`).
3. The diff overlay rendering a known before/after pair.
4. The complexity-overlay view on the same fixture (see `design/complexity-overlay.md`).
5. The empty-state screen — what the user sees when no IR has been generated yet.
6. The legend / edge-typing key (see `design/edge-typing.md`).

These are the screens where a regression would be embarrassing in the README. Six baselines is enough to catch layout-engine breakage without requiring weekly baseline updates.

**Layout determinism.** Force-directed layouts are non-deterministic by default. The viewer pins a seed when running under Playwright (env flag `CG_VIEWER_SEED=1`). Without that, baselines would churn on every run.

**Visual baselines update protocol:** same as IR snapshots — `playwright test --update-snapshots`, the PR diff is the audit trail, viewer-team CODEOWNER must ack.

### 1.7 Action tests

**Question:** does the GitHub Action work end-to-end in a real Actions runtime?

**Tooling:** [`act`](https://github.com/nektos/act) — runs the workflow locally in Docker. Way faster than pushing to a test repo to iterate.

**Location:** `packages/action/test/act/` with a small matrix of repo configs:

```
test/act/
  fixtures/
    ts-only/        # repo with only TS sources
    polyglot/       # TS + Python
    monorepo/       # multiple package roots
  workflows/
    pr.yml
    push.yml
    schedule.yml
  run.sh            # invokes act with the matrix
```

**CI strategy:** Linux only, because `act` requires Docker and Windows/macOS Docker on hosted runners is slow and expensive. The Action itself is platform-agnostic; we test that elsewhere.

**Assertions per cell:**

1. Action exits 0.
2. Expected artifacts exist (`codegraph.ir.json`, `codegraph.diff.json` if applicable).
3. PR-comment payload (when applicable) contains expected anchors.
4. Annotations (if the action emits `::warning` / `::error` lines) appear in the right order and reference the right files.
5. The action's IR output matches what the local CLI produces against the same fixture — no drift between "ran via Action" and "ran via CLI."

**Pinning the act runner image.** `act` defaults to a stripped-down Ubuntu image that's missing tools real GitHub runners have. We pin to `ghcr.io/catthehacker/ubuntu:act-22.04` (the medium-size image) and document that as the only supported image for the act tier. Contributors who run `act` locally with a different image will see different failures than CI; the README spells this out.

### 1.8 Performance / regression benchmarks

**Question:** is this commit measurably slower than the baseline?

**Tooling:** [`mitata`](https://github.com/evanwashere/mitata) for the microbench cases, plus a "pipeline" macrobench that runs the full indexer on a frozen e2e fixture.

**Location:** `bench/` at the repo root.

**CI behavior:** runs on every PR against `main`. Compares to the baseline (latest `main` benchmark posted as a workflow artifact). **Fails the build if any single bench regresses >20%** or if the geomean across the suite regresses >10%. Both thresholds are tunable in `bench/thresholds.json`.

**What we benchmark:**

- IR normalization on a 500-file synthetic tree.
- Diff between two 500-file IRs with ~5% churn.
- Adapter cold-start time.
- Viewer initial render (Playwright + `performance.now()`, not visual).

**What we don't benchmark:** anything tree-sitter does internally (their problem), filesystem walking on cold cache (too noisy on shared CI).

**Noise control:** each bench runs N=20 with median + MAD. Single-run regressions don't fail; a regression must persist across the run for the threshold to fire. Pin the runner type (`ubuntu-22.04`, not `ubuntu-latest`).

**Why 20% per-bench, 10% geomean.** Per-bench noise on shared CI is empirically in the 5–10% range. 20% gives us comfortable headroom against false positives while still catching real regressions, which tend to be 30%+ when they happen. Geomean is a stricter check that catches "death by a thousand 5% regressions" — each one alone wouldn't trip the per-bench gate.

**Comparing across machines.** When the runner image changes (e.g. `ubuntu-22.04` → `ubuntu-24.04`), the baseline is invalidated. The first build on the new image rewrites the baseline with a `[bench-rebaseline]` commit message and a one-paragraph note in the PR explaining the move. Don't compare apples to oranges silently.

---

## 2. Tooling decisions

### Test runner: Vitest

**Picked.** Reasons:

- First-class TypeScript with ESM, no transpile step.
- Good watch mode and parallelism out of the box.
- Snapshot, mocking, coverage, and concurrent suites all built in.
- Same configuration shape across unit, snapshot, and component tests, which means we don't need to teach contributors three runners.

**Bun test as alternative — rejected for now.** Bun test is faster and we love it for greenfield projects, but: (a) we ship to consumers running on Node, and we want to test on the same runtime by default; (b) some of our deps (tree-sitter, esbuild bindings) have Node-specific install paths and shake out behavioral differences between Node and Bun. Revisit when Bun has a stable LTS story and our deps are clean on it.

**ts-jest / Jest — rejected.** Slower, ESM story is still painful, no compelling reason to adopt over Vitest.

### Browser / E2E for viewer: Playwright

**Picked.** Cypress works but Playwright's multi-browser matrix and trace viewer are decisive. Playwright also handles visual diffing natively (`toHaveScreenshot`).

### Action runner: `act`

**Picked.** No real alternative for local-first GitHub Action testing. Yes, it has quirks (some `actions/*` versions misbehave, runner image drift). Document the exact `act` flags and runner image in `packages/action/test/act/README.md` and pin them.

### Property-based testing: `fast-check`

**Picked.** Mature, integrates cleanly with Vitest, has a shrinking story that actually works.

### Coverage: `c8` via Vitest

**Picked.** Native V8 coverage, no instrumentation, no source-map disasters. Ship the LCOV to Codecov for trend tracking.

### Bench: `mitata`

**Picked.** Sub-microsecond resolution, sane statistics, low overhead. `tinybench` is fine too but `mitata`'s output formatting is friendlier.

---

## 3. Fixture layout

Three tiers, three locations. **Do not mix them.**

### 3.1 `__fixtures__/` — per-package, tiny, synthetic

Lives inside the package that uses it. Hand-authored, < 30 lines per source file, maximum a few files per case. These power §1.2 (IR snapshots), §1.3 (adapter tests), §1.4 (diff tests).

```
packages/core/__fixtures__/
  ir/
    empty-class/
    single-function/
    nested-namespace/
  diff/
    rename-function/
    delete-edge/

adapters/typescript/__fixtures__/
  basic-import/
  react-hook/
  generics-quirk/
```

**Why colocated:** the adapter team owns the adapter and its fixtures. PRs touching one usually touch the other. Cross-package fixture moves get noticed and lose updates.

### 3.2 `test-fixtures/` — repo-wide, shared, still synthetic

Lives at the repo root. Cross-package fixtures used by integration tests and the CLI. Larger than per-package fixtures but still hand-authored — think 5–50 files per case, deliberately constructed to exercise a specific cross-cutting behavior (multi-language repos, monorepo discovery, config edge cases).

```
test-fixtures/
  polyglot-monorepo/      # TS + Python in one repo
  config-precedence/      # nested codegraph.config.* files
  cycle-detection/        # known-cyclic dependency graph
```

### 3.3 `e2e-fixtures/` — real open-source repos

Lives at the repo root, but **not checked into the main repo**. Either a git submodule pointing at pinned commits of upstream repos, or a `pnpm e2e:fetch` script that clones the pinned shas into `e2e-fixtures/` (gitignored).

Why pinned commits, not `main`:

- Reproducibility. An e2e regression should be diagnosable a year from now.
- License hygiene. We don't redistribute upstream code; we run against a checkout the user obtains.
- CI cache friendliness — pinned shas are cacheable forever.

**Initial set:**

- A medium TS app (e.g. a real Express service).
- A small Python lib.
- A polyglot monorepo (one TS package, one Python package).

Adding a new e2e fixture is a separate PR with explicit reviewer ack — they're expensive and they shape what we can never break.

**Fetch script behavior.** `pnpm e2e:fetch` reads `e2e-fixtures/manifest.json`, which lists each fixture as `{ name, repo, sha, sparse-paths? }`. The script does shallow clones at the pinned sha. If a contributor doesn't run `pnpm e2e:fetch`, the e2e jobs skip with a clear message rather than silently passing — failing-closed beats false-positive green.

**Which repos to pin and which to leave on a leash.** Pin small, stable libraries (parsers, utility libs). For frameworks that move fast (Next.js, Vite), prefer to pin to a tagged release rather than a sha — easier to read in PRs, and we never want to be debugging "why did our test break" against a random main commit of an upstream we don't control.

**Updating an e2e pin.** Treat it like a dependency upgrade: separate PR, title `[e2e] bump <fixture> to <sha>`, link the upstream changelog or commit log, expect reviewers to scan the diff in IR output for surprises. If the new sha causes a snapshot test to break, the upgrade PR fixes that snapshot too — don't split into two PRs and lose context.

---

## 4. Determinism guarantees

**Hard requirement: codegraph IR is byte-identical for byte-identical input.**

This is not a nice-to-have. Diff, snapshot tests, caching, and incremental builds all assume it. CI enforces it.

### 4.1 Sources of non-determinism we have to neutralize

1. **Filesystem ordering.** `readdir` returns entries in OS-dependent order. Always sort by `(path, locale=POSIX)` before consuming.
2. **Parallelism.** Worker pools complete in arbitrary order. The merge step that combines per-file IRs into the repo IR must sort by stable key (file path, then node ID).
3. **Map / Set iteration.** JS preserves insertion order, so this is usually fine — but only as long as insertion order is itself deterministic. Treat any `Map.entries()` call in the IR producer as suspect; sort before serializing.
4. **`Date.now()`, `Math.random()`, PIDs, hostnames.** Banned in IR producers. Lint rule (`no-restricted-globals`) blocks them in `packages/core/src/ir/**` and `adapters/**/src/**`.
5. **Error message text from third-party tools.** If we embed parser errors in IR, normalize them — strip line-column when the underlying message is the same.
6. **Floating-point.** Avoid in IR. If we must (e.g. complexity scores), round to a fixed precision at serialization time.

### 4.2 CI enforcement

Every PR runs the **double-build job**:

1. Run the indexer on every fixture in `test-fixtures/` and `e2e-fixtures/`.
2. Run it again.
3. `diff -r` the two output trees.
4. Any difference fails the build, with a script that prints the offending bytes.

This is cheap (parallelizable) and catches the long tail of "I added one Set without sorting" bugs that snapshot tests can miss when they happen to coincide with insertion order.

### 4.3 Cross-platform determinism

The double-build only proves "deterministic on this OS." Cross-OS determinism is a separate, stronger claim: same input → same output on Linux, macOS, Windows.

We assert this on the smaller `test-fixtures/` set in the matrix job: linux output is the canonical reference, macos and windows must match it. Path separators are normalized to `/` everywhere in IR (the normalizer handles this; there's an explicit unit test for it).

---

## 5. Coverage targets

**Targets, not floors with teeth — except where noted.**

| Layer                            | Target | Rationale |
| -------------------------------- | ------ | --------- |
| `packages/core` (IR, diff, etc.) | 80% line, 75% branch | This is the load-bearing logic. Bugs here corrupt every downstream artifact. |
| `adapters/*`                     | 60% line | Adapters are mostly glue + parser walk. Real coverage comes from fixture-driven snapshot tests, which `c8` undercounts because most lines run inside vendored parsers. |
| `packages/cli`                   | 70% line | CLI is mostly arg parsing and orchestration. The orchestration is covered by E2E. |
| `packages/viewer`                | none required | Visual + component tests cover the user-facing surface. Line coverage on a React app is a vanity metric. |
| `packages/action`                | act tests, no line-coverage threshold | Same reasoning as viewer — exit-code + artifact assertions are what we actually care about. |

CI fails if `packages/core` drops below 80%. Other layers report coverage but don't block. We track the trend; if `adapters/typescript` is at 40%, that is a flag, not a build failure.

**Why the asymmetry:**

- Core has stable inputs and outputs. Coverage there is meaningful.
- Adapter coverage is gamed by lines inside parsers — line-counting tools can't tell the difference between "exercised this branch" and "imported this module." Fixture coverage is the real measure for adapters: count distinct syntactic constructs hit, not lines.
- Viewer coverage punishes refactoring without rewarding reliability.

---

## 6. CI matrix

### 6.1 PR matrix (every push, must be fast)

| Axis | Values |
| ---- | ------ |
| OS   | ubuntu-22.04 |
| Node | 22 |
| TypeScript (for the TS adapter) | latest stable |

One cell. Goal: < 5 minutes to first signal. Runs unit + snapshot + adapter tests, plus the determinism double-build on `test-fixtures/`.

### 6.2 Pre-merge matrix (required for merge)

| Axis | Values |
| ---- | ------ |
| OS   | ubuntu-22.04, macos-14, windows-2022 |
| Node | 20, 22 |
| TypeScript (TS adapter) | 5.4, 5.5, 5.6 |

Six OS×Node cells × three TS versions for the TS adapter = manageable. E2E and `act` jobs run here too, but only on linux. Visual regression runs only on linux (rendering differs across OS).

### 6.3 Nightly matrix

Runs against `e2e-fixtures/` at HEAD of each upstream pinned repo's branch (in addition to the pinned sha). Failures here don't block merges; they file an issue. Purpose: early warning that a popular upstream is about to ship something we can't parse.

### 6.4 Why no Node 18

Node 18 is end-of-life. We test what we ship on. Lock the support floor at 20 in `engines` and don't litter the matrix with dead versions.

### 6.5 Caching strategy

- `pnpm` store cache, keyed on `pnpm-lock.yaml`. Standard.
- `node_modules` per-package, keyed on the same lockfile + the package's source hash. Short cache, mostly there to skip rebuilds within a PR's iterations.
- `e2e-fixtures/` cache, keyed on `e2e-fixtures/manifest.json`. Pinned shas mean this cache is essentially permanent; we only invalidate on a pin bump.
- Playwright browser cache, keyed on the Playwright version pinned in `package.json`.
- Bench baseline, fetched as a workflow artifact from the latest successful main run, not cached as such.

The matrix jobs share the pnpm store cache but not the per-package `node_modules` (different OS, different platform binaries).

### 6.6 Flake policy

A test that fails twice in a row on the same sha is treated as broken, not flaky. A test that fails once and passes on retry is logged but not surfaced as a build failure.

We do not have a "retry the whole job" policy — that hides real flakes. We do have a "retry one timed-out network step" policy on the e2e-fetch job, where the network is the only legitimately flaky part.

If a test is identified as flaky, the protocol is: skip it with a `// FLAKY: <issue-link>` comment and a tracking issue, fix the root cause within one week, or remove the test. We don't quarantine forever.

---

## 7. What we deliberately do not test

Each of these is a real cost we are choosing not to pay.

1. **Exhaustive mocking of language internals.** We don't mock tree-sitter, the TypeScript compiler, or any other parser. Mocks of language internals are wrong by the time the test is reviewed; real fixtures stay valid as long as the language does. The cost of running real parsers is measured in milliseconds. The cost of a wrong mock is a confidently green test on broken code.

2. **HTML/markup snapshots of viewer components beyond the key flows.** A snapshot of every component's rendered HTML produces enormous PR diffs on benign refactors and trains reviewers to rubber-stamp. We test components with explicit role/text/aria assertions.

3. **CLI help text snapshots.** Help text changes constantly. We test that `--help` exits 0 and contains the command name. That's it.

4. **Performance benchmarks on shared CI for absolute numbers.** We measure ratios against a baseline on the same runner. Treating `5.1ms` as a contract is a lie — that 5.1ms reflects the runner's neighbors.

5. **Coverage on generated code.** `packages/core/src/generated/**` is excluded from coverage reporting. Generated code is tested by the thing that generates it.

6. **Tests for third-party type imports.** If we re-export a type from `@types/x`, we don't write a test "asserting the type is importable." TypeScript's compile step is the test.

7. **Internationalization of error messages.** All errors are English. If we ever localize, we'll add a separate suite. Until then, error-message tests assert English.

8. **Fuzz testing of the parser layer.** We use real fixtures and property-based tests on the diff/IR layer. Fuzzing tree-sitter inputs is interesting but not our job; upstream owns it.

---

## 8. Property-based tests

`fast-check`, run as part of the standard Vitest suite with a fixed seed in CI and a random seed locally (so contributors find new bugs; CI is reproducible). Property runs default to 100 cases; for the diff algorithm we crank to 1000 in the nightly matrix.

### Five properties worth testing

1. **Diff round-trip: `apply(diff(a, b), a) ≡ b`.**
   For arbitrary IRs `a` and `b` (drawn from a generator that produces well-formed IRs of bounded size), applying the computed diff to `a` reproduces `b` byte-for-byte after canonicalization. This is the load-bearing property of the diff algorithm. If it fails on any input, the diff algorithm is broken — not "subtly wrong," wrong.

2. **Diff identity: `diff(a, a) ≡ ∅`.**
   Diffing an IR against itself produces the empty edit script. Easy property, but it catches an entire class of bugs where the algorithm is sensitive to insertion order or set-vs-array confusion.

3. **Diff idempotence: `apply(d, apply(d, a))` is well-defined and equal to `apply(d, a)` whenever `d` is the diff of `a` and `b`.**
   Re-applying an already-applied diff doesn't corrupt state. Important for the "PR comment retries" path where the action might re-apply the same edit script twice on flaky network.

4. **IR canonical-form fixed point: `canonicalize(canonicalize(ir)) ≡ canonicalize(ir)`.**
   Canonicalization is idempotent. Run on a generator of arbitrary, possibly-non-canonical IRs, this catches sort instability and ID-rewriting bugs that would otherwise show up as mysterious snapshot churn.

5. **IR schema validity is preserved under diff/apply.**
   For any valid IR `a` and any diff `d` produced by `diff(a, b)` with `b` valid, `apply(d, a)` is valid against `spec/ir.schema.json`. Pairs the diff property with our schema contract; ensures the diff algorithm can't construct an invalid IR from valid inputs.

### Generators

The IR generator is the load-bearing piece. Sketch:

- Generate a small set of file paths (POSIX, deduped, sorted).
- For each path, generate 0–N nodes with stable IDs (hash of path + index).
- Generate edges by sampling pairs of nodes.
- Optionally apply random renames / deletions / additions to produce a "next" IR.

The generator lives in `packages/core/test/gen/ir.ts` and is shared by all property tests. Don't write a one-off generator per property — they drift.

### Other properties we considered and rejected

- "Diff symmetry: `diff(a, b) ≡ inverse(diff(b, a))`." Tempting, but our diff format isn't required to have a clean inverse — applying `diff(a, b)` to `b` is a no-op, not a reversal. Encoding symmetry as a property would force a design we don't want.
- "Diff size is bounded by `|a| + |b|`." True in the limit, but the constant matters and we'd be testing a tautology. Cover this with targeted bench cases instead.
- "Adapter is a pure function of input source." Belongs to determinism (§4), not property-based tests. The double-build job is a stronger and cheaper check.

### Shrinking

Default `fast-check` shrinking is fine for the IR generator. When we hit a counter-example, the failing minimal IR gets dumped to `packages/core/__fixtures__/diff/regression-<date>/` and converted into a regular snapshot test. The property test caught it; the snapshot test pins it forever.

---

## 9. Test commands (contract)

What contributors and CI invoke. **These names are stable.**

| Command                  | Runs                                                |
| ------------------------ | --------------------------------------------------- |
| `pnpm test`              | Unit + snapshot + adapter + diff + property (fast). |
| `pnpm test:watch`        | Same, in watch mode, on the package you're in.      |
| `pnpm test:e2e`          | E2E suite. Requires `pnpm e2e:fetch` first.         |
| `pnpm test:viewer`       | Vitest component + Playwright visual.               |
| `pnpm test:action`       | `act` matrix for the GH Action.                     |
| `pnpm test:bench`        | Benchmarks. Posts results to `bench/results/`.      |
| `pnpm test:determinism`  | Double-build the determinism check.                 |
| `pnpm test:all`          | Everything except bench.                            |

CI maps these one-to-one to jobs. Locally, `pnpm test` is what you run before pushing.

---

## 10. Updating snapshots and baselines

A unified protocol so contributors don't guess:

1. **IR snapshot changed?** Run `pnpm test:ir --update-snapshots`. The expected JSON files diff in your PR. CODEOWNER for `spec/` reviews.
2. **Visual baseline changed?** Run `pnpm test:viewer --update-snapshots`. PNGs diff in your PR. Viewer CODEOWNER reviews.
3. **Bench baseline changed (intentionally)?** Update `bench/baseline.json` in the same PR as the change that justifies the regression. Title prefix `[perf]` is required.
4. **Determinism check failed?** This is never an "update the baseline" situation. Fix the producer. See §4.

---

## 11. Open questions

Real ones, listed so reviewers can poke at them:

1. **Should adapter fixture cases have a stable ID independent of directory name?** Right now the case name is the directory name. If we ever rename for clarity, the case effectively becomes a new case in CI history. Tracking IDs in a manifest file would be more robust but adds friction.

2. **Visual regression on macOS / Windows — worth it?** Renderers differ. Today we only baseline on linux. If we get bug reports about Windows-specific rendering, we add a Windows visual lane; until then, no.

3. **Bench in PRs vs. only on main.** PR-time benches catch regressions earlier but add 2–3 minutes. Current plan: PR. If runner contention gets bad, demote to main-only with a label-triggered opt-in.

4. **Property-test seed strategy.** Fixed seed in CI is reproducible but blind to seasonal bugs. Random in CI surfaces them but reviewers can't repro. Current plan: fixed in PR CI, random in nightly. Watch how often nightly catches things PR CI doesn't.

---

## 12. TL;DR for new contributors

- Write a unit test next to your function. Use Vitest.
- If you touched the IR shape, update the relevant fixture in `__fixtures__/ir/`.
- If you added an adapter feature, add a fixture in `adapters/<lang>/__fixtures__/`.
- Don't touch `e2e-fixtures/`. Almost no PR should.
- Run `pnpm test` before pushing. CI runs more, but the fast tier is what catches 95% of issues.
- Determinism failures are real bugs. Don't add a sort and call it done — figure out which set wasn't ordered and fix it at the source.

---

## 12a. Local development workflow

How a contributor's machine should behave during normal work, so that "passes on my machine" actually means something.

**Pre-push hook (opt-in, recommended).** A husky hook that runs `pnpm test` (the fast tier) on the packages affected by the diff. Opt-in via `pnpm setup-hooks` so we don't strong-arm contributors who prefer to run things by hand. Hook is fast tier only — never `test:e2e`, never bench.

**Watch mode default.** `pnpm test:watch` from inside any package runs only that package's tests. From the repo root, it runs the full fast tier. The Vitest config does the right thing based on `process.cwd()`; contributors don't have to remember a flag.

**Failing-fast vs. running everything.** Default is `--bail=1` — first failure stops the run. Override with `pnpm test --no-bail` when you want to see how bad the damage is. CI runs without bail because we want the full report on every PR.

**IDE integration.** We commit a `.vscode/settings.json` that points the Vitest extension at our root config and enables inline test results. JetBrains users have `.idea/runConfigurations/` checked in. Contributors using other editors are on their own; we don't multiply IDE-config drift.

**Debugging a single failing case.** `pnpm test -- --reporter=verbose <substring>` filters by test name. For deeper debugging, `pnpm test:debug <substring>` launches Vitest under `--inspect-brk`; attach your debugger of choice. The CI job logs include the seed for property tests on failure, so the same failing case can be reproduced locally with `FC_SEED=<seed> pnpm test`.

---

## 13. Glossary

A few terms get used loosely in test-related conversations. Here's how this document uses them.

- **Snapshot test:** a test that compares the current output of a producer against a checked-in expected output. Pass = bytes match. Used here for IR (§1.2), visual baselines (§1.6).
- **Golden test:** synonym for snapshot test in this doc. We standardize on "snapshot."
- **Fixture:** input data fed to a test. Synthetic or real, lives in `__fixtures__/`, `test-fixtures/`, or `e2e-fixtures/`.
- **Canonicalization:** deterministic re-serialization of an IR — sorted keys, sorted arrays-as-sets, normalized paths. Required before any byte comparison.
- **Determinism:** byte-identical output for byte-identical input, on the same OS at minimum and ideally cross-OS.
- **Property-based test:** a test that asserts a property holds across a generated space of inputs, run by `fast-check` here.
- **Adapter:** the package that turns one language's source tree into IR (`adapters/typescript`, `adapters/python`, etc.).
- **Framework adapter:** a layer on top of a language adapter that recognizes framework-specific patterns (`adapters/typescript/react`, etc.). Tested the same way as adapters; the `__fixtures__/` are framework-specific.
- **IR:** the intermediate representation defined in `spec/ir.schema.json` and `spec/ir.types.ts`. Single source of truth for "what does codegraph know."

---

## 14. Review checklist for test-touching PRs

A short list reviewers use. If a PR touches tests, every applicable item should be answered.

- [ ] New unit tests are colocated with the code they cover (`*.test.ts` next to `*.ts`)?
- [ ] New IR snapshot fixtures have a `README.md` explaining what they prove?
- [ ] If `expected.ir.json` changed, is there a CODEOWNER ack from spec/?
- [ ] If a visual baseline changed, is there a CODEOWNER ack from viewer/?
- [ ] If a bench regression is intentional, is the title prefixed `[perf]` and is `bench/baseline.json` updated in the same PR?
- [ ] If a new adapter feature was added, is `__fixtures__/COVERAGE.md` updated?
- [ ] If a new property was added to the diff/IR property tests, does it use the shared generator in `packages/core/test/gen/ir.ts`?
- [ ] No `Date.now()` / `Math.random()` / hostname / pid in any IR-producing code path?
- [ ] `pnpm test:determinism` was run locally on the new fixtures?
