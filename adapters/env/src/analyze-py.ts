/**
 * adapter-env — Python analyzer.
 *
 * Walks one Python file's AST and emits the same per-file findings as the
 * TS analyzer. Symmetry is intentional: the index.ts caller doesn't care
 * which language a finding came from when it flushes IR.
 *
 * Patterns recognized:
 *
 *   os.environ['DATABASE_URL']                        → name='DATABASE_URL', source='os.environ'
 *   os.environ.get('DATABASE_URL')                    → name='DATABASE_URL', source='os.environ.get'
 *   os.environ.get('DATABASE_URL', 'default')         → ... defaultValue='default'
 *   os.getenv('DATABASE_URL')                         → name='DATABASE_URL', source='os.getenv'
 *   os.getenv('DATABASE_URL', 'default')              → ... defaultValue='default'
 *
 *   environ['X']                                      ← `from os import environ`
 *   getenv('X')                                       ← `from os import getenv`
 *   getenv('X')        with `import os as _os`        ← namespace alias variant
 *
 *   class Settings(BaseSettings):
 *       database_url: str
 *       debug: bool = False
 *       model_config = SettingsConfigDict(env_prefix="APP_")
 *     → for each annotated field: name=<PREFIX><UPPERCASE_FIELD_NAME>, source='pydantic-settings'
 *
 * Why we walk the tree ourselves rather than rely solely on the
 * SymbolIndex: the spec's `SymbolIndex` exposes definitions and references,
 * but doesn't surface subscript keys, call argument string literals, or
 * class-body annotated fields as first-class refs/defs. Per coordination
 * with py-indexer, that's a known gap; once `ParsedRef.subscriptKey` and
 * `def.field` ship we can switch to those for primary detection. Until
 * then we operate against the AST directly via the SDK's normalized
 * walker.
 *
 * Determinism contract: this module never depends on iteration order of
 * Python dicts/sets, never reads files outside `ctx.file`, and treats the
 * AST as the only source of truth.
 */

import type {
  AnalyzeFileContext,
  IrId,
  SourceRange,
} from "@codegraph/adapter-sdk";
import type { EnvReadSource, PerFileEnvFinding } from "./types.js";

interface AstNode {
  readonly type: string;
  readonly range: SourceRange;
  readonly [key: string]: unknown;
}

interface AstWalker {
  walk(visitors: Record<string, (node: AstNode, parent?: AstNode) => void>): void;
}

/**
 * The names we resolve through `from os import ...` so that bare
 * `environ['X']` / `getenv('X')` calls can be linked back to the os module.
 *
 * The map is `localBindingName → originalImportName`. So
 * `from os import getenv as ge` records `'ge' → 'getenv'`.
 *
 * We keep this per-file scoped (Python imports don't bleed across modules).
 */
type ImportResolver = Map<string, "environ" | "getenv">;

/**
 * Bindings introduced by `import os` / `import os as foo`. Map of binding
 * → True; we only need the keys to gate `<binding>.environ.X` lookups.
 */
type OsBindings = Set<string>;

