/**
 * Python Tier-B indexer.
 *
 * Implements the tree-sitter side of the two-tier model from
 * `research/tree-sitter.md`. SCIP (`scip-python`) is preferred when available;
 * this indexer is the always-available fallback and the source of
 * framework-pattern facts SCIP doesn't model (FastAPI route decorators,
 * pydantic-settings field annotations, env-var subscript reads, ...).
 *
 * Output: an `IRFragment` of node and edge candidates. Every edge carries a
 * `resolution` field per §4 of the strategy doc:
 *   exact      same-file lexical scope (§4.1)
 *   imported   cross-file via the import map (§4.2)
 *   name-match project-wide name match (§4.3) — the merger picks unique vs
 *              ambiguous and stamps `candidate_group_id` accordingly
 *   unresolved nothing matched, or matched too widely (§4.4)
 *
 * Mirrors `typescript.ts` in shape so the merger has a single contract to
 * consume. Coordinate any structural change with ts-indexer first.
 */

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
  TypeFlowEdgeMeta,
  TypeMeta,
} from "./types";

// =============================================================================
// Versioning
// =============================================================================

/** Pinned grammar version (research/tree-sitter.md §3 — version pinning). */
export const GRAMMAR_VERSION = "0.20.4";

/** Identifier published in `metadata.generators[]` per spec/ir-schema.md §2. */
export const INDEXER_NAME = "tree-sitter-python";
export const INDEXER_VERSION = "0.1.0";

/**
 * Hash of `python.scm`. The build step writes the real hash here; the
 * placeholder still round-trips through cache — the cache_version bump trips
 * on first indexer run after a query edit.
 */
export const QUERY_HASH = "scm:python:v0";

// Tree-sitter node shape we depend on. Matched against web-tree-sitter and the
// native bindings via structural typing — keeps this module portable between
// WASM (viewer) and native (CLI) runtimes.
interface TsNode {
  readonly type: string;
  readonly text: string;
  readonly id: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: { row: number; column: number };
  readonly endPosition: { row: number; column: number };
  readonly parent: TsNode | null;
  readonly childCount: number;
  child(i: number): TsNode | null;
  childForFieldName(name: string): TsNode | null;
}

interface TsTree {
  readonly rootNode: TsNode;
  readonly language: unknown;
}

interface QueryCapture {
  readonly name: string;
  readonly node: TsNode;
}

interface TsQuery {
  captures(node: TsNode): ReadonlyArray<QueryCapture>;
}

let cachedQuery: TsQuery | undefined;

/**
 * Wire the runtime-compiled query in. Called once at process startup by the
 * runtime adapter — keeps this module free of `fs.readFileSync` / WASM init
 * so it works in both Node and browser builds. The runtime is responsible for
 * reading `python.scm` and calling `language.query(...)`.
 */
export function registerPythonQuery(query: TsQuery): void {
  cachedQuery = query;
}

// =============================================================================
// Public entry point — `LanguageIndexer.index(file)`
// =============================================================================

export const pythonIndexer: LanguageIndexer = {
  name: INDEXER_NAME,
  version: INDEXER_VERSION,
  grammar: "tree-sitter-python",
  grammarVersion: GRAMMAR_VERSION,
  languages: ["python"],

  index(file: ParsedFile): IRFragment {
    return runIndexer(file);
  },
};

/** Convenience plain-function form for unit tests. */
export function index(file: ParsedFile): IRFragment {
  return runIndexer(file);
}

// =============================================================================
// Pipeline
// =============================================================================

