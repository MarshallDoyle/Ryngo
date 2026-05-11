# Compiler Research

Status: expanded research report, 2026-05-10

Purpose: document how Ryngo should compile source repositories upward into
heuristics, abstractions, representation layers, source-backed facts, view
models, and LLM-agent context. This is not about compiling to executable code.
It is about building a trustworthy comprehension compiler.

## Read This First

Ryngo's compiler should be designed like a compiler and judged like a product.
The output is not machine code. The output is a compact, source-backed model of
what a repository contains, how the important parts relate, what was extracted
well, what was missed, and what context an agent should receive next.

The core strategy:

1. Parse broadly.
2. Resolve precisely where possible.
3. Infer framework facts cautiously.
4. Preserve provenance for every fact.
5. Project the full graph into small task-specific views.
6. Log quality signals so the compiler improves from real usage.

The product cannot win by drawing every syntactic node. It wins by choosing
the smallest truthful abstraction that helps a human or agent move through a
codebase.

## What Ryngo Must Get Right

Ranked by implementation importance:

1. **Provenance-first IR.** Every node, edge, and fact needs source evidence or
   an explicit inferred reason.
2. **Layered extraction.** File inventory, syntax, symbols, imports, calls,
   framework facts, effects, and projections should be separate passes.
3. **Confidence-aware facts.** Confirmed semantic resolution, framework
   inference, and heuristics must not collapse into the same certainty.
4. **Stable IDs.** Node and edge identity must survive line changes and support
   annotations, diffs, caching, and event logs.
5. **Framework adapters.** Modern apps are convention-heavy. Routes, models,
   env vars, jobs, and infra often require adapter logic beyond AST parsing.
6. **Compact projection.** The full IR is too large for users and agents. The
   product surface is the projected view model, subgraph, and signature.
7. **Language realism.** TypeScript, Python, Go, Java, Ruby, Rust, C#, HCL,
   SQL, GraphQL, and notebooks need different extraction strategies.
8. **Quality feedback loop.** Usage logs, rejected repos, parse failures,
   weak-language flags, and token evals should directly drive compiler work.

## Implementation Implications

- Build the analyzer as a pass pipeline, not one monolithic extraction file.
- Use tree-sitter for broad syntax and spans, but do not pretend syntax is
  semantic resolution.
- Use language-native tools when they are clearly better: TypeScript compiler
  API, `go list`, Java build metadata/LSP, Rust analyzer, SQL parsers, HCL
  parsers.
- Treat SCIP/LSIF/LSP as enrichment sources for definitions, references, hovers,
  and diagnostics, not as the full Ryngo product model.
- Put framework adapters after syntax/symbol extraction so they can add facts
  to a shared IR.
- Treat every dropped/skipped file as a measurable compiler-quality signal.
- Keep MCP and web outputs deterministic, bounded, and byte-stable for the same
  repo/ref/options whenever possible.

## Open Questions And Product Research

- What is the v1 IR schema boundary between "full IR" and "view model"?
- Should Ryngo store raw AST fragments, normalized symbol records, or both?
- How much call graph precision is needed before it becomes useful in UI?
- Which confidence levels are enough for users: confirmed, inferred,
  heuristic, unknown; or more granular?
- Should source spans be line-only or line/column ranges throughout?
- How much type information should be captured in v1, and how should `unknown`
  be displayed?
- Which language gets the next investment after TS/Python: Go via `go list`,
  Java/Spring, Ruby/Rails, Rust, or Terraform?
- What event schema best captures "this repo compiled poorly because..."?

## The Compiler Target Is Upward, Not Downward

Traditional compilers lower source code into machine-executable forms. Ryngo
does the reverse kind of useful work: it raises code into abstractions.

Traditional direction:

```text
source -> AST -> semantic IR -> low-level IR -> machine code
```

Ryngo direction:

```text
repo -> files -> syntax -> symbols -> semantic facts -> framework facts
     -> effect graph -> importance-ranked IR -> compact projections
     -> agent/viewer context
```

This "upward compiler" must keep the rigor of compilers:

- deterministic passes
- explicit intermediate artifacts
- typed edges/facts
- diagnostics
- reproducible outputs
- benchmark corpus
- regression gates

But it should optimize for product questions:

- What does this repo do?
- What are the important nodes?
- Where does this route go?
- What will break if I change this?
- What should an agent inspect next?
- What compiled poorly, and why?

## Chronological Lineage

### 1950s-1960s: Parsing, ASTs, And Compiler Frontends

The abstract syntax tree is the first major representation jump: source text
becomes a structured tree. ASTs remove many textual accidents while preserving
syntax.

What it solved:

- Structured representation of code.
- Basis for semantic analysis and transformation.
- A way to identify definitions, expressions, statements, and scopes.

Where ASTs are insufficient:

- They do not resolve imports or types by themselves.
- They represent syntax, not architecture.
- Framework conventions are often outside the AST.
- A raw AST is too verbose for humans or LLM agents.

Ryngo implication:

ASTs are extraction substrate, not product output. Ryngo should use ASTs to
create source-backed nodes and facts, then discard or hide most AST detail from
the default view model.

What to steal:

- Source ranges.
- Structured node kinds.
- Parent/child containment.

What to avoid:

- Exposing AST-shaped graphs directly to users.

Sources:

- Tree-sitter, concrete syntax trees and incremental parsing:
  https://github.com/tree-sitter/tree-sitter
- AST representation learning survey:
  https://arxiv.org/abs/2312.00413

### 1960s-1970s: Control-Flow And Data-Flow Analysis

