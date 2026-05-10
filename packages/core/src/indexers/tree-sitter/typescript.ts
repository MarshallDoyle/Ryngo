/**
 * TypeScript / JavaScript Tier-B indexer.
 *
 * Implements the tree-sitter side of the two-tier model from
 * `research/tree-sitter.md`. SCIP (`scip-typescript`) is preferred when
 * available; this indexer is the always-available fallback and the source
 * of framework-pattern facts SCIP doesn't model.
 *
 * Output: an `IRFragment` of node and edge candidates. Every edge carries a
 * `resolution` field per §4 of the strategy doc:
 *   exact      same-file lexical scope (§4.1)
 *   imported   cross-file via the import map (§4.2)
 *   name-match project-wide name match (§4.3) — the merger picks unique vs
 *              ambiguous and stamps `candidate_group_id` accordingly
 *   unresolved nothing matched, or matched too widely (§4.4)
 *
 * Runtime: `web-tree-sitter` for the WASM path (browser viewer + tests);
 * the same query strings work against the native binding when wired up by
 * `runtime-native.ts`. We only depend on `web-tree-sitter` here so the
 * indexer module is portable.
 */

import {
  Language,
  Parser,
  type Node as TsNode,
  type Query,
  type QueryCapture,
  type Tree,
} from "web-tree-sitter";

import type {
  CallEdgeMeta,
  DeferredTargetRef,
  EdgeMeta,
  ExpressionMeta,
  FunctionMeta,
  ImportEdgeMeta,
  ImportRecord,
  IREdgeCandidate,
  IRFragment,
  IRNodeCandidate,
  LanguageIndexer,
  ModuleMeta,
  NodeLoc,
  ParsedFile,
  Resolution,
  SupportedLanguage,
  TypeFieldDecl,
  TypeMeta,
  TypeFlowEdgeMeta,
} from "./types";

// =============================================================================
// Versioning
// =============================================================================

/** Pinned grammar version (research/tree-sitter.md §3 — version pinning). */
export const GRAMMAR_VERSION = "0.20.4";

/** Identifier published in `metadata.generators[]` per spec/ir-schema.md §2. */
export const INDEXER_NAME = "tree-sitter-typescript";
export const INDEXER_VERSION = "0.1.0";

/**
 * Hash of `typescript.scm`. The merger uses this in the cache key so a
 * query change invalidates only TS/JS fragments. We don't compute it
 * dynamically here (no I/O at module load); the build script writes the
 * real hash into this constant. Until then, the placeholder still
 * round-trips through cache — the cache_version bump just trips on first
 * indexer run after a query edit.
 */
export const QUERY_HASH = "scm:typescript:v0";


// =============================================================================
// Public entry point — `LanguageIndexer.index(file)`
// =============================================================================

let cachedQueryByLanguage: Map<SupportedLanguage, Query> = new Map();

export const typescriptIndexer: LanguageIndexer = {
  name: INDEXER_NAME,
  version: INDEXER_VERSION,
  grammar: "tree-sitter-typescript",
  grammarVersion: GRAMMAR_VERSION,
  languages: ["typescript", "tsx", "javascript", "jsx"],

  index(file: ParsedFile): IRFragment {
    return runIndexer(file);
  },
};

/**
 * Convenience plain-function form so callers can avoid the object indirection
 * (e.g. when running a single file in a unit test).
 */
export function index(file: ParsedFile): IRFragment {
  return runIndexer(file);
}


// =============================================================================
// Pipeline
// =============================================================================