function runIndexer(file: ParsedFile): IRFragment {
  const tree = file.tree as TsTree | null;
  if (!tree) {
    return emptyFragment(file, [
      {
        severity: "error",
        code: "py-indexer/no-tree",
        message: `tree-sitter parse tree missing for ${file.path}`,
      },
    ]);
  }
  if (!cachedQuery) {
    return emptyFragment(file, [
      {
        severity: "error",
        code: "py-indexer/no-query",
        message:
          "python.scm query not registered; runtime adapter must call registerPythonQuery() at startup",
      },
    ]);
  }

  const captures = cachedQuery.captures(tree.rootNode);
  const buckets = bucketCaptures(captures);
  const scopes = buildScopeTree(tree.rootNode, buckets.scopes);

  const moduleNode = makeModuleNode(file);
  const imports = collectImports(buckets);
  const importMap = indexImports(imports);

  const diagnostics: IRFragment["diagnostics"] = [];
  for (const imp of imports) {
    if (imp.kind === "wildcard") {
      diagnostics.push({
        severity: "warn",
        code: "wildcard-import",
        message: `wildcard import (\`from ${imp.specifier} import *\`) — references through it cannot be resolved`,
        loc: imp.loc,
      });
    }
  }

  const defNodes: IRNodeCandidate[] = [];
  for (const def of buckets.defs) {
    const node = makeDefNode(def, file);
    if (node) defNodes.push(node);
  }

  bindDefsToScopes(defNodes, scopes, buckets.defs);

  const edges: IREdgeCandidate[] = [];
  const expressionNodes: IRNodeCandidate[] = [];

  for (const ref of buckets.refs) {
    const enclosingFnLocalId = enclosingFunctionLocalIdOf(ref.captureNode, defNodes);
    let sourceLocalId: string;
    if (enclosingFnLocalId) {
      sourceLocalId = enclosingFnLocalId;
    } else {
      const expr = makeTopLevelExpression(ref, file);
      expressionNodes.push(expr);
      sourceLocalId = expr.localId;
    }
    const edge = resolveRef(ref, sourceLocalId, scopes, importMap, defNodes);
    if (edge) edges.push(edge);
  }

  for (const imp of imports) {
    edges.push(makeImportEdge(imp, moduleNode));
  }

  return {
    path: file.path,
    indexer: INDEXER_NAME,
    indexerVersion: INDEXER_VERSION,
    grammar: "tree-sitter-python",
    grammarVersion: GRAMMAR_VERSION,
    queryHash: QUERY_HASH,
    contentHash: file.contentHash,
    nodes: [moduleNode, ...defNodes, ...expressionNodes],
    edges,
    imports,
    diagnostics,
  };
}

function emptyFragment(file: ParsedFile, diagnostics: IRFragment["diagnostics"]): IRFragment {
  return {
    path: file.path,
    indexer: INDEXER_NAME,
    indexerVersion: INDEXER_VERSION,
    grammar: "tree-sitter-python",
    grammarVersion: GRAMMAR_VERSION,
    queryHash: QUERY_HASH,
    contentHash: file.contentHash,
    nodes: [],
    edges: [],
    imports: [],
    diagnostics,
  };
}

// =============================================================================
// Capture bucketing
// =============================================================================

interface DefCapture {
  readonly declarationNode: TsNode;
  readonly nameNode: TsNode;
  kind: "function" | "method" | "class" | "variable" | "type";
  readonly asyncness: "sync" | "async" | "generator" | "async-generator";
  readonly exported: boolean;
  decorators: string[];
  /** Enclosing class name for methods. */
  parentName?: string;
}

/**
 * Class-body annotated field captured for later attachment to the parent
 * class's `TypeMeta.fields[]`. Per ir-types, fields nest on the type node
 * rather than producing standalone def-nodes — this avoids id-equality drift
 * with SCIP, which embeds fields in the class symbol.
 */
interface FieldCapture {
  readonly enclosingClassNode: TsNode;
  readonly nameNode: TsNode;
  /** Surface form of the annotation, e.g. "str", "int | None", "Optional[Settings]". */
  readonly typeDisplay: string;
  readonly fieldRangeNode: TsNode;
}

interface RefCapture {
  readonly captureNode: TsNode;
  readonly nameNode: TsNode;
  readonly kind: "call" | "attribute" | "type" | "subscript" | "decorator" | "construct";
  readonly receiver?: TsNode;
  /** For `obj['KEY']` reads — the literal key, when statically resolvable. */
  readonly subscriptKey?: string;
}

interface ScopeCapture {
  readonly node: TsNode;
  readonly kind: "module" | "class" | "function" | "block";
}

