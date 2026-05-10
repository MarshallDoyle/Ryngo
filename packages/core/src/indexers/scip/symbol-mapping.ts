/**
 * SCIP symbol moniker -> codegraph node ID.
 *
 * Implements the canonicalization rule from research/scip.md §3. The two
 * inputs are:
 *
 *   1. A SCIP symbol string. Either `local <id>` or
 *      `<scheme> <manager> <package-name> <version> <descriptor>+`.
 *   2. The relative path of the Document the occurrence was emitted in
 *      (used to namespace local symbols, which are document-scoped).
 *
 * The output is a stable, human-readable string we can use directly as the
 * codegraph node id without further hashing (research/scip.md §3.4 explains
 * why we keep the readable form rather than hashing).
 *
 * This module is pure — no I/O, no env reads. That makes it trivial to test
 * by table-driven shape assertions.
 */

/** A symbol parsed back into its components. */
export interface ParsedScipSymbol {
  /** Always true for `local <n>` symbols; the rest of the fields are absent. */
  readonly isLocal: boolean;
  /** Local id (the integer following `local `). Only set when `isLocal`. */
  readonly localId?: string;

  /** Indexer scheme, e.g. `scip-typescript`. Empty string if absent. */
  readonly scheme?: string;
  /** Package manager, e.g. `npm`, `pypi`, `cargo`, `maven`, `go`. */
  readonly manager?: string;
  /** Package name, e.g. `lodash`, `requests`. `.` is a placeholder for empty. */
  readonly packageName?: string;
  /** Package version. `*` after canonicalization. */
  readonly version?: string;
  /** Descriptor chain (the `<name><suffix>` segments) joined verbatim. */
  readonly descriptor?: string;
}

/** Standard-library collapse table. See research/scip.md §3.3. */
const STDLIB_REPLACEMENTS: ReadonlyArray<{
  scheme: string;
  manager: string;
  packageMatch: RegExp;
  canonical: { manager: string; packageName: string };
}> = [
  // scip-go ships the Go standard library as `go github.com/golang/go go1.x.y`.
  {
    scheme: 'scip-go',
    manager: 'go',
    packageMatch: /^github\.com\/golang\/go$/,
    canonical: { manager: 'go', packageName: 'std' },
  },
  // scip-java ships the JDK as `maven jdk <version>` (e.g. `maven jdk 17`).
  {
    scheme: 'scip-java',
    manager: 'maven',
    packageMatch: /^jdk$/,
    canonical: { manager: 'maven', packageName: 'jdk' },
  },
  // rust-analyzer ships std as `cargo std <version>`.
  {
    scheme: 'rust-analyzer',
    manager: 'cargo',
    packageMatch: /^std$/,
    canonical: { manager: 'cargo', packageName: 'std' },
  },
];

/**
 * Parse a SCIP symbol moniker into its components.
 *
 * SCIP's grammar (§3.1):
 *   <symbol>     ::= <scheme> ' ' <package> ' ' <descriptor>+ | 'local ' <id>
 *   <package>    ::= <manager> ' ' <package-name> ' ' <version>
 *
 * Spaces inside any single field are escaped as `'  '` (double space). We
 * split on a single space but un-escape afterwards.
 */
export function parseScipSymbol(symbol: string): ParsedScipSymbol {
  if (symbol.startsWith('local ')) {
    return { isLocal: true, localId: symbol.slice('local '.length) };
  }

  // Split on single spaces but treat `'  '` (escaped space) as a literal.
  // We do this by scanning; not glamorous but correct.
  const fields = splitTopLevelSpaces(symbol);
  // Expect at least scheme + manager + package-name + version + 1 descriptor
  // segment. Fewer than that means a malformed symbol; we still return what
  // we have so the caller can fall back gracefully.
  const [scheme, manager, packageName, version, ...descriptorParts] = fields;
  const descriptor = descriptorParts.join(' ');

  return {
    isLocal: false,
    scheme: scheme ?? '',
    manager: manager ?? '',
    packageName: packageName ?? '',
    version: version ?? '',
    descriptor: descriptor ?? '',
  };
}

/**
 * Canonicalize a SCIP symbol per the rule in research/scip.md §3.3:
 *
 *   1. Strip the version (replace with `*`). Versions are kept as separate
 *      metadata on the IR node, not the id.
 *   2. Lowercase the manager (e.g. `NPM` -> `npm`).
 *   3. Collapse standard-library packages to the canonical name.
 *
 * Local symbols are namespaced by the relative path of the document they
 * appeared in, since `local 4` is meaningful only inside one Document
 * (research/scip.md §3.5).
 */
export function canonicalize(symbol: string, documentPath?: string): string {
  const parsed = parseScipSymbol(symbol);

  if (parsed.isLocal) {
    if (!documentPath) {
      // Cross-document edges to local symbols are impossible by definition,
      // so a missing path here is a programmer error in the caller.
      throw new Error(
        `canonicalize: documentPath is required to canonicalize local symbol "${symbol}"`,
      );
    }
    return `${normalizePosixPath(documentPath)}:${parsed.localId ?? ''}`;
  }

  const scheme = parsed.scheme ?? '';
  let manager = (parsed.manager ?? '').toLowerCase();
  let packageName = parsed.packageName ?? '';

  for (const rule of STDLIB_REPLACEMENTS) {
    if (
      rule.scheme === scheme &&
      rule.manager === manager &&
      rule.packageMatch.test(packageName)
    ) {
      manager = rule.canonical.manager;
      packageName = rule.canonical.packageName;
      break;
    }
  }

  const descriptor = parsed.descriptor ?? '';
  return `${scheme} ${manager} ${packageName} * ${descriptor}`.trimEnd();
}

/**
 * Pull the original version from a SCIP symbol. Returned separately so the
 * IR node can store it as metadata even though the id strips it.
 */
export function extractVersion(symbol: string): string | undefined {
  const parsed = parseScipSymbol(symbol);
  if (parsed.isLocal) return undefined;
  if (!parsed.version) return undefined;
  return parsed.version;
}

/** True if the symbol is a `local <id>` symbol. */
export function isLocalSymbol(symbol: string): boolean {
  return symbol.startsWith('local ');
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Split a SCIP symbol on single-space separators while preserving the
 * `'  '` (double-space) field-internal escape as a literal space.
 *
 * The descriptor chain itself never contains an unescaped space — descriptors
 * are concatenated without separators (`Map#get().` is one descriptor of two
 * segments). So we only need to handle the four leading fields. To stay
 * forgiving we just merge a `'  '` run back into the previous token.
 */
function splitTopLevelSpaces(s: string): string[] {
  const out: string[] = [];
  let current = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ') {
      // Look ahead: a second space means an escaped literal space.
      if (s[i + 1] === ' ') {
        current += ' ';
        i += 2;
        continue;
      }
      out.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  out.push(current);
  return out;
}

function normalizePosixPath(p: string): string {
  // Windows producers can emit backslashes; the IR is POSIX-normalized.
  // We leave the path otherwise untouched (no leading-`./` strip, since the
  // SCIP Document.relative_path is already repo-rooted).
  return p.replace(/\\/g, '/');
}