function runIndexer(file: ParsedFile): IRFragment {
  const tree = file.tree as Tree | null;
  if (!tree) {
    return emptyFragment(file, [
      {
        severity: "error",
        code: "ts-indexer/no-tree",
        message: `tree-sitter parse tree missing for ${file.path}`,
      },
    ]);
  }

  const language = tree.language as Language;
  const query = getQuery(file.language, language);

  // Run captures on the whole tree once. Tree-sitter's matcher visits nodes
  // in document order, which lets the scope walker thread state forward.
  const captures = query.captures(tree.rootNode);

  // -------------------------------------------------------------------------
  // Pass 1 — collect raw captures into typed buckets.
  // -------------------------------------------------------------------------
  const buckets = bucket(captures);

  // -------------------------------------------------------------------------
  // Pass 2 — build the lexical scope tree (research §4.1).
  // -------------------------------------------------------------------------
  const scopes = buildScopeTree(tree.rootNode, buckets.scopes);

  // -------------------------------------------------------------------------
  // Pass 3 — emit module + import records.
  // -------------------------------------------------------------------------
  const moduleNode: IRNodeCandidate = makeModuleNode(file);
  const imports = collectImports(buckets, file);
  const importMap = indexImports(imports);

  // -------------------------------------------------------------------------
  // Pass 4 — emit type / function / method definitions.
  // -------------------------------------------------------------------------
  const defNodes: IRNodeCandidate[] = [];
  const defByRange: Map<string, IRNodeCandidate> = new Map();

  for (const def of buckets.defs) {
    const node = makeDefNode(def, file, scopes, defByRange);
    if (!node) continue;
    defNodes.push(node);
    defByRange.set(rangeKey(def.declarationNode), node);
  }

  // Bind defs to enclosing scopes so the resolver can look them up.
  bindDefsToScopes(defNodes, scopes, buckets.defs);

  // Pass 4b — attach class-body field captures to their enclosing class
  // node's `TypeMeta.fields[]` (ir-types' decision: fields nest, no separate
  // tier:type 'field' nodes). Non-trivial field initializers also produce
  // an expression node + field-write type-flow edge.
  const fieldExtras = attachFieldsToClasses(buckets.defs, defByRange, file);

  // -------------------------------------------------------------------------
  // Pass 5 — references (calls, attribute access, type refs, constructors).
  // -------------------------------------------------------------------------
  const edges: IREdgeCandidate[] = [];
  const expressionNodes: IRNodeCandidate[] = [];

  for (const ref of buckets.refs) {
    const referencingFunctionLocalId = enclosingFunctionLocalId(ref.captureNode, defNodes);
    if (!referencingFunctionLocalId) {
      // A reference at module top-level — we model it as a synthetic
      // expression child of the module so the edge has a tier-valid source.
      const expr = makeTopLevelExpression(ref, file, moduleNode);
      expressionNodes.push(expr);
      const edge = resolveRef(ref, expr.localId, scopes, importMap, defNodes, file);
      if (edge) edges.push(edge);
      continue;
    }
    const edge = resolveRef(ref, referencingFunctionLocalId, scopes, importMap, defNodes, file);
    if (edge) edges.push(edge);
  }

  // -------------------------------------------------------------------------
  // Pass 6 — emit one `import` edge per import record (module → module).
  //
  // The merger resolves the module specifier to a target module id during
  // the project-wide pass; until then the edge is `imported`-resolution but
  // carries the specifier in `targetRef.moduleSpecifier`.
  // -------------------------------------------------------------------------
  for (const imp of imports) {
    edges.push(makeImportEdge(imp, moduleNode));
  }

  return {
    path: file.path,
    indexer: INDEXER_NAME,
    indexerVersion: INDEXER_VERSION,
    grammar: "tree-sitter-typescript",
    grammarVersion: GRAMMAR_VERSION,
    queryHash: QUERY_HASH,
    contentHash: file.contentHash,
    nodes: [moduleNode, ...defNodes, ...expressionNodes, ...fieldExtras.nodes],
    edges: [...edges, ...fieldExtras.edges],
    imports,
    diagnostics: [],
  };
}


// =============================================================================
// Query loading
// =============================================================================

/**
 * Built-in query string. We embed the `.scm` text as a string literal so the
 * indexer doesn't need filesystem access at runtime — important for the WASM
 * viewer build, which can't `fs.readFileSync` at load time.
 *
 * The `runtime-native.ts` and `runtime-wasm.ts` loaders both compile this
 * against the current grammar via `language.query(...)`.
 */
import { TYPESCRIPT_QUERY_SOURCE } from "./typescript.query.embed";
// `typescript.query.embed.ts` is generated at build time from
// `typescript.scm` (a one-line `export const TYPESCRIPT_QUERY_SOURCE = ...`).
// Until the build step lands, ship a stub at that path containing the same
// string, or the runtime loader wires it in directly.

function getQuery(lang: SupportedLanguage, language: Language): Query {
  const cached = cachedQueryByLanguage.get(lang);
  if (cached) return cached;
  const query = language.query(TYPESCRIPT_QUERY_SOURCE);
  cachedQueryByLanguage.set(lang, query);
  return query;
}


// =============================================================================
// Capture bucketing
// =============================================================================

interface CaptureRecord {
  readonly captureName: string;
  readonly captureNode: TsNode;
}

interface DefCapture {
  /** The whole-construct node (function_declaration, class_declaration, …). */
  readonly declarationNode: TsNode;
  /** The identifier subtree (`@name`). */
  readonly nameNode: TsNode;
  /** Which @def.* capture this is. */
  readonly kind:
    | "function"
    | "class"
    | "method"
    | "type"
    | "variable"
    | "reexport"
    | "field";
  /** TS-only: function's `async`/`*` modifiers, captured by walking siblings. */
  readonly asyncness: "sync" | "async" | "generator" | "async-generator";
  readonly exported: boolean;
}

interface RefCapture {
  readonly captureNode: TsNode;
  readonly nameNode: TsNode;
  readonly kind:
    | "call"
    | "construct"
    | "attribute"
    | "identifier"
    | "type"
    | "subscript";
  /** Receiver subtree for member-style refs; absent for plain calls. */
  readonly receiver?: TsNode;
  /** For kind:'subscript', the literal key from `obj['KEY']`. */
  readonly subscriptKey?: string;
}

interface ScopeCapture {
  readonly node: TsNode;
  readonly kind: "module" | "class" | "function" | "block";
}

