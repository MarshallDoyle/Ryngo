# Node Research

Status: expanded research report, 2026-05-10

Purpose: document the lineage, product lessons, and design risks behind
representing software as high-level maps, nodes, graphs, diagrams, notebooks,
and visual systems. This is not a general history of visual programming. It is
a working report for Ryngo: what to copy, what to avoid, and what is most
critical if the product is going to make large codebases easier for humans and
LLM coding agents to understand.

## Read This First

Ryngo's opportunity is not "turn code into a diagram." That idea has existed
for decades, and most attempts become either too shallow to help experts or too
complex to remain readable. Ryngo's opportunity is narrower and stronger:
produce a source-anchored, agent-ready code map that compresses a repository
without breaking trust.

The critical product idea is a three-part contract:

1. Every visible node or fact must link back to exact code where possible.
2. Every relationship must have a typed meaning and confidence level.
3. Every high-level view must be a projection of the same underlying IR that
   agents consume through MCP.

The user should never feel that the graph is a second, fuzzy version of the
repo. The graph should feel like a navigable index over the repo.

## What Ryngo Must Get Right

Ranked by importance:

1. **Source anchoring.** Click any node, edge, or fact and land on the exact
   supporting code span. If a fact is inferred from convention, show that.
2. **Typed relationships.** `imports`, `calls`, `tests`, `defines route`,
   `reads env`, and `writes db` cannot share the same visual language.
3. **Progressive disclosure.** Nodes should be useful open-by-default, but the
   whole canvas must not become a wall of cards.
4. **Stable IDs.** Annotations, diffs, quality events, and agent handoffs need
   deterministic node identity that survives line movement.
5. **Honest uncertainty.** The UI must show confirmed, inferred, heuristic, and
   unknown differently. A useful partial map beats a confident hallucinated map.
6. **Small projection surfaces.** The full internal graph can be rich, but the
   default viewer and MCP response must be compact.
7. **Task-specific layouts.** One graph layout cannot answer every software
   question. Ryngo needs architecture, file-focus, request-flow, data-flow, and
   change-impact modes.
8. **Human/agent parity.** The UI and the MCP server should use the same view
   model so ChatGPT, Claude, Codex, and the web viewer do not drift.

## Implementation Implications

- Default expanded nodes should include title, kind, path, source span, short
  description, top relationship counts, and the most important facts.
- The inspector should be denser than the node: callers, callees, related tests,
  routes, models, env vars, diagnostics, and recommended drill-down prompts.
- Hovering a fact should highlight or preview the supporting source line.
- Clicking an edge should explain the edge type, confidence, endpoints, and
  source evidence.
- Large repos should be truncated explicitly with omitted counts and suggested
  next views, never silently.
- The viewer should let users switch from "architecture map" to "source-local
  map" quickly; deep comprehension usually begins with one file or feature.
- Visual style should help cognition: restrained palette, clear shape grammar,
  no decorative graph noise, no unlabeled edge soup.

## Open Questions And Product Research

- What is the smallest node schema that supports both UI navigation and agent
  reasoning without duplicating fields?
- How much information should be visible in a node before it becomes too large
  for canvas navigation?
- Should Ryngo maintain separate confidence per node, per edge, and per fact,
  or collapse confidence into a single provenance object?
- Which tasks should get first-class layout modes: onboarding, bug fix,
  route tracing, data modeling, security review, test planning, or refactor
  impact?
- How should source anchoring work when framework conventions create a fact
  from a path rather than one line of code?
- What is the right public demo corpus for showing that Ryngo works across
  different repo shapes and languages?

## Chronological Lineage

This section is chronological, but it is not nostalgia. Each entry is evaluated
by how it should influence Ryngo's product decisions.

### 1940s-1960s: Flowcharts And Procedure Diagrams

Flowcharts gave software one of its first common visual languages: boxes for
steps, diamonds for decisions, arrows for flow. They work because they make
sequence and branching visible without requiring the reader to scan syntax.

What they solved:

- They gave programmers and reviewers a shared language for control flow.
- They made local algorithms easier to discuss before code was written.
- They normalized the idea that a program can have a graphical representation.

Where they failed:

- They are weak for large software systems because arrows multiply quickly.
- They usually hide data, ownership, module boundaries, and runtime effects.
- They encourage "flow" as the only axis of understanding.

Ryngo implication:

Use flowchart-like directionality only for task-specific views such as request
flow or data flow. The default architecture map should not pretend that a whole
repo has one clean control-flow path.

What to steal:

- Directional reading.
- Familiar visual semantics for decisions and effects.
- Simple node labels.

What to avoid:

- Generic arrows with no semantic type.
- Whole-repo flowcharts.
- Treating control flow as the same thing as architecture.

### 1963: Sketchpad And Direct Manipulation

Ivan Sutherland's Sketchpad is not a code visualization tool, but it matters
because it showed that complex symbolic systems can be manipulated visually and
constrained interactively. It is a root ancestor of modern graphical editing
and CAD-style direct manipulation.

Ryngo implication:

The viewer should feel directly connected to the code. A user should not simply
read a diagram; they should select, hover, jump, filter, ask, and return. The
interface needs a strong "object under cursor" model:

- Node -> source span.
- Fact -> source evidence.
- Edge -> relationship evidence.
- Cluster -> contained nodes.
- Prompt -> exact selected context.

Critical warning:

Direct manipulation is only trustworthy when the objects have clear identity.
For Ryngo, this means stable node IDs and exact source ranges are not backend
details. They are interaction primitives.

### 1972-1973: Nassi-Shneiderman Diagrams

Nassi-Shneiderman diagrams, described in the 1973 "Flowchart techniques for
structured programming" paper, replaced arbitrary flowchart jumps with nested
blocks for structured programming. They are important because they emphasize
containment and structure rather than arrow chaos.

What they solved:

- They represented structured control constructs clearly.
- They made nesting visible.
- They discouraged arbitrary jumps that break human reasoning.

Where they failed:

- They are better for individual algorithms than for whole systems.
- They still focus on control structure more than semantic relationships.
- They do not naturally represent imports, routes, tests, or data models.

Ryngo implication:

Containment should be a first-class visual relation. Files contain classes,
classes contain methods, notebooks contain cells, packages contain modules,
routes own handlers, and adapters can group related nodes. Containment often
reads better than drawing another edge.

What to steal:

- Nested visual hierarchy.
- Clear top-down decomposition.
- Block-level readability.

What to avoid:

- Forcing everything into nested rectangles.
- Hiding cross-cutting edges like tests, external calls, and data access.

Sources:

- Nassi-Shneiderman history and original paper references:
  https://www.cs.umd.edu/hcil/members/bshneiderman/nsd/
- ResearchGate summary of the 1973 paper:
  https://www.researchgate.net/publication/234805404_Flowchart_techniques_for_structured_programming

### 1970s-1994: Flow-Based Programming

J. Paul Morrison's Flow-Based Programming (FBP) describes applications as
networks of asynchronous processes communicating via information packets.
Morrison's book framed applications as component networks with externally
defined connections.

What it solved:

- It separated component internals from component wiring.
- It treated data movement as a first-class design concern.
- It made component boundaries explicit.

Where it failed or stayed niche:

- General-purpose software does not always decompose into clean packet flows.
- Visual flow systems can become difficult to search, diff, and version.
- A visual network can hide the actual code that does the work.

Ryngo implication:

FBP is one of the strongest ancestors for Ryngo's high-level node idea, but
Ryngo should invert its ambition. Ryngo should not ask users to program in the
graph. It should extract a graph from the code and keep the code primary.

What to steal:

- Nodes with explicit inputs and outputs.
- Relationship-oriented thinking.
- Subnetworks and grouping.

What to avoid:

- Making the graph the source of truth before the read-only map is excellent.
- Letting dataflow edges imply more static certainty than the analyzer has.

Source:

- Morrison, Flow-Based Programming:
  https://jpaulmorrison.com/fbp/fbp2.htm

### 1980s: DRAKON And Review-Oriented Visual Algorithms

DRAKON is a visual algorithmic language associated with the Soviet Buran space
program. Whether or not Ryngo copies any DRAKON notation, the lesson is useful:
visual systems for serious software need a strict, reviewable grammar.

What it solved:

- It optimized diagrams for human review.
- It reduced ambiguity by constraining the notation.
- It treated visual clarity as an engineering property, not decoration.

Where it is limited for Ryngo:

- It is procedural and algorithm-oriented.
- It is less relevant to dependency maps, framework conventions, and agent
  context.

Ryngo implication:

The node viewer should have a small visual language. If every adapter invents a
new node color, badge, edge shape, or tooltip pattern, the viewer will become
unlearnable.

What to steal:

- Visual grammar discipline.
- Unambiguous reading order.
- Bias toward review.

What to avoid:

- A full custom diagramming language before the product has user evidence.

### 1986: LabVIEW

LabVIEW made graphical dataflow programming practical for laboratory,
instrumentation, and control systems. It works especially well because its
domain has natural signals, wires, measurements, and device boundaries.

What it solved:

- It matched visual dataflow to a domain where dataflow is the task.
- It made hardware/software integration more approachable.
- It let users build systems by wiring functional blocks.

Where it fails as a general model:

- Large diagrams can become hard to search and refactor.
- The visual representation can be less compact than text.
- It works best when the domain's data shapes are well known.

Ryngo implication:

Dataflow should be a special view, not the default view. When Ryngo knows a
route receives a request, calls a service, writes a model, and returns JSON,
dataflow is valuable. When it only sees dynamic code with weak type info,
showing dataflow as solid wires is misleading.

What to steal:

- Strong visual distinction between data and execution.
- Domain-specific node affordances.
- Inspectable block boundaries.

What to avoid:

- Huge unstructured canvases.
- Treating visual dataflow as always clearer than text.

Sources:

- LabVIEW history:
  https://labviewwiki.org/wiki/History_of_LabVIEW
- NI/LabVIEW overview references:
  https://www.ni.com/en/shop/labview.html

### 1990: Simulink And Executable Models

Simulink made block diagrams a serious engineering environment for dynamic
systems and model-based design. The important distinction is that Simulink
models are executable artifacts, not merely documentation.

