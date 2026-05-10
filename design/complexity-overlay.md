# Complexity / Heat Overlay — Design

Status: draft v1
Scope: optional bonus feature on top of the core codegraph static-analysis pipeline.
Constraint: no LLM calls. Pure static analysis plus git plumbing. MIT-licensed.

## 0. Goal

The base codegraph product produces a graph of code: files, modules, functions,
classes, services, and the call/import edges between them. The overlay system
layers a **scalar metric** onto every node in that graph and renders it as a
color in the viewer. The user picks the metric; the viewer recolors. Nothing
about the underlying graph changes.

Two audiences:

1. **Reviewers** scanning a foreign codebase — "where is the gnarly stuff?"
2. **Maintainers** of their own codebase — "what should we refactor next?"

The overlay is the cheapest way to answer both questions. It must be:

- **Cheap to compute** (sub-second on incremental updates).
- **Honest** (no fake precision; metrics are signals, not verdicts).
- **Composable** (stack two metrics for "refactor candidate" views).
- **Optional** (off by default; the base graph stands on its own).

## 1. Metrics

We ship six metrics in v1. Each is independently toggleable. None of them is
the right metric in all cases — the point is to give the user a quick way to
flip between lenses.

### 1.1 Cyclomatic complexity (per function)

Classic McCabe cyclomatic complexity: count of linearly independent paths
through a function. Computed during the AST walk that already builds the
function nodes — no second pass.

Decision points that increment the count by 1:

- `if`, `else if` (each branch arm)
- `for`, `while`, `do-while`
- `case` arms in `switch` (each `case`, not the `switch` itself)
- `catch` clauses
- ternary `?:`
- short-circuit `&&` and `||` in boolean expressions
- nullish coalescing `??`
- `?.` optional chaining (each link adds a branch)

Base value is 1 (the straight-line path). Result is an integer per function.

Aggregation: see §3. We keep the per-function number; we never average across
functions inside a module (averages mask outliers, which is exactly what we
want to find).

### 1.2 Cognitive complexity (per function)

A nesting-aware variant inspired by SonarSource's cognitive complexity. It
penalizes deeply nested control flow more than flat control flow with the same
cyclomatic count.

Rules in v1:

- Each break in linear flow (`if`, `for`, `while`, `switch`, `catch`,
  `&&`/`||` inside conditions) adds 1.
- Nesting increments add **the current nesting level** on top of the base 1.
  An `if` inside an `if` inside a `for` adds 1 + 2 = 3, not 1.
- `else` and `else if` add 1 (no nesting bonus on the else itself).
- Recursion (call to the enclosing function) adds 1.
- Jumps to labels (`break label`, `continue label`, `goto` in C-family) add 1.

Exclusions: `try`/`finally` do not increment by themselves; only `catch` does.
Switch statements add 1 for the `switch` itself plus 1 per `case` (matches
human intuition that a 12-arm switch is more complex than an `if/else`).

The output is an integer per function. Cognitive and cyclomatic disagree
often enough that exposing both is worth the extra column.

### 1.3 Lines of code (per node)

Physical lines, not logical statements. For a function we use the source
range from the AST node (last line minus first line plus 1). For a file we
use the file's line count. We do not subtract blank lines or comments — that
opens a long argument about what counts as a comment in JSDoc-heavy code, and
the difference is rarely material.

Aggregation up the tree is a sum (see §3).

### 1.4 Git churn (per file, last 90 days)

Number of commits in the last 90 days that touched the file. Computed once
per file via a single `git log` invocation (see §4.2), not per-function. The
90-day window is a default; users can override via config.

We deliberately scope churn to **file**, not function. Per-function churn
requires line-blame intersection per commit, which is roughly an order of
magnitude more expensive and produces noisier output (renames, formatting
passes, and large refactors all distort it). File-level churn is a more
honest signal at the cost of being coarser.

For nodes inside a file (functions, classes), the churn value is inherited
from the containing file. The viewer shows this clearly: hovering a function
node displays "churn: 14 (file)" so the user knows where the number came from.

### 1.5 Author count (last 90 days)

Number of distinct authors who touched the file in the last 90 days. A
proxy for bus-factor risk: a file with 1 author and 30 commits is a single
point of failure; a file with 8 authors and 30 commits is shared knowledge.

Same scope and inheritance rules as churn. Computed in the same `git log`
pass to avoid re-walking history.

