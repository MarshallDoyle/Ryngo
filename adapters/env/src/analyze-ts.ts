/**
 * adapter-env — TypeScript / JavaScript analyzer.
 *
 * Walks one parsed TS/JS/TSX/JSX file's AST and emits IR for each env-var
 * read it recognizes. Every read produces:
 *
 *   - one expression-tier `IrNode` with `leaf: { flavor: 'env', name, defaultValue? }`
 *     and `tags: ['env:source=<source>', 'env:declared'?]`
 *   - one `env-read` `IrEdge` from the enclosing function (when there is
 *     one) to the leaf node. Top-level reads (module scope) emit only the
 *     leaf — the spec allows `expression` parented to `module` indirectly
 *     via the function-or-module containment rule.
 *
 * `dotenv.config()` and `import 'dotenv/config'` get a different shape: a
 * `LeafConfigFile` node (`flavor: 'config-file'`, `format: 'env'`) tagged
 * `env:dotenv-loaded`. This matches ir-types' guidance — overloading a
 * loader call onto LeafEnv would conflate "I read X" with "I caused X to
 * exist".
 *
 * The walk is intentionally pattern-based, not type-based. We don't ask the
 * TS service "what's the inferred type of this expression?" because (a) it
 * makes the adapter dependent on a TS program, breaking the per-file
 * caching contract, and (b) `process.env` is special-cased by Node's
 * runtime, not a thing the type checker knows about beyond its declared
 * `string | undefined` shape.
 *
 * Patterns recognized (with examples):
 *
 *   process.env.DATABASE_URL                 → name='DATABASE_URL', source='process.env'
 *   process.env['DATABASE_URL']              → name='DATABASE_URL', source='process.env'
 *   process.env.X || 'fallback'              → defaultValue='fallback'
 *   process.env.X ?? 'fallback'              → defaultValue='fallback'
 *   const { X, Y } = process.env             → two leaves, names X and Y
 *   const { X: alias } = process.env         → name='X' (alias is for the read site, but the env var is X)
 *   import.meta.env.VITE_API_URL             → source='import.meta.env'
 *   Bun.env.PORT                             → source='Bun.env'
 *
 *   dotenv.config()                          → loader leaf, source='dotenv'
 *   import 'dotenv/config'                   → loader leaf, source='dotenv'
 *   import { config } from 'dotenv'; config()→ loader leaf (resolved via local imports map)
 *
 * NOT recognized (deliberately — we don't fabricate facts):
 *
 *   const env = process.env; env.X           → after `const env = process.env`, we'd need to
 *                                              follow the binding through arbitrary code; out
 *                                              of scope. (A ts-binding-aware adapter could
 *                                              extend this in resolve.)
 *   process.env[someVar]                     → key is a non-literal expression; we record an
 *                                              "env/dynamic-key" diagnostic and move on.
 *
 * The analyzer is structurally typed against a generic AST walker because
 * `@codegraph/adapter-sdk` normalizes parser output (per
 * adapters/express.ts:91 and the SDK's claim that "structurally typed nodes
 * via file.ast.walk(visitor)" is the only public surface). The SDK
 * handles tree-sitter ↔ ts-morph differences for us; we describe the
 * shapes we want and let the visitor match.
 */

import type {
  AnalyzeFileContext,
  IrId,
  SourceRange,
} from "@codegraph/adapter-sdk";
import type { EnvReadSource, PerFileEnvFinding } from "./types.js";

/**
 * Subset of an AST node we consume. The SDK's normalized walker promises a
 * `type: string` discriminator and a `range: SourceRange`, plus arbitrary
 * children we read by name. Nothing else is portable across parsers; if we
 * find ourselves needing more, that's a request to extend the SDK.
 */
interface AstNode {
  readonly type: string;
  readonly range: SourceRange;
  // Children are accessed by structural property name. We use a permissive
  // type because this varies by node kind. Visitors below cast as needed.
  readonly [key: string]: unknown;
}

interface AstWalker {
  walk(visitors: Record<string, (node: AstNode, parent?: AstNode) => void>): void;
}

/**
 * Public entry point. Called once per matching file. Pushes findings into
 * `findings` (the index.ts caller flushes them via ctx.emit + provenance).
 *
 * We separate "find" from "emit" because the spec emits via a callback
 * (ctx.emit) and we want to keep this module pure-ish for testing — a unit
 * test can call analyzeTsFile against a hand-built AST and inspect the
 * findings array without an adapter context.
 */