What it solved:

- It made models executable and analyzable.
- It tied visual blocks to simulation, code generation, and test workflows.
- It made domain-level abstractions concrete.

Where it differs from Ryngo:

- Simulink's diagram can be the source artifact.
- Ryngo's first product should not replace source code.
- Simulink succeeds in a constrained domain; repositories are more varied.

Ryngo implication:

Ryngo should learn from the "multi-level model" idea, not the whole model-based
development workflow. The IR can have multiple layers, but source code remains
the authority.

What to steal:

- Layered model hierarchy.
- Block metadata and typed ports.
- Simulation-like task views for paths or flows.

What to avoid:

- Building a parallel editing environment too early.
- Letting diagrams drift from code.

Sources:

- MathWorks history mentions Simulink's 1990 release:
  https://www.mathworks.com/company/technical-articles/the-growth-of-matlab-and-the-mathworks-over-two-decades.html
- Simulink model concepts:
  https://ch.mathworks.com/help/simulink/slref/simulink-concepts-models.html

### 1990s-2000s: UML And Enterprise Modeling

UML standardized many diagram types: class, sequence, activity, state,
component, deployment, and more. Its success and its fatigue are both relevant.

What it solved:

- It gave teams a shared vocabulary for object-oriented design.
- It separated diagram types by question.
- It made relationships like inheritance and composition visible.

Where it failed:

- It became heavy, process-bound, and often disconnected from code.
- Many diagrams were made once and then stale.
- It encouraged model completeness over practical usefulness.

Ryngo implication:

Ryngo should have multiple views, like UML, but should not ask users to maintain
diagrams manually. Views should be generated from code, source-anchored, and
bounded to useful questions.

What to steal:

- Multiple diagram types for different questions.
- Relationship vocabulary.
- Sequence/interaction view concepts for request paths.

What to avoid:

- Manual modeling burden.
- Giant comprehensive diagrams.
- Visual notation that requires training before payoff.

Source:

- OMG UML specification archive:
  https://www.omg.org/spec/UML/1.5/

### 1990s-2000s: IDE Code Browsers, Call Hierarchies, And Reverse Engineering

Before agent-era code maps, IDEs already exposed symbol trees, go-to-definition,
find references, call hierarchy, type hierarchy, and dependency views. Tools
like Rigi, Understand, Doxygen, Sourcegraph, and Sourcetrail show that code
navigation is a mature domain.

What they solved:

- They made precise symbol navigation fast.
- They exposed references and call relationships.
- They connected graph views with code panes.

Where they often fell short:

- They were developer tools, not explanation tools.
- They usually had weak product narrative for "what matters in this repo."
- Many graphs were precise but visually hard to interpret at architecture
  scale.

Ryngo implication:

Go-to-definition is not a differentiator; it is table stakes. Ryngo's advantage
must be converting deterministic code intelligence into compact, meaningful
agent/human context.

What to steal:

- Split graph/code view.
- Precise symbol and reference navigation.
- Search-first interaction.

What to avoid:

- Raw dependency graph dumps.
- Tooling that is powerful only after users already know what they seek.

Sources:

- Sourcetrail overview:
  https://en.wikipedia.org/wiki/Sourcetrail
- Sourcegraph SCIP / precise code intelligence:
  https://sourcegraph.com/blog/announcing-scip
  https://github.com/sourcegraph/scip

### 2001-2003: Software Visualization And Program Comprehension Surveys

Software visualization research has long emphasized that comprehension is not
just graph drawing. The Koschke survey and related work focus on maintenance,
reverse engineering, and reengineering: the exact setting where users need to
understand code they did not just write.

What the research tells Ryngo:

- Visualization is useful when it is tied to a specific comprehension task.
- Automatic graph layout is a persistent weakness.
- Users need interaction between views and source, not isolated pictures.
- Abstraction level determines success: a tool that helps one task may fail at
  general comprehension.

Ryngo implication:

The viewer should be explicitly task-shaped. "Show architecture" and "show why
this route writes this table" are different products. A single overview canvas
can be the entrance, but not the whole experience.

What to steal:

- Evaluation against comprehension tasks.
- Multiple coordinated views.
- Emphasis on maintenance and reverse engineering, not just greenfield design.

What to avoid:

- Measuring success by whether the graph looks impressive.
- Overinvesting in automatic layout without source-linked interaction.

Sources:

- Koschke, software visualization survey:
  https://researchr.org/publication/Koschke03
- ResearchGate full-text metadata for the survey:
  https://www.researchgate.net/publication/258762162_Software_Visualization_in_Software_Maintenance_Reverse_Engineering_and_Reengineering_A_Research_Survey
- Program comprehension / reverse engineering survey:
  https://arxiv.org/abs/cs/0503068

### 2007: Scratch And Blocks As Cognitive Scaffolding

Scratch is not a code comprehension tool, but it is a major proof that visual
programming can reduce syntax burden and make behavior approachable.

What it solved:

- It removed syntax errors as an early blocker.
- It made action/event blocks discoverable.
- It made remixing and learning social.