export function analyzePyFile(
  ctx: AnalyzeFileContext,
  findings: PerFileEnvFinding[],
): void {
  const ast = ctx.file.ast;
  if (!ast) return;

  const walker = ast as unknown as AstWalker;

  const fromOs: ImportResolver = new Map();
  const osBindings: OsBindings = new Set();

  // First pass: collect imports. Two-pass walk so visitor order doesn't
  // matter when the file places imports below their first use (rare in
  // Python but legal). The SDK walks once and we feed both visitor sets;
  // we put import collection in a guard and just let the walker hit it
  // first naturally (Python files have imports at the top in practice).
  walker.walk({
    // import os, import os as <alias>
    Import(node) {
      const names = (node["names"] as ReadonlyArray<AstNode> | undefined) ?? [];
      for (const alias of names) {
        const moduleName = alias["name"] as string | undefined;
        if (moduleName !== "os") continue;
        const local = (alias["asname"] as string | undefined) ?? moduleName;
        osBindings.add(local);
      }
    },
    // from os import environ, getenv [as ...]
    ImportFrom(node) {
      const moduleName = node["module"] as string | undefined;
      if (moduleName !== "os") return;
      const names = (node["names"] as ReadonlyArray<AstNode> | undefined) ?? [];
      for (const alias of names) {
        const original = alias["name"] as string | undefined;
        if (original !== "environ" && original !== "getenv") continue;
        const local = (alias["asname"] as string | undefined) ?? original;
        fromOs.set(local, original);
      }
    },

    // ----- Calls: os.environ.get(...), os.getenv(...), getenv(...) -------
    Call(node) {
      const result = matchOsCall(node, osBindings, fromOs);
      if (!result) return;

      const args = (node["args"] as ReadonlyArray<AstNode> | undefined) ?? [];
      const keyArg = args[0];
      const name = constString(keyArg);
      if (!name || !isValidEnvVarName(name)) {
        // Non-literal key — record a diagnostic on the call but not a leaf.
        if (keyArg) {
          ctx.diagnostic({
            severity: "warn",
            code: "env/dynamic-key",
            message: `${result.source} called with non-literal key; cannot statically resolve env var name.`,
            file: ctx.file.path,
            range: keyArg.range,
          });
        }
        return;
      }

      const defaultValue = constString(args[1]);
      const enclosingFunctionId = enclosingFunctionFor(ctx, node.range.startByte);

      findings.push({
        name,
        source: result.source,
        range: node.range,
        defaultValue,
        enclosingFunctionId,
      });
    },

    // ----- Subscript: os.environ['X'] / environ['X'] ---------------------
    Subscript(node) {
      const value = node["value"] as AstNode | undefined;
      const slice = node["slice"] as AstNode | undefined;
      if (!value || !slice) return;
      // Resolve the value to the `environ` reference.
      const isEnviron = matchEnvironExpr(value, osBindings, fromOs);
      if (!isEnviron) return;
      // The "slice" is either an Index(value=Constant('X')) (legacy CPython
      // ast layout) or a Constant directly (new layout). Try both.
      const inner =
        slice.type === "Index" ? (slice["value"] as AstNode | undefined) : slice;
      const name = constString(inner);
      if (!name || !isValidEnvVarName(name)) {
        if (inner) {
          ctx.diagnostic({
            severity: "warn",
            code: "env/dynamic-key",
            message:
              "os.environ subscripted with non-literal key; cannot statically resolve env var name.",
            file: ctx.file.path,
            range: inner.range,
          });
        }
        return;
      }
      findings.push({
        name,
        source: "os.environ",
        range: node.range,
        defaultValue: undefined,
        enclosingFunctionId: enclosingFunctionFor(ctx, node.range.startByte),
      });
    },

    // ----- pydantic-settings: class Settings(BaseSettings): ... ----------
    ClassDef(node) {
      const bases = (node["bases"] as ReadonlyArray<AstNode> | undefined) ?? [];
      const isSettings = bases.some(isBaseSettingsRef);
      if (!isSettings) return;

      const body = (node["body"] as ReadonlyArray<AstNode> | undefined) ?? [];
      const prefix = extractEnvPrefix(body) ?? "";

      const enclosingFunctionId = enclosingFunctionFor(ctx, node.range.startByte);

      for (const stmt of body) {
        // AnnAssign = `field: type [= default]`
        if (stmt.type !== "AnnAssign") continue;
        const target = stmt["target"] as AstNode | undefined;
        if (!target || target.type !== "Name") continue;
        const fieldName = target["id"] as string | undefined;
        if (!fieldName) continue;
        // Skip `model_config: ...` and `Config: ...` — those are config,
        // not env-var fields.
        if (fieldName === "model_config" || fieldName === "Config") continue;
        // Convention: pydantic-settings uppercases field names to env keys
        // (case-insensitive on Windows, case-preserving on POSIX). Apply
        // prefix + uppercased field name.
        const envName = `${prefix}${fieldName.toUpperCase()}`;
        if (!isValidEnvVarName(envName)) continue;

        // Default value, if literal.
        const defaultValue = constString(stmt["value"] as AstNode | undefined);

        findings.push({
          name: envName,
          source: "pydantic-settings",
          range: stmt.range,
          defaultValue,
          enclosingFunctionId,
        });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Pattern matchers
// ---------------------------------------------------------------------------

/**
 * Match a Call node and return which env source it represents, or null.
 *
 * Recognized:
 *   os.environ.get('X')        → 'os.environ.get'
 *   os.getenv('X')             → 'os.getenv'
 *   getenv('X')   (after `from os import getenv`) → 'os.getenv'
 *
 * Not recognized:
 *   environ.get('X')           ← `from os import environ; environ.get('X')`
 *                                 — this is a method call on the dict; we'd
 *                                 need to track that `environ` is a dict.
 *                                 Skipped for v0.1; use os.environ.get instead.
 */
function matchOsCall(
  node: AstNode,
  osBindings: OsBindings,
  fromOs: ImportResolver,
): { source: EnvReadSource } | null {
  const func = node["func"] as AstNode | undefined;
  if (!func) return null;

  // Bare-name call: getenv('X')
  if (func.type === "Name") {
    const id = func["id"] as string | undefined;
    if (!id) return null;
    const original = fromOs.get(id);
    if (original === "getenv") return { source: "os.getenv" };
    return null;
  }

  // Attribute call: <something>.<method>(args)
  if (func.type === "Attribute") {
    const attr = func["attr"] as string | undefined;
    const value = func["value"] as AstNode | undefined;
    if (!attr || !value) return null;

    // <os>.getenv(...)
    if (attr === "getenv" && value.type === "Name") {
      const obj = value["id"] as string | undefined;
      if (obj && osBindings.has(obj)) return { source: "os.getenv" };
      return null;
    }
    // <os>.environ.get(...)
    if (attr === "get" && value.type === "Attribute") {
      const innerAttr = value["attr"] as string | undefined;
      const innerObj = value["value"] as AstNode | undefined;
      if (
        innerAttr === "environ" &&
        innerObj?.type === "Name" &&
        osBindings.has(innerObj["id"] as string)
      ) {
        return { source: "os.environ.get" };
      }
    }
  }
  return null;
}

/**
 * Match a value expression that resolves to `os.environ` (for subscripts).
 *   os.environ           → Attribute(value=Name('os'), attr='environ')
 *   environ              ← `from os import environ`
 */
function matchEnvironExpr(
  node: AstNode,
  osBindings: OsBindings,
  fromOs: ImportResolver,
): boolean {
  if (node.type === "Name") {
    const id = node["id"] as string | undefined;
    return !!id && fromOs.get(id) === "environ";
  }
  if (node.type === "Attribute") {
    const attr = node["attr"] as string | undefined;
    const value = node["value"] as AstNode | undefined;
    if (
      attr === "environ" &&
      value?.type === "Name" &&
      osBindings.has(value["id"] as string)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Is a base-class reference `BaseSettings` (or `pydantic_settings.BaseSettings`,
 * or the legacy `pydantic.BaseSettings`)?
 *
 * We don't follow imports here because BaseSettings is the conventional
 * name and false positives (some non-pydantic class also called
 * BaseSettings) are vanishingly rare. The sound thing for a future
 * iteration is to require the import map to confirm it resolves to one
 * of the two pydantic packages.
 */
function isBaseSettingsRef(node: AstNode): boolean {
  if (node.type === "Name") {
    return (node["id"] as string | undefined) === "BaseSettings";
  }
  if (node.type === "Attribute") {
    return (node["attr"] as string | undefined) === "BaseSettings";
  }
  return false;
}

/**
 * Find `model_config = SettingsConfigDict(env_prefix="...")` or
 * `class Config: env_prefix = "..."` inside a class body and return the
 * prefix string, or undefined if none.
 *
 * Only literal-string prefixes are returned. Computed prefixes (e.g.
 * `env_prefix=os.environ['BASE_PREFIX']`) are ignored — we don't unfold
 * computed config.
 */
function extractEnvPrefix(body: ReadonlyArray<AstNode>): string | undefined {
  for (const stmt of body) {
    // model_config = SettingsConfigDict(env_prefix="X_")
    if (stmt.type === "Assign") {
      const targets = (stmt["targets"] as ReadonlyArray<AstNode> | undefined) ?? [];
      const target0 = targets[0];
      if (
        target0?.type === "Name" &&
        (target0["id"] as string | undefined) === "model_config"
      ) {
        const value = stmt["value"] as AstNode | undefined;
        if (value?.type === "Call") {
          const kw = (value["keywords"] as ReadonlyArray<AstNode> | undefined) ?? [];
          for (const k of kw) {
            if ((k["arg"] as string | undefined) === "env_prefix") {
              const v = constString(k["value"] as AstNode | undefined);
              if (typeof v === "string") return v;
            }
          }
        }
        // Plain dict: model_config = {"env_prefix": "X_"}.
        if (value?.type === "Dict") {
          const keys = (value["keys"] as ReadonlyArray<AstNode> | undefined) ?? [];
          const values = (value["values"] as ReadonlyArray<AstNode> | undefined) ?? [];
          for (let i = 0; i < keys.length; i++) {
            if (constString(keys[i]) === "env_prefix") {
              const v = constString(values[i]);
              if (typeof v === "string") return v;
            }
          }
        }
      }
    }
    // class Config: env_prefix = "X_"  (legacy pydantic v1)
    if (stmt.type === "ClassDef" && (stmt["name"] as string | undefined) === "Config") {
      const innerBody = (stmt["body"] as ReadonlyArray<AstNode> | undefined) ?? [];
      for (const inner of innerBody) {
        if (inner.type !== "Assign") continue;
        const targets = (inner["targets"] as ReadonlyArray<AstNode> | undefined) ?? [];
        const t = targets[0];
        if (
          t?.type === "Name" &&
          (t["id"] as string | undefined) === "env_prefix"
        ) {
          const v = constString(inner["value"] as AstNode | undefined);
          if (typeof v === "string") return v;
        }
      }
    }
  }
  return undefined;
}

/**
 * Resolve an AST node believed to be a literal string and return its
 * value, or undefined if it isn't a string literal.
 *
 * Handles both `Constant(value='x')` (Python 3.8+) and the older
 * `Str(s='x')` shape, since some indexers still emit the latter.
 */
function constString(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "Constant") {
    const v = node["value"];
    return typeof v === "string" ? v : undefined;
  }
  if (node.type === "Str") {
    const s = node["s"];
    return typeof s === "string" ? s : undefined;
  }
  // f-strings (`JoinedStr`) and concatenations are not statically
  // resolvable in general; skip them.
  return undefined;
}

/**
 * Smallest enclosing function/method NodeId at byte offset, or null.
 * Same algorithm as in analyze-ts.ts; kept duplicated rather than shared
 * because the two analyzers might diverge as they evolve (e.g. Python
 * methods need a `receiverType`-based id, TS has overload arity).
 */
function enclosingFunctionFor(ctx: AnalyzeFileContext, byte: number): IrId | null {
  const symbols = ctx.file.symbols;
  if (!symbols) return null;
  let best: { id: IrId; size: number } | null = null;
  for (const def of symbols.definitions) {
    if (def.kind !== "function" && def.kind !== "method") continue;
    const r = def.range;
    if (r.startByte > byte || r.endByte <= byte) continue;
    const size = r.endByte - r.startByte;
    if (!best || size < best.size) {
      best = { id: def.id, size };
    }
  }
  return best ? best.id : null;
}

function isValidEnvVarName(name: string): boolean {
  if (name.length === 0) return false;
  if (name.length > 256) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return false;
  }
  return true;
}