interface PythonImportCapture {
  readonly statementNode: TsNode;
  readonly moduleSpecifier: string;
  readonly relativeDots: number;
  readonly symbols: ReadonlyArray<{ name: string; alias?: string }>;
  readonly wildcard: boolean;
  readonly aliasOnModule?: string;
}

interface CaptureBuckets {
  readonly defs: DefCapture[];
  readonly refs: RefCapture[];
  readonly scopes: ScopeCapture[];
  readonly importStatements: PythonImportCapture[];
}

function bucketCaptures(captures: ReadonlyArray<QueryCapture>): CaptureBuckets {
  const defs: DefCapture[] = [];
  const refs: RefCapture[] = [];
  const scopes: ScopeCapture[] = [];

  // Decorator wrappers — collected first so we can attach decorator names to
  // the inner def when it shows up.
  const decoratorWrappers = new Map<number, string[]>();
  for (const c of captures) {
    if (c.name !== "def.decorated") continue;
    const names: string[] = [];
    for (const inner of captures) {
      if (inner.name !== "ref.decorator") continue;
      if (!nodeContains(c.node, inner.node)) continue;
      names.push(decoratorPath(inner.node));
    }
    decoratorWrappers.set(c.node.id, names);
  }

  for (const c of captures) {
    if (c.name === "def.function") {
      const ident = c.node.childForFieldName("name");
      if (!ident) continue;
      const enclosingClass = findEnclosingClass(c.node);
      defs.push({
        declarationNode: c.node,
        nameNode: ident,
        kind: enclosingClass ? "method" : "function",
        asyncness: detectAsyncness(c.node),
        exported: !ident.text.startsWith("_"),
        decorators: decoratorsForInnerDef(c.node, decoratorWrappers),
        parentName: enclosingClass?.name,
      });
    } else if (c.name === "def.class") {
      const ident = c.node.childForFieldName("name");
      if (!ident) continue;
      defs.push({
        declarationNode: c.node,
        nameNode: ident,
        kind: "class",
        asyncness: "sync",
        exported: !ident.text.startsWith("_"),
        decorators: decoratorsForInnerDef(c.node, decoratorWrappers),
      });
    } else if (c.name === "def.variable") {
      const nameCap = findInnerCapture(captures, c, "name");
      if (!nameCap) continue;
      defs.push({
        declarationNode: c.node,
        nameNode: nameCap.node,
        kind: "variable",
        asyncness: "sync",
        exported: !nameCap.node.text.startsWith("_"),
        decorators: [],
      });
    } else if (c.name === "def.type") {
      const nameCap = findInnerCapture(captures, c, "name");
      if (!nameCap) continue;
      defs.push({
        declarationNode: c.node,
        nameNode: nameCap.node,
        kind: "type",
        asyncness: "sync",
        exported: !nameCap.node.text.startsWith("_"),
        decorators: [],
      });
    } else if (c.name === "def.field") {
      const nameCap = findInnerCapture(captures, c, "name");
      if (!nameCap) continue;
      const annotationCap = findInnerCapture(captures, c, "def.field.annotation");
      const enclosingClass = findEnclosingClass(c.node);
      defs.push({
        declarationNode: c.node,
        nameNode: nameCap.node,
        kind: "field",
        asyncness: "sync",
        exported: !nameCap.node.text.startsWith("_"),
        decorators: [],
        annotation: annotationCap?.node.text,
        parentName: enclosingClass?.name,
      });
    } else if (c.name === "ref.call") {
      const ref = buildCallRef(c.node);
      if (ref) refs.push(ref);
    } else if (c.name === "ref.attribute") {
      const ref = buildAttributeRef(c.node);
      if (ref) refs.push(ref);
    } else if (c.name === "ref.type") {
      const nameCap = findInnerCapture(captures, c, "name");
      if (!nameCap) continue;
      const recvCap = findInnerCapture(captures, c, "ref.receiver");
      refs.push({
        captureNode: c.node,
        nameNode: nameCap.node,
        kind: "type",
        receiver: recvCap?.node,
      });
    } else if (c.name === "ref.subscript") {
      const value = c.node.childForFieldName("value");
      if (!value) continue;
      const subscriptNode = c.node.childForFieldName("subscript");
      const subscriptKey = subscriptNode ? extractStringLiteral(subscriptNode) : undefined;
      const nameNode = leftmostIdentifier(value) ?? value;
      refs.push({
        captureNode: c.node,
        nameNode,
        kind: "subscript",
        receiver: value,
        subscriptKey,
      });
    } else if (
      c.name === "scope.module" ||
      c.name === "scope.class" ||
      c.name === "scope.function"
    ) {
      const kind = c.name.slice("scope.".length) as ScopeCapture["kind"];
      scopes.push({ node: c.node, kind });
    }
    // @name, @ref.receiver, @ref.decorator, @def.target, @def.field.annotation,
    // @ref.subscript.key, @import.* are sub-captures consumed by their parents.
  }

  const importStatements = collectImportCaptures(captures);
  return { defs, refs, scopes, importStatements };
}