Where it does not transfer:

- Scratch is designed for creation by beginners, not comprehension of existing
  production repositories.
- Blocks work because the language is constrained.
- Large professional codebases have too many concepts for a simple block set.

Ryngo implication:

Ryngo should borrow approachability, not infantilize code. Nodes can be readable
and friendly while still representing exact source-backed facts.

What to steal:

- Recognizable categories.
- Low-friction exploration.
- Visual affordances for events, actions, and data.

What to avoid:

- Replacing code with blocks.
- Oversimplifying expert workflows.

Source:

- MIT News Scratch launch, 2007:
  https://news.mit.edu/2007/resnick-scratch

### 2012: Blockly And Visual Grammar As A Library

Blockly is a library for building block-based visual programming environments.
Its lesson for Ryngo is architectural: visual languages need reusable primitives
and clear grammar.

What it solved:

- It made block editors reusable.
- It supported code generation to multiple languages.
- It showed how visual shape can encode syntax constraints.

Where it differs:

- Blockly usually generates code from blocks.
- Ryngo should generate nodes from code.

Ryngo implication:

The viewer should have reusable node primitives and a strict design system:
function nodes, class/type nodes, route nodes, data nodes, config nodes,
external nodes, test nodes, and source-backed fact rows.

What to steal:

- Reusable visual components.
- Shape/category consistency.
- Constraint-driven visual grammar.

What to avoid:

- Making visual construction the first product surface.

Sources:

- Neil Fraser, Blockly history:
  https://neil.fraser.name/software/Blockly-History/
- Blockly block language paper:
  https://developers.google.com/static/blockly/publications/papers/TipsForCreatingABlockLanguage.pdf

### 2013: Node-RED And Browser-Native Flow Editing

Node-RED is a browser-based flow editor for wiring devices, APIs, and services.
It is one of the closest product precedents for a web graph surface.

What it solved:

- It made service and event wiring approachable.
- It made deployable flows inspectable in the browser.
- It created an ecosystem of reusable nodes.

Where it can struggle:

- Large flows become hard to scan without grouping.
- Flow nodes can hide too much behavior inside function nodes.
- Visual structure can look clean while runtime semantics remain complex.

Ryngo implication:

Ryngo should make grouping, search, and inspector detail central from day one.
The product should not rely on panning a beautiful canvas as the main
comprehension mechanism.

What to steal:

- Browser-native graph interaction.
- Palette-like mental model for node kinds.
- Grouping and subflows.

What to avoid:

- Giant canvases where meaning depends on zoom and pan.
- Function-like nodes that hide source details.

Source:

- Node-RED about:
  https://nodered.org/about/

### 2014: Code Property Graphs

The Code Property Graph (CPG) merged abstract syntax trees, control-flow
graphs, and program dependence graphs into a property graph for vulnerability
discovery. It is one of the strongest technical precedents for Ryngo's internal
model.

What it solved:

- It unified multiple code representations.
- It made code queryable as a graph.
- It enabled cross-cutting analysis such as vulnerability patterns.

Where it is not enough by itself:

- Raw property graphs are too dense for normal users.
- Security queries are not the same as product-level code comprehension.
- Graph databases do not automatically create good UI or agent context.

Ryngo implication:

Ryngo should probably think "property graph internally, compact projections
externally." The viewer should not expose every AST/control/data edge. It
should expose the subset relevant to the user's question.

What to steal:

- Multi-representation graph.
- Queryability.
- Source-backed properties on nodes and edges.

What to avoid:

- Treating the internal graph as the UI.
- Exposing graph database complexity to users or agents.

Source:

- Code Property Graph paper summary:
  https://colab.ws/articles/10.1109/SP.2014.44

### 2014+: Jupyter And Notebook-Style Program Comprehension

Jupyter notebooks bundle code, prose, output, and execution context. More
recent work like Slicito applies notebook interactivity to program
comprehension.

What notebooks solved:

- They combined explanation and executable code.
- They made stepwise analysis natural.
- They encouraged narrative around computations.

Where notebooks fail:

- Execution order can drift from visible order.
- Hidden state harms reproducibility.
- Long notebooks become hard to navigate.

Ryngo implication:

Notebooks show that explanation belongs beside code, not in a separate static
document. Ryngo annotations and generated explanations should be graph overlays
with source anchors. For `.ipynb` repos, cells should become source-backed
nodes with markdown/code/output awareness.

What to steal:

- Narrative plus executable/source context.
- Expand/collapse sections.
- Cell-level anchors.

What to avoid:

- Hidden state.
- Long unstructured scrolls.
- Generated explanation that cannot be traced to source.

Sources:

- Slicito program comprehension notebook paper:
  https://d3s.mff.cuni.cz/publications/husak_slicito_2023/
- Notebook sensemaking research:
  https://arxiv.org/abs/2312.11431

### 2014+: Unreal Blueprints And Production Visual Scripting

Unreal Blueprints show that node-based visual scripting can be production-useful
when deeply integrated with a domain. Designers can inspect and author gameplay
logic with events, data pins, and execution wires.

What it solved:

- It exposed engine behavior to non-C++ users.
- It supported rapid prototyping and domain scripting.
- It gave nodes clear execution/data roles.

Where it can struggle:

- Large graphs become difficult to refactor.
- Visual density can hide logic.
- Documentation and naming matter intensely.

Ryngo implication:

Blueprints are a warning and an inspiration. Ryngo should use separate visual
channels for control, data, and effects, but it should not make users visually
wire arbitrary repo logic in v1.

What to steal:

- Separate execution and data semantics.
- Dense inspector panels.
- Domain-specific node types.

What to avoid:

- Editable graph complexity before read-only comprehension is excellent.

Source:

- Epic Blueprint Visual Scripting docs:
  https://dev.epicgames.com/documentation/unreal-engine/blueprint-visual-scripting

### 2016+: LSP, LSIF, SCIP, And Persistent Code Intelligence

Language Server Protocol made language intelligence available across editors.
LSIF and SCIP made code intelligence indexable and reusable outside a live
language server. These systems are directly relevant because Ryngo needs exact
source spans, definitions, references, and symbol metadata.

What they solved:

- Common protocol for definitions, references, hovers, diagnostics.
- Persistent code intelligence for code browsers.
- Language-agnostic indexing formats.

Where they stop:

- They are navigation formats, not product-level architecture maps.
- They do not know framework intent unless indexers/adapters add it.
- They do not decide what matters most in a repo.

Ryngo implication:

LSP/SCIP should be enrichment sources, not the entire product. Ryngo can use
them for precision, then layer framework adapters and product projections on
top.

What to steal:

- Exact ranges.
- Symbol identity.
- Definition/reference semantics.
- Diagnostics.

What to avoid:

- Returning raw symbol/reference dumps to agents.
- Assuming language intelligence equals architecture comprehension.

Sources:

- LSP announcement:
  https://www.globenewswire.com/press-release/red-hat-codenvy-and-microsoft-collaborate-on-language-server-protocol-2137810.htm
- LSIF overview:
  https://lsif.dev/
- SCIP repository:
  https://github.com/sourcegraph/scip

### 2018+: Tree-Sitter And Incremental Syntax

Tree-sitter is a parser generator and incremental parsing library. It is fast,
language-flexible, and designed for editor-like scenarios.

What it solved:

- Fast syntax trees across many languages.
- Useful parses even during editing or syntax errors.
- Query-based extraction of syntax patterns.

Where it is limited:

- Syntax is not semantic resolution.
- Tree-sitter alone cannot reliably answer "what does this call target?"
- Dynamic languages and framework conventions still need adapters.

Ryngo implication:

Tree-sitter is an excellent Tier B parser and source-range backbone. It should
not be oversold as full code understanding.

What to steal:

- Broad syntax coverage.
- Exact ranges.
- Query system.

What to avoid:

- Treating syntactic extraction as semantic certainty.

Source:

- Tree-sitter repository:
  https://github.com/tree-sitter/tree-sitter

### 2020s: GraphRAG And Agent-Oriented Knowledge Graphs

GraphRAG uses graph structures and community summaries to improve retrieval
over large text datasets. For Ryngo, the useful lesson is not "use GraphRAG"
as a buzzword. The useful lesson is that relationship structure can improve
multi-hop reasoning if the graph is clean, typed, and measured.

What it solved:

- It attacks questions that require connecting multiple entities.
- It uses graph communities to summarize large corpora.
- It makes retrieval less purely chunk-similarity-based.

Where it can fail:

- LLM-extracted edges can be noisy.
- Graph construction can be expensive and hard to update.
- Graphs still have to be serialized into useful context.

Ryngo implication:

Ryngo has an advantage over generic GraphRAG because code offers deterministic
relationships: imports, symbols, routes, schemas, calls, tests. The graph should
be built by static analysis first, with LLMs consuming it rather than inventing
it.

What to steal:

- Community/cluster summaries.
- Multi-hop retrieval.
- Graph-first context for agents.

What to avoid:

- LLM-guessed code edges.
- Graph hype without evaluation.

Sources:

- Microsoft GraphRAG project:
  https://www.microsoft.com/en-us/research/project/graphrag/
- Microsoft GraphRAG repository:
  https://github.com/microsoft/graphrag

### 2023+: Repository-Level LLM Coding Context

Recent repository-level code completion research keeps repeating the same
message: local file context is not enough. Cross-file relationships matter, and
static analysis can help retrieve the right context.

What this research suggests:

- Agents need repository structure, not only nearest text chunks.
- Static analysis can identify cross-file dependencies that retrieval may miss.
- Benchmarks increasingly test cross-file and multilingual understanding.

Ryngo implication:

Ryngo's graph is not only a UI. It is an agent context router. The map should
help decide which files, symbols, routes, tests, and diagnostics to pass to a
model for a given task.

What to steal:

- Static-analysis-aware retrieval.
- Cross-file context benchmarks.
- Evaluation by task success, not only graph completeness.

What to avoid:

- Assuming a longer context window solves repo understanding.
- Feeding agents huge raw graphs without projection.

Sources:

- CrossCodeEval:
  https://arxiv.org/abs/2310.11248