We use `--use-mailmap` so that `Jane <jane@old.com>` and `Jane <jane@new.com>`
collapse to one author when the repo has a `.mailmap` file. Without
`.mailmap`, identical names with different emails count as separate authors;
we surface this in the viewer's metric description so users know to add a
`.mailmap` if the numbers look inflated.

### 1.6 Test coverage (per function, optional)

Read from a `coverage.json` file if one is provided. We accept the standard
Istanbul-format JSON (used by `nyc`, `c8`, `jest --coverage`,
`vitest --coverage`) because it's the broadest common denominator in
JavaScript/TypeScript. Other formats (lcov, cobertura) are converted via
`nyc report` upstream of codegraph.

We map coverage entries to function nodes by `(file, startLine, endLine)`
intersection. If no entry overlaps a function's line range, the function is
shown as **unknown** (gray), not as 0%. Distinguishing "not measured" from
"measured at 0%" matters: a 0% function is a refactor candidate; an unknown
function might just be excluded by the coverage tool's glob.

The metric value is the percentage of statements covered, 0 to 100. We do
not split into branch / line / function coverage in v1; this can be a future
sub-metric.

## 2. Overlay UI

The viewer is the existing codegraph web UI. The overlay system adds a
panel and a recoloring layer; it does not change graph layout.

### 2.1 Toggle and metric picker

Top-right of the canvas: a small panel with:

- **Overlay** toggle (on/off). Off is the default. When off, nodes use the
  base coloring (by language, by node kind, etc. — whatever the base does).
- **Metric** dropdown. Six options listed in §1.
- **Threshold** slider (only visible for cyclomatic, cognitive, churn,
  authors, LOC). Drags a horizontal line on the legend; nodes below the
  threshold are dimmed to 30% opacity. Useful for "show me only the hot
  spots."
- **Combine** button (see §6). Hidden until the user has picked one metric.

The panel is collapsible. When collapsed, it shows a single chip:
"Overlay: cyclomatic" or "Overlay: off."

### 2.2 Color scale

A perceptually uniform cool-to-hot ramp: viridis-inverted (so high values
are warm/red and low values are cool/blue). Concretely we use the
matplotlib `viridis_r` palette interpolated to 9 stops.

Why viridis: colorblind-friendly and monotonically increasing in luminance,
so even a black-and-white screenshot conveys ordering. Common alternatives
(jet, rainbow) fail both tests.

Per-metric defaults:

| Metric          | Min | Max  | Notes                                            |
|-----------------|-----|------|--------------------------------------------------|
| cyclomatic      | 1   | 20   | clamp >20 to max color                           |
| cognitive       | 0   | 30   | clamp >30 to max color                           |
| LOC             | 0   | 300  | log scale (LOC distribution is heavy-tailed)     |
| churn           | 0   | 50   | log scale                                        |
| authors         | 0   | 8    | linear; >8 is rare and saturates                 |
| coverage        | 0   | 100  | reversed (low coverage is the "hot" end)         |

The min/max are chosen from typical large-codebase distributions. The
viewer also shows the actual min/max of the current graph; users can pin
the scale to either the defaults or the actual range. Pinning to actual
range gives more dynamic range on small repos but makes cross-repo
comparison meaningless, which is why defaults are the default.

### 2.3 Legend with thresholds

Below the metric picker: a vertical color bar with numeric tick labels at
the 0%, 25%, 50%, 75%, 100% positions of the scale. Three named bands:

- **Cool** (lowest 33%): "ok"
- **Mid** (middle 33%): "watch"
- **Hot** (highest 33%): "review"

The labels are advisory, not authoritative. Hovering the legend shows the
exact threshold values for the current metric.

### 2.4 Per-node tooltip

Hovering a node shows:

```
fn handlePayment      packages/billing/src/handler.ts:142
cyclomatic   18  (hot)
cognitive    24
LOC          87
file churn   31 commits / 90d
authors      4
coverage     62%
```

All six metrics are shown regardless of which one is currently colored,
so the user gets the full picture without flipping the dropdown.

## 3. Aggregation

Code graphs are hierarchical: function ⊂ class ⊂ file ⊂ module ⊂ service.
The viewer lets users zoom out to higher tiers, at which point a single
node represents many children. Each metric needs an explicit aggregation
rule for these higher tiers; "average everything" is the wrong default for
most of them.

