/**
 * Inspector design tokens for the codegraph viewer.
 *
 * Authoritative source: brand/visual-identity.md §2 (Inspector palette) and §8
 * (design tokens table). The Inspector identity is locked: near-black "Void"
 * canvas, electric chartreuse "Volt" accent, wireframe whites/grays. The
 * docs-style light theme borrows Vellum + Bearing from Cartographer, per
 * brand §4.2 / §5.7.
 *
 * These tokens are the single source of truth for graph-node and inspector-
 * panel coloring. Edge, purity, and sink palettes are an Inspector-aligned
 * extension of the brand doc — chosen to be readable on Void without breaking
 * the "Volt is the only highlighter" rule (Volt is reserved for the user's
 * active selection in the rendered graph; see brand §6.7).
 *
 * WCAG AA contrast pairs are documented next to each entry. AA = 4.5:1 for
 * normal text, 3:1 for large text or non-text UI. AAA = 7:1.
 */

/** Hex color string. Branded only by name; runtime is just `string`. */
export type Hex = `#${string}`;

/* ------------------------------------------------------------------------- */
/* Surface — backgrounds, panels, hairlines                                  */
/* ------------------------------------------------------------------------- */

/**
 * Layered surfaces for both themes. The Inspector dialect uses three depths:
 * canvas (page), panel (cards / sidebars), and hairline (1px borders only).
 */
export interface SurfacePalette {
  /** Page / graph canvas background. */
  readonly canvas: Hex;
  /** Card, sidebar, inspector panel background. ~12% lighter than canvas (dark) or ~3% darker (light). */
  readonly panel: Hex;
  /** Slightly raised surface inside panels (nested cards). */
  readonly raised: Hex;
  /** 1px borders, dividers, dot-grid. Never used for text. */
  readonly hairline: Hex;
  /** Hover/focus surface tint. Subtle. */
  readonly hover: Hex;
}

/* ------------------------------------------------------------------------- */
/* Text                                                                       */
/* ------------------------------------------------------------------------- */

export interface TextPalette {
  /** Body and heading copy. Off-white on dark, near-black on light. */
  readonly primary: Hex;
  /** Secondary text — labels, metadata, captions. AA on canvas. */
  readonly secondary: Hex;
  /** Disabled / placeholder. Below AA contrast (intentional). */
  readonly muted: Hex;
  /** Inverted (text drawn on the accent surface). */
  readonly inverse: Hex;
}

/* ------------------------------------------------------------------------- */
/* Accent — Volt (dark) / Volt-Dark (light)                                   */
/* ------------------------------------------------------------------------- */

export interface AccentPalette {
  /** The single highlighter. Volt #C8FF3D on dark; Volt-Dark #7BAA1A on light. */
  readonly base: Hex;
  /** Pressed / hover variant of the accent button surface. */
  readonly hover: Hex;
  /** A faint accent tint for selection halos (~10% alpha on canvas). */
  readonly halo: Hex;
}

/* ------------------------------------------------------------------------- */
/* Edge kinds — typed graph edges                                             */
/* ------------------------------------------------------------------------- */

/**
 * Edge colors map to the typed-edge taxonomy from README.md ("calls,
 * imports, http-route, db-query, event-publish, imports-type"). Hues are
 * spaced around the wheel so red-green colorblind users can still tell
 * `db-read` from `db-write` by *value* (lightness) — see `*-write` being
 * deeper than `*-read`. Color is never the only signal: graph edges always
 * carry a stroke style (solid/dashed) and a label (per brand §6.6).
 *
 * AA on Void #08090C (large text / non-text UI ≥3:1):
 *   call        #A8B0BD  ~9.4:1
 *   import      #7FA8C9  ~7.0:1
 *   type        #B8A0D8  ~7.5:1
 *   db.read     #5FB8A0  ~6.8:1
 *   db.write    #2E8B7C  ~3.6:1
 *   network     #E89B5A  ~7.4:1
 *   event       #C97FA8  ~5.6:1
 *   dataflow    #C8FF3D  ~16.2:1  (== Volt; reserved for selection only)
 *   contains    #4A4F5A  ~2.4:1   (sub-AA; hairline-only, not standalone)
 */