- STALL+ static analysis for repository-level code completion:
  https://arxiv.org/abs/2406.10018
- ContextModule repository-level context:
  https://arxiv.org/abs/2412.08063
- M2RC-Eval multilingual repository completion:
  https://arxiv.org/abs/2410.21157

## Representation Families

### Structural Maps

Structural maps answer "what exists?" They include file trees, package maps,
symbol outlines, class hierarchies, module dependency diagrams, and API
surface inventories.

Ryngo should use them for:

- Initial repo overview.
- File/package ownership.
- Public API surfaces.
- Framework-defined boundaries.

Key product rules:

- Structural nodes should show source path and line span.
- Containers should be visually distinct from executable symbols.
- The default architecture view should cluster by meaningful ownership, not
  arbitrary directory depth.
- Generated/vendor/test/config classification should be visible because it
  changes interpretation.

Failure mode:

A structural map can make a repo look organized while hiding runtime behavior.
For example, a clean folder tree may still have global env reads, dynamic
imports, or untested data writes.

### Dependency Maps

Dependency maps answer "what points to what?" They include import graphs, call
graphs, test coverage graphs, package dependencies, and reference maps.

Ryngo should use them for:

- Change impact.
- Test targeting.
- Identifying hot files and high fan-in utilities.
- Explaining why a file matters.

Key product rules:

- Edge kind must be visible and filterable.
- Confidence must be visible.
- Edge density must be managed with grouping and summaries.
- Edge clicks must explain evidence.

Failure mode:

Most dependency graphs become unreadable when every edge is drawn. Ryngo should
summarize relationships on nodes and draw only the edges relevant to the active
view or selection.

### Behavioral Flow Maps

Behavioral maps answer "what happens?" They include request flows, data flows,
event/job flows, sequence diagrams, and pipeline graphs.

Ryngo should use them for:

- Route to handler to service to database.
- CLI command to action to output.
- Job producer to queue to consumer.
- Notebook cell dataflow.

Key product rules:

- Use only when the analyzer has enough evidence.
- Show framework-inferred paths differently than confirmed calls.
- Prefer narrow task views over whole-repo behavior.

Failure mode:

Behavioral maps are easy to overclaim. Static analysis may see a possible call
without knowing whether it happens at runtime. The UI must show confidence.

### Semantic Property Graphs

Semantic property graphs answer "what facts and relationships can be queried?"
They are best internal representations for combining syntax, control, data,
framework, and effect facts.

Ryngo should use them for:

- Internal IR.
- Querying source-backed facts.
- Building focused subgraphs.
- Recording compiler-quality diagnostics.

Key product rules:

- The property graph is not the UI.
- Projection is a first-class product layer.
- Query results should be compact and source-backed.

Failure mode:

A graph database does not automatically create understanding. Without view
models, summaries, and source anchors, it becomes infrastructure.

### Narrative Maps

Narrative maps answer "why is the system this way?" They include notebooks,
architecture decision records, generated repo summaries, onboarding docs, and
agent context packs.

Ryngo should use them for:

- Agent handoffs.
- Human onboarding.
- Explaining clusters and hotspots.
- Capturing annotations.

Key product rules:

- Narrative must cite nodes and source spans.
- Generated summaries should never become an ungrounded parallel truth.
- Notes should attach to graph entities and survive stable IDs.

Failure mode:

Narrative drift. Once prose stops being linked to exact code, users stop
trusting it.

## Agent Workflow Examples

These examples translate the research into concrete Ryngo usage patterns. They
are useful because the product has two audiences at once: a human trying to
understand a repo and an agent trying to choose the next useful tool call.

### Workflow 1: First Repo Triage

User action:

- Paste a public GitHub URL.

Ryngo response:

- Show a bounded architecture map.
- Open the most important file/function/route/model nodes by default.
- Show language mix, node counts, edge counts, truncation, and weak-language
  warnings.
- In the inspector, show "why these nodes matter" rather than a generic repo
  summary.

Agent context:

- `get_view_model` should return the same high-level map.
- The suggested prompts should include "explain this repo", "show high-risk
  files", "show routes and persistence", and "show unsupported/weak areas".

Critical success:

The user should know within 30 seconds whether Ryngo found real structure or
only a file tree. This is where source anchor coverage matters.

### Workflow 2: One File Deep Dive

User action:

- Click a file node.

Ryngo response:

- Switch or zoom into file-focus layout.
- Put imports on the left, definitions on the right, tests below, and external
  effects in a small side cluster.
- Highlight the matching source region.
- Expand functions/classes by default if the file is not too large.

Agent context:

- The agent should call `get_subgraph(fileNodeId)` or equivalent.
- The returned context should include file-local definitions, related imports,
  related tests, and top effects, not the entire repo.

Critical success:

This workflow should beat opening the file in a plain editor because it shows
relationships immediately.

### Workflow 3: Route / Request Flow

User action:

- Search for `/api/users` or click a route node.

Ryngo response:

- Show route -> handler -> service -> model/database/external edges.
- Show request/response facts where known.
- Mark adapter-inferred edges differently from confirmed calls.
- Let the user jump to the route declaration, handler body, model definition,
  and tests.