| Metric       | Aggregation up the tree     | Rationale                                                                 |
|--------------|-----------------------------|---------------------------------------------------------------------------|
| cyclomatic   | **max** of children          | One ugly function poisons the module. Sum hides outliers; mean dilutes.   |
| cognitive    | **max** of children          | Same as cyclomatic.                                                        |
| LOC          | **sum** of children          | Total size is the sensible aggregate.                                     |
| churn        | not aggregated (file scope)  | Already at file granularity; module/service rolls up via §3.1.            |
| authors      | not aggregated (file scope)  | Same as churn.                                                             |
| coverage     | **weighted mean by LOC**     | A 10-line 100% function and a 500-line 0% function should not average to 50%. Weight by lines covered / total measurable lines. |

### 3.1 Module and service rollups for file-scoped metrics

For churn and authors, "module" and "service" tiers aggregate by:

- **module churn**: sum of churn across files in the module.
- **module authors**: size of the union of authors across files (not sum;
  the same author working on three files in the module is one author, not
  three).

The same rule extends to services. The "union, not sum" choice for authors
is deliberate: a service touched by 12 authors (whether they each touched
one file or all touched every file) has a bus-factor of 12, not 144.

### 3.2 Why max for complexity

A module with one function of cyclomatic 30 and twenty functions of
cyclomatic 2 has an average of ~3.3 — looks fine. The max is 30 — looks
broken. The max is what we actually care about when scanning at the module
tier; we expose the count of children above the threshold ("3 hot
functions") in the module tooltip so users get both the worst case and a
sense of how isolated it is.

### 3.3 Showing aggregation in the UI

When a metric is aggregated, the legend shows a small badge: "max" or
"sum" or "weighted mean." Tooltips on aggregated nodes name the worst
child for max-aggregated metrics: "cyclomatic max: 28 (in
`handlePayment`)."

## 4. Computation

### 4.1 Cyclomatic and cognitive

Both are computed during the existing AST walk that builds function nodes.
The walker maintains a per-function counter that the visit functions for
each control-flow node increment. Cognitive's nesting bonus is tracked by
incrementing a depth counter on `if`/`for`/`while`/`switch`/`catch` entry
and decrementing on exit.

Pseudocode for the visitor:

```
fn visitFunction(node):
  cyclo = 1
  cog = 0
  depth = 0
  walk(node.body, on_enter, on_exit)
  store(cyclo, cog) on the function node

fn on_enter(child):
  match kind(child):
    If:        cyclo += 1; cog += 1 + depth; depth += 1
    ElseIf:    cyclo += 1; cog += 1
    Else:                  cog += 1
    For|While: cyclo += 1; cog += 1 + depth; depth += 1
    Switch:                cog += 1 + depth; depth += 1
    Case:      cyclo += 1
    Catch:     cyclo += 1; cog += 1 + depth; depth += 1
    Ternary:   cyclo += 1; cog += 1 + depth
    LogicalAnd|LogicalOr|NullishCoalesce: cyclo += 1; cog += 1
    OptionalChain: cyclo += 1
    BreakLabel|ContinueLabel: cog += 1
    RecursiveCall: cog += 1

fn on_exit(child):
  if kind(child) in {If, For, While, Switch, Catch}: depth -= 1
```

LOC is also captured in this pass (`node.endLine - node.startLine + 1`).

### 4.2 Git churn and authors

One `git log` per repo, not per file:

```
git log \
  --since=90.days \
  --pretty=format:'%H%x09%an' \
  --name-only \
  --use-mailmap \
  -- '*'
```

The output alternates header lines (`hash<tab>author`) with file path
lines until a blank line. We parse it streaming and build two maps:

- `churn[file]` = count of commits touching the file
- `authors[file]` = set of distinct author names touching the file

Total cost: one git process, output proportional to commits × files
changed per commit. On a repo with 5k commits in 90 days and an average
of 4 files per commit, this is ~20k lines of output and finishes in
hundreds of milliseconds.

The `since` window is configurable: `codegraph.config.json` accepts
`overlay.churnWindowDays`. Defaults to 90.

### 4.3 Coverage

Read `coverage.json` once at load time. Build a map keyed by absolute
file path. For each function node, find the coverage entry whose file
matches and intersect statement ranges with the function's line range.
Coverage % = covered_statements_in_range / total_statements_in_range × 100.

If `coverage.json` is missing, the metric is grayed out in the dropdown.

## 5. Performance

### 5.1 Caching

Two caches, both keyed appropriately for invalidation:

- **AST-derived metrics** (cyclomatic, cognitive, LOC): cached per file at
  `(file path, file mtime, file size)`. Reused across runs unless the file
  changed. This is the same cache the base graph builder uses; we just add
  the metric values to its payload.