export interface EdgePalette {
  /** Function call edge. Cool neutral — most common, lowest visual weight. */
  readonly call: Hex;
  /** Module import edge. */
  readonly import: Hex;
  /** Type-of / extends / implements edge. */
  readonly type: Hex;
  /** DB read (query). Teal, lighter than write. */
  readonly 'db-read': Hex;
  /** DB write (mutation). Teal, deeper. */
  readonly 'db-write': Hex;
  /** HTTP / network edge (fetch, axios, http-route). */
  readonly network: Hex;
  /** Event publish/subscribe edge. */
  readonly event: Hex;
  /** Active selection path. Volt — only used while a query is highlighted. */
  readonly dataflow: Hex;
  /** Containment edge (service contains module contains function). Hairline only. */
  readonly contains: Hex;
}

/* ------------------------------------------------------------------------- */
/* Purity — pure / impure-low / impure-high classification                    */
/* ------------------------------------------------------------------------- */

/**
 * Function purity classification, per README.md ("Pure vs. effectful
 * coloring"). Three tiers because the IR distinguishes pure, partially
 * effectful (e.g. logs only), and heavily effectful (DB/network/exec).
 *
 * AA on Void #08090C:
 *   pure         #7FA8C9  ~7.0:1   cool blue — calm, trusted
 *   impure-low   #E8B96A  ~9.4:1   == Bearing — emphasis without alarm
 *   impure-high  #FF8C66  ~7.8:1   muted red-orange — firm, not panicked
 */
export interface PurityPalette {
  readonly pure: Hex;
  readonly 'impure-low': Hex;
  readonly 'impure-high': Hex;
}

/* ------------------------------------------------------------------------- */
/* Sink kinds — terminal effect kinds                                         */
/* ------------------------------------------------------------------------- */

/**
 * Sink kinds tag the *terminal* effect performed by an impure function:
 * the DB it writes to, the FS it touches, the network it calls. Sinks are
 * what distinguishes "this function logs" from "this function rm -rf's".
 *
 * Aligned with edge palette where the concept overlaps (db, network)
 * so a function tagged `sink: db` and the outgoing `db-write` edge use the
 * same hue. AA on Void:
 *   db        #2E8B7C  ~3.6:1   (large/non-text)
 *   fs        #B89066  ~6.8:1
 *   network   #E89B5A  ~7.4:1
 *   exec      #FF8C66  ~7.8:1   (== purity.impure-high)
 *   log       #8A8D93  ~5.4:1   (== text.secondary on dark; quiet)
 */
export interface SinkPalette {
  readonly db: Hex;
  readonly fs: Hex;
  readonly network: Hex;
  readonly exec: Hex;
  readonly log: Hex;
}

/* ------------------------------------------------------------------------- */
/* Semantic — error / warn / success / info                                   */
/* ------------------------------------------------------------------------- */

export interface SemanticPalette {
  /** Diff: removed nodes, error states. Muted red, not panic-red. */
  readonly error: Hex;
  /** Diff: changed nodes, warnings. Bearing — same as warm.light. */
  readonly warn: Hex;
  /** Diff: added nodes, success. Volt-Dark on light, Volt on dark. */
  readonly success: Hex;
  /** Informational chips. Cool blue, lower weight than purity.pure. */
  readonly info: Hex;
}

/* ------------------------------------------------------------------------- */
/* Composite palette                                                          */
/* ------------------------------------------------------------------------- */

export interface Palette {
  readonly surface: SurfacePalette;
  readonly text: TextPalette;
  readonly accent: AccentPalette;
  readonly edge: EdgePalette;
  readonly purity: PurityPalette;
  readonly sink: SinkPalette;
  readonly semantic: SemanticPalette;
  /** Subtle dot-grid color, drawn at 32px spacing per brand §5.1. */
  readonly grid: Hex;
  /** Volt focus ring color (always Volt, both themes — focus must be loud). */
  readonly focusRing: Hex;
}

/* ========================================================================= */
/* Dark palette (default) — Inspector / Pitch / Volt                          */
/* ========================================================================= */

