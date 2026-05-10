/**
 * SCIP `index.scip` -> `IRFragment` (the shape ts-indexer publishes from
 * `../tree-sitter/types.ts`; reused so the merger can treat tree-sitter and
 * SCIP fragments uniformly).
 *
 * Mapping rules come from research/scip.md §2.5 and §3. Cross-language
 * merging (research/scip.md §5.2) is the merger's job; this module emits a
 * single fragment per `index.scip` payload.
 *
 * `signatureParts` recipe — must match spec/ir-schema.md §6 byte-for-byte
 * so SCIP and tree-sitter mint id-identical candidates for the same
 * logical entity (this is what makes the SCIP-wins-on-conflict rule from
 * research §1 actually work):
 *
 *   module     -> [serviceId, repoRelPath]
 *   type       -> [parentModuleId, fullyQualifiedTypeName]
 *   function   -> [parentId, name, String(arity), ...paramTypeDisplays,
 *                  receiverDisplay ?? '']
 *   expression -> [parentFunctionId, role, canonicalPayload,
 *                  String(occurrenceIndexInFunction)]
 *
 * If SCIP omits `signature_documentation`, we degrade to `arity=0,
 * paramTypeDisplays=[]` and stamp a `coarse-function-id` diagnostic so the
 * merger knows the id is broader than tree-sitter's.
 */
import { scip } from '@sourcegraph/scip';

import type {
  CallEdgeMeta,
  DeferredTargetRef,
  ExpressionMeta,
  FunctionMeta,
  ImportEdgeMeta,
  ImportRecord,
  IREdgeCandidate,
  IRFragment,
  IRNodeCandidate,
  ModuleMeta,
  NodeLoc,
  TypeFlowEdgeMeta,
  TypeMeta,
} from '../tree-sitter/types';

import {
  canonicalize,
  extractVersion,
  isLocalSymbol,
} from './symbol-mapping';

/** Bit values for `Occurrence.symbol_roles` (SCIP spec). */
const ROLE_DEFINITION = 0x1;
const ROLE_IMPORT = 0x2;
const ROLE_WRITE_ACCESS = 0x4;
const ROLE_READ_ACCESS = 0x8;

/**
 * Every edge we emit is `resolution: 'scip'`. ts-indexer added the value to
 * `Resolution` in `tree-sitter/types.ts`; we use it directly so the merger
 * can apply the SCIP-wins-on-conflict rule from research/scip.md §1 without
 * losing provenance to the `'exact'` bucket.
 */
const SCIP_RESOLUTION = 'scip' as const;

interface IngestOpts {
  /**
   * Stable indexer id, e.g. `'scip-typescript'`. Stamped into
   * `IRFragment.indexer` and `IRFragment.grammar` (the cache key uses
   * `grammar` separately because tree-sitter fragments distinguish the
   * grammar from the indexer; for SCIP they coincide).
   */
  readonly indexerId: string;
  /**
   * Repo-relative path for the fragment. ts-indexer's convention is that
   * `IRFragment.path` is a *file* path (Document-level) so the on-disk
   * cache (research/scip.md §5.1, keyed by `contentHash`) can invalidate
   * per-file rather than per-index. We currently emit ONE fragment per
   * `index.scip` (Document-level fragmenting is queued behind streaming
   * decode in research §8) and stamp the path of the index file itself,
   * e.g. `'.codegraph/scip/typescript.scip'`. cli-index passes this in.
   */
  readonly fragmentPath?: string;
  /**
   * BLAKE3 of the source `index.scip` bytes. Optional; when missing we
   * stamp `''` and let cli-index recompute on its merger pass.
   */
  readonly contentHash?: string;
  /**
   * Service id for the `signatureParts` of module nodes (spec §6). When
   * absent we use `''`; cli-index promotes module signatures with the
   * resolved service ancestor on merge.
   */
  readonly serviceId?: string;
}

/**
 * Lift a SCIP `index.scip` payload into an `IRFragment`.
 *
 * Two-pass approach (research/scip.md §2.4):
 *   - Pass 1: build the moniker -> defining-document map from
 *             `Document.symbols`, so cross-document references resolve in
 *             the same fragment without `DeferredTargetRef`.
 *   - Pass 2: walk Documents/Occurrences/Relationships and emit
 *             `IRNodeCandidate` / `IREdgeCandidate`.
 */