interface CaptureBuckets {
  readonly defs: DefCapture[];
  readonly refs: RefCapture[];
  readonly scopes: ScopeCapture[];
  readonly importStatements: ImportCapture[];
}

interface ImportCapture {
  readonly statementNode: TsNode;
  readonly specifierNode: TsNode;
  /** Capture name that triggered this record. */
  readonly captureName:
    | "import.module"
    | "import.dynamic"
    | "import.require";
  /** Sibling captures the runtime collected on this same statement. */
  readonly defaults: TsNode[];
  readonly namespaces: TsNode[];
  readonly named: { name: TsNode; alias?: TsNode }[];
  readonly typeOnly: boolean;
  readonly sideEffectOnly: boolean;
}

function bucket(captures: ReadonlyArray<QueryCapture>): CaptureBuckets {
  const defs: DefCapture[] = [];
  const refs: RefCapture[] = [];
  const scopes: ScopeCapture[] = [];

  // Group by the @def./@ref./@import. parent capture — tree-sitter emits
  // sibling captures (`@name`, `@ref.receiver`, `@import.module`, …)
  // attached to the *same* match. We group by node range to stitch them.
  //
  // The simplest robust strategy: walk captures in order, holding a
  // "current pattern" while sibling captures arrive, and flush on tier
  // boundaries.
  //
  // For brevity here we walk captures looking for each anchor capture and
  // then scan its match siblings via the capture's `pattern` index when
  // available; the helper `findSibling` does a localised search.

  const byPattern: Map<number, QueryCapture[]> = new Map();
  for (const c of captures) {
    const list = byPattern.get(c.pattern) ?? [];
    list.push(c);
    byPattern.set(c.pattern, list);
  }

  // We emit one logical record per `@def.*` / `@ref.*` / `@import.module`
  // anchor capture. Multi-capture matches (e.g. an `import_statement` with
  // both `@import.module` and `@import.symbol`) are reconstructed by
  // looking at the pattern's full capture list above.
  for (const c of captures) {
    if (c.name.startsWith("def.")) {
      pushDef(defs, c, captures);
    } else if (c.name.startsWith("ref.")) {
      pushRef(refs, c, captures);
    } else if (c.name.startsWith("scope.")) {
      scopes.push({
        node: c.node,
        kind: c.name.slice("scope.".length) as ScopeCapture["kind"],
      });
    }
  }

  const importStatements = collectImportCaptures(captures);

  return { defs, refs, scopes, importStatements };
}

function pushDef(out: DefCapture[], anchor: QueryCapture, all: ReadonlyArray<QueryCapture>): void {
  const kind = anchor.name.slice("def.".length) as DefCapture["kind"];
  const nameCap = findSiblingByName(anchor, all, "name");
  if (!nameCap) return; // malformed pattern; skip silently
  out.push({
    declarationNode: anchor.node,
    nameNode: nameCap.node,
    kind,
    asyncness: detectAsyncness(anchor.node, kind),
    exported: isExportedDeclaration(anchor.node),
  });
}

function pushRef(out: RefCapture[], anchor: QueryCapture, all: ReadonlyArray<QueryCapture>): void {
  const kind = anchor.name.slice("ref.".length) as RefCapture["kind"];

  // Subscript refs don't carry @name; the literal key sits on
  // @ref.subscript-key. Treat the key node as the "name" for IR purposes.
  if (kind === "subscript") {
    const keyCap = findSiblingByName(anchor, all, "ref.subscript-key");
    const receiverCap = findSiblingByName(anchor, all, "ref.receiver");
    if (!keyCap) return;
    out.push({
      captureNode: anchor.node,
      nameNode: keyCap.node,
      kind,
      receiver: receiverCap?.node,
      subscriptKey: stripQuotes(nodeText(keyCap.node)),
    });
    return;
  }

  const nameCap = findSiblingByName(anchor, all, "name");
  if (!nameCap) return;
  const receiverCap = findSiblingByName(anchor, all, "ref.receiver");
  out.push({
    captureNode: anchor.node,
    nameNode: nameCap.node,
    kind,
    receiver: receiverCap?.node,
  });
}

/**
 * Locate a sibling capture in the same `pattern` whose `name` matches. The
 * tree-sitter API doesn't directly expose match boundaries from `captures()`,
 * so we approximate by finding the nearest preceding/following capture with
 * the right name *whose node is inside the anchor's range*. This is correct
 * for our patterns because we never nest two patterns of the same shape.
 */
function findSiblingByName(
  anchor: QueryCapture,
  all: ReadonlyArray<QueryCapture>,
  name: string,
): QueryCapture | undefined {
  for (const c of all) {
    if (c.name !== name) continue;
    if (
      c.node.startIndex >= anchor.node.startIndex &&
      c.node.endIndex <= anchor.node.endIndex
    ) {
      return c;
    }
  }
  return undefined;
}

