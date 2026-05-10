import type { Edge, Node, Tier } from './load-ir';
import {
  EDGE_CATEGORIES,
  type EdgeCategory,
  type Filters,
  type TypeMatchMode,
} from '../state/graph';

/**
 * Filter predicates and edge/node metadata accessors.
 *
 * The IR types in `load-ir.ts` are intentionally lax (string-typed `kind`,
 * free-form `attributes`) to allow the viewer to render IRs produced by
 * adapters that emit fields ahead of the schema in `@codegraph/ir`. The
 * accessors here read those fields defensively and normalize them onto the
 * vocabulary defined in `design/edge-typing.md` and `design/pure-effectful.md`.
 *
 * The functions are pure so they can be unit-tested without the store, and
 * memoized at call sites that care.
 */

// -----------------------------------------------------------------------------
// Edge category
// -----------------------------------------------------------------------------

const CATEGORY_SET: ReadonlySet<EdgeCategory> = new Set(EDGE_CATEGORIES);

/**
 * Resolve an edge's category. Adapters may emit `category` directly (the spec
 * shape), or fall back to the older `kind` field. Anything not in the
 * 13-category vocabulary is reported as `null` so callers can either include
 * or exclude it explicitly — we never silently coerce an unknown kind into
 * one of the spec categories.
 */
export function edgeCategory(edge: Edge): EdgeCategory | null {
  const raw = readString(edge, 'category') ?? edge.kind;
  if (typeof raw !== 'string') return null;
  // Tolerate the legacy plural shapes from `EdgeKind`.
  const normalized = LEGACY_KIND_TO_CATEGORY[raw] ?? raw;
  return CATEGORY_SET.has(normalized as EdgeCategory) ? (normalized as EdgeCategory) : null;
}

/**
 * Mapping from the older `EdgeKind` strings still used in some fixtures
 * (`calls`, `imports`, `reads`, `writes`) to the spec categories. Only the
 * unambiguous ones are mapped — `reads`/`writes` need an adapter to know
 * whether they are filesystem, DB, env, or network, so we leave those alone.
 */
const LEGACY_KIND_TO_CATEGORY: Record<string, EdgeCategory> = {
  calls: 'call',
  imports: 'import',
  type_of: 'type-flow',
};

/**
 * Categories grouped by the visual buckets in design/edge-typing.md §3.1.
 * Used to colour the inspector's edge sub-headers and the FilterBar legend.
 */
export const CATEGORY_GROUPS: Record<string, readonly EdgeCategory[]> = {
  data: ['type-flow', 'http-route', 'db-read', 'message-consume'],
  control: ['call', 'import'],
  effects: [
    'db-write',
    'fs-read',
    'fs-write',
    'network',
    'exec',
    'env-read',
    'message-publish',
  ],
} as const;

/**
 * For an edge category, the design spec's "sub-class". `effect` further splits
 * into `source`/`sink` so the inspector can pick the right glyph + arrow head.
 */
export type EdgeSubclass = 'control' | 'structural' | 'data' | 'effect-source' | 'effect-sink';

export function edgeSubclass(category: EdgeCategory): EdgeSubclass {
  switch (category) {
    case 'call':
      return 'control';
    case 'import':
      return 'structural';
    case 'type-flow':
    case 'http-route':
      return 'data';
    case 'db-read':
    case 'env-read':
    case 'fs-read':
    case 'message-consume':
      return 'effect-source';
    case 'db-write':
    case 'fs-write':
    case 'network':
    case 'exec':
    case 'message-publish':
      return 'effect-sink';
  }
}

// -----------------------------------------------------------------------------
// Edge value-type
// -----------------------------------------------------------------------------

/**
 * The structural form of a value type, recursive. Mirrors the `canonical` shape
 * from design/edge-typing.md §2 — a discriminated tree of named refs and
 * generic constructors. Adapters may emit anything; we read defensively.
 */
export type CanonicalType =
  | { kind: 'ref'; ref: string }
  | { kind: 'unknown' }
  | { kind: 'primitive'; name: string }
  | { kind: string; [k: string]: unknown };

export type EdgeValueType = {
  /** Single-line, language-flavored — what shows on the edge label. */
  display: string;
  /** Structural, language-agnostic form used for type-equality filtering. */
  canonical: CanonicalType | null;
  /** Definition site of a named type, when adapters can determine it. */
  origin: { file: string; line?: number; symbol?: string } | null;
};