export function ingestSCIP(buf: Buffer, opts: IngestOpts): IRFragment {
  const index = scip.Index.deserialize(buf);

  const indexerName = index.metadata?.toolInfo?.name ?? opts.indexerId;
  const indexerVersion = index.metadata?.toolInfo?.version ?? '0.0.0';
  void indexerName;

  const nodes: IRNodeCandidate[] = [];
  const edges: IREdgeCandidate[] = [];
  const imports: ImportRecord[] = [];
  const diagnostics: IRFragment['diagnostics'] = [];

  // ── Pass 1: defining-document map ───────────────────────────────────────
  // Symbol moniker -> the relative path of the Document that defines it.
  // Used so an Occurrence whose target lives in another Document still
  // resolves in-fragment via `targetLocalId` rather than `targetRef`.
  const definingDoc = new Map<string, string>();
  for (const doc of index.documents ?? []) {
    const path = normalizePath(doc.relativePath ?? '');
    for (const sym of doc.symbols ?? []) {
      if (sym.symbol) definingDoc.set(sym.symbol, path);
    }
  }

  // moniker -> localId; populated as we mint nodes. Used when we encounter
  // an occurrence whose target was already minted earlier in the walk.
  //
  // Local-id namespace: every id starts with `scip:` so we don't collide
  // with ts-indexer's `def:` / `mod:` / `expr:` prefixes when fragments
  // share a localId space at merge time. Subforms:
  //   - `scip:mod:<filePath>`           -- module nodes (one per Document)
  //   - `scip:def:<canonical-moniker>`  -- defined symbols (any tier)
  //   - `scip:ext:<canonical-moniker>`  -- external symbols
  // We use the canonical moniker rather than a counter so two occurrences
  // of the same symbol in the same fragment resolve to the same local id.
  const localByMoniker = new Map<string, string>();
  const localIdForModule = (path: string): string => `scip:mod:${path}`;
  const localIdForDefined = (canonicalMoniker: string): string =>
    `scip:def:${canonicalMoniker}`;
  const localIdForExternal = (canonicalMoniker: string): string =>
    `scip:ext:${canonicalMoniker}`;

  // ── Pass 2: lift ─────────────────────────────────────────────────────────
  for (const doc of index.documents ?? []) {
    const path = normalizePath(doc.relativePath ?? '');

    // Module node — one per Document.
    const moduleLocal = localIdForModule(path);
    localByMoniker.set(`__module__:${path}`, moduleLocal);
    const moduleMeta: ModuleMeta = {
      kind: 'module',
      lang: scipLanguageToIrLang(doc.language ?? ''),
      path,
    } as ModuleMeta;
    nodes.push({
      tier: 'module',
      name: basename(path),
      signatureParts: [opts.serviceId ?? '', path],
      localId: moduleLocal,
      meta: moduleMeta,
      loc: rootLoc(path),
    });

    // Defined symbols.
    for (const sym of doc.symbols ?? []) {
      if (!sym.symbol) continue;
      const tier = kindToTier(sym.kind);
      const name = sym.displayName || lastDescriptorName(sym.symbol);
      const canonical = canonicalize(sym.symbol, path);
      const localId = localIdForDefined(canonical);
      localByMoniker.set(canonical, localId);

      const sigText = sym.signatureDocumentation?.text;
      const signatureParts = signaturePartsFor(
        tier,
        moduleLocal,
        name,
        sigText,
      );
      if (tier === 'function' && !sigText) {
        diagnostics.push({
          severity: 'info',
          code: 'coarse-function-id',
          message: `function "${name}" has no signature_documentation; id will be coarser than tree-sitter's`,
        });
      }

      nodes.push({
        tier,
        name,
        signatureParts,
        localId,
        meta: metaForSymbol(tier, sym, path),
        loc: rootLoc(path),
      });

      // Relationships -> edges. SCIP's `is_implementation` /
      // `is_reference` / `is_type_definition` carry edge kinds the spec
      // closed-enum doesn't list under category yet, so we emit them as
      // `type-flow` edges with the SCIP edge kind stashed in `meta.tags`
      // for the merger to project (see message thread w/ ts-indexer).
      for (const rel of sym.relationships ?? []) {
        if (!rel.symbol) continue;
        const targetMoniker = canonicalize(rel.symbol, path);
        const tag = rel.isImplementation
          ? 'scip:implements'
          : rel.isTypeDefinition
            ? 'scip:defines-type'
            : rel.isReference
              ? 'scip:type-references'
              : null;
        if (!tag) continue;
        edges.push(
          buildEdge({
            category: 'type-flow',
            sourceLocalId: localId,
            targetMoniker,
            localByMoniker,
            meta: { kind: 'type-flow', tags: [tag] } as TypeFlowEdgeMeta,
            loc: rootLoc(path),
          }),
        );
      }
    }

    // Occurrences.
    for (const occ of doc.occurrences ?? []) {
      if (!occ.symbol) continue;
      const roles = occ.symbolRoles ?? 0;

      // Definition occurrences are fully captured by the node's parentage;
      // we don't emit a separate edge for them.
      if (roles & ROLE_DEFINITION) continue;

      const targetMoniker = canonicalize(occ.symbol, path);

      // Imports get an explicit ImportRecord plus an `'import'` edge from
      // the module node to the target.
      if (roles & ROLE_IMPORT) {
        imports.push({
          fromLocalId: moduleLocal,
          targetMoniker,
          loc: occToLoc(path, occ),
        } as ImportRecord);
        edges.push(
          buildEdge({
            category: 'import',
            sourceLocalId: moduleLocal,
            targetMoniker,
            localByMoniker,
            meta: { kind: 'import' } as ImportEdgeMeta,
            loc: occToLoc(path, occ),
          }),
        );
        continue;
      }

      // Plain reference / read / write. We attribute to the module node
      // because SCIP gives us only `enclosing_range`, not the enclosing
      // function's identity — the merger refines source via tree-sitter's
      // scope info on its pass.
      const access =
        roles & ROLE_WRITE_ACCESS
          ? 'write'
          : roles & ROLE_READ_ACCESS
            ? 'read'
            : 'ref';

      const isCallish = monikerLooksCallish(occ.symbol);
      const meta = isCallish
        ? ({ kind: 'call', access } as unknown as CallEdgeMeta)
        : ({ kind: 'type-flow', tags: [`scip:${access}`] } as TypeFlowEdgeMeta);

      edges.push(
        buildEdge({
          category: isCallish ? 'call' : 'type-flow',
          sourceLocalId: moduleLocal,
          targetMoniker,
          localByMoniker,
          meta,
          loc: occToLoc(path, occ),
        }),
      );
    }
  }

  void definingDoc; // populated for symmetry with future streaming pass

  // External symbols.
  for (const sym of index.externalSymbols ?? []) {
    if (!sym.symbol) continue;
    if (isLocalSymbol(sym.symbol)) {
      diagnostics.push({
        severity: 'warn',
        code: 'malformed-external-symbol',
        message: `external_symbols contains a local symbol "${sym.symbol}"; skipping`,
      });
      continue;
    }
    const tier = kindToTier(sym.kind);
    const name = sym.displayName || lastDescriptorName(sym.symbol);
    const moniker = canonicalize(sym.symbol);
    const localId = localIdForExternal(moniker);
    localByMoniker.set(moniker, localId);

    const meta = metaForSymbol(tier, sym, '');
    (meta as { external?: boolean }).external = true;
    (meta as { version?: string }).version = extractVersion(sym.symbol);

    nodes.push({
      tier,
      name,
      // Externals don't have a parent module in this fragment; merger
      // attaches them to a synthetic external-deps service.
      signatureParts: ['external', moniker],
      localId,
      meta,
      loc: rootLoc(''),
    });
  }

  return {
    path: opts.fragmentPath ?? index.metadata?.projectRoot ?? '',
    indexer: opts.indexerId,
    indexerVersion,
    grammar: opts.indexerId,
    grammarVersion: indexerVersion,
    queryHash: 'scip:v0',
    contentHash: opts.contentHash ?? '',
    nodes,
    edges,
    imports,
    diagnostics,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

interface BuildEdgeArgs {
  readonly category: IREdgeCandidate['category'];
  readonly sourceLocalId: string;
  readonly targetMoniker: string;
  readonly localByMoniker: Map<string, string>;
  readonly meta: IREdgeCandidate['meta'];
  readonly loc: NodeLoc;
}

function buildEdge(args: BuildEdgeArgs): IREdgeCandidate {
  const targetLocalId = args.localByMoniker.get(args.targetMoniker);

  if (targetLocalId) {
    return {
      category: args.category,
      sourceLocalId: args.sourceLocalId,
      targetLocalId,
      resolution: SCIP_RESOLUTION,
      meta: args.meta,
      loc: args.loc,
    } as IREdgeCandidate;
  }

  // No in-fragment target — emit a DeferredTargetRef so the merger looks
  // it up cross-fragment.
  const targetRef: DeferredTargetRef = {
    moniker: args.targetMoniker,
  } as DeferredTargetRef;
  return {
    category: args.category,
    sourceLocalId: args.sourceLocalId,
    targetRef,
    resolution: SCIP_RESOLUTION,
    meta: args.meta,
    loc: args.loc,
  } as IREdgeCandidate;
}

function signaturePartsFor(
  tier: IRNodeCandidate['tier'],
  parentLocalId: string,
  name: string,
  sigText: string | undefined,
): string[] {
  switch (tier) {
    case 'type':
      return [parentLocalId, name];
    case 'function': {
      const { arity, paramTypeDisplays, receiverDisplay } =
        parseSignatureForId(sigText);
      // Mirror tree-sitter's recipe (spec/ir-schema.md §6: unannotated
      // params display as `unknown`). When SCIP shipped no signature at
      // all, we have no way to know arity either; cli-index pairs us with
      // the tree-sitter fragment for that file and overwrites this id at
      // merge time. The `coarse-function-id` diagnostic flags it.
      return [
        parentLocalId,
        name,
        String(arity),
        ...paramTypeDisplays.map((t) => (t === '' ? 'unknown' : t)),
        receiverDisplay ?? '',
      ];
    }
    case 'expression':
      // Per spec §6: parent + role + canonical payload + occurrence index.
      // SCIP doesn't ship occurrence-grouped expressions natively; cli-index
      // fills role/index from the occurrence walk. We stamp a single-arg
      // form so the merger can detect "needs refinement".
      return [parentLocalId, 'scip-symbol', name, '0'];
    case 'module':
      // Caller fills in module signatureParts; this branch is unused.
      return [parentLocalId, name];
  }
}

/**
 * Best-effort signature parser for `signature_documentation.text`. We only
 * extract the three fields the function-id recipe needs; full parsing is
 * the viewer's job. Returns sane defaults when the text is absent.
 */
function parseSignatureForId(sigText: string | undefined): {
  arity: number;
  paramTypeDisplays: string[];
  receiverDisplay: string | undefined;
} {
  if (!sigText) {
    return { arity: 0, paramTypeDisplays: [], receiverDisplay: undefined };
  }
  // Find the outermost (...). If absent, treat as zero-arg.
  const open = sigText.indexOf('(');
  const close = sigText.lastIndexOf(')');
  if (open < 0 || close < 0 || close < open) {
    return { arity: 0, paramTypeDisplays: [], receiverDisplay: undefined };
  }
  const inside = sigText.slice(open + 1, close).trim();
  if (!inside) {
    return { arity: 0, paramTypeDisplays: [], receiverDisplay: undefined };
  }
  // Split on top-level commas; we don't try to be clever about nested
  // generics on the first cut — the merger can re-derive a sharper id from
  // the raw text on demand.
  const params = splitTopLevelCommas(inside);
  // For each `name: Type` produce just the type display.
  const paramTypeDisplays = params.map((p) => {
    const colon = p.indexOf(':');
    return colon >= 0 ? p.slice(colon + 1).trim() : p.trim();
  });
  return {
    arity: paramTypeDisplays.length,
    paramTypeDisplays,
    receiverDisplay: undefined,
  };
}

function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '<' || c === '(' || c === '[' || c === '{') depth++;
    else if (c === '>' || c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter((x) => x.length > 0);
}

function metaForSymbol(
  tier: IRNodeCandidate['tier'],
  sym: scip.SymbolInformation,
  path: string,
): IRNodeCandidate['meta'] {
  const docstring = firstParagraph(sym.documentation ?? []);
  const sigText = sym.signatureDocumentation?.text;
  switch (tier) {
    case 'type':
      return { kind: 'type', signatureText: sigText, docstring } as TypeMeta;
    case 'function':
      return {
        kind: 'function',
        signatureText: sigText,
        docstring,
      } as FunctionMeta;
    case 'expression':
      return { kind: 'expression', signatureText: sigText } as ExpressionMeta;
    case 'module':
      return { kind: 'module', path } as ModuleMeta;
  }
}

/** Map a SCIP `SymbolInformation.Kind` enum to an IR tier. */
function kindToTier(
  kind: scip.SymbolInformation.Kind | undefined,
): IRNodeCandidate['tier'] {
  switch (kind) {
    case scip.SymbolInformation.Kind.Class:
    case scip.SymbolInformation.Kind.Interface:
    case scip.SymbolInformation.Kind.Struct:
    case scip.SymbolInformation.Kind.Trait:
    case scip.SymbolInformation.Kind.Type:
    case scip.SymbolInformation.Kind.Enum:
      return 'type';
    case scip.SymbolInformation.Kind.Function:
    case scip.SymbolInformation.Kind.Method:
    case scip.SymbolInformation.Kind.Constructor:
      return 'function';
    case scip.SymbolInformation.Kind.Module:
    case scip.SymbolInformation.Kind.Package:
    case scip.SymbolInformation.Kind.Namespace:
      return 'module';
    default:
      return 'expression';
  }
}

/**
 * Heuristic: does this moniker name a function or method? Used to choose
 * between `'call'` and `'type-flow'` for non-import occurrences. SCIP's
 * descriptor suffix grammar (research/scip.md §3.1) makes this trivial:
 * `().` is the function/method suffix.
 */
function monikerLooksCallish(symbol: string): boolean {
  return symbol.includes('().');
}

function scipLanguageToIrLang(lang: string): string {
  const lower = lang.toLowerCase();
  if (lower === 'typescript') return 'ts';
  if (lower === 'javascript') return 'js';
  if (lower === 'tsx') return 'tsx';
  if (lower === 'jsx') return 'jsx';
  return lower;
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function lastDescriptorName(symbol: string): string {
  const tail = symbol.split(' ').pop() ?? symbol;
  const cleaned = tail.replace(/[#./()\[\]:]+$/g, '');
  const lastSlash = cleaned.lastIndexOf('/');
  return lastSlash >= 0 ? cleaned.slice(lastSlash + 1) : cleaned;
}

function firstParagraph(md: readonly string[]): string | undefined {
  if (md.length === 0) return undefined;
  const first = md[0] ?? '';
  const blank = first.indexOf('\n\n');
  return blank >= 0 ? first.slice(0, blank) : first;
}

function rootLoc(path: string): NodeLoc {
  // SCIP often emits empty `Document.text`; the merger fills in 1-indexed
  // spans from disk on its pass. A zero-range loc keyed by the document
  // path is a safe sentinel.
  return {
    path,
    startLine: 1,
    startCol: 1,
    endLine: 1,
    endCol: 1,
  } as NodeLoc;
}

function occToLoc(path: string, occ: scip.Occurrence): NodeLoc {
  const r = occ.range ?? [];
  // SCIP packs `[startLine, startCol, endLine, endCol]` (or 3 ints when
  // start/end are on the same line). Zero-indexed; we shift to 1-indexed
  // for IR parity with editors (spec/ir-schema.md §2.5 conversion rule).
  const startLine = (r[0] ?? 0) + 1;
  const startCol = (r[1] ?? 0) + 1;
  const endLine = r.length === 4 ? (r[2] ?? 0) + 1 : startLine;
  const endCol =
    r.length === 4 ? (r[3] ?? 0) + 1 : (r[2] ?? r[1] ?? 0) + 1;
  return { path, startLine, startCol, endLine, endCol } as NodeLoc;
}