Control-flow graphs (CFGs) represent possible execution paths. Data-flow
analysis tracks facts across those paths. These concepts made compilers and
static analysis much more powerful.

What they solved:

- Reasoning about paths, branches, loops, and reachability.
- Propagating facts such as definitions, liveness, constants, and types.
- Making optimization and verification possible.

Where they are hard for Ryngo:

- Whole-program CFG/data-flow is expensive and language-specific.
- Dynamic dispatch and runtime configuration complicate static certainty.
- UI users rarely want raw CFGs.

Ryngo implication:

Control/data-flow should appear as targeted drill-down views and effect facts,
not as the default graph. For example: request flow, data flow to a database,
or impact slice around a selected node.

What to steal:

- Flow-sensitive facts where valuable.
- Reachability/slicing ideas.
- Distinction between control, data, and effect edges.

What to avoid:

- Drawing basic blocks as product nodes.
- Overclaiming runtime behavior from static analysis.

### 1977: Abstract Interpretation

Cousot and Cousot's abstract interpretation gives a rigorous framework for
approximating program behavior over abstract domains instead of concrete
values. It matters because Ryngo can classify effects without executing code.

Useful abstract domains for Ryngo:

- reads environment
- reads filesystem
- writes filesystem
- calls network
- reads database
- writes database
- executes subprocess
- handles user input
- serializes/deserializes
- test-only
- framework entrypoint
- auth/session boundary

What it solved:

- Sound approximation of program behavior.
- A way to reason about many possible executions.
- A language for static analysis precision.

Where Ryngo must be careful:

- Full soundness is likely too expensive for MVP.
- Unsound but useful heuristics must be labeled honestly.
- Abstract interpretation concepts should inform design without requiring a
  formal analyzer for every language.

Ryngo implication:

Effect badges and risk flags should be treated as abstract domains. They should
carry source provenance and confidence.

Source:

- Cousot and Cousot, Abstract Interpretation, 1977:
  https://cs.nyu.edu/~pcousot/COUSOTpapers/POPL77.shtml

### 1980s-1990: Program Dependence Graphs And Slicing

Program dependence graphs combine data dependence and control dependence.
Program slicing uses dependence relationships to extract the subset of a
program relevant to a variable, statement, or behavior.

What it solved:

- Focused comprehension around a criterion.
- Debugging and maintenance support.
- A formal basis for "show me what influences this."

Why it matters to Ryngo:

Ryngo's focused subgraph is a product version of slicing. When a user selects
`download_single_shard`, the viewer should show callers, callees, imports,
effects, tests, env vars, and source facts around that node without requiring
the whole repo.

Where it is hard:

- Precise interprocedural slicing is expensive.
- Dynamic languages and frameworks complicate call/context resolution.
- Full dependence graphs are too dense for default UI.

Ryngo implication:

Implement practical, confidence-aware slices:

- Exact where symbol resolution is known.
- Framework-inferred where adapter evidence exists.
- Heuristic where only syntactic references exist.
- Always bounded by hops, node caps, and omitted counts.

Sources:

- Ferrante, Ottenstein, Warren, Program Dependence Graph:
  https://bears.ece.ucsb.edu/class/ece253/papers/ferrante87.pdf
- Horwitz, Reps, Binkley, interprocedural slicing:
  https://research.cs.wisc.edu/wpis/papers/toplas90.pdf
- Program slicing survey:
  https://www.cerias.purdue.edu/apps/reports_and_papers/view/906

### 1991: Static Single Assignment

Static Single Assignment (SSA) renames variables so each assignment has one
definition. It is a major compiler representation because it makes data
dependencies explicit.

What it solved:

- Simplified optimization.
- Explicit def-use chains.
- Efficient data-flow reasoning.

Where it is too low-level:

- Users do not want SSA nodes in a product graph.
- LLM agents usually need source-level concepts, not compiler temporaries.

Ryngo implication:

SSA's lesson is not to expose SSA. The lesson is normalization. If Ryngo can
normalize routes, symbols, imports, env reads, and data writes into stable
facts, downstream projection becomes much easier.

Source:

- Cytron et al., Efficiently Computing Static Single Assignment:
  https://app.scinito.ai/article/W1982205631

### Mid-1990s: Sea Of Nodes

Sea-of-nodes IR combines data/control dependencies in a graph-like SSA form and
relaxes strict basic-block ordering. It is used in optimizing compiler contexts
such as JVM/JIT systems.

What it solved:

- Exposes data dependencies directly.
- Gives optimizers freedom to reorder.
- Supports global reasoning about computation.

Why it is a warning:

- Powerful graph IRs can be hard to debug.
- Graph density can overwhelm humans.
- Compiler-internal nodes are not product-level nodes.

Ryngo implication:

Ryngo should internalize the idea that data and control can be separate graph
dimensions, but the viewer should stay source-level. The product graph is not
an optimizer IR.

Sources:

- Sea-of-nodes overview:
  https://en.wikipedia.org/wiki/Sea_of_nodes
- Cliff Click / sea-of-nodes references:
  https://static.squarespace.com/static/50030e0ac4aaab8fd03f41b7/50030ec0e4b0c0ebbd07b0e0/50030ec0e4b0c0ebbd07b268/1281379125883/

### 1990s-2000s: Bytecode, Virtual Machines, And Shared IR

Java bytecode, .NET IL, LLVM IR, and similar intermediate forms show the value
of separating frontends from backends. Many source languages can target a
shared intermediate representation.

What it solved:

- Reuse of analysis/optimization infrastructure.
- Decoupling language parsing from downstream passes.
- Portability across targets.

Ryngo implication:

Ryngo needs one shared repo IR across language adapters. Parser-specific facts
should be normalized before viewer/MCP projection. The UI should not special
case every language.

What to steal:

- Common IR schema.
- Pass architecture.
- Diagnostics per pass.

What to avoid:

- Overgeneralizing until language-specific meaning is lost.

Source:

- LLVM project:
  https://llvm.org/

### 2000s-2010s: Datalog And Query-Based Static Analysis

Static analysis tools often represent code as facts and rules. CodeQL is the
most product-visible example: code is extracted into a relational database that
can be queried for vulnerabilities and semantic patterns.

What it solved:

- Code can be queried declaratively.
- Analyses can be written separately from extractors.
- Security and correctness patterns become reusable.

Where Ryngo should be cautious:

- Query languages are powerful but not friendly as primary UX.
- A relational/code database is not automatically a good map.
- Rich query results still need projection and explanation.

Ryngo implication:

Ryngo may eventually benefit from storing fact tables or a property graph, but
v1 should focus on a clean IR and high-value query surfaces: find node, focused
subgraph, English signature, quality report, source provenance.

Sources:

- CodeQL overview:
  https://codeql.github.com/docs/codeql-overview/about-codeql/
- CodeQL Go library AST/DFG explanation:
  https://codeql.github.com/docs/codeql-language-guides/codeql-library-for-go/
- QL language reference:
  https://codeql.github.com/docs/ql-language-reference/about-the-ql-language/

### 2014: Code Property Graphs

Code Property Graphs combine AST, CFG, and program dependence graph concepts
into one property graph. This is close to Ryngo's desired internal model.

What it solved:

- Unified syntax, control, and data facts.
- Queryable graph for vulnerabilities.
- A way to compose multiple analysis views.

Where Ryngo diverges:

- Ryngo is not only a security analysis tool.
- Ryngo must serve human visual exploration and LLM-agent context.
- The full graph must be projected into digestible view models.

Ryngo implication:

Use CPG as conceptual precedent:

- Rich internal graph.
- Source-backed properties.
- Queryable relationships.
- Multiple projections.

Do not expose CPG density directly.

Source:

- Code Property Graph summary:
  https://colab.ws/articles/10.1109/SP.2014.44

### 2016: LSP And The Split Between Language Intelligence And Editors

Language Server Protocol lets editors request definitions, references,
diagnostics, completions, and hovers from language servers. It separated
language intelligence from any one editor.

What it solved:

- Shared language tooling across editors.
- Rich code navigation through a protocol.
- A standard way to access language-specific intelligence.

Where it is not enough:

- Language servers are live services, not necessarily batch repo compilers.
- LSP responses are local and request-based.
- Framework semantics and product projections are outside the protocol.

Ryngo implication:

LSP can enrich Ryngo, especially for definitions/references/diagnostics, but
Ryngo's compiler needs deterministic batch outputs for MCP, caching, corpus
evals, and Cloud Run deployment.

Source:

- LSP announcement:
  https://www.globenewswire.com/press-release/red-hat-codenvy-and-microsoft-collaborate-on-language-server-protocol-2137810.htm

### 2018-2022: LSIF And SCIP

LSIF persisted language server knowledge as an index. SCIP simplified and
improved persisted code intelligence with a protobuf schema and stable symbol
strings.

What it solved:

- Definitions/references without a live language server.
- Cross-file code navigation in code browsers.
- Language-agnostic index format.

Where Ryngo should use it:

- Precise symbol occurrences.
- Definition/reference edges.
- Hover/signature facts.
- External symbol info.

Where Ryngo must go beyond it:

- Architecture importance.
- Framework routes/models/env vars.
- Effect classification.
- Token-efficient agent projections.
- Compiler-quality logging.

Ryngo implication:

SCIP is a strong enrichment tier. It can provide source ranges and symbol
identity that tree-sitter cannot. But Ryngo still needs its own IR and product
projection layer.

Sources:

- LSIF:
  https://lsif.dev/
- SCIP announcement:
  https://sourcegraph.com/blog/announcing-scip
- SCIP repository:
  https://github.com/sourcegraph/scip
- Sourcegraph indexer docs:
  https://sourcegraph.com/docs/code-search/code-navigation/writing_an_indexer

### 2018+: Tree-Sitter

Tree-sitter provides robust, incremental parse trees for many languages. It is
especially useful when full semantic tooling is unavailable.

What it solved:

- Broad syntax extraction.
- Fast parsing.
- Error-tolerant trees.
- Query-based captures.

Where it is limited:

- It does not resolve types.
- It does not know framework semantics.
- It can change across grammar versions.

Ryngo implication:

Tree-sitter should be a universal syntax and source-span tier. Its output must
be normalized and confidence-labeled.

Source:

- Tree-sitter:
  https://github.com/tree-sitter/tree-sitter

### 2019: MLIR And Multi-Level Representation

MLIR supports multiple abstraction levels through extensible dialects. It is
not a source-code comprehension tool, but its architecture is deeply relevant.

What it solved:

- Multiple IR levels in one infrastructure.
- Domain-specific dialects.
- Progressive lowering and reusable passes.

Ryngo implication:

Ryngo should use an MLIR-like mindset:

- Generic code dialect: files, symbols, imports, calls.
- Framework dialects: Express, Next, FastAPI, Django, Rails, Spring, Terraform.
- Effect dialect: db, env, fs, network, exec, messages.
- Projection dialect: view model, topology, subgraph, signature.

The key is not to copy MLIR syntax. The key is layered extensibility.

Sources:

- MLIR project:
  https://mlir.llvm.org/