/**
 * Read the value-type triple off an edge. Falls back through a few shapes:
 *   1. `edge.type` (the spec shape).
 *   2. `edge.attributes.type` (older adapter convention).
 *   3. `edge.attributes.valueType` (the cgql shape — see design/query-language.md §8.3).
 * Returns null when no usable display string can be found.
 */
export function edgeValueType(edge: Edge): EdgeValueType | null {
  const candidates: unknown[] = [
    (edge as Record<string, unknown>).type,
    edge.attributes?.type,
    edge.attributes?.valueType,
  ];
  for (const c of candidates) {
    if (!isObject(c)) continue;
    const display =
      typeof c.display === 'string'
        ? c.display
        : typeof c.name === 'string'
          ? c.name
          : null;
    if (!display) continue;
    return {
      display,
      canonical: isObject(c.canonical) ? (c.canonical as CanonicalType) : null,
      origin: readOrigin(c.origin),
    };
  }
  return null;
}

function readOrigin(o: unknown): EdgeValueType['origin'] {
  if (!isObject(o)) return null;
  const file = typeof o.file === 'string' ? o.file : null;
  if (!file) return null;
  const line = typeof o.line === 'number' ? o.line : undefined;
  const symbol = typeof o.symbol === 'string' ? o.symbol : undefined;
  return {
    file,
    ...(line !== undefined ? { line } : {}),
    ...(symbol !== undefined ? { symbol } : {}),
  };
}

/**
 * Stable string key for a canonical type, used to group "all edges carrying
 * this type" without depending on object identity. We hash the canonical form
 * if present, otherwise the display string. Two edges whose canonical forms
 * stringify identically are considered the same type — which is exactly what
 * design/edge-typing.md §6 means by "matched by canonical, not display".
 */
export function typeKey(t: EdgeValueType | null): string {
  if (!t) return '';
  if (t.canonical) return canonicalKey(t.canonical);
  return `display:${t.display}`;
}

function canonicalKey(c: CanonicalType): string {
  // Stable JSON: sort object keys so { a, b } and { b, a } collide.
  return JSON.stringify(c, Object.keys(c).sort());
}

/**
 * Predicate "does this edge carry a type whose canonical form references
 * `name`". Implements the structural match described in
 * design/edge-typing.md §6: `User` matches `User`, `Promise<User>`,
 * `Result<User, E>`, `{ user: User }`, `User[]`, etc.
 */
export function edgeCarriesType(
  edge: Edge,
  name: string,
  mode: TypeMatchMode,
): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  const t = edgeValueType(edge);
  if (!t) return false;
  if (mode === 'exact') {
    if (t.canonical) {
      return t.canonical.kind === 'ref' &&
        typeof (t.canonical as { ref?: unknown }).ref === 'string' &&
        (t.canonical as { ref: string }).ref === trimmed;
    }
    return t.display === trimmed;
  }
  // Structural: walk the canonical tree if we have one, else fall back to a
  // case-sensitive substring on display (sufficient for primitive labels).
  if (t.canonical) return canonicalContainsRef(t.canonical, trimmed);
  return t.display.includes(trimmed);
}

function canonicalContainsRef(c: unknown, name: string): boolean {
  if (!isObject(c)) {
    return typeof c === 'string' && c === name;
  }
  if ((c as { kind?: unknown }).kind === 'ref' && (c as { ref?: unknown }).ref === name) {
    return true;
  }
  for (const v of Object.values(c)) {
    if (Array.isArray(v)) {
      for (const item of v) if (canonicalContainsRef(item, name)) return true;
    } else if (isObject(v)) {
      if (canonicalContainsRef(v, name)) return true;
    } else if (typeof v === 'string' && v === name) {
      // Some adapters store `ref` as a sibling string in nested generics.
      return true;
    }
  }
  return false;
}

/**
 * Walk the canonical tree and collect every ref name. Used by the type-drill
 * panel to render the structural members of a type as clickable chips.
 */
export function collectMembers(c: CanonicalType | null): string[] {
  if (!c) return [];
  const out = new Set<string>();
  walk(c);
  return [...out].sort();
  function walk(v: unknown): void {
    if (!isObject(v)) return;
    if ((v as { kind?: unknown }).kind === 'ref' && typeof (v as { ref?: unknown }).ref === 'string') {
      out.add((v as { ref: string }).ref);
    }
    for (const child of Object.values(v)) {
      if (Array.isArray(child)) child.forEach(walk);
      else walk(child);
    }
  }
}

// -----------------------------------------------------------------------------
// Node leaf / sink classification
// -----------------------------------------------------------------------------