function decoratorsForInnerDef(
  innerNode: TsNode,
  wrappers: Map<number, string[]>,
): string[] {
  const parent = innerNode.parent;
  if (parent && parent.type === "decorated_definition") {
    return wrappers.get(parent.id) ?? [];
  }
  return [];
}

function buildCallRef(callNode: TsNode): RefCapture | null {
  const fn = callNode.childForFieldName("function");
  if (!fn) return null;
  if (fn.type === "identifier") {
    return { captureNode: callNode, nameNode: fn, kind: "call" };
  }
  if (fn.type === "attribute") {
    const attr = fn.childForFieldName("attribute");
    const obj = fn.childForFieldName("object");
    if (!attr) return null;
    return {
      captureNode: callNode,
      nameNode: attr,
      kind: "call",
      receiver: obj ?? undefined,
    };
  }
  return null;
}

function buildAttributeRef(attrNode: TsNode): RefCapture | null {
  // Skip attribute nodes that are themselves the function child of a call —
  // those are handled by the @ref.call branch and would double-count.
  const parent = attrNode.parent;
  if (parent && parent.type === "call" && parent.childForFieldName("function") === attrNode) {
    return null;
  }
  const attr = attrNode.childForFieldName("attribute");
  const obj = attrNode.childForFieldName("object");
  if (!attr) return null;
  return {
    captureNode: attrNode,
    nameNode: attr,
    kind: "attribute",
    receiver: obj ?? undefined,
  };
}

function collectImportCaptures(captures: ReadonlyArray<QueryCapture>): PythonImportCapture[] {
  const out: PythonImportCapture[] = [];
  const seenStmts = new Set<number>();

  for (const c of captures) {
    if (c.name !== "import.module" && c.name !== "import.relative") continue;
    const stmt = enclosingImportStatement(c.node);
    if (!stmt || seenStmts.has(stmt.id)) continue;
    seenStmts.add(stmt.id);

    const isRelative = c.name === "import.relative";
    const moduleText = c.node.text;
    const relativeDots = isRelative ? countLeadingDots(moduleText) : 0;
    const moduleSpecifier = isRelative ? moduleText.replace(/^\.+/, "") : moduleText;

    const wildcard = captures.some(
      (s) => s.name === "import.wildcard" && nodeContains(stmt, s.node),
    );

    const symbolCaps = captures.filter(
      (s) => s.name === "import.symbol" && nodeContains(stmt, s.node),
    );
    const aliasCaps = captures.filter(
      (s) => s.name === "import.alias" && nodeContains(stmt, s.node),
    );

    // Pair each `from x import y as z` symbol with its alias by walking up to
    // the nearest aliased_import. A bare `import x as y` carries the alias on
    // the module instead — caught below.
    const symbols: { name: string; alias?: string }[] = [];
    for (const sym of symbolCaps) {
      const aliasedParent = ancestorOfType(sym.node, "aliased_import");
      const alias = aliasedParent
        ? aliasCaps.find((a) => nodeContains(aliasedParent, a.node))
        : undefined;
      symbols.push({ name: sym.node.text, alias: alias?.node.text });
    }

    let aliasOnModule: string | undefined;
    if (stmt.type === "import_statement") {
      const aliasedModuleParent = ancestorOfType(c.node, "aliased_import");
      if (aliasedModuleParent) {
        const alias = aliasCaps.find((a) => nodeContains(aliasedModuleParent, a.node));
        aliasOnModule = alias?.node.text;
      }
    }

    out.push({
      statementNode: stmt,
      moduleSpecifier,
      relativeDots,
      symbols,
      wildcard,
      aliasOnModule,
    });
  }
  return out;
}

