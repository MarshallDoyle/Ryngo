# Ryngo Evaluation Plan

Ryngo's public claim should be measured as two separate things:

1. **Compression:** how many tokens each Ryngo representation uses compared with raw source.
2. **Compiler quality:** how much useful structure Ryngo preserves while compressing.

The corpus harness is already the right backbone. The next pass should add a token-efficiency report on top of each successful corpus run.

## Representations To Compare

| Representation | Purpose | Token source |
|---|---|---|
| Raw files | Baseline: what an LLM would need if fed the repo directly | sampled source bytes / tokenizer |
| Topology markdown | Planning / first-pass repo understanding | `topology(ir)` |
| Compact IR | Agent-ready structured context | `compactJson(ir)` |
| RyngoViewModel | UI and ChatGPT widget graph | `buildViewModel(ir)` |
| Focused subgraph | Change work around one node | `slice(ir, rootId, hops)` |
| English signature | Single symbol explanation | `englishSignature(node)` |

## Language Slices

Publish every metric by primary language and by repo family:

- TypeScript / JavaScript
- Python / Jupyter
- Go
- Java / Spring
- Ruby / Rails
- Rust
- C#
- HCL / Terraform

For stubbed languages, compression still matters, but compiler-quality claims should say "file-level / adapter-level only" until full parsers land.

## Metrics

| Metric | Definition |
|---|---|
| Raw token estimate | Token count for source files Ryngo considered analyzable |
| Representation tokens | Token count for each emitted representation |
| Compression ratio | `representationTokens / rawTokens` |
| Token savings | `1 - compressionRatio` |
| Source anchor coverage | nodes with exact `file:line` / total source-backed nodes |
| Parse recall proxy | extracted defs, classes, routes, db models, env reads per language baseline |
| Adapter coverage | repos triggering each adapter |
| Weak-language flags | languages with high file count but low extracted structure |

## Implementation Steps

1. Add `scripts/token-efficiency-report.js`.
2. Reuse `test/corpus.js` and `analyzeRepo`.
3. For each successful repo, compute raw source token estimate, topology tokens, compact IR tokens, view-model tokens, and representative subgraph/signature tokens.
4. Write `test/results/token-efficiency-latest.json` and `test/results/token-efficiency-latest.md`.
5. Update `scripts/corpus-run.js` to optionally call the token report after a full run.
6. Add a landing build step that copies summarized ratios into a static JSON asset consumed by the landing chart.
7. Gate public claims: landing copy should only show measured corpus numbers after at least one full successful run.

## Landing Page Shape

The landing page should show:

- A slider for "raw repo context tokens" as intuition.
- A measured chart from the latest corpus run.
- A language-by-language table.
- A representation-by-representation table.
- A short caveat: fewer tokens are useful only when exact source anchors and graph edges are preserved.

## First Acceptance Bar

Before publishing a headline, run the full corpus and require:

- 90%+ successful repo analyses.
- No hard expected-classification regressions.
- Token report generated for every successful repo.
- Separate "measured" and "modeled" numbers in the landing page.