- **Git metrics** (churn, authors): cached per repo at
  `(repo HEAD sha, churn window days)`. Invalidated when HEAD moves. Stored
  in `.codegraph/cache/git-overlay-{sha}.json`. A single file because the
  whole map is built in one pass; per-file cache files would multiply the
  IO with no benefit.

Coverage is read fresh each run because `coverage.json` is small and users
expect it to reflect the latest test run.

### 5.2 Incremental updates

When the user edits a file in watch mode:

- AST metrics for that file are recomputed (~ms).
- Git metrics are **not** recomputed. The HEAD sha hasn't moved, so the
  cached map is still valid. The new version of the file inherits the same
  churn count it had before; this is correct (uncommitted changes don't
  affect commit history).

When the user commits, a hook can invalidate the git cache, or the user can
re-run; we don't auto-watch `.git/` because it generates churn that the
user usually doesn't care about until they actively look at the overlay.

### 5.3 Render cost

Recoloring the canvas is O(nodes), one lookup per node. On a 50k-node
graph this is well under a frame. Switching metrics is instantaneous; we
don't reload the graph.

## 6. Combined views

The "refactor candidates" view: high churn AND high complexity. A function
that's both gnarly (hard to change without breaking things) and changing
often (people are trying to change it) is the highest-value refactor
target. Either signal alone is much weaker.

### 6.1 The combine UI

Clicking **Combine** in the overlay panel adds a second metric picker
below the first and a relation selector: AND, OR, or "ratio."

- **AND**: a node is "hot" only if it's hot in *both* metrics. Color by
  `min(metric1_normalized, metric2_normalized)`.
- **OR**: hot in *either*. Color by max.
- **Ratio**: useful for things like "high LOC, low coverage" — color by
  `metric1_normalized × (1 - metric2_normalized)`.

Each metric is normalized to [0, 1] using its scale (§2.2) before
combining, so we don't have to worry about cyclomatic's range being
different from churn's.

### 6.2 Preset combinations

Three named presets in the dropdown:

- **Refactor candidate** = cyclomatic AND churn
- **Risk** = (cyclomatic OR cognitive) AND (1 - coverage)
- **Bus factor risk** = LOC AND (1 / authors)

These are starting points. Picking a preset populates the two pickers and
the relation; users can tweak from there.

### 6.3 Why not "all metrics combined into a score"

We considered shipping a single "code health" score and decided against it.
Combining six metrics into one number requires choosing weights, and any
weighting we pick will be wrong for some teams. The combine UI is honest
about the choice; a "score" would hide it. If users want one number they
can build it via the CLI (§7) and pipe it wherever.

## 7. CLI output

The viewer is the primary surface, but the same metrics are exposed via
CLI for CI integration, dashboards, and quick checks.

### 7.1 `codegraph complexity`

```
codegraph complexity [--metric=<metric>] [--threshold=<n>] [--format=<fmt>]
```

Flags:

- `--metric` one of `cyclomatic` (default), `cognitive`, `loc`, `churn`,
  `authors`, `coverage`.
- `--threshold` numeric. Reports nodes above (or below, for coverage) the
  threshold. Defaults per metric: cyclomatic 10, cognitive 15, LOC 200,
  churn 20, authors 1, coverage 50.
- `--format` one of `table` (default), `json`, `csv`, `sarif`. SARIF is
  for posting findings as PR comments via standard tooling.
- `--scope=<glob>` restrict to a path glob.
- `--top=<n>` show only the top N (default: all above threshold).

Default output (table):

```
$ codegraph complexity --metric=cyclomatic --threshold=10

  cyclomatic  function                                                       file:line
  ----------  ------------------------------------------------------------   ----------------------------
          28  handlePayment                                                  packages/billing/handler.ts:142
          22  parseExpression                                                packages/parser/expr.ts:88
          17  reconcileLedger                                                packages/billing/ledger.ts:301
          14  resolveRoute                                                   packages/router/resolve.ts:56
          11  formatTimestamp                                                packages/util/time.ts:19

5 functions above threshold (10).
```

JSON output is a flat array of `{ node, file, line, metric, value }`
objects, suitable for piping into jq or a dashboard.

### 7.2 `codegraph complexity --combine`

Mirrors the viewer's combine view:

```
codegraph complexity \
  --combine cyclomatic,churn \
  --relation=and \
  --threshold=0.7
```