Agent context:

- The agent should receive a small request-flow subgraph plus source spans.
- Follow-up prompts should include "explain validation", "show persistence",
  "show auth/session boundary", and "show tests".

Critical success:

The user should not need to grep the repo for the route string after seeing the
map. If they do, the map failed.

### Workflow 4: Change Impact

User action:

- Select a function, class, model, or config node and ask "what breaks if I
  change this?"

Ryngo response:

- Show callers, callees, tests, routes, models, and external effects.
- Highlight direct versus indirect relationships.
- Show unresolved or heuristic edges separately.
- Suggest specific tests and files to inspect.

Agent context:

- The agent should receive a focused impact subgraph and source spans.
- It should not receive every file in the repo.

Critical success:

The output must be honest about uncertainty. A wrong "nothing depends on this"
is worse than "I found these confirmed dependents and these unresolved
references."

### Workflow 5: Compiler Quality Review

User action:

- Ask why the map looks thin or why a repo compiled poorly.

Ryngo response:

- Show weak-language flags, parser diagnostics, skipped files, adapter misses,
  source anchor coverage, and truncation reasons.
- Link each problem to a source file or repo-level cause where possible.

Agent context:

- The agent should call a quality-report tool rather than guessing from the
  visible graph.

Critical success:

This turns failure into product learning. A thin graph should produce a clear
next compiler workstream.

## Critical Node Viewer Report

This section is intentionally blunt. The viewer is the product surface where
the research becomes real.

### Current Risk: The Canvas Can Look Like A Toy Before It Becomes A Tool

If nodes are just colored boxes with names, users may initially be impressed
but quickly ask: "What do I do with this?" A real code map must answer
questions:

- What is this node?
- Why did Ryngo choose to show it?
- Where is the supporting code?
- What calls it?
- What does it call?
- What data or external resources does it touch?
- What tests protect it?
- What should I ask the agent next?

The node should expose enough of this by default that a screenshot is useful.
The inspector should expose the rest.

### Default-Expanded Nodes

Default expanded state should include:

- Kind icon or label.
- Name.
- Path.
- Source span.
- One-sentence role.
- Importance reason.
- Relationship counts by type.
- Top 1-3 facts.
- Confidence badge if not fully confirmed.

Collapsed state should still preserve:

- Kind.
- Name.
- Path or owner.
- Source line.
- Warning badge if confidence is low or diagnostics exist.

Do not make users click every node just to find out what it is.

### Inspector Density

The inspector should be the "serious work" area. It should show:

- Summary.
- Source location.
- Incoming edges by kind.
- Outgoing edges by kind.
- Related tests.
- Related routes/models/env vars.
- Diagnostics.
- Adapter/extractor provenance.
- Suggested MCP/tool calls.
- "Ask about this" prompts.

The inspector should be scrollable and dense. The graph should stay readable.

### Source Anchoring And Hover Provenance

Every node fact should be hoverable when evidence exists:

- Hover "reads DATABASE_URL" -> highlight the exact line.
- Hover "route GET /users" -> highlight route declaration.
- Hover "writes User" -> highlight ORM call or schema relationship.
- Hover "tested by parse.test.ts" -> highlight relevant test or reference.

Click behavior:

- Click node -> jump to start line and highlight full span.
- Click fact -> jump to evidence span.
- Click edge -> show relationship evidence and endpoints.
- Double-click node -> focused subgraph around node.

Fallback:

- If evidence is inferred from file path convention, show "inferred from path"
  and highlight the file path/owning file, not a fake line.

### Edge Readability

Edges must carry semantic information:

- Color: category.
- Style: confidence.
- Label: short kind/value.
- Width: optional heat/frequency, off by default.
- Direction: meaningful only when relationship is directional.

Default edge visibility should be conservative:

- Show selected-node edges.
- Show key architecture edges.
- Summarize the rest as counts.

Edge kinds should include at least:

- `contains`
- `imports`
- `exports`
- `calls`
- `tests`
- `route-to-handler`
- `reads-env`
- `db-read`
- `db-write`
- `external-call`
- `configures`
- `generates`
- `uses-schema`

### Layout Modes

Required v1 layout modes:

1. **Architecture.** Cluster by layer: frontend, backend, data, config, tests,
   docs, external.
2. **File focus.** One file center, imports left, definitions right, tests and
   related routes below.
3. **Change impact.** Selected node center, callers/dependents/tests around it.
4. **Request flow.** Route/client trigger -> handler -> service -> data/external.
5. **Agent context.** Smallest graph that should be sent to a model for the
   selected question.

Do not rely on one force-directed graph for all tasks. It will fail.

### Truncation

Truncation is part of the product contract. Users and agents need to know what
was omitted.

Display:

- Max node cap.
- Omitted node count by kind/layer.
- Omitted edge count by kind.
- Reason: size cap, low importance, hidden filter, unsupported language.
- Suggested drill-downs.

MCP should return this too. A model should know when it is seeing a projection.

### Confidence

Confidence should be visible but not noisy:

- Confirmed: normal.
- Framework inferred: subtle dotted/outlined mark.
- Heuristic: warning tint or dashed relation.
- Unknown/partial: explicit badge or inspector note.