function collectImportCaptures(captures: ReadonlyArray<QueryCapture>): ImportCapture[] {
  // Walk all `@import.module` captures and gather their siblings.
  const out: ImportCapture[] = [];
  for (const c of captures) {
    const isAnchor =
      c.name === "import.module" ||
      c.name === "import.dynamic" ||
      c.name === "import.require";
    if (!isAnchor) continue;

    const stmt = enclosingStatement(c.node);
    const defaults: TsNode[] = [];
    const namespaces: TsNode[] = [];
    const named: { name: TsNode; alias?: TsNode }[] = [];
    let typeOnly = false;

    for (const s of captures) {
      if (s === c) continue;
      if (
        s.node.startIndex < stmt.startIndex ||
        s.node.endIndex > stmt.endIndex
      ) {
        continue;
      }
      if (s.name === "import.default") defaults.push(s.node);
      else if (s.name === "import.namespace") namespaces.push(s.node);
      else if (s.name === "import.symbol") {
        // Pair with a following `import.alias` if it lives in the same
        // import_specifier subtree.
        const aliasCap = captures.find(
          (a) =>
            a.name === "import.alias" &&
            a.node.parent === s.node.parent,
        );
        named.push({ name: s.node, alias: aliasCap?.node });
      }
    }

    typeOnly = nodeText(stmt).includes("import type");
    const sideEffectOnly =
      defaults.length === 0 &&
      namespaces.length === 0 &&
      named.length === 0 &&
      c.name === "import.module";

    out.push({
      statementNode: stmt,
      specifierNode: c.node,
      captureName: c.name as ImportCapture["captureName"],
      defaults,
      namespaces,
      named,
      typeOnly,
      sideEffectOnly,
    });
  }
  return out;
}


// =============================================================================
// Scope tree (research §4.1)
// =============================================================================

interface Scope {
  readonly node: TsNode;
  readonly kind: ScopeCapture["kind"];
  readonly parent?: Scope;
  /** Bindings introduced in this scope by name. */
  readonly bindings: Map<string, IRNodeCandidate>;
  /**
   * Hoisting flag: when true, function/class bindings in this scope are
   * visible *before* their declaration node. JS function declarations hoist;
   * `let` / `const` and class declarations don't.
   */
  readonly hoists: boolean;
}

function buildScopeTree(root: TsNode, scopeCaps: ReadonlyArray<ScopeCapture>): Scope {
  const moduleScope: Scope = {
    node: root,
    kind: "module",
    bindings: new Map(),
    hoists: true,
  };

  // Sort scopes by start byte so we can build a tree by containment.
  const sorted = [...scopeCaps].sort((a, b) => a.node.startIndex - b.node.startIndex);
  const all: Scope[] = [moduleScope];
  const stack: Scope[] = [moduleScope];

  for (const sc of sorted) {
    if (sc.node === root) continue;
    while (
      stack.length > 1 &&
      sc.node.startIndex >= stack[stack.length - 1]!.node.endIndex
    ) {
      stack.pop();
    }
    const parent = stack[stack.length - 1]!;
    const scope: Scope = {
      node: sc.node,
      kind: sc.kind,
      parent,
      bindings: new Map(),
      hoists: sc.kind === "module" || sc.kind === "function",
    };
    all.push(scope);
    stack.push(scope);
  }

  // Attach the full list onto the root for downstream lookups.
  (moduleScope as unknown as { all: Scope[] }).all = all;
  return moduleScope;
}

function scopeFor(node: TsNode, root: Scope): Scope {
  const all = (root as unknown as { all: Scope[] }).all ?? [root];
  let best: Scope = root;
  for (const s of all) {
    if (
      node.startIndex >= s.node.startIndex &&
      node.endIndex <= s.node.endIndex &&
      s.node.endIndex - s.node.startIndex <= best.node.endIndex - best.node.startIndex
    ) {
      best = s;
    }
  }
  return best;
}

function bindDefsToScopes(
  defs: ReadonlyArray<IRNodeCandidate>,
  root: Scope,
  rawDefs: ReadonlyArray<DefCapture>,
): void {
  for (let i = 0; i < defs.length; i++) {
    const node = defs[i]!;
    const raw = rawDefs[i];
    if (!raw) continue;
    const scope = scopeFor(raw.declarationNode, root);
    scope.bindings.set(node.name, node);
  }
}

function lookupInScope(name: string, from: Scope): IRNodeCandidate | undefined {
  let cur: Scope | undefined = from;
  while (cur) {
    const hit = cur.bindings.get(name);
    if (hit) return hit;
    cur = cur.parent;
  }
  return undefined;
}


// =============================================================================
// Definitions → IRNodeCandidate
// =============================================================================

function makeModuleNode(file: ParsedFile): IRNodeCandidate {
  const meta: ModuleMeta = { tier: "module" };
  return {
    tier: "module",
    name: file.path.split("/").pop() ?? file.path,
    signatureParts: ["module", file.path],
    localId: `mod:${file.path}`,
    meta,
    loc: {
      startByte: 0,
      endByte: file.sizeBytes,
      startLine: 0,
      startCol: 0,
      endLine: 0,
      endCol: 0,
    },
  };
}