Threshold is on the normalized [0, 1] combined score, not on either raw
metric. Useful in CI: "fail the build if any function's combined score
exceeds 0.85."

### 7.3 Exit codes

- 0: no nodes above threshold.
- 1: nodes found above threshold (default; CI-friendly).
- 2: invalid args / missing inputs (e.g., `--metric=coverage` without a
  `coverage.json`).

The non-zero on findings lets a single line in CI gate merges:

```
codegraph complexity --metric=cyclomatic --threshold=20 || exit 1
```

We document that this gate should usually be set conservatively (high
threshold, narrow scope) — graph-wide gates produce noise faster than
they produce action.

## 8. Configuration

Per-repo config lives in `codegraph.config.json` under an `overlay` key:

```json
{
  "overlay": {
    "churnWindowDays": 90,
    "coveragePath": "./coverage/coverage-final.json",
    "scales": {
      "cyclomatic": { "min": 1, "max": 20 },
      "loc": { "min": 0, "max": 300, "scale": "log" }
    },
    "thresholds": {
      "cyclomatic": 10,
      "cognitive": 15
    }
  }
}
```

All keys optional. Missing keys fall back to the defaults documented in
§2.2 and §7.1. The config is the single source of truth for both the CLI
and the viewer; no separate UI-only settings.

## 9. Non-goals (v1)

Documented to keep scope honest:

- **Halstead metrics** (volume, difficulty, effort). Real metrics, but
  they correlate strongly with LOC and cyclomatic for most code, and
  they're harder to explain to non-experts. Defer to v2 if there's demand.
- **Maintainability index.** A composite of cyclomatic + Halstead + LOC.
  We provide the inputs and the combine view; users can build their own.
- **Per-function git churn.** Discussed in §1.4. Re-evaluate once we have
  data on whether file-level is too coarse in practice.
- **Historical overlays** ("show me what was hot 6 months ago"). Possible
  with the existing data — git log doesn't care about the time window —
  but the UI cost is non-trivial and the demand is speculative.
- **Comparison against another branch.** Same data shape, separate UI
  surface; defer.
- **Type complexity.** Counting union arms and generic depth in TypeScript
  types. Interesting but a different beast from runtime control flow;
  doesn't belong in the same metric family.

## 10. Open questions

1. Should the combine view's normalization use the per-graph actual range
   or the global defaults? Per-graph makes small repos more expressive
   but breaks cross-repo comparison. Current plan: follow whatever the
   single-metric scale is pinned to.
2. How to surface "this file has no measurable coverage" vs. "this file
   has 0% coverage" in the CLI table. Currently we print `n/a` for
   unmeasured; some teams may want to fail CI on `n/a`.
3. What's the right default churn window? 90 days is a quarter, which
   matches a lot of planning cadences, but is too long for fast-moving
   product code and too short for stable infra. Per-repo config covers
   this, but the default still matters because most users won't change it.
4. Should `codegraph complexity` accept stdin (a list of files) for
   integration with `git diff --name-only`? Useful for "complexity check
   on changed files only" in CI; cheap to add.

## 11. Test plan

Fixtures under `test-fixtures/overlay/`:

- `cyclomatic/`: a function with each control-flow construct used once,
  asserted to produce the expected count.
- `cognitive/`: nested vs. flat versions of the same logic, asserted to
  produce different cognitive scores but identical cyclomatic scores.
- `git-churn/`: a fixture repo built by a shell script that creates N
  commits with known author/file distributions; the metric job runs and
  results are compared to expected JSON.
- `coverage/`: a hand-written `coverage.json` with known overlap to a
  function fixture; tests the line-range intersection.
- `aggregation/`: a mini graph with three modules, each with known
  per-function values; asserts the §3 rules.
- `combine/`: nodes hand-tagged with known metric pairs; asserts AND/OR/
  ratio outputs.

Integration tests run the CLI end-to-end against the fixture repos with
golden-file comparisons.

## 12. Summary

The overlay is a lens, not a verdict. It takes the graph the rest of
codegraph already produces and asks one question per node: how much should
the user care about this? Six different definitions of "care" are
provided; users pick one (or combine two) and the viewer recolors. The
implementation reuses the AST walker for code metrics and a single git
log for history metrics, with caching keyed to the things that actually
invalidate. The CLI exposes the same data for CI and scripting. Nothing
in the system is irreversible, opinionated, or dependent on a model;
everything is a static count the user can verify by hand.