// =============================================================================
// Scope tree
// =============================================================================

interface Scope {
  readonly node: TsNode;
  readonly kind: ScopeCapture["kind"];
  parent?: Scope;
  readonly bindings: Map<string, IRNodeCandidate>;
  /**
   * Module + function scopes hoist in Python: a top-level def is visible to
   * earlier references within the same module body (subject to runtime order
   * at execution time, but for static analysis we conservatively allow it).
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

  (moduleScope as unknown as { all: Scope[] }).all = all;
  return moduleScope;
}

function scopeFor(node: TsNode, root: Scope): Scope {
  const all = (root as unknown as { all?: Scope[] }).all ?? [root];
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

function makeDefNode(def: DefCapture, file: ParsedFile): IRNodeCandidate | undefined {
  const name = def.nameNode.text;
  const loc = locOf(def.declarationNode);
  const localId = `def:${file.path}:${def.declarationNode.startIndex}:${name}`;

  switch (def.kind) {
    case "function":
    case "method": {
      const params = extractParams(def.declarationNode);
      const returnTypeDisplay = extractReturnType(def.declarationNode);
      const meta: FunctionMeta = {
        tier: "function",
        kind: def.kind,
        exported: def.exported,
        asyncness: def.asyncness,
        params,
        returnTypeDisplay,
        receiverTypeDisplay: def.parentName,
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
          def.parentName ?? "",
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
        kind: def.kind === "type" ? "type-alias" : "class",
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
      // Fields ride on the type tier with a `field` kind discriminator.
      // ts-indexer agreed to widen TypeMeta to carry `annotation`. Until
      // that lands the cast is a documented forward-compat slot.
      const meta = {
        tier: "type" as const,
        kind: "field",
        exported: def.exported,
        annotation: def.annotation,
      } as unknown as TypeMeta;
      return {
        tier: "type",
        name,
        signatureParts: ["field", file.path, def.parentName ?? "", name],
        localId,
        meta,
        loc,
      };
    }

    case "variable": {
      // Module-level constants. Modeled as an expression-tier node with a
      // `binding` role — refs to the name resolve here via scope lookup.
      const meta: ExpressionMeta = {
        tier: "expression",
        role: "binding",
        payload: name,
      };
      return {
        tier: "expression",
        name,
        signatureParts: ["expression", file.path, "binding", name, "0"],
        localId,
        meta,
        loc,
      };
    }
  }
  return undefined;
}

function extractParams(fnNode: TsNode): ReadonlyArray<{ name: string; typeDisplay: string }> {
  const paramsNode = fnNode.childForFieldName("parameters");
  if (!paramsNode) return [];
  const out: { name: string; typeDisplay: string }[] = [];
  for (let i = 0; i < paramsNode.childCount; i++) {
    const c = paramsNode.child(i);
    if (!c) continue;
    switch (c.type) {
      case "identifier":
        out.push({ name: c.text, typeDisplay: "unknown" });
        break;
      case "typed_parameter": {
        const nameId = firstChildOfType(c, "identifier");
        const typeNode = c.childForFieldName("type");
        if (nameId) {
          out.push({ name: nameId.text, typeDisplay: typeNode?.text ?? "unknown" });
        }
        break;
      }
      case "default_parameter": {
        const nameId = c.childForFieldName("name");
        if (nameId) out.push({ name: nameId.text, typeDisplay: "unknown" });
        break;
      }
      case "typed_default_parameter": {
        const nameId = c.childForFieldName("name");
        const typeNode = c.childForFieldName("type");
        if (nameId) {
          out.push({ name: nameId.text, typeDisplay: typeNode?.text ?? "unknown" });
        }
        break;
      }
      case "list_splat_pattern":
      case "dictionary_splat_pattern": {
        const inner = firstChildOfType(c, "identifier");
        if (inner) {
          const prefix = c.type === "list_splat_pattern" ? "*" : "**";
          out.push({ name: prefix + inner.text, typeDisplay: "unknown" });
        }
        break;
      }
    }
  }
  return out;
}

function extractReturnType(fnNode: TsNode): string {
  const ret = fnNode.childForFieldName("return_type");
  return ret?.text ?? "unknown";
}

// =============================================================================
// Imports → ImportRecord
// =============================================================================

function collectImports(buckets: CaptureBuckets): ImportRecord[] {
  const out: ImportRecord[] = [];
  for (const imp of buckets.importStatements) {
    const loc = locOf(imp.statementNode);
    const specifier =
      imp.relativeDots > 0
        ? ".".repeat(imp.relativeDots) + imp.moduleSpecifier
        : imp.moduleSpecifier;

    if (imp.wildcard) {
      out.push({ specifier, local: "*", kind: "wildcard", loc });
      continue;
    }

    if (imp.symbols.length === 0) {
      // `import foo` / `import foo as bar` — Python binds the module name
      // (or alias) into the current scope. namespace-style.
      const local = imp.aliasOnModule ?? leftmostDottedSegment(imp.moduleSpecifier);
      out.push({ specifier, local, kind: "namespace", loc });
      continue;
    }

    for (const sym of imp.symbols) {
      out.push({
        specifier,
        imported: sym.name,
        local: sym.alias ?? sym.name,
        kind: "named",
        loc,
      });
    }
  }
  return out;
}

function indexImports(records: ReadonlyArray<ImportRecord>): Map<string, ImportRecord> {
  const m = new Map<string, ImportRecord>();
  for (const r of records) {
    if (r.local && r.local !== "*") m.set(r.local, r);
  }
  return m;
}

function makeImportEdge(imp: ImportRecord, moduleNode: IRNodeCandidate): IREdgeCandidate {
  const meta: ImportEdgeMeta = {
    category: "import",
    specifier: imp.specifier,
    symbols: imp.imported ? [imp.imported] : [],
    kind: imp.kind === "wildcard" ? "side-effect" : "static",
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

// =============================================================================
// Reference resolution cascade (research §4)
// =============================================================================

function resolveRef(
  ref: RefCapture,
  sourceLocalId: string,
  scopeRoot: Scope,
  importMap: Map<string, ImportRecord>,
  defs: ReadonlyArray<IRNodeCandidate>,
): IREdgeCandidate | undefined {
  const name = ref.nameNode.text;
  const loc = locOf(ref.captureNode);

  const receiverText =
    ref.receiver && ref.receiver.type === "identifier" ? ref.receiver.text : undefined;

  // §4.5 method-on-self / cls heuristic — `self.bar()` resolves against the
  // enclosing class's methods only, not the project-wide name bag.
  if (receiverText === "self" || receiverText === "cls") {
    const enclosingClass = findEnclosingClassFromCapture(ref.captureNode);
    if (enclosingClass) {
      const sibling = defs.find(
        (d) =>
          d.tier === "function" &&
          d.name === name &&
          (d.meta as FunctionMeta).receiverTypeDisplay === enclosingClass.name,
      );
      if (sibling) {
        return makeRefEdge(ref, sourceLocalId, "exact", loc, {
          targetLocalId: sibling.localId,
        });
      }
      // Fall through — `self.foo` may refer to an instance attribute set in
      // `__init__`, which we don't currently capture as a def.
    }
  }

  // §4.1 same-file lexical scope.
  const fromScope = scopeFor(ref.captureNode, scopeRoot);
  const localHit = lookupInScope(name, fromScope);
  if (localHit) {
    return makeRefEdge(ref, sourceLocalId, "exact", loc, {
      targetLocalId: localHit.localId,
    });
  }

  // §4.2 import-aware cross-file. For `pkg.func`, the leftmost segment is
  // the import-map key; the resolved name is `pkg.func` against that module.
  const lookupName = receiverText ?? name;
  const imp = importMap.get(lookupName);
  if (imp) {
    return makeRefEdge(ref, sourceLocalId, "imported", loc, {
      targetRef: {
        strategy: "import-map",
        name: ref.receiver ? `${lookupName}.${name}` : name,
        importLocal: lookupName,
        moduleSpecifier: imp.specifier,
      },
    });
  }

  // §4.3 project-wide name match. Same-file pre-filter as a confidence hint;
  // otherwise hand the merger the bare name and let it consult the global
  // name index.
  const sameFile = defs.find((d) => d.name === name);
  if (sameFile) {
    return makeRefEdge(ref, sourceLocalId, "name-match", loc, {
      targetLocalId: sameFile.localId,
    });
  }

  return makeRefEdge(ref, sourceLocalId, "unresolved", loc, {
    targetRef: { strategy: "name-match", name },
  });
}

function makeRefEdge(
  ref: RefCapture,
  sourceLocalId: string,
  resolution: Resolution,
  loc: NodeLoc,
  binding: { targetLocalId?: string; targetRef?: DeferredTargetRef },
): IREdgeCandidate {
  const category: IREdgeCandidate["category"] =
    ref.kind === "type" || ref.kind === "attribute" || ref.kind === "subscript"
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
      role: ref.kind === "type" ? "argument" : "field-read",
    };
    if (ref.subscriptKey !== undefined) {
      // ts-indexer is widening TypeFlowEdgeMeta with `subscriptKey`; until
      // that lands we ride it as a forward-compat extra field.
      (tfMeta as TypeFlowEdgeMeta & { subscriptKey?: string }).subscriptKey =
        ref.subscriptKey;
    }
    meta = tfMeta;
  }

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

// =============================================================================
// Top-level expression nodes for refs that don't sit inside a function
// =============================================================================

function makeTopLevelExpression(ref: RefCapture, file: ParsedFile): IRNodeCandidate {
  const loc = locOf(ref.captureNode);
  const role = ref.kind === "call" ? "call" : ref.kind;
  const localId = `expr:${file.path}:${ref.captureNode.startIndex}:${role}`;
  const meta: ExpressionMeta = {
    tier: "expression",
    role,
    payload: ref.nameNode.text,
  };
  return {
    tier: "expression",
    name: ref.nameNode.text,
    signatureParts: [
      "expression",
      file.path,
      role,
      ref.nameNode.text,
      String(ref.captureNode.startIndex),
    ],
    localId,
    meta,
    loc,
  };
}

function enclosingFunctionLocalIdOf(
  refNode: TsNode,
  defs: ReadonlyArray<IRNodeCandidate>,
): string | undefined {
  let best: IRNodeCandidate | undefined;
  let bestSize = Infinity;
  for (const d of defs) {
    if (d.tier !== "function") continue;
    if (d.loc.startByte <= refNode.startIndex && d.loc.endByte >= refNode.endIndex) {
      const size = d.loc.endByte - d.loc.startByte;
      if (size < bestSize) {
        best = d;
        bestSize = size;
      }
    }
  }
  return best?.localId;
}

// =============================================================================
// Tree-walk utilities
// =============================================================================

function nodeContains(outer: TsNode, inner: TsNode): boolean {
  return inner.startIndex >= outer.startIndex && inner.endIndex <= outer.endIndex;
}

function findInnerCapture(
  all: ReadonlyArray<QueryCapture>,
  parent: QueryCapture,
  captureName: string,
): QueryCapture | undefined {
  for (const c of all) {
    if (c.name !== captureName) continue;
    if (nodeContains(parent.node, c.node)) return c;
  }
  return undefined;
}

function ancestorOfType(node: TsNode, type: string): TsNode | null {
  let cur: TsNode | null = node;
  while (cur) {
    if (cur.type === type) return cur;
    cur = cur.parent;
  }
  return null;
}

function enclosingImportStatement(node: TsNode): TsNode | null {
  let cur: TsNode | null = node;
  while (cur) {
    if (cur.type === "import_statement" || cur.type === "import_from_statement") return cur;
    cur = cur.parent;
  }
  return null;
}

function findEnclosingClass(node: TsNode): { name: string } | null {
  let cur: TsNode | null = node.parent;
  while (cur) {
    if (cur.type === "class_definition") {
      const ident = cur.childForFieldName("name");
      return ident ? { name: ident.text } : null;
    }
    // Stop at function boundary — nested-function-in-class still belongs to
    // the inner function, not the outer class.
    if (cur.type === "function_definition") return null;
    cur = cur.parent;
  }
  return null;
}

function findEnclosingClassFromCapture(node: TsNode): { name: string } | null {
  let cur: TsNode | null = node;
  while (cur) {
    if (cur.type === "class_definition") {
      const ident = cur.childForFieldName("name");
      return ident ? { name: ident.text } : null;
    }
    cur = cur.parent;
  }
  return null;
}

function detectAsyncness(fnNode: TsNode): "sync" | "async" | "generator" | "async-generator" {
  let isAsync = false;
  for (let i = 0; i < fnNode.childCount; i++) {
    if (fnNode.child(i)?.type === "async") {
      isAsync = true;
      break;
    }
  }
  const body = fnNode.childForFieldName("body");
  const isGenerator = body ? containsYield(body) : false;
  if (isAsync && isGenerator) return "async-generator";
  if (isAsync) return "async";
  if (isGenerator) return "generator";
  return "sync";
}

function containsYield(node: TsNode): boolean {
  if (node.type === "yield") return true;
  // Don't descend into nested function/class bodies — their yields belong
  // to them, not the outer function.
  if (
    node.type === "function_definition" ||
    node.type === "lambda" ||
    node.type === "class_definition"
  ) {
    return false;
  }
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && containsYield(c)) return true;
  }
  return false;
}

function isAwaited(refNode: TsNode): boolean {
  let p: TsNode | null = refNode.parent;
  let hops = 0;
  while (p && hops < 3) {
    if (p.type === "await") return true;
    p = p.parent;
    hops++;
  }
  return false;
}

function leftmostIdentifier(node: TsNode): TsNode | null {
  let cur: TsNode | null = node;
  while (cur) {
    if (cur.type === "identifier") return cur;
    if (cur.type === "attribute") {
      cur = cur.childForFieldName("object");
      continue;
    }
    if (cur.type === "subscript") {
      cur = cur.childForFieldName("value");
      continue;
    }
    if (cur.type === "call") {
      cur = cur.childForFieldName("function");
      continue;
    }
    return null;
  }
  return null;
}

function leftmostDottedSegment(s: string): string {
  const i = s.indexOf(".");
  return i < 0 ? s : s.slice(0, i);
}

function countLeadingDots(s: string): number {
  let n = 0;
  while (n < s.length && s[n] === ".") n++;
  return n;
}

function decoratorPath(node: TsNode): string {
  if (node.type === "identifier") return node.text;
  if (node.type === "attribute") return dottedFromExpr(node);
  if (node.type === "call") {
    const fn = node.childForFieldName("function");
    return fn ? decoratorPath(fn) : node.text;
  }
  return node.text;
}

function dottedFromExpr(node: TsNode): string {
  if (node.type === "identifier") return node.text;
  if (node.type === "attribute") {
    const obj = node.childForFieldName("object");
    const attr = node.childForFieldName("attribute");
    if (obj && attr) return `${dottedFromExpr(obj)}.${attr.text}`;
  }
  return node.text;
}

function firstChildOfType(node: TsNode, type: string): TsNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c?.type === type) return c;
  }
  return null;
}

/**
 * Extract a Python string literal's value, stripping quotes and `b`/`r`/`f`
 * prefixes. Returns undefined for f-strings with interpolations or anything
 * we can't statically resolve.
 */
function extractStringLiteral(node: TsNode): string | undefined {
  if (node.type !== "string") return undefined;
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === "interpolation") return undefined;
  }
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c?.type === "string_content") return c.text;
  }
  const t = node.text;
  const m = /^[rRbBuUfF]*(?:'''|"""|'|")(.*?)(?:'''|"""|'|")$/s.exec(t);
  return m ? m[1] : undefined;
}

function locOf(node: TsNode): NodeLoc {
  return {
    startByte: node.startIndex,
    endByte: node.endIndex,
    startLine: node.startPosition.row,
    startCol: node.startPosition.column,
    endLine: node.endPosition.row,
    endCol: node.endPosition.column,
  };
}