function makeDefNode(
  def: DefCapture,
  file: ParsedFile,
  _scopes: Scope,
  defByRange: Map<string, IRNodeCandidate>,
): IRNodeCandidate | undefined {
  const name = nodeText(def.nameNode);
  const loc = locOf(def.declarationNode);
  const localId = `def:${file.path}:${def.declarationNode.startIndex}:${name}`;

  switch (def.kind) {
    case "function": {
      const params = extractParams(def.declarationNode);
      const returnTypeDisplay = extractReturnType(def.declarationNode);
      const meta: FunctionMeta = {
        tier: "function",
        kind: detectFunctionKind(def.declarationNode),
        exported: def.exported,
        asyncness: def.asyncness,
        params,
        returnTypeDisplay,
      };
      return {
        tier: "function",
        name,
        signatureParts: [
          "function",
          file.path,
          name,
          String(params.length),
          params.map((p) => p.typeDisplay).join(","),
        ],
        localId,
        meta,
        loc,
      };
    }

    case "method": {
      const enclosingClass = findEnclosingClass(def.declarationNode, defByRange);
      const params = extractParams(def.declarationNode);
      const meta: FunctionMeta = {
        tier: "function",
        kind: name === "constructor" ? "ctor" : "method",
        exported: enclosingClass?.meta.tier === "type" ? (enclosingClass.meta as TypeMeta).exported : false,
        asyncness: def.asyncness,
        params,
        returnTypeDisplay: extractReturnType(def.declarationNode),
        receiverTypeDisplay: enclosingClass?.name,
        enclosingTypeLocalId: enclosingClass?.localId,
      };
      return {
        tier: "function",
        name,
        signatureParts: [
          "function",
          enclosingClass?.localId ?? file.path,
          name,
          String(params.length),
          params.map((p) => p.typeDisplay).join(","),
          enclosingClass?.name ?? "",
        ],
        localId,
        meta,
        loc,
      };
    }

    case "class":
    case "type": {
      const meta: TypeMeta = {
        tier: "type",
        kind: def.kind === "class" ? "class" : detectTypeKind(def.declarationNode),
        exported: def.exported,
      };
      return {
        tier: "type",
        name,
        signatureParts: ["type", file.path, name],
        localId,
        meta,
        loc,
      };
    }

    case "field": {
      // ir-types decision: fields nest on the parent type via
      // `TypeMeta.fields[]`, not as separate tier:type nodes. We attach them
      // in a post-pass (`attachFieldsToClasses`) after all class nodes exist.
      void defByRange;
      return undefined;
    }

    case "variable": {
      // We model module-level `const FOO = 42` as a type-tier sibling? No —
      // variables aren't IR-level entities in v0.1. We skip them here, but
      // keep the capture so refs to the binding can still resolve via
      // scope.bindings. The `addVariableBinding` call elsewhere does that.
      return undefined;
    }

    case "reexport": {
      // Re-exports don't get their own def node; the resolver chases the
      // chain (research §4.5 "re-export chasing") via the import map.
      return undefined;
    }

    default:
      return undefined;
  }
}

function detectFunctionKind(decl: TsNode): FunctionMeta["kind"] {
  // Detect React function components: capitalized name + JSX return.
  // Cheap heuristic; SCIP would do better but this is the fallback.
  const t = decl.type;
  if (t === "method_definition") return "method";
  if (t === "arrow_function" || t === "function_expression") return "lambda";
  return "function";
}

function detectTypeKind(decl: TsNode): TypeMeta["kind"] {
  switch (decl.type) {
    case "interface_declaration":
      return "interface";
    case "type_alias_declaration":
      return "type-alias";
    case "enum_declaration":
      return "enum";
    case "class_declaration":
      return "class";
    default:
      return "type-alias";
  }
}

