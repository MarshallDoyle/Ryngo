/**
 * Shared types, constants, and helpers for the five tier-node renderers and
 * the typed-edge renderer.
 *
 * Token names are placeholders and follow the `cg-<area>-<tier>-<role>`
 * convention. When viewer-styles publishes the real token file these
 * `STYLE_TOKEN.*` references swap in, and the inline hex fallbacks here are
 * deleted. The structure of the records below is the contract; the values are
 * not.
 */

import type { Node as IRNode } from '../lib/load-ir';

// ---------- Tiers ----------

export const TIER_SIZE = {
  service: { width: 480, height: 280 },
  module: { width: 280, height: 160 },
  type: { width: 220, minHeight: 100 },
  function: { width: 160, height: 60 },
  expression: { height: 24 },
} as const;

export type LanguageFamily = 'ts' | 'go' | 'python' | 'rust' | 'jvm' | 'unknown';

/** Per-language header tints for service cards (design/nested-nodes.md §1.1). */
export const LANGUAGE_HEADER_TINT: Record<LanguageFamily, string> = {
  ts: 'var(--cg-lang-ts, #5B6B85)',
  go: 'var(--cg-lang-go, #2BA39D)',
  python: 'var(--cg-lang-python, #B98A37)',
  rust: 'var(--cg-lang-rust, #B7410E)',
  jvm: 'var(--cg-lang-jvm, #6B1F2E)',
  unknown: 'var(--cg-lang-unknown, #6B7280)',
};

// ---------- Effects (pure-effectful.md §2, §5) ----------

export type EffectKind =
  | 'exec'
  | 'fs-write'
  | 'db-write'
  | 'network'
  | 'log'
  | 'db-read'
  | 'fs-read'
  | 'mutation-of-arg'
  | 'throw';

/** Severity-ordered list (highest → lowest) per pure-effectful.md §4. */
export const EFFECT_PRIORITY: EffectKind[] = [
  'exec',
  'fs-write',
  'db-write',
  'network',
  'log',
  'db-read',
  'fs-read',
  'mutation-of-arg',
];

/** Effects that get a 2px border (the "danger" tier per §5.2). */
export const DANGER_EFFECTS: ReadonlySet<EffectKind> = new Set([
  'exec',
  'fs-write',
  'db-write',
]);

/** Default-palette fills, indexed by dominant effect (pure-effectful.md §5.2). */
export const EFFECT_FILL: Record<EffectKind, string> = {
  exec: 'var(--cg-effect-exec-fill, #7A1F1F)',
  'fs-write': 'var(--cg-effect-fs-write-fill, #B23A2A)',
  'db-write': 'var(--cg-effect-db-write-fill, #D9542B)',
  network: 'var(--cg-effect-network-fill, #E68A2E)',
  log: 'var(--cg-effect-log-fill, #E8B33A)',
  'db-read': 'var(--cg-effect-db-read-fill, #E8C77A)',
  'fs-read': 'var(--cg-effect-fs-read-fill, #EFD9A6)',
  'mutation-of-arg': 'var(--cg-effect-mutation-of-arg-fill, #C7A26B)',
  throw: 'var(--cg-effect-throw-fill, #D7E4D2)',
};

export const PURE_FILL = 'var(--cg-pure-fill, #D7E4D2)';
export const PURE_BORDER = 'var(--cg-pure-border, #B5C8AE)';
export const PURE_TEXT = 'var(--cg-pure-text, #1A1F1A)';

/** Single-glyph mnemonic per effect (pure-effectful.md §4.1). */
export const EFFECT_GLYPH: Record<EffectKind, string> = {
  exec: 'ⓔ',
  'fs-write': 'ⓦ',
  'db-write': 'ⓓ',
  network: 'ⓝ',
  log: 'ⓛ',
  'db-read': 'ⓡ',
  'fs-read': 'ⓕ',
  'mutation-of-arg': 'ⓜ',
  throw: 'ⓣ',
};

/**
 * Pick the dominant effect from a set; null means pure (or throw-only — the
 * caller checks for that explicitly).
 */