- TensorFlow MLIR introduction:
  https://blog.tensorflow.org/2019/04/mlir-new-intermediate-representation.html

### 2020s: Semgrep And Pattern-Oriented Static Analysis

Semgrep made AST-aware pattern matching more accessible. It shows that many
useful code facts can be extracted through language-shaped patterns rather than
full compiler precision.

What it solved:

- Practical custom static analysis rules.
- Syntax-aware patterns without regex-only fragility.
- Security/style/bug scanning across many languages.

Where Ryngo can learn:

- Adapter rules can be pattern-like.
- Patterns should be simple, testable, and source-backed.
- Pattern matches must not overclaim type certainty.

Ryngo implication:

Framework adapters can start as deterministic pattern passes over syntax and
metadata. They should record extractor, source span, confidence, and diagnostic
codes.

Sources:

- Semgrep introduction:
  https://semgrep.dev/docs/introduction
- Semgrep rules overview:
  https://semgrep.dev/docs/writing-rules/overview/
- Semgrep type-awareness discussion:
  https://dev2.semgrep.dev/blog/2020/type-awareness-in-semantic-grep/

### 2023+: LLM Agents, Static Analysis, And Repository-Level Context

Modern code LLM work increasingly recognizes that repo-level tasks require
cross-file context. CrossCodeEval builds examples requiring cross-file context.
STALL+ tests static-analysis integration for repository-level completion.
ContextModule includes repository-wide static analysis and user behavior.

What this solves:

- Demonstrates that local context is insufficient.
- Shows static analysis can improve retrieval/context selection.
- Creates benchmarks for repo-level understanding.

Where Ryngo fits:

Ryngo is a deterministic context compiler for agents. Instead of asking an LLM
to infer a repo map from raw chunks, Ryngo gives the model a compact map with
source anchors and follow-up tools.

Ryngo implication:

Do not frame Ryngo as replacing coding agents. Frame it as the missing
repository map and context compiler that makes agents more reliable.

Sources:

- CrossCodeEval:
  https://arxiv.org/abs/2310.11248
- STALL+:
  https://arxiv.org/abs/2406.10018
- ContextModule:
  https://arxiv.org/abs/2412.08063
- M2RC-Eval:
  https://arxiv.org/abs/2410.21157
- Do Code LLMs Do Static Analysis?:
  https://arxiv.org/abs/2505.12118

## Decision-Complete Ryngo Compiler Model

### Stage 0: Repo Submission And Preflight

Inputs:

- GitHub URL.
- Optional ref.
- Requested mode.
- Node cap.
- Caller surface: web, MCP, ChatGPT widget, Claude/Codex plain endpoint.

Responsibilities:

- Validate GitHub URL.
- Fetch public repo metadata before clone.
- Reject unsupported/private/missing/oversized repos.
- Log accepted and rejected submissions.
- Normalize repo identity and ref.

Outputs:

- `repo_submission` event.
- `accepted=true/false`.
- Reject reason if false.
- Clone plan if accepted.

Quality facts:

- `invalid_url`
- `repo_not_found`
- `repo_too_large`
- `rate_limited`
- `clone_saturated`

### Stage 1: File Inventory

Responsibilities:

- Walk repo.
- Apply ignore rules.
- Detect languages.
- Classify generated/vendor/test/config/docs/source.
- Detect package/build files.
- Record skipped files and reasons.

Outputs:

- File nodes.
- Language summary.
- Build/package metadata.
- Skip diagnostics.

Implementation defaults:

- File nodes are always Tier 0.
- Generated/vendor files are excluded from default graph but counted.
- Config files are included when they define architecture: package manifests,
  Dockerfiles, CI, Terraform, schemas.

### Stage 2: Syntax Extraction

Responsibilities:

- Parse source files.
- Extract definitions, classes, methods, imports, exports, constants, notebook
  cells, decorators/annotations.
- Attach exact source spans.
- Store parser diagnostics.

Outputs:

- Syntax-backed symbol nodes.
- Containment edges.
- Import declarations.
- Export declarations.
- Parse diagnostics.

Implementation defaults:

- Tree-sitter where available.
- Native parser where easier and reliable: Python AST, JSON/YAML/TOML parsers,
  HCL parser, notebook parser.
- No strong semantic claim without source evidence.

### Stage 3: Symbol And Reference Enrichment

Responsibilities:

- Resolve symbols where tools allow.
- Add definition/reference edges.
- Add hover/signature data where available.
- Mark unresolved references.

Potential sources:

- TypeScript compiler API.
- `go list` / `go/packages`.
- LSP/SCIP/LSIF where practical.
- Rust analyzer.
- Java build/LSP tooling.

Outputs:

- Confirmed symbol edges.
- Reference counts.
- External symbol nodes.
- Unresolved diagnostics.

Implementation defaults:

- Confirmed semantic edges override heuristic syntax edges.
- Keep unresolved references as diagnostics, not silent failures.

### Stage 4: Framework Adapter Passes

Responsibilities:

- Lift syntax into product-level concepts.
- Add routes, handlers, models, schemas, jobs, queues, env vars, external APIs,
  tests, infra resources.
- Attach provenance and confidence.

Adapters should cover:

- Express/Next/React.
- FastAPI/Django/Flask.
- Rails.
- Spring.
- GraphQL.
- Prisma/SQLAlchemy/ActiveRecord/JPA.
- Terraform/HCL.
- Docker/Cloud Run/GitHub Actions.

Outputs:

- Framework nodes.
- Semantic edges.
- Adapter diagnostics.
- Confidence-tagged inferred facts.

Implementation defaults:

- Adapters add to shared IR, never sidecar-only output.
- Path conventions are allowed but labeled `framework-inferred`.
- Regex-only facts are labeled `heuristic`.

### Stage 5: Effect Classification

Responsibilities:

- Classify IO/effect boundaries.
- Detect env reads, db reads/writes, network calls, fs access, exec calls,
  message publish/consume, auth/session use.

Outputs:

- Effect badges.
- Effect source/sink nodes.
- Effect edges.
- Risk flags.

Implementation defaults:

- Effect categories should be filterable in UI.
- Unknown effect type is first-class.
- Do not infer sensitive behavior without evidence.

### Stage 6: Importance Scoring

Responsibilities:

- Rank nodes for projection.
- Explain why a node is important.

Signals:

- Public/exported API.
- Route/CLI/job entrypoint.
- Data model or persistence boundary.
- Env/secret interaction.
- High fan-in/fan-out.
- Related tests.
- Central package/file.
- Adapter confidence.
- User annotations/selections.

Outputs:

- Importance score.
- Importance reasons.
- Hotspot list.

Implementation defaults:

- Scores are deterministic.
- Reasons must be visible in inspector.
- Do not score unknown/unsupported files as unimportant solely because they
  failed to parse.

### Stage 7: Projection

Responsibilities:

- Convert full IR into bounded outputs for users and agents.

Artifacts:

- `RyngoViewModel`.
- Topology markdown.
- Compact IR.
- Focused subgraph.
- English signature.
- Quality report.

Projection rules:

- Sort by importance.
- Preserve source anchors.
- Preserve clusters.
- Include truncation metadata.
- Include omitted counts by kind/layer.
- Include suggested drill-downs.
- Keep raw large details out of model-visible content where appropriate.

### Stage 8: Event And Quality Logging

Responsibilities:

- Record usage and compiler quality.
- Tie failures back to actionable improvement areas.

Events:

- Repo submitted.
- Repo rejected.
- Clone started/finished/failed.
- Analyze started/finished/failed.
- Parser diagnostics.
- Adapter diagnostics.
- View model generated.
- MCP tool called.
- User selected node.
- User requested subgraph/signature.

Quality outputs:

- Top weak languages.
- Top diagnostic codes.
- Repos with low source anchor coverage.
- Repos with high truncation.
- Adapter hit/miss rates.
- Token compression by representation.

## Core IR Concepts

### Nodes

Minimum node fields:

- `id`
- `kind`
- `label`
- `path`
- `span`
- `language`
- `layer`
- `description`
- `confidence`
- `provenance`
- `importance`
- `facts`

Node kinds:

- repo
- directory
- file
- package/module
- function
- method
- class/type/interface
- route
- handler/controller
- model/schema/table
- query
- env var
- config
- job/task
- queue/topic
- external package/service
- test
- notebook cell
- synthetic source/sink

### Edges

Minimum edge fields:

- `id`
- `kind`
- `source`
- `target`
- `label`
- `confidence`
- `provenance`
- `weight`

Edge kinds:

- contains
- imports
- exports
- references
- calls
- tests
- route-to-handler
- reads-env
- db-read
- db-write
- fs-read
- fs-write
- network-call
- exec
- publishes
- consumes
- uses-schema
- configures
- generated-by

### Facts

Facts are compact, source-backed statements attached to nodes or edges.

Examples:

- `GET /api/users`
- `reads DATABASE_URL`
- `writes User`
- `called by parse.test.ts`
- `exports default App`
- `uses torch DataLoader`

Fact fields:

- `kind`
- `text`
- `confidence`
- `provenance`
- `relatedNodeIds`
- `suggestedActions`

### Provenance

Every fact should carry evidence:

```json
{
  "path": "src/index.ts",
  "startLine": 42,
  "endLine": 58,
  "startColumn": 0,
  "endColumn": 1,
  "extractor": "tree-sitter-typescript",
  "confidence": "confirmed"
}
```

For inferred convention:

```json
{
  "path": "app/users/page.tsx",
  "startLine": 1,
  "endLine": 120,
  "extractor": "nextjs-adapter",
  "confidence": "framework-inferred",
  "reason": "file path matches Next App Router page convention"
}
```

## Stable IDs

Stable IDs should not depend only on line numbers.

Recommended ID input:

- Repo-relative path.
- Node kind.
- Symbol name.
- Parent symbol path.
- Normalized signature or route/schema name.

Examples:

```text
node:function:src/index.ts:parse(msString)
node:route:app/api/users/route.ts:GET /api/users
node:model:prisma/schema.prisma:User
edge:calls:src/index.ts:parse->src/index.ts:format
```

Rules:

- Use source span as location metadata, not identity.
- Change ID only when the semantic entity changes.
- Keep an ID migration/debug mode later if annotations fail to reattach.

## Confidence Model

Recommended levels:

- `confirmed`: compiler/indexer/language tool resolved it.
- `source-syntax`: extracted directly from syntax, but not semantically typed.
- `framework-inferred`: adapter inferred from convention or framework pattern.
- `heuristic`: weak pattern, useful but uncertain.
- `unknown`: unsupported or not determined.

UI mapping:

- Confirmed: normal.
- Source-syntax: normal with no semantic certainty badge.
- Framework-inferred: dotted/outlined.
- Heuristic: dashed/warning.
- Unknown: muted, explicit.

MCP mapping:

- Include confidence in structured content.
- Suggested drill-downs should prefer confirmed facts.
- Agent prompts should mention when a fact is inferred.

## Language Strategy

### TypeScript / JavaScript

Targets:

- Imports/exports.
- Functions, classes, React components.
- Next.js routes/pages/actions.
- Express routes.
- Package scripts.
- Env reads.
- Tests.