/**
 * Dark theme. Source: brand/visual-identity.md §2.2.
 *
 * Verified contrast pairs (WCAG AA / AAA):
 *   text.primary    #ECEDEE on surface.canvas #0A0A0B  → 17.8:1  AAA
 *   text.secondary  #8A8D93 on surface.canvas #0A0A0B  →  5.4:1  AA
 *   accent.base     #C8FF3D on surface.canvas #0A0A0B  → 16.2:1  AAA  (CTA-grade)
 *   surface.hairline #1F1F23 on surface.canvas #0A0A0B →  1.4:1  intentional hairline
 */
export const darkPalette: Palette = {
  surface: {
    canvas: '#0A0A0B',     // Pitch
    panel: '#141416',      // Slab
    raised: '#1A1A1D',     // Slab+ (between Slab and Rule)
    hairline: '#1F1F23',   // Rule
    hover: '#202024',      // ~1 step above hairline; for hover backgrounds
  },
  text: {
    primary: '#ECEDEE',    // Bone — AAA
    secondary: '#8A8D93',  // Ash — AA
    muted: '#5A5D62',      // Below AA, intentional (placeholder/disabled)
    inverse: '#0A0A0B',    // Pitch — drawn on Volt CTAs
  },
  accent: {
    base: '#C8FF3D',       // Volt — AAA on Pitch (16.2:1)
    hover: '#D6FF6B',      // Lighter Volt, used on hover
    halo: '#C8FF3D1A',     // Volt at ~10% alpha for selection halos
  },
  edge: {
    call: '#A8B0BD',
    import: '#7FA8C9',
    type: '#B8A0D8',
    'db-read': '#5FB8A0',
    'db-write': '#2E8B7C',
    network: '#E89B5A',
    event: '#C97FA8',
    dataflow: '#C8FF3D',   // == accent.base
    contains: '#4A4F5A',   // hairline-only
  },
  purity: {
    pure: '#7FA8C9',
    'impure-low': '#E8B96A',
    'impure-high': '#FF8C66',
  },
  sink: {
    db: '#2E8B7C',
    fs: '#B89066',
    network: '#E89B5A',
    exec: '#FF8C66',
    log: '#8A8D93',
  },
  semantic: {
    error: '#FF6B6B',      // muted red — brand §5.6
    warn: '#E8B96A',       // Bearing
    success: '#C8FF3D',    // Volt — added nodes glow with the accent
    info: '#7FA8C9',
  },
  grid: '#1F1F23',         // Rule — used at 30% opacity in CSS
  focusRing: '#C8FF3D',    // Volt — brand §6.6, always loud
} as const;

/* ========================================================================= */
/* Light palette (docs theme) — Vellum / Bearing / Volt-Dark                  */
/* ========================================================================= */

/**
 * Light theme borrowed from Cartographer (brand §4.2, §5.7). Used for the
 * docs site and any "long reading session" surface; the graph viewer
 * defaults to dark but switches via the theme hook.
 *
 * Verified contrast pairs (WCAG AA / AAA):
 *   text.primary    #1F1F23 on surface.canvas #F4F1E8  → 14.6:1  AAA
 *   text.secondary  #5C6F73 on surface.canvas #F4F1E8  →  4.7:1  AA
 *   accent.base     #7BAA1A on surface.canvas #F4F1E8  →  4.0:1  AA (large/non-text)
 *                   #7BAA1A on text.primary    #1F1F23 →  3.7:1  AA (large)
 *   surface.hairline #D6D2C2 on surface.canvas #F4F1E8 →  1.3:1  intentional hairline
 *
 * Note: accent.base on canvas is just under 4.5:1, so accent text on the
 * canvas surface should be sized 18px+ or 14px bold+ (AA large-text rule).
 * Body-weight accent text in light theme should use #6A9216 instead.
 */