export function dominantEffect(effects: ReadonlySet<EffectKind>): EffectKind | null {
  for (const k of EFFECT_PRIORITY) {
    if (effects.has(k)) return k;
  }
  // mutation-of-arg sits at the bottom of the dominant list (§4); throw alone
  // is not a dominant kind — caller treats throw-only specially.
  if (effects.has('mutation-of-arg')) return 'mutation-of-arg';
  return null;
}

/** Read the effect set off an IR node's attributes, defensively. */
export function readEffects(node: IRNode): Set<EffectKind> {
  const out = new Set<EffectKind>();
  const raw = node.attributes?.['effects'];
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (typeof v === 'string' && (KNOWN_EFFECTS as readonly string[]).includes(v)) {
        out.add(v as EffectKind);
      }
    }
  }
  return out;
}

const KNOWN_EFFECTS: readonly EffectKind[] = [
  'exec',
  'fs-write',
  'db-write',
  'network',
  'log',
  'db-read',
  'fs-read',
  'mutation-of-arg',
  'throw',
];

// ---------- Edge categories (edge-typing.md §1, §3.1) ----------

export type EdgeCategory =
  | 'call'
  | 'import'
  | 'type-flow'
  | 'http-route'
  | 'db-read'
  | 'db-write'
  | 'env-read'
  | 'fs-read'
  | 'fs-write'
  | 'network'
  | 'exec'
  | 'message-publish'
  | 'message-consume';

export type EdgeCertainty = 'resolved' | 'dynamic' | 'adapter' | 'cross-tier';

/** Hex pairs (light, dark) per edge-typing.md §3.1. */
export const EDGE_COLOR: Record<EdgeCategory, { light: string; dark: string }> = {
  'type-flow': { light: '#1F6FEB', dark: '#5AA9FF' },
  'http-route': { light: '#5B5BD6', dark: '#8B8BFF' },
  'db-read': { light: '#0E8C8B', dark: '#3CC4C2' },
  'message-consume': { light: '#0E8C8B', dark: '#3CC4C2' },
  call: { light: '#3F4651', dark: '#A8B0BD' },
  import: { light: '#6B7280', dark: '#9AA3B2' },
  'db-write': { light: '#C0392B', dark: '#FF6B58' },
  'message-publish': { light: '#C0392B', dark: '#FF6B58' },
  'fs-read': { light: '#D17B1A', dark: '#FFAA45' },
  'fs-write': { light: '#D17B1A', dark: '#FFAA45' },
  network: { light: '#B8860B', dark: '#E8B33A' },
  exec: { light: '#B8860B', dark: '#E8B33A' },
  'env-read': { light: '#6B7B27', dark: '#A6C24C' },
};

/**
 * Truncate a type-display string to ~24 chars, middle-elided
 * (edge-typing.md §3.4). Preserves the leading constructor and trailing param.
 */
export function truncateTypeLabel(s: string, max = 24): string {
  if (s.length <= max) return s;
  const keep = max - 1; // 1 for ellipsis
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return s.slice(0, head) + '…' + s.slice(s.length - tail);
}

/**
 * Middle-truncate a name to a fixed character budget (function-name truncation
 * per nested-nodes.md §1.4). Reversible because the caller keeps the full
 * string in a `title` attribute.
 */
export function middleTruncate(s: string, max = 18): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return s.slice(0, head) + '…' + s.slice(s.length - tail);
}

// ---------- Selection / focus tokens ----------

export const SELECTION_RING = 'var(--cg-selection-ring, #5B5BD6)';
export const FOCUS_DASH = 'var(--cg-focus-dash, #8B8BFF)';

// ---------- Type-card members (nested-nodes.md §1.3) ----------

export type TypeMember =
  | { kind: 'field'; name: string; type?: string }
  | { kind: 'method'; name: string; signature?: string };

/** Read the structured member list off a type-tier IR node, defensively. */
export function readTypeMembers(node: IRNode): TypeMember[] {
  const raw = node.attributes?.['members'];
  if (!Array.isArray(raw)) return [];
  const out: TypeMember[] = [];
  for (const m of raw) {
    if (!isObj(m)) continue;
    const name = m['name'];
    const kind = m['kind'];
    if (typeof name !== 'string') continue;
    if (kind === 'method') {
      const signature = typeof m['signature'] === 'string' ? m['signature'] : undefined;
      out.push(signature ? { kind, name, signature } : { kind, name });
    } else {
      const type = typeof m['type'] === 'string' ? m['type'] : undefined;
      out.push(type ? { kind: 'field', name, type } : { kind: 'field', name });
    }
  }
  return out;
}

