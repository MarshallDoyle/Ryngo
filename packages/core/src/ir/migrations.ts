/**
 * IR schema migrations.
 *
 * Migrations operate on RAW JSON (parsed `unknown`) BEFORE validation, so an
 * old document with an outdated shape can be lifted to the current shape and
 * then validated. The validator only sees the current schema.
 *
 * v0.1.0 is current. The registry intentionally starts empty — there is no
 * older schema yet — but the scaffold + types are wired so that future
 * migrations slot in without churn.
 */
import type { SchemaVersion } from './types';
import { SCHEMA_VERSION } from './types';

/** A pure transform from one document version to the next. */
export type MigrationFn = (doc: unknown) => unknown;

export interface Migration {
  /** Version this migration consumes. */
  from: SchemaVersion;
  /** Version this migration produces. */
  to: SchemaVersion;
  /** Pure function (no I/O, no Date.now, no randomness). */
  apply: MigrationFn;
}

/**
 * Registry of migrations keyed by their `from` version. The lookup chain:
 *   while doc.schemaVersion !== CURRENT:
 *     m = registry.get(doc.schemaVersion)
 *     if !m: throw  (no path forward)
 *     doc = m.apply(doc); doc.schemaVersion = m.to
 *
 * Two migrations sharing a `from` is a programming error — the registry
 * rejects the second registration so the upgrade path stays unambiguous.
 */
export class MigrationRegistry {
  private readonly byFrom = new Map<SchemaVersion, Migration>();

  register(migration: Migration): void {
    if (this.byFrom.has(migration.from)) {
      throw new Error(
        `MigrationRegistry: duplicate migration from ${migration.from} ` +
          `(existing -> ${this.byFrom.get(migration.from)!.to}, ` +
          `new -> ${migration.to})`,
      );
    }
    if (migration.from === migration.to) {
      throw new Error(
        `MigrationRegistry: refusing to register no-op migration ${migration.from} -> ${migration.to}`,
      );
    }
    this.byFrom.set(migration.from, migration);
  }

  get(from: SchemaVersion): Migration | undefined {
    return this.byFrom.get(from);
  }

  has(from: SchemaVersion): boolean {
    return this.byFrom.has(from);
  }

  /** Number of registered migrations. Mostly for tests. */
  size(): number {
    return this.byFrom.size;
  }

  /** Sorted (by `from`) snapshot of the registered migrations. */
  list(): readonly Migration[] {
    return [...this.byFrom.values()].sort((a, b) =>
      a.from < b.from ? -1 : a.from > b.from ? 1 : 0,
    );
  }
}

/**
 * The shared registry. v0.1 ships empty — there is no prior schema.
 * Future versions register their migrations here at module-load time.
 */
export const migrations = new MigrationRegistry();

/**
 * Walk the registry, applying migrations until `doc.schemaVersion` reaches
 * `target` (default: current `SCHEMA_VERSION`). Each step both transforms the
 * payload and stamps `schemaVersion` to the migration's `to` value, so a
 * migration's `apply` does NOT need to bump the version itself.
 *
 * Throws if:
 *   - the input is not a record with a string `schemaVersion`,
 *   - no migration is registered for the current version (and we are not yet
 *     at the target),
 *   - a cycle is detected (defense-in-depth; the registry's invariants make
 *     this impossible in practice).
 */
export function migrateToCurrent(
  input: unknown,
  registry: MigrationRegistry = migrations,
  target: SchemaVersion = SCHEMA_VERSION,
): unknown {
  if (!isRecord(input)) {
    throw new MigrationError('document is not an object');
  }
  if (typeof input.schemaVersion !== 'string') {
    throw new MigrationError(
      'document is missing a string `schemaVersion`; cannot determine migration path',
    );
  }

  let current: Record<string, unknown> = { ...input };
  const visited = new Set<string>();
  let steps = 0;
  // A cap proportional to the registry size guarantees termination even in
  // pathological cases. +2 leaves room for the start version and the target.
  const maxSteps = registry.size() + 2;

  while (current.schemaVersion !== target) {
    const from = current.schemaVersion as SchemaVersion;
    if (visited.has(from)) {
      throw new MigrationError(
        `migration cycle detected at schemaVersion=${from}`,
      );
    }
    visited.add(from);

    const m = registry.get(from);
    if (!m) {
      throw new MigrationError(
        `no migration registered from schemaVersion=${from} ` +
          `(target=${target}); upgrade the producer or add a migration`,
      );
    }

    const next = m.apply(current);
    if (!isRecord(next)) {
      throw new MigrationError(
        `migration ${m.from} -> ${m.to} returned a non-object`,
      );
    }
    current = { ...next, schemaVersion: m.to };

    if (++steps > maxSteps) {
      throw new MigrationError(
        `migration chain exceeded ${maxSteps} steps; aborting to prevent infinite loop`,
      );
    }
  }

  return current;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