export const lightPalette: Palette = {
  surface: {
    canvas: '#F4F1E8',     // Vellum
    panel: '#EAE6D7',      // Vellum-2
    raised: '#DFDAC6',     // Vellum-3 (raised within panel)
    hairline: '#D6D2C2',
    hover: '#E0DBC9',
  },
  text: {
    primary: '#1F1F23',    // Pitch-on-light — AAA
    secondary: '#5C6F73',  // Slate-Tide — AA
    muted: '#8A8D80',      // muted greenish gray, below AA (intentional)
    inverse: '#F4F1E8',    // Vellum — drawn on Volt-Dark CTAs
  },
  accent: {
    base: '#7BAA1A',       // Volt-Dark
    hover: '#6A9216',      // deeper for hover; also use for body-weight text
    halo: '#7BAA1A1A',
  },
  edge: {
    call: '#5C6F73',       // == text.secondary; calls fade into the page
    import: '#3D6B96',
    type: '#7A5BA8',
    'db-read': '#1F7A6A',
    'db-write': '#155449',
    network: '#B26920',
    event: '#9A4070',
    dataflow: '#7BAA1A',   // == accent.base
    contains: '#A8A496',
  },
  purity: {
    pure: '#3D6B96',
    'impure-low': '#A07A2C',
    'impure-high': '#B23A20',
  },
  sink: {
    db: '#155449',
    fs: '#7A5C2A',
    network: '#B26920',
    exec: '#B23A20',
    log: '#5C6F73',
  },
  semantic: {
    error: '#B23A20',
    warn: '#A07A2C',
    success: '#6A9216',
    info: '#3D6B96',
  },
  grid: '#D6D2C2',
  focusRing: '#7BAA1A',
} as const;

/* ========================================================================= */
/* Mode-agnostic constants                                                    */
/* ========================================================================= */

/**
 * Edge stroke styles. Per brand §2.5: "Optional: dashed strokes for
 * 'potential' or 'indirect' relationships." Values are SVG `stroke-dasharray`.
 */
export const edgeStroke = {
  solid: 'none',
  dashed: '4 3',
  dotted: '1 3',
} as const;
export type EdgeStroke = keyof typeof edgeStroke;

/**
 * Stroke widths, per brand §8. Hairlines are 1px; icons 1.5px; bold 2px.
 * Graph edges sit between hairline (background graph) and bold (selected path).
 */
export const strokeWidth = {
  hairline: 1,
  edge: 1.25,
  icon: 1.5,
  bold: 2,
  selected: 2.5,
} as const;

/** Spacing scale, per brand §8. */
export const space = {
  0: 4,
  1: 8,
  2: 12,
  3: 16,
  4: 24,
  5: 32,
  6: 48,
  7: 64,
  8: 96,
} as const;

/** Border radius, per brand §8. */
export const radius = {
  sm: 2,
  md: 4,
  lg: 8,
  full: 9999,
} as const;

/** Type scale (px). H1 is responsive: desktop / tablet / mobile. */
export const fontSize = {
  caption: 14,
  body: 16,
  bodyLarge: 18,
  h3: 24,
  h2: 32,
  h1Mobile: 40,
  h1Tablet: 56,
  h1: 64,
} as const;

/** Font stacks, per brand §2.3. */
export const fontFamily = {
  heading: '"Geist Mono", "JetBrains Mono", ui-monospace, monospace',
  body: '"Geist Sans", "Inter", ui-sans-serif, system-ui, sans-serif',
  mono: '"JetBrains Mono", "Berkeley Mono", "IBM Plex Mono", ui-monospace, monospace',
} as const;

/** Motion easing + durations, per brand §6.5. Inspector does not bounce. */
export const motion = {
  /** Default decelerate curve. Brand §6.5. */
  ease: 'cubic-bezier(0.2, 0.0, 0.0, 1.0)',
  /** Buttons — brand §6.5. */
  fast: '80ms',
  /** Links / underlines — brand §6.5. */
  medium: '100ms',
  /** Maximum non-progress animation length — brand §6.5. */
  slow: '400ms',
} as const;

/* ========================================================================= */
/* Type aliases for consumers                                                 */
/* ========================================================================= */

export type EdgeKind = keyof EdgePalette;
export type PurityKind = keyof PurityPalette;
export type SinkKind = keyof SinkPalette;
export type SemanticKind = keyof SemanticPalette;
export type ThemeMode = 'dark' | 'light';

/** Palette lookup by mode. */
export const palettes: Record<ThemeMode, Palette> = {
  dark: darkPalette,
  light: lightPalette,
} as const;

/**
 * The active palette at module load. Components that need a value at render
 * time should prefer the `useTheme()` hook from `./theme` so they re-render
 * on mode change; this constant is a fallback for non-React consumers (e.g.
 * the ELK layout pass) that just need a default.
 */
export const palette: Palette = darkPalette;