// ---------- Boundary chips on a service card (nested-nodes.md §1.1) ----------

export type Boundary = { label: string; category: EdgeCategory };

export function readBoundaries(node: IRNode): Boundary[] {
  const raw = node.attributes?.['boundaries'];
  if (!Array.isArray(raw)) return [];
  const out: Boundary[] = [];
  for (const b of raw) {
    if (!isObj(b)) continue;
    const label = b['label'];
    const category = b['category'];
    if (typeof label !== 'string') continue;
    if (typeof category !== 'string') continue;
    out.push({ label, category: category as EdgeCategory });
  }
  return out;
}

// ---------- Node attribute helpers ----------

export function readString(node: IRNode, key: string): string | undefined {
  const v = node.attributes?.[key];
  return typeof v === 'string' ? v : undefined;
}

export function readNumber(node: IRNode, key: string): number | undefined {
  const v = node.attributes?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function readBool(node: IRNode, key: string): boolean | undefined {
  const v = node.attributes?.[key];
  return typeof v === 'boolean' ? v : undefined;
}

export function readLanguage(node: IRNode): LanguageFamily {
  const v = readString(node, 'language');
  switch (v) {
    case 'ts':
    case 'typescript':
    case 'js':
    case 'javascript':
      return 'ts';
    case 'go':
    case 'golang':
      return 'go';
    case 'python':
    case 'py':
      return 'python';
    case 'rust':
    case 'rs':
      return 'rust';
    case 'java':
    case 'kotlin':
    case 'scala':
    case 'jvm':
      return 'jvm';
    default:
      return 'unknown';
  }
}

/** Read the tri-state side-effect pill on a module (nested-nodes.md §1.2). */
export function readModuleSideEffectState(node: IRNode): 'clean' | 'impure' | 'io' | undefined {
  const v = readString(node, 'sideEffects');
  if (v === 'clean' || v === 'impure' || v === 'io') return v;
  return undefined;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------- Card-style derivation ----------

/**
 * Derive fill / border / text colors for an *impure-aware* tier card. Returns
 * tokens that work for `style={...}` on the card div.
 *
 * Pure-vs-effectful coloring per pure-effectful.md §5: the card fill is the
 * gradient color of the dominant effect; border thickness is 2px for danger,
 * 1px otherwise; throw-only is hatched.
 */
export function deriveEffectStyle(effects: ReadonlySet<EffectKind>): {
  fill: string;
  border: string;
  borderWidth: 1 | 2;
  hatched: boolean;
} {
  const dominant = dominantEffect(effects);
  const throwOnly = !dominant && effects.size === 1 && effects.has('throw');
  if (throwOnly) {
    return { fill: PURE_FILL, border: PURE_BORDER, borderWidth: 1, hatched: true };
  }
  if (!dominant) {
    return { fill: PURE_FILL, border: PURE_BORDER, borderWidth: 1, hatched: false };
  }
  const isDanger = DANGER_EFFECTS.has(dominant);
  return {
    fill: EFFECT_FILL[dominant],
    border: `var(--cg-effect-${dominant}-border, ${EFFECT_FILL[dominant]})`,
    borderWidth: isDanger ? 2 : 1,
    hatched: false,
  };
}

/** CSS for the throw-only diagonal hatch overlay. */
export const THROW_HATCH_BG =
  'repeating-linear-gradient(45deg, transparent 0 3px, rgba(0,0,0,0.08) 3px 4px)';

// ---------- Leaf / sink badges (used by viewer-inspector too) ----------

export function isLeaf(node: IRNode): boolean {
  return readBool(node, 'isLeaf') === true;
}

export function isSink(node: IRNode): boolean {
  return readBool(node, 'isSink') === true;
}

export function hasWarning(node: IRNode): boolean {
  return readBool(node, 'hasWarning') === true;
}

export function isRecursive(node: IRNode): boolean {
  return readBool(node, 'isRecursive') === true;
}