Do not hide uncertainty in the docs or in `_meta`. It changes user trust.

## Product Priorities

### Priority 1: Source-Linked Trust

The first time a user clicks a node and lands on the exact line, the product
becomes credible. The first time a node fact has no evidence, the product loses
credibility. Source-linked trust is the core moat.

Concrete requirements:

- Every node has `path` and span when source-backed.
- Every fact has provenance.
- Every inferred fact has a reason.
- Every missing span is treated as a quality gap.

### Priority 2: Useful Defaults

Users should not need to configure the graph before it helps.

Concrete requirements:

- Default architecture view with important nodes open.
- Selected-node inspector populated immediately.
- Search visible.
- Filters obvious.
- Suggested questions present.

### Priority 3: Agent-Compatible Context

The graph is not only for humans. It is a context object for agents.

Concrete requirements:

- Same view model for web and MCP.
- Stable JSON schema.
- Compact summaries.
- Focused subgraph calls.
- English signature calls.
- Truncation metadata.

### Priority 4: Measured Compression

The token-efficiency story matters only if quality remains high.

Concrete requirements:

- Measure raw tokens vs topology/view model/subgraph/signature.
- Measure source anchor coverage.
- Measure extracted nodes/edges per language.
- Report weak language flags.

### Priority 5: Adapter Coverage

Modern apps are framework-shaped. Syntax extraction alone will miss routes,
models, jobs, env vars, and infra.

Concrete requirements:

- Framework adapters add facts to shared IR.
- Adapter facts carry provenance and confidence.
- Corpus includes framework fixtures.

## Suggested Product Metrics

- Time from repo URL to first useful map.
- Percentage of visible nodes with exact source spans.
- Percentage of visible facts with provenance.
- User click-through from node to code.
- Agent follow-up tool-call success.
- Token savings by representation.
- Extraction quality by language/framework.
- Truncation rate by repo size.
- Unsupported file count by language.
- Diagnostic count by extractor.
- Return rate after first repo analysis.

## What To Avoid

- A graph that looks polished but cannot answer "why is this node here?"
- LLM-generated summaries with no source evidence.
- Untyped edges.
- One giant layout for every task.
- Overusing colors before edge semantics are stable.
- Hiding omitted nodes.
- Making users inspect node-by-node to understand the repo.
- Treating graph editing as v1 scope.
- Assuming tree-sitter alone means code understanding.
- Assuming a code graph alone means agent success.

## Research Sources

### Visual / Node-Based Systems

- J. Paul Morrison, Flow-Based Programming:
  https://jpaulmorrison.com/fbp/fbp2.htm
- Node-RED about:
  https://nodered.org/about/
- MIT News, Scratch launch:
  https://news.mit.edu/2007/resnick-scratch
- Blockly history:
  https://neil.fraser.name/software/Blockly-History/
- Blockly block language paper:
  https://developers.google.com/static/blockly/publications/papers/TipsForCreatingABlockLanguage.pdf
- LabVIEW history:
  https://labviewwiki.org/wiki/History_of_LabVIEW
- MathWorks MATLAB/Simulink history:
  https://www.mathworks.com/company/technical-articles/the-growth-of-matlab-and-the-mathworks-over-two-decades.html
- Simulink model concepts:
  https://ch.mathworks.com/help/simulink/slref/simulink-concepts-models.html
- OMG UML specification archive:
  https://www.omg.org/spec/UML/1.5/
- Epic Blueprint Visual Scripting:
  https://dev.epicgames.com/documentation/unreal-engine/blueprint-visual-scripting

### Software Visualization / Program Comprehension

- Koschke, software visualization survey:
  https://researchr.org/publication/Koschke03
- ResearchGate metadata/full text for Koschke survey:
  https://www.researchgate.net/publication/258762162_Software_Visualization_in_Software_Maintenance_Reverse_Engineering_and_Reengineering_A_Research_Survey
- Survey of reverse engineering and program comprehension:
  https://arxiv.org/abs/cs/0503068
- Slicito notebook-based program comprehension:
  https://d3s.mff.cuni.cz/publications/husak_slicito_2023/
- Notebook sensemaking:
  https://arxiv.org/abs/2312.11431

### Code Intelligence / Agent Context

- Code Property Graph paper summary:
  https://colab.ws/articles/10.1109/SP.2014.44
- Tree-sitter:
  https://github.com/tree-sitter/tree-sitter
- LSP announcement:
  https://www.globenewswire.com/press-release/red-hat-codenvy-and-microsoft-collaborate-on-language-server-protocol-2137810.htm
- LSIF overview:
  https://lsif.dev/
- SCIP:
  https://github.com/sourcegraph/scip
- Microsoft GraphRAG:
  https://www.microsoft.com/en-us/research/project/graphrag/
- CrossCodeEval:
  https://arxiv.org/abs/2310.11248
- STALL+:
  https://arxiv.org/abs/2406.10018
- ContextModule:
  https://arxiv.org/abs/2412.08063
- M2RC-Eval:
  https://arxiv.org/abs/2410.21157