Best sources:

- Tree-sitter for fast syntax and JSX/TSX spans.
- TypeScript compiler API for type/reference enrichment.
- `package.json` for architecture and scripts.

Risks:

- Dynamic imports.
- Barrel exports.
- Framework magic.
- `any` and weak JS typing.

Priority adapters:

- Express.
- Next.js App Router.
- React components.
- Prisma.
- GraphQL.

### Python / Jupyter

Targets:

- Functions/classes.
- FastAPI/Django/Flask routes.
- CLI entrypoints.
- Notebook cells.
- Imports.
- Env reads.
- Database access.
- Tests.

Best sources:

- Python AST for syntax.
- Tree-sitter for robust spans where useful.
- Framework adapters for decorators and conventions.
- Notebook parser for `.ipynb`.

Risks:

- Dynamic imports.
- Monkey patching.
- Decorator-heavy frameworks.
- Notebook hidden state.

Priority adapters:

- FastAPI.
- Django.
- Flask.
- SQLAlchemy.
- PyTorch/Jupyter notebook cell maps.

### Go

Targets:

- Packages.
- Exported functions/types.
- Structs/interfaces.
- HTTP handlers.
- `go.mod`.
- Tests.

Best sources:

- `go list` and `go/packages`.
- Tree-sitter for source spans.

Risks:

- Build tags.
- Generated code.
- Interface dispatch.

Priority:

Go should be one of the next compiler workstreams because `go list` gives
high-quality package/import metadata with relatively low ambiguity.

### Java / Spring

Targets:

- Controllers.
- Services.
- Repositories.
- Entities.
- Annotations.
- Maven/Gradle modules.
- Tests.

Best sources:

- Java parser/tree-sitter.
- Build metadata.
- LSP/SCIP or javac-based tooling where available.
- Spring adapter.

Risks:

- Annotation processors.
- Reflection.
- Dependency injection.
- Multi-module builds.

Priority:

Spring route/entity extraction is a high-value adapter because Java apps often
have strong conventions and annotations.

### Ruby / Rails

Targets:

- Routes.
- Controllers.
- Models.
- Jobs.
- Migrations.
- Gems.
- Tests.

Best sources:

- Ruby parser/tree-sitter.
- Rails convention adapter.
- Route file parser.

Risks:

- Dynamic metaprogramming.
- Weak static type info.
- DSL-heavy code.

Priority:

Rails support should lean on conventions and file structure. Full semantic
resolution is less realistic early.

### Rust

Targets:

- Crates/modules.
- Public functions/types.
- Traits/impls.
- Cargo metadata.
- Tests.

Best sources:

- Rust analyzer / SCIP where practical.
- Cargo metadata.
- Tree-sitter for spans.

Risks:

- Macro expansion.
- Trait dispatch.
- Feature flags.

Priority:

Rust is valuable but should follow Go/Java/Rails unless user demand is high.

### C# / .NET

Targets:

- Projects/solutions.
- Controllers.
- Services.
- Models.
- DI registrations.
- Tests.

Best sources:

- Roslyn/LSP/SCIP where practical.
- `.csproj` and solution files.
- Tree-sitter as fallback.

Risks:

- Multi-project solution complexity.
- Reflection and DI.

Priority:

Good candidate after Java because the ecosystem has strong compiler APIs, but
tooling integration may take more setup.

### Terraform / HCL

Targets:

- Providers.
- Resources.
- Modules.
- Variables.
- Outputs.
- Secrets/stateful resources.

Best sources:

- HCL parser.
- Terraform file conventions.

Risks:

- Variables resolved across files/workspaces.
- Provider-specific semantics.

Priority:

High product value because infra nodes explain deployment and cloud shape, but
should stay separate from executable-code claims.

### GraphQL

Targets:

- Schemas.
- Types.
- Queries/mutations.
- Resolvers.
- Client operations.

Best sources:

- GraphQL parser.
- Framework adapters.
- Resolver naming conventions.

Risks:

- Resolver indirection.
- Generated clients.
- Schema stitching/federation.

Priority:

GraphQL is a strong cross-tier adapter because it links frontend operations to
backend resolvers and data models.

### SQL

Targets:

- Tables.
- Views.
- Migrations.
- Queries.
- ORM model links.

Best sources:

- SQL parser where possible.
- ORM adapters.
- Migration file conventions.

Risks:

- Dialect differences.
- Raw SQL strings embedded in code.
- Dynamic query builders.

Priority:

Start with schema/migration extraction and ORM links before trying full query
analysis.

### Notebooks

Targets:

- Markdown cells.
- Code cells.
- Imports.
- Function/class definitions.
- Data loads.
- Model training/eval steps.
- Outputs where relevant.

Best sources:

- Notebook JSON parser.
- Python AST/tree-sitter for code cells.

Risks:

- Hidden execution order.
- Large outputs.
- Non-reproducible state.

Priority:

Important for research repos and ML examples. Treat notebooks as ordered cells
with explicit caveats.

## Compiler Quality Feedback Loop

The product should learn from every repo submitted.

### Events To Capture

- `repo_submission`
- `repo_rejected`
- `clone_started`
- `clone_finished`
- `clone_failed`
- `analysis_started`
- `analysis_finished`
- `analysis_failed`
- `parser_diagnostic`
- `adapter_diagnostic`
- `view_model_generated`
- `mcp_tool_call`
- `node_selected`
- `subgraph_requested`
- `signature_requested`

### Rejection Reasons