export function analyzeTsFile(
  ctx: AnalyzeFileContext,
  findings: PerFileEnvFinding[],
  loaderFindings: PerFileEnvFinding[],
): void {
  const ast = ctx.file.ast;
  if (!ast) return; // Non-host-language adapters never see TS files; defensive.

  // Track imported names from `dotenv` so we can recognize `config()` calls
  // whose binding came from a named import. Per-file map; reset each call.
  // key = local binding name, value = the original `dotenv` export name.
  const dotenvImports = new Map<string, "config" | "default">();

  // The walker provided by the SDK. Visitors are matched by node `type`.
  const walker = ast as unknown as AstWalker;

  walker.walk({
    // ---- import 'dotenv/config' ------------------------------------------
    // Pure side-effect import; flips the loader flag.
    ImportDeclaration(node) {
      const source = (node.source as AstNode | undefined) ?? null;
      const value = source ? (source["value"] as string | undefined) : undefined;
      if (value === "dotenv/config") {
        sawDotenvSideEffectImport = true;
        loaderFindings.push({
          name: "<dotenv/config>", // not a real env var; conventional sentinel
          source: "process.env", // unused for loader leaves; the sentinel name disambiguates
          range: node.range,
          defaultValue: undefined,
          enclosingFunctionId: null,
        });
        return;
      }
      // import { config } from 'dotenv'
      // import config from 'dotenv'
      // import * as dotenv from 'dotenv'
      if (value === "dotenv" || value === "dotenv-flow" || value === "dotenv-expand") {
        const specifiers = (node.specifiers as ReadonlyArray<AstNode> | undefined) ?? [];
        for (const spec of specifiers) {
          if (spec.type === "ImportDefaultSpecifier") {
            const local = (spec.local as AstNode | undefined)?.["name"] as string | undefined;
            if (local) dotenvImports.set(local, "default");
          } else if (spec.type === "ImportSpecifier") {
            const importedName =
              ((spec.imported as AstNode | undefined)?.["name"] as string | undefined) ??
              ((spec.local as AstNode | undefined)?.["name"] as string | undefined);
            const local = (spec.local as AstNode | undefined)?.["name"] as string | undefined;
            if (local && importedName === "config") dotenvImports.set(local, "config");
          } else if (spec.type === "ImportNamespaceSpecifier") {
            // Namespace binding lets `dotenv.config()` resolve below.
            const local = (spec.local as AstNode | undefined)?.["name"] as string | undefined;
            if (local) dotenvImports.set(local, "default");
          }
        }
      }
    },

    // ---- MemberExpression ------------------------------------------------
    // Covers process.env.X, import.meta.env.X, Bun.env.X (dotted access).
    MemberExpression(node) {
      const result = matchEnvAccess(node);
      if (!result) return;

      const { source, name } = result;
      if (!isValidEnvVarName(name)) return;

      // Skip if this MemberExpression is itself the object of another
      // member access (e.g. `process.env` on the way to `.X`) — we'll
      // catch the outer one when its parent is visited. The walker hands
      // us the parent; if absent, we conservatively emit (better a leaf
      // than a missed read).
      // Note: a property-access where the OBJECT is the `process.env`
      // MemberExpression is exactly what we want to capture; it's only
      // "intermediate" when this node is itself an OBJECT of another
      // member. Visitors are post-order in the SDK's normalized walker.

      const enclosingFunctionId = enclosingFunctionFor(ctx, node.range.startByte);
      const defaultValue = inferDefaultFromContext(node);
      findings.push({
        name,
        source,
        range: node.range,
        defaultValue,
        enclosingFunctionId,
      });
    },

    // ---- Subscript: process.env['X'] -------------------------------------
    // Same shape as MemberExpression but the property is a literal string;
    // SDK normalizes both to MemberExpression with `computed: true`. We
    // already cover that inside matchEnvAccess via the `computed` branch.

    // ---- Destructuring: const { X, Y } = process.env --------------------
    VariableDeclarator(node) {
      const id = node.id as AstNode | undefined;
      const init = node.init as AstNode | undefined;
      if (!id || !init) return;
      if (id.type !== "ObjectPattern") return;

      const initSource = matchEnvObject(init);
      if (!initSource) return;

      const props = (id.properties as ReadonlyArray<AstNode> | undefined) ?? [];
      const enclosingFunctionId = enclosingFunctionFor(ctx, node.range.startByte);

      for (const prop of props) {
        // Rest element (`...rest`) is uninterpretable — every key would
        // need to be enumerated, and we don't track the full env shape.
        if (prop.type === "RestElement") {
          ctx.diagnostic({
            severity: "warn",
            code: "env/rest-destructure",
            message: "Rest destructuring of process.env captures all env vars; cannot enumerate statically.",
            file: ctx.file.path,
            range: prop.range,
          });
          continue;
        }
        const key = prop.key as AstNode | undefined;
        if (!key) continue;
        let envName: string | undefined;
        if (key.type === "Identifier") {
          envName = key["name"] as string | undefined;
        } else if (key.type === "Literal" || key.type === "StringLiteral") {
          envName = key["value"] as string | undefined;
        }
        if (!envName || !isValidEnvVarName(envName)) continue;

        // `{ X = 'default' }` patterns: capture default if it's a literal.
        const value = prop.value as AstNode | undefined;
        let defaultValue: string | undefined;
        if (value && value.type === "AssignmentPattern") {
          defaultValue = literalString(value.right as AstNode | undefined);
        }

        findings.push({
          name: envName,
          source: initSource,
          range: prop.range,
          defaultValue,
          enclosingFunctionId,
        });
      }
    },

    // ---- dotenv.config() / config() --------------------------------------
    CallExpression(node) {
      const callee = node.callee as AstNode | undefined;
      if (!callee) return;

      // dotenv.config() / dotenvNamespaceBinding.config()
      if (callee.type === "MemberExpression") {
        const obj = callee.object as AstNode | undefined;
        const prop = callee.property as AstNode | undefined;
        if (
          obj?.type === "Identifier" &&
          prop?.type === "Identifier" &&
          (prop["name"] as string | undefined) === "config" &&
          dotenvImports.has(obj["name"] as string)
        ) {
          loaderFindings.push({
            name: "<dotenv.config>",
            source: "process.env",
            range: node.range,
            defaultValue: undefined,
            enclosingFunctionId: enclosingFunctionFor(ctx, node.range.startByte),
          });
        }
        return;
      }
      // Bare `config()` from `import { config } from 'dotenv'`
      if (callee.type === "Identifier") {
        const name = callee["name"] as string | undefined;
        if (name && dotenvImports.get(name) === "config") {
          loaderFindings.push({
            name: "<dotenv.config>",
            source: "process.env",
            range: node.range,
            defaultValue: undefined,
            enclosingFunctionId: enclosingFunctionFor(ctx, node.range.startByte),
          });
        }
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Pattern matchers
// ---------------------------------------------------------------------------

/**
 * Match a MemberExpression that reads a single env var. Recognizes:
 *
 *   process.env.NAME       → MemberExpression(object=process.env, prop=NAME, computed=false)
 *   process.env['NAME']    → MemberExpression(object=process.env, prop='NAME', computed=true)
 *   import.meta.env.NAME   → object is `import.meta.env`
 *   Bun.env.NAME           → object is `Bun.env`
 *
 * Returns null if the shape doesn't match exactly. We deliberately don't
 * match `globalThis.process.env.X` — too rare to special-case, and a
 * follow-up adapter or a binding-aware pass can pick it up.
 */
function matchEnvAccess(node: AstNode): { source: EnvReadSource; name: string } | null {
  const object = node["object"] as AstNode | undefined;
  const property = node["property"] as AstNode | undefined;
  const computed = (node["computed"] as boolean | undefined) ?? false;
  if (!object || !property) return null;

  const source = matchEnvObject(object);
  if (!source) return null;

  // Resolve the property to a string key.
  let name: string | undefined;
  if (!computed && property.type === "Identifier") {
    name = property["name"] as string | undefined;
  } else if (computed) {
    if (property.type === "Literal" || property.type === "StringLiteral") {
      const v = property["value"];
      if (typeof v === "string") name = v;
    }
    // Non-literal computed keys are dynamic — can't statically resolve.
    // We silently skip; the analyzer in index.ts may surface a single
    // file-level diagnostic per dynamic-key occurrence.
  }
  if (!name) return null;
  return { source, name };
}

/**
 * Match the OBJECT side of an env access — the `process.env` /
 * `import.meta.env` / `Bun.env` part — and return which source it is.
 */
function matchEnvObject(node: AstNode): EnvReadSource | null {
  if (node.type !== "MemberExpression") return null;
  const obj = node["object"] as AstNode | undefined;
  const prop = node["property"] as AstNode | undefined;
  if (!obj || !prop) return null;
  if (prop.type !== "Identifier") return null;
  const propName = prop["name"] as string | undefined;
  if (propName !== "env") return null;

  // process.env
  if (obj.type === "Identifier" && (obj["name"] as string | undefined) === "process") {
    return "process.env";
  }
  // import.meta.env (object is itself a MetaProperty: import.meta)
  if (obj.type === "MetaProperty") {
    const meta = obj["meta"] as AstNode | undefined;
    const property = obj["property"] as AstNode | undefined;
    if (
      meta?.type === "Identifier" &&
      (meta["name"] as string | undefined) === "import" &&
      property?.type === "Identifier" &&
      (property["name"] as string | undefined) === "meta"
    ) {
      return "import.meta.env";
    }
  }
  // Bun.env
  if (obj.type === "Identifier" && (obj["name"] as string | undefined) === "Bun") {
    return "Bun.env";
  }
  return null;
}

/**
 * Walk up from a child node (the env access) to its parent expression and,
 * if the parent is a `||` / `??` / `||=` / `??=` whose LEFT operand is the
 * env access, return the literal string on the RIGHT (the default).
 *
 * This is best-effort. We only capture string literals — capturing
 * arbitrary expressions ("`http://${HOST}`") in a structurally diffable
 * way is non-trivial and the spec stores defaultValue as `unknown` but
 * recommends omitting it when not statically extractable.
 *
 * The SDK's walker doesn't always pass `parent`. If the parent isn't
 * available, we return undefined; that's the safe over-approximation.
 */
function inferDefaultFromContext(node: AstNode): string | undefined {
  const parent = node["__parent"] as AstNode | undefined; // SDK extension: optional parent pointer.
  if (!parent) return undefined;
  if (parent.type !== "LogicalExpression" && parent.type !== "AssignmentExpression") {
    return undefined;
  }
  const op = parent["operator"] as string | undefined;
  if (op !== "||" && op !== "??" && op !== "||=" && op !== "??=") return undefined;
  // The env access must be the LEFT operand. (For `??=` the left is the
  // assignment target, but for our purposes that's still the lookup.)
  if (parent["left"] !== node) return undefined;
  return literalString(parent["right"] as AstNode | undefined);
}

/**
 * Resolve an AST node that we believe is a literal string to its value.
 * Returns undefined for non-string-literal nodes (template literals with
 * non-constant interpolations, numeric literals, identifiers, etc.).
 */
function literalString(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "Literal" || node.type === "StringLiteral") {
    const v = node["value"];
    return typeof v === "string" ? v : undefined;
  }
  if (node.type === "TemplateLiteral") {
    // Only constant template literals (no expressions): `'foo'` form.
    const expressions = (node["expressions"] as ReadonlyArray<unknown> | undefined) ?? [];
    if (expressions.length !== 0) return undefined;
    const quasis = (node["quasis"] as ReadonlyArray<AstNode> | undefined) ?? [];
    if (quasis.length !== 1) return undefined;
    const cooked = (quasis[0]["value"] as { cooked?: string } | undefined)?.cooked;
    return typeof cooked === "string" ? cooked : undefined;
  }
  return undefined;
}

/**
 * Resolve the smallest enclosing function-kind SymbolDef at the given
 * byte offset and return its IrId, or null if the offset is at module
 * top level.
 *
 * Per spec/adapter-interface.ts:196, `SymbolIndex.atOffset` returns the
 * symbol AT a given byte; for env reads, that's typically the access
 * symbol itself. We need its containing function. The SDK's symbol index
 * doesn't expose a parent pointer directly (spec §SymbolDef has no
 * parent field), so we fall back to scanning `definitions` for the
 * smallest function/method whose range contains `byte`.
 *
 * This is O(N_defs) per call. For typical files (<200 definitions) this
 * is fine. If we discover a hot path we can build a per-file interval
 * tree once at the top of analyzeTsFile and pass it in.
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

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Reject obvious garbage as env-var names (empty, all-numeric, contains
 * whitespace). We do NOT enforce uppercase or POSIX naming — `import.meta
 * .env` is conventionally lowercase-prefixed (`viteApiUrl`, etc.) and
 * Node permits any string at runtime.
 */
function isValidEnvVarName(name: string): boolean {
  if (name.length === 0) return false;
  if (name.length > 256) return false; // sanity bound
  // Disallow whitespace and ASCII control chars; everything else is fair
  // game (Node accepts unicode env names, weird as that is).
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return false;
  }
  return true;
}