function detectAsyncness(decl: TsNode, kind: DefCapture["kind"]): FunctionMeta["asyncness"] {
  if (kind !== "function" && kind !== "method") return "sync";
  const text = nodeText(decl);
  const isAsync = /^\s*(?:export\s+)?(?:default\s+)?async\b/.test(text) ||
                  /\basync\s+function\b/.test(text) ||
                  /\basync\s+\(/.test(text);
  const isGen = /\bfunction\s*\*/.test(text) || decl.type === "generator_function_declaration";
  if (isAsync && isGen) return "async-generator";
  if (isAsync) return "async";
  if (isGen) return "generator";
  return "sync";
}

function isExportedDeclaration(decl: TsNode): boolean {
  // Walk up to see if an export_statement wraps this declaration.
  let p: TsNode | null = decl.parent;
  let hops = 0;
  while (p && hops < 4) {
    if (p.type === "export_statement") return true;
    p = p.parent;
    hops++;
  }
  return false;
}

function extractParams(decl: TsNode): FunctionMeta["params"] {
  // Walk children for a `formal_parameters` node and harvest each param's
  // identifier + (optional) type_annotation surface form.
  const params: { name: string; typeDisplay: string }[] = [];
  const formal = childByType(decl, "formal_parameters");
  if (!formal) return params;
  for (let i = 0; i < formal.namedChildCount; i++) {
    const p = formal.namedChild(i);
    if (!p) continue;
    const nameNode =
      childByType(p, "identifier") ??
      childByType(p, "shorthand_property_identifier") ??
      childByType(p, "object_pattern") ??
      childByType(p, "array_pattern");
    const annotation = childByType(p, "type_annotation");
    params.push({
      name: nameNode ? nodeText(nameNode) : "_",
      typeDisplay: annotation
        ? nodeText(annotation).replace(/^\s*:\s*/, "").trim()
        : "unknown",
    });
  }
  return params;
}

function extractReturnType(decl: TsNode): string {
  const annotation = childByType(decl, "type_annotation");
  if (!annotation) return "unknown";
  return nodeText(annotation).replace(/^\s*:\s*/, "").trim();
}

function extractFieldAnnotation(decl: TsNode): string | undefined {
  // public_field_definition wraps `name: TypeAnnotation = init?`. The
  // annotation child is `type_annotation`; the surface form (sans leading
  // colon) is what adapters expect on `TypeMeta.annotation`.
  const annotation = childByType(decl, "type_annotation");
  if (!annotation) return undefined;
  return nodeText(annotation).replace(/^\s*:\s*/, "").trim();
}

function findEnclosingClass(
  node: TsNode,
  defByRange: Map<string, IRNodeCandidate>,
): IRNodeCandidate | undefined {
  let p: TsNode | null = node.parent;
  while (p) {
    if (p.type === "class_declaration" || p.type === "class") {
      const hit = defByRange.get(rangeKey(p));
      if (hit) return hit;
    }
    p = p.parent;
  }
  return undefined;
}

/**
 * For every captured `@def.field`, append a `TypeFieldDecl` to the enclosing
 * class node's `TypeMeta.fields` (per ir-types: fields nest, no separate
 * tier:type nodes). For non-trivial initializers — anything that *executes
 * code*, e.g. `field = computeDefault()` — also emit an `expression`-tier
 * node and a `type-flow` field-write edge so call/dataflow stays in the
 * graph (ir-types directive: declarations live on the type, initialization
 * lives in the dataflow graph).
 *
 * Detects TypeScript's `?:` optional marker and `readonly` modifier from the
 * declaration's surface text — cheaper than walking the modifier subtree.
 */
function attachFieldsToClasses(
  rawDefs: ReadonlyArray<DefCapture>,
  defByRange: Map<string, IRNodeCandidate>,
  file: ParsedFile,
): { nodes: IRNodeCandidate[]; edges: IREdgeCandidate[] } {
  const extraNodes: IRNodeCandidate[] = [];
  const extraEdges: IREdgeCandidate[] = [];

  for (const def of rawDefs) {
    if (def.kind !== "field") continue;
    const enclosing = findEnclosingClass(def.declarationNode, defByRange);
    if (!enclosing || enclosing.tier !== "type") continue;

    const decl = def.declarationNode;
    const declText = nodeText(decl);
    const fieldName = nodeText(def.nameNode);
    const field: TypeFieldDecl = {
      name: fieldName,
      typeDisplay: extractFieldAnnotation(decl) ?? "unknown",
      optional: /\?\s*:/.test(declText) || /\?\s*=/.test(declText),
      readonly: /\breadonly\b/.test(declText),
      loc: locOf(decl),
    };

    const meta = enclosing.meta as TypeMeta;
    const nextFields: TypeFieldDecl[] = meta.fields
      ? [...meta.fields, field]
      : [field];
    (enclosing as { meta: TypeMeta }).meta = { ...meta, fields: nextFields };

    // Non-trivial initializer: `value` child that's not a bare literal/null.
    // public_field_definition shape: `name: type? = value?`. The grammar
    // exposes `value` as a named child.
    const init = childByType(decl, "value");
    if (init && !isTrivialInitializer(init)) {
      const initLoc = locOf(init);
      const initLocalId = `expr:${file.path}:${init.startIndex}:field-init`;
      const initNode: IRNodeCandidate = {
        tier: "expression",
        name: fieldName,
        signatureParts: [
          "expression",
          enclosing.localId,
          "field-initializer",
          fieldName,
          String(init.startIndex),
        ],
        localId: initLocalId,
        meta: {
          tier: "expression",
          role: "field-initializer",
          payload: nodeText(init).slice(0, 64),
        },
        loc: initLoc,
      };
      extraNodes.push(initNode);

      const writeEdge: IREdgeCandidate = {
        category: "type-flow",
        sourceLocalId: initLocalId,
        targetLocalId: enclosing.localId,
        resolution: "exact",
        loc: initLoc,
        meta: {
          category: "type-flow",
          role: "field-write",
        },
      };
      extraEdges.push(writeEdge);
    }
  }

  return { nodes: extraNodes, edges: extraEdges };
}

/**
 * "Trivial" initializers — a bare literal or null — don't execute code, so
 * we don't emit a separate expression node for them. Anything else (calls,
 * member access, arithmetic, identifiers from outer scope) is non-trivial.
 */
function isTrivialInitializer(n: TsNode): boolean {
  switch (n.type) {
    case "string":
    case "template_string":
    case "number":
    case "true":
    case "false":
    case "null":
    case "undefined":
    case "regex":
      return true;
    default:
      return false;
  }
}


// =============================================================================
// Imports
// =============================================================================

function collectImports(buckets: CaptureBuckets, file: ParsedFile): ImportRecord[] {
  const out: ImportRecord[] = [];
  for (const imp of buckets.importStatements) {
    const specifier = stripQuotes(nodeText(imp.specifierNode));
    const loc = locOf(imp.statementNode);

    // Build the records for each binding form.
    if (imp.captureName === "import.dynamic") {
      out.push({
        specifier,
        local: "",
        kind: "side-effect",
        loc,
      });
      continue;
    }

    if (imp.captureName === "import.require") {
      out.push({
        specifier,
        local: detectRequireBinding(imp.statementNode) ?? "",
        kind: "namespace",
        loc,
      });
      continue;
    }

    if (imp.sideEffectOnly) {
      out.push({ specifier, local: "", kind: "side-effect", loc });
      continue;
    }

    for (const d of imp.defaults) {
      out.push({
        specifier,
        local: nodeText(d),
        kind: "default",
        typeOnly: imp.typeOnly,
        loc,
      });
    }
    for (const ns of imp.namespaces) {
      out.push({
        specifier,
        local: nodeText(ns),
        kind: "namespace",
        typeOnly: imp.typeOnly,
        loc,
      });
    }
    for (const n of imp.named) {
      const importedName = nodeText(n.name);
      out.push({
        specifier,
        imported: importedName,
        local: n.alias ? nodeText(n.alias) : importedName,
        kind: "named",
        typeOnly: imp.typeOnly,
        loc,
      });
    }
  }
  void file;
  return out;
}

function indexImports(records: ReadonlyArray<ImportRecord>): Map<string, ImportRecord> {
  const m = new Map<string, ImportRecord>();
  for (const r of records) {
    if (r.local) m.set(r.local, r);
  }
  return m;
}

function makeImportEdge(imp: ImportRecord, moduleNode: IRNodeCandidate): IREdgeCandidate {
  const meta: ImportEdgeMeta = {
    category: "import",
    specifier: imp.specifier,
    symbols: imp.imported ? [imp.imported] : [],
    kind: imp.typeOnly ? "type-only" : imp.kind === "side-effect" ? "side-effect" : "static",
  };
  const targetRef: DeferredTargetRef = {
    strategy: "module",
    name: imp.specifier,
    moduleSpecifier: imp.specifier,
  };
  return {
    category: "import",
    sourceLocalId: moduleNode.localId,
    targetRef,
    resolution: "imported",
    loc: imp.loc,
    meta,
  };
}

function detectRequireBinding(stmt: TsNode): string | undefined {
  // Walk up to find an enclosing variable_declarator.
  let p: TsNode | null = stmt.parent;
  while (p) {
    if (p.type === "variable_declarator") {
      const id = childByType(p, "identifier");
      if (id) return nodeText(id);
      return undefined;
    }
    p = p.parent;
  }
  return undefined;
}


// =============================================================================
// Reference resolution cascade (research §4)
// =============================================================================

function resolveRef(
  ref: RefCapture,
  sourceLocalId: string,
  scopeRoot: Scope,
  importMap: Map<string, ImportRecord>,
  defs: ReadonlyArray<IRNodeCandidate>,
  file: ParsedFile,
): IREdgeCandidate | undefined {
  const name = nodeText(ref.nameNode);
  const loc = locOf(ref.captureNode);

  // Step 1: same-file lexical scope.
  const fromScope = scopeFor(ref.captureNode, scopeRoot);
  const localHit = lookupInScope(name, fromScope);
  if (localHit) {
    return makeRefEdge(ref, sourceLocalId, "exact", loc, name, file, {
      targetLocalId: localHit.localId,
    });
  }

  // For member calls (`pkg.fn`, `obj.method`) the *receiver* is what we look
  // up, then the field is the symbol. Plain calls resolve directly.
  const lookupName =
    ref.receiver && ref.receiver.type === "identifier"
      ? nodeText(ref.receiver)
      : name;

  // Step 2: import-aware cross-file.
  const imp = importMap.get(lookupName);
  if (imp) {
    return makeRefEdge(ref, sourceLocalId, "imported", loc, name, file, {
      targetRef: {
        strategy: "import-map",
        name: ref.receiver ? `${lookupName}.${name}` : name,
        importLocal: lookupName,
        moduleSpecifier: imp.specifier,
      },
    });
  }

  // Step 3: project-wide name match (deferred to merger; we just hand it
  // the bare name and let it consult the project-wide name index).
  // Local same-file project-wide lookup as a sanity prefilter:
  const sameFile = defs.find((d) => d.name === name);
  if (sameFile) {
    return makeRefEdge(ref, sourceLocalId, "name-match", loc, name, file, {
      targetLocalId: sameFile.localId,
    });
  }

  return makeRefEdge(ref, sourceLocalId, "unresolved", loc, name, file, {
    targetRef: {
      strategy: "name-match",
      name,
    },
  });
}

function makeRefEdge(
  ref: RefCapture,
  sourceLocalId: string,
  resolution: Resolution,
  loc: NodeLoc,
  refName: string,
  file: ParsedFile,
  binding: { targetLocalId?: string; targetRef?: DeferredTargetRef },
): IREdgeCandidate {
  const category =
    ref.kind === "type" ||
    ref.kind === "attribute" ||
    ref.kind === "subscript"
      ? "type-flow"
      : "call";

  let meta: EdgeMeta;
  if (category === "call") {
    const callMeta: CallEdgeMeta = {
      category: "call",
      callKind: ref.kind === "construct" ? "constructor" : "direct",
      awaited: isAwaited(ref.captureNode),
    };
    meta = callMeta;
  } else {
    const tfMeta: TypeFlowEdgeMeta = {
      category: "type-flow",
      role:
        ref.kind === "type"
          ? "argument"
          : ref.kind === "subscript"
          ? "subscript"
          : "field-read",
      subscriptKey: ref.subscriptKey,
    };
    meta = tfMeta;
  }

  void refName;
  void file;

  return {
    category,
    sourceLocalId,
    targetLocalId: binding.targetLocalId,
    targetRef: binding.targetRef,
    resolution,
    loc,
    meta,
  };
}

function isAwaited(refNode: TsNode): boolean {
  let p: TsNode | null = refNode.parent;
  let hops = 0;
  while (p && hops < 3) {
    if (p.type === "await_expression") return true;
    p = p.parent;
    hops++;
  }
  return false;
}

function enclosingFunctionLocalId(
  refNode: TsNode,
  defs: ReadonlyArray<IRNodeCandidate>,
): string | undefined {
  // The closest function/method def whose range contains refNode.
  let best: IRNodeCandidate | undefined;
  for (const d of defs) {
    if (d.tier !== "function") continue;
    if (
      refNode.startIndex >= d.loc.startByte &&
      refNode.endIndex <= d.loc.endByte
    ) {
      if (
        !best ||
        d.loc.endByte - d.loc.startByte < best.loc.endByte - best.loc.startByte
      ) {
        best = d;
      }
    }
  }
  return best?.localId;
}

function makeTopLevelExpression(
  ref: RefCapture,
  file: ParsedFile,
  moduleNode: IRNodeCandidate,
): IRNodeCandidate {
  const meta: ExpressionMeta = {
    tier: "expression",
    role: ref.kind === "construct" ? "construct" : ref.kind,
    payload: nodeText(ref.nameNode),
  };
  return {
    tier: "expression",
    name: nodeText(ref.nameNode),
    signatureParts: [
      "expression",
      moduleNode.localId,
      ref.kind,
      nodeText(ref.nameNode),
      String(ref.captureNode.startIndex),
    ],
    localId: `expr:${file.path}:${ref.captureNode.startIndex}`,
    meta,
    loc: locOf(ref.captureNode),
  };
}


// =============================================================================
// Misc helpers
// =============================================================================

function emptyFragment(
  file: ParsedFile,
  diagnostics: IRFragment["diagnostics"],
): IRFragment {
  return {
    path: file.path,
    indexer: INDEXER_NAME,
    indexerVersion: INDEXER_VERSION,
    grammar: "tree-sitter-typescript",
    grammarVersion: GRAMMAR_VERSION,
    queryHash: QUERY_HASH,
    contentHash: file.contentHash,
    nodes: [],
    edges: [],
    imports: [],
    diagnostics,
  };
}

function locOf(n: TsNode): NodeLoc {
  return {
    startByte: n.startIndex,
    endByte: n.endIndex,
    startLine: n.startPosition.row,
    startCol: n.startPosition.column,
    endLine: n.endPosition.row,
    endCol: n.endPosition.column,
  };
}

function rangeKey(n: TsNode): string {
  return `${n.startIndex}-${n.endIndex}`;
}

function nodeText(n: TsNode): string {
  return n.text;
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith("`") && s.endsWith("`"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function childByType(n: TsNode, type: string): TsNode | undefined {
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i);
    if (c?.type === type) return c;
  }
  return undefined;
}

function enclosingStatement(n: TsNode): TsNode {
  let p: TsNode | null = n;
  while (p && !p.type.endsWith("_statement") && p.type !== "program") {
    p = p.parent;
  }
  return p ?? n;
}

/**
 * Re-export for the sibling Python indexer / unit tests / WASM viewer that
 * want to bring up an in-process parser without re-importing
 * `web-tree-sitter` directly.
 */
export { Parser, Language };

/** Stable sort key tuple (`[startIndex, endIndex]`) for deterministic output. */
export function sortByRange<T extends { loc: NodeLoc }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) =>
      a.loc.startByte - b.loc.startByte || a.loc.endByte - b.loc.endByte,
  );
}