- `invalid_url`
- `repo_not_found`
- `repo_private`
- `repo_too_large`
- `rate_limited`
- `clone_saturated`
- `unsupported_host`
- `clone_failed`

### Quality Metrics

- Source anchor coverage.
- Parser success by language.
- Extracted nodes per KLOC.
- Extracted edges by kind.
- Route/model/env recall on fixtures.
- Adapter hit rate.
- Unsupported file count.
- Weak-language flags.
- Diagnostic codes.
- Truncation rate.
- Token savings by representation.
- Agent follow-up success rate.

### Report Output

`npm run quality:report` should show:

- Top weak languages.
- Top diagnostic codes.
- Worst quality flags.
- Recent repo submissions.
- Rejected repos by reason.
- Repos with low source anchor coverage.
- Repos with high truncation.
- Compiler workstream suggestions.

### How To Use It

If Go repos show many files but low symbol extraction, prioritize `go list`.
If Java repos show routes but weak model links, prioritize Spring/JPA adapter
fixtures. If Python notebooks dominate failures, prioritize notebook/cell
parsing. If token compression looks great but source anchor coverage drops, do
not use the compression number in marketing.

## End-To-End Compiler Examples

These examples are intentionally concrete. They show what the upward compiler
should emit for different repo shapes and where quality signals should appear.

### Example 1: Small TypeScript Utility Library

Repo shape:

- `src/index.ts`
- test files
- `package.json`
- TypeScript config

Expected extraction:

- File nodes for source, tests, config, README/license.
- Function/type nodes for exported API.
- Import edges from tests to source.
- Public/exported flags from `index.ts`.
- Package metadata from `package.json`.
- Test edges from each test file to the exported functions it references.

Expected projection:

- One central source file with exported functions open.
- Tests grouped beneath the source file.
- Config nodes collapsed unless selected.
- Inspector shows that the source file is the central hotspot because it owns
  public exports and has many test references.

Quality signals:

- High source anchor coverage.
- Low truncation.
- Strong confidence for syntax and exports.
- Limited effect edges because pure libraries usually have few runtime effects.

Agent context:

- The default view model should be enough for "explain this repo".
- A focused subgraph around one exported function should be enough for a safe
  change plan.

### Example 2: Mixed Frontend / Backend Web App

Repo shape:

- React/Next frontend.
- API routes or Express backend.
- ORM schema.
- Env config.
- Tests.

Expected extraction:

- Frontend component nodes.
- Route/page nodes.
- Handler/controller nodes.
- Model/schema nodes.
- Env var source nodes.
- Package/config nodes.
- Edges from frontend operations to routes where resolvable.
- Edges from handlers to services/models/database calls.

Expected projection:

- Architecture layout by layer: frontend, backend, data, config, tests,
  external.
- Request-flow mode for selected route.
- Data-flow mode for selected model/env var.

Quality signals:

- Adapter hit/miss counts for Next/Express/ORM.
- Confidence split between confirmed imports/calls and framework-inferred
  route edges.
- Source anchor coverage per layer.

Agent context:

- The agent should not receive the whole app. It should receive a route or
  feature subgraph plus source anchors.
- Follow-up tools should include "show related tests", "show env reads", and
  "show model writes".

### Example 3: Python Research / ML Repo

Repo shape:

- Python scripts.
- Jupyter notebooks.
- data preparation scripts.
- training/eval functions.
- requirements/pyproject.

Expected extraction:

- Script file nodes.
- Function/class nodes.
- Notebook cell nodes.
- Import/package nodes.
- Data load/save effect nodes.
- CLI entrypoint facts where available.
- Training/evaluation function hotspots.

Expected projection:

- Notebook/script cells should be first-class source regions.
- Data preparation, training, and evaluation clusters should be visible.
- Long notebooks should show collapsed sections with cell counts.

Quality signals:

- Notebook hidden-state warning.
- Parser diagnostics for cells that fail.
- Source anchor coverage for notebook cells.
- Effect classification for file/network/model/data writes.

Agent context:

- The agent should receive the relevant script/cell subgraph, not an entire
  notebook dump.
- Prompts should ask about data flow, training loop, eval metrics, and external
  dependencies.

### Example 4: Java / Spring Service

Repo shape:

- Maven/Gradle modules.
- Controllers.
- Services.
- Repositories.
- Entities.
- Tests.

Expected extraction:

- Module/package nodes.
- Controller route nodes from annotations.
- Service class nodes.
- Repository/model/entity nodes.
- Dependency injection relationships where detectable.
- Test edges.

Expected projection:

- Layered backend/data/test view.
- Request-flow from controller method to service to repository/entity.
- Annotation provenance visible in inspector.

Quality signals:

- Strong adapter confidence for annotations.
- Weaker confidence for runtime DI resolution unless enriched by language
  tooling.
- Multi-module build diagnostics.

Agent context:

- The agent should get controller/service/entity slices for endpoint questions.
- It should see which edges are annotation-confirmed and which are DI-inferred.

### Example 5: Terraform / Infra Repo

Repo shape:

- `.tf` modules.
- providers.
- variables.
- resources.
- outputs.

Expected extraction:

- Provider nodes.
- Resource nodes.
- Module nodes.
- Variable and output nodes.
- Edges from modules to resources and variables.
- Cloud resource layer classification.

Expected projection:

- Infrastructure layout rather than code-symbol layout.
- Stateful resources highlighted.
- Secrets/variables and outputs visible.

Quality signals:

- HCL parse success.
- Provider/resource classification coverage.
- Unknown provider/resource diagnostics.

Agent context:

- The agent should receive infra topology and source spans.
- It should not treat Terraform resources as executable code functions.