/**
 * Sink/leaf "flavor" — the specific kind of effect a sink/source represents,
 * per design/pure-effectful.md §2 and design/edge-typing.md §4.2. We type this
 * loosely so future adapters can introduce flavors without a viewer rebuild.
 */
export type Flavor = string;

export type LeafBadge = { kind: 'leaf' | 'sink' | 'source'; flavor: Flavor };

/**
 * Read a node's leaf/sink classification, if any. Adapters tag the synthetic
 * boundary nodes (`sink:postgres:users`, `source:env:DATABASE_URL`) and the
 * leaf expressions (HTTP-input, etc.) with a small object — accept either the
 * spec shape (`node.sink = { flavor: ... }`) or the attribute-bag fallback.
 */
export function nodeBadge(node: Node): LeafBadge | null {
  const r = node as Record<string, unknown>;
  return readBadge('sink', r.sink) ??
    readBadge('source', r.source) ??
    readBadge('leaf', r.leaf) ??
    readBadge('sink', node.attributes?.sink) ??
    readBadge('source', node.attributes?.source) ??
    readBadge('leaf', node.attributes?.leaf);
}

function readBadge(kind: LeafBadge['kind'], v: unknown): LeafBadge | null {
  if (!isObject(v)) return null;
  const flavor = typeof v.flavor === 'string' ? v.flavor : null;
  if (!flavor) return null;
  return { kind, flavor };
}

// -----------------------------------------------------------------------------
// Combined filter predicate
// -----------------------------------------------------------------------------

export function nodePassesFilters(node: Node, filters: Filters): boolean {
  if (filters.tiers.size > 0 && !filters.tiers.has(node.tier as Tier)) return false;
  const q = filters.query.trim().toLowerCase();
  if (q && !node.name.toLowerCase().includes(q) && !node.id.toLowerCase().includes(q)) {
    return false;
  }
  return true;
}

/**
 * Edge predicate combining category + carry-type. The type filter is the
 * load-bearing one: when a user types `User` it lights up every edge carrying
 * `User` regardless of category, and the canvas dims everything else.
 */
export function edgePassesFilters(edge: Edge, filters: Filters): boolean {
  if (filters.categories.size > 0) {
    const cat = edgeCategory(edge);
    if (!cat || !filters.categories.has(cat)) return false;
  }
  if (filters.type.trim()) {
    if (!edgeCarriesType(edge, filters.type, filters.typeMatch)) return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// URL <-> filter state
// -----------------------------------------------------------------------------

/**
 * Serialize filters into URL search-params so a graph view is shareable
 * (design/edge-typing.md §6 calls out `?type=User&match=structural`).
 *
 * We omit defaults: a freshly-loaded viewer URL stays clean, and only
 * non-default filter state shows up as parameters.
 */
export function filtersToParams(filters: Filters): URLSearchParams {
  const p = new URLSearchParams();
  if (filters.query.trim()) p.set('q', filters.query.trim());
  if (filters.tiers.size > 0) p.set('tier', [...filters.tiers].sort().join(','));
  if (filters.categories.size > 0) {
    p.set('cat', [...filters.categories].sort().join(','));
  }
  if (filters.type.trim()) p.set('type', filters.type.trim());
  if (filters.typeMatch !== 'structural') p.set('match', filters.typeMatch);
  return p;
}

export function paramsToFilters(p: URLSearchParams): Filters {
  const tiers = parseSet(p.get('tier')) as Set<Tier>;
  const categories = new Set<EdgeCategory>();
  for (const v of parseSet(p.get('cat'))) {
    if (CATEGORY_SET.has(v as EdgeCategory)) categories.add(v as EdgeCategory);
  }
  const match = p.get('match');
  return {
    query: p.get('q') ?? '',
    tiers,
    categories,
    type: p.get('type') ?? '',
    typeMatch: match === 'exact' ? 'exact' : 'structural',
  };
}

function parseSet(v: string | null): Set<string> {
  if (!v) return new Set();
  return new Set(v.split(',').map((s) => s.trim()).filter(Boolean));
}

/**
 * Compare two filter states for equality. Used by the FilterBar's URL-sync
 * effect to avoid pushing redundant history entries when the URL already
 * reflects the current state.
 */
export function filtersEqual(a: Filters, b: Filters): boolean {
  return (
    a.query === b.query &&
    a.type === b.type &&
    a.typeMatch === b.typeMatch &&
    setsEqual(a.tiers, b.tiers) &&
    setsEqual(a.categories, b.categories)
  );
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// -----------------------------------------------------------------------------
// internals
// -----------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readString(o: unknown, key: string): string | null {
  if (!isObject(o)) return null;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}