## Compression And Agent Context

Ryngo's token-efficiency claim must be paired with quality.

Representations to compare:

- Raw source.
- Topology markdown.
- Compact IR.
- View model.
- Focused subgraph.
- English signature.

Metrics:

- Representation tokens.
- Raw token baseline.
- Compression ratio.
- Token savings.
- Source anchor coverage.
- Omitted counts.
- Task success.

Important warning:

A tiny summary with no source anchors is cheap but dangerous. The product claim
should be "fewer tokens while preserving source-backed structure," not merely
"fewer tokens."

## Most Critical Success Factors

1. **Exact source provenance.** Without this, Ryngo becomes another summary
   tool.
2. **Compiler-quality measurement.** Without this, the team will improve what
   feels broken, not what users actually hit.
3. **Framework adapters.** Without this, modern app repos look like generic
   functions and files.
4. **Confidence-aware projection.** Without this, users cannot distinguish
   semantic truth from heuristic guesses.
5. **Agent contract stability.** Without this, Claude/ChatGPT/Codex integrations
   will drift.
6. **Language-specific humility.** Without this, the product will overpromise
   across languages.
7. **Focused subgraphs.** Without this, every large repo becomes a hairball.
8. **Usefulness before completeness.** A partial, honest map with great source
   links beats a complete graph no one can read.

## Near-Term Workstreams

Recommended order:

1. Make spans and provenance first-class across nodes, edges, and facts.
2. Improve the viewer inspector and hover-to-source interactions.
3. Add confidence fields to view model and MCP structured content.
4. Add compiler diagnostics and quality events to the database.
5. Add `go list` enrichment for Go.
6. Add language/framework fixtures for Spring, Rails, GraphQL, notebooks, and
   Terraform.
7. Add focused subgraph quality tests.
8. Add token compression reports by representation and language.
9. Add cacheable compact IR snapshots.
10. Use real submission logs to pick the next adapter.

## Suggested Companion Docs

1. `RepresentationTaxonomy.md` - canonical definitions of node, edge, fact,
   span, confidence, layer, cluster, projection, and source evidence.
2. `RyngoIRPrinciples.md` - invariants for the internal IR and pass pipeline.
3. `SourceAnchoring.md` - exact rules for spans, hover provenance, code
   highlighting, and fallback behavior.
4. `VisualGrammar.md` - UI rules for nodes, colors, badges, edges, expanded
   state, and layout modes.
5. `AgentContextContracts.md` - MCP/view-model/subgraph/signature contracts for
   Claude, Codex, ChatGPT, and the web app.
6. `StableIdStrategy.md` - deterministic IDs, migrations, annotation survival,
   and graph diffing.
7. `CompilerQualityRubric.md` - extraction quality metrics by language and
   adapter.
8. `LanguageAdapterPlaybooks.md` - implementation recipes per language and
   framework.
9. `CorpusSelection.md` - corpus design by language, framework, size, and use
   case.
10. `CompressionAndTokenEconomics.md` - measured token savings, prompt cost,
    and public claim rules.

## Research Sources

### Compiler / Static Analysis Foundations

- Cousot and Cousot, Abstract Interpretation:
  https://cs.nyu.edu/~pcousot/COUSOTpapers/POPL77.shtml
- Ferrante, Ottenstein, Warren, Program Dependence Graph:
  https://bears.ece.ucsb.edu/class/ece253/papers/ferrante87.pdf
- Horwitz, Reps, Binkley, Interprocedural Slicing:
  https://research.cs.wisc.edu/wpis/papers/toplas90.pdf
- Program slicing survey:
  https://www.cerias.purdue.edu/apps/reports_and_papers/view/906
- Cytron et al., SSA:
  https://app.scinito.ai/article/W1982205631
- Sea-of-nodes overview:
  https://en.wikipedia.org/wiki/Sea_of_nodes
- LLVM:
  https://llvm.org/
- MLIR:
  https://mlir.llvm.org/
- TensorFlow MLIR introduction:
  https://blog.tensorflow.org/2019/04/mlir-new-intermediate-representation.html

### Code Intelligence / Extraction

- Tree-sitter:
  https://github.com/tree-sitter/tree-sitter
- LSP announcement:
  https://www.globenewswire.com/press-release/red-hat-codenvy-and-microsoft-collaborate-on-language-server-protocol-2137810.htm
- LSIF:
  https://lsif.dev/
- SCIP:
  https://github.com/sourcegraph/scip
- SCIP announcement:
  https://sourcegraph.com/blog/announcing-scip
- Sourcegraph indexer docs:
  https://sourcegraph.com/docs/code-search/code-navigation/writing_an_indexer
- CodeQL overview:
  https://codeql.github.com/docs/codeql-overview/about-codeql/
- CodeQL Go AST/DFG docs:
  https://codeql.github.com/docs/codeql-language-guides/codeql-library-for-go/
- Semgrep introduction:
  https://semgrep.dev/docs/introduction
- Semgrep rules:
  https://semgrep.dev/docs/writing-rules/overview/

### Agent / LLM Context Research

- CrossCodeEval:
  https://arxiv.org/abs/2310.11248
- STALL+:
  https://arxiv.org/abs/2406.10018
- ContextModule:
  https://arxiv.org/abs/2412.08063
- M2RC-Eval:
  https://arxiv.org/abs/2410.21157
- Do Code LLMs Do Static Analysis?:
  https://arxiv.org/abs/2505.12118
- Microsoft GraphRAG:
  https://www.microsoft.com/en-us/research/project/graphrag/
- Microsoft GraphRAG repository:
  https://github.com/microsoft/graphrag
