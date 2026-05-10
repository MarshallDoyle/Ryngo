/**
 * Per-file analysis for `@codegraph/adapter-nextjs`.
 *
 * Scope per file (only run on .ts/.tsx/.js/.jsx, gated by `appliesTo`):
 *   1. If the file is `app/.../route.{ts,js,...}`, scan its named exports for
 *      HTTP-method handlers (`GET`, `POST`, ...) and emit one `http.route`
 *      node per export, plus an `http.route-handler` edge to the function
 *      symbol.
 *   2. If the file is `app/.../page.{tsx,jsx}`, emit a `nextjs.page` node for
 *      the default export plus a `nextjs.page-component` edge.
 *   3. For ANY in-scope file, detect `'use server'` directives at module or
 *      function scope and emit `nextjs.server-action` nodes for every async
 *      function definition that's covered.
 *   4. For ANY in-scope file, find `fetch(...)` calls with statically-known
 *      URLs and emit `http.client-call` nodes. For each, also emit a deferred
 *      `http.calls` edge so the resolver can match it to a peer-emitted route
 *      (own, express, fastapi).
 */

import type {
  AnalyzeFileContext,
  IrEdge,
  IrId,
  IrNode,
  Provenance,
  SourceRange,
  SymbolDef,
  SymbolRef,
} from "@codegraph/adapter-sdk";

import {
  appRelativePath,
  filePathToRoute,
  isPageFile,
  isRouteFile,
} from "./route-conv.js";
import {
  DIAG_CODE,
  EDGE_KIND,
  HTTP_METHODS,
  NODE_KIND,
  REF_KIND_MATCH_ROUTE,
  type ClientCallNodeData,
  type HttpMethod,
  type MatchRouteQuery,
  type PageNodeData,
  type RouteNodeData,
  type ServerActionNodeData,
} from "./types.js";

export async function analyzeFile(ctx: AnalyzeFileContext): Promise<void> {
  const file = ctx.file;
  const appRel = appRelativePath(file.path);

  if (appRel !== null && isRouteFile(appRel)) {
    emitRouteNodes(ctx, appRel);
  }

  if (appRel !== null && isPageFile(appRel)) {
    emitPageNode(ctx, appRel);
  }

  emitServerActionNodes(ctx);
  emitClientCallNodes(ctx);
}

/* -------------------------------------------------------------------------- */
/*  Route emission                                                            */
/* -------------------------------------------------------------------------- */

function emitRouteNodes(ctx: AnalyzeFileContext, appRel: string): void {
  const routePath = filePathToRoute(appRel);
  const symbols = ctx.file.symbols;
  if (!symbols) return;

  // App Router exposes one route per HTTP-method export. We identify the
  // exports by their fully-qualified name (`<module>.GET`) so this works on
  // both `export function GET(...)` and `export const GET = ...`.
  const exports = collectExportedDefs(symbols);
  for (const [name, def] of exports) {
    if (!isHttpMethodName(name)) {
      if (looksLikeMethodName(name)) {
        ctx.diagnostic({
          severity: "warn",
          code: DIAG_CODE.UNKNOWN_HTTP_METHOD,
          message: `Export '${name}' looks like an HTTP method but isn't recognized.`,
          file: ctx.file.path,
          range: def.range,
        });
      }
      continue;
    }
    if (!isFunctionDef(def)) {
      ctx.diagnostic({
        severity: "warn",
        code: DIAG_CODE.ROUTE_HANDLER_NOT_FUNCTION,
        message: `Route export '${name}' is not a function-shaped binding.`,
        file: ctx.file.path,
        range: def.range,
      });
      continue;
    }

    const method = name as HttpMethod;
    const localId = `${method}::${routePath}`;
    const routeId = ctx.id.mint({ path: ctx.file.path, localId });

    const data: RouteNodeData = {
      method,
      path: routePath,
      framework: "nextjs",
      ownerKind: "app",
      sourceFile: ctx.file.path,
      handlerExport: method,
    };

    const node: IrNode<RouteNodeData> = {
      id: routeId,
      kind: NODE_KIND.ROUTE,
      label: `${method} ${routePath}`,
      data,
      provenance: provenanceFor(ctx, def.range),
    };
    ctx.emit(node);

    const edge: IrEdge = {
      id: ctx.id.mint({
        path: ctx.file.path,
        localId: `route-handler::${method}::${routePath}`,
      }),
      kind: EDGE_KIND.ROUTE_HANDLER,
      from: routeId,
      to: def.id,
      label: method,
      provenance: provenanceFor(ctx, def.range),
    };
    ctx.emit(edge);
  }
}

/* -------------------------------------------------------------------------- */
/*  Page emission                                                             */
/* -------------------------------------------------------------------------- */

function emitPageNode(ctx: AnalyzeFileContext, appRel: string): void {
  const symbols = ctx.file.symbols;
  if (!symbols) return;

  const def = findDefaultExportDef(symbols);
  if (!def) return;

  const routePath = filePathToRoute(appRel);
  const pageId = ctx.id.mint({
    path: ctx.file.path,
    localId: `page::${routePath}`,
  });

  // Heuristic: a 'page' file's default export being async means it's a server
  // component that fetches data. The symbol kind alone doesn't surface async,
  // but `docComment` / `fqName` do; we look in source for the async keyword
  // immediately preceding the symbol. Local read; safe in the analyze phase.
  const isAsync = isAsyncFunctionDef(ctx.file.content, def);

  const data: PageNodeData = {
    path: routePath,
    framework: "nextjs",
    sourceFile: ctx.file.path,
    async: isAsync,
  };

  ctx.emit({
    id: pageId,
    kind: NODE_KIND.PAGE,
    label: `page ${routePath}`,
    data,
    provenance: provenanceFor(ctx, def.range),
  } satisfies IrNode<PageNodeData>);

  ctx.emit({
    id: ctx.id.mint({
      path: ctx.file.path,
      localId: `page-component::${routePath}`,
    }),
    kind: EDGE_KIND.PAGE_COMPONENT,
    from: pageId,
    to: def.id,
    provenance: provenanceFor(ctx, def.range),
  });
}

/* -------------------------------------------------------------------------- */
/*  Server Action emission                                                    */
/* -------------------------------------------------------------------------- */

function emitServerActionNodes(ctx: AnalyzeFileContext): void {
  const symbols = ctx.file.symbols;
  if (!symbols) return;

  const moduleScope = hasModuleUseServer(ctx.file.content);
  const functionScopeRanges = findFunctionUseServerRanges(ctx.file.content);

  for (const def of symbols.definitions) {
    if (!isFunctionDef(def)) continue;
    const scope: "module" | "function" | null = moduleScope
      ? "module"
      : containsAny(functionScopeRanges, def.range.startByte)
        ? "function"
        : null;
    if (scope === null) continue;

    // Server actions must be async functions. The reliable test using only
    // host-provided info is to look at the few bytes preceding the def for
    // an `async` keyword.
    if (!isAsyncFunctionDef(ctx.file.content, def)) continue;

    const actionId = ctx.id.mint({
      path: ctx.file.path,
      localId: `server-action::${def.fqName}`,
    });

    const data: ServerActionNodeData = {
      framework: "nextjs",
      name: def.name,
      sourceFile: ctx.file.path,
      directiveScope: scope,
      symbolId: def.id,
    };

    ctx.emit({
      id: actionId,
      kind: NODE_KIND.ACTION,
      label: `action ${def.name}`,
      data,
      provenance: provenanceFor(ctx, def.range),
    } satisfies IrNode<ServerActionNodeData>);

    ctx.emit({
      id: ctx.id.mint({
        path: ctx.file.path,
        localId: `action-handler::${def.fqName}`,
      }),
      kind: EDGE_KIND.ACTION_HANDLER,
      from: actionId,
      to: def.id,
      provenance: provenanceFor(ctx, def.range),
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Client `fetch(...)` emission                                              */
/* -------------------------------------------------------------------------- */

function emitClientCallNodes(ctx: AnalyzeFileContext): void {
  const sites = findFetchCalls(ctx.file.content);
  if (sites.length === 0) return;

  const symbols = ctx.file.symbols;

  for (const site of sites) {
    const range = byteRangeToSourceRange(ctx.file.content, site.start, site.end);
    if (!site.url) {
      ctx.diagnostic({
        severity: "info",
        code: DIAG_CODE.DYNAMIC_FETCH_URL,
        message: "fetch() URL is not statically resolvable; skipping.",
        file: ctx.file.path,
        range,
      });
      continue;
    }

    const method = site.method ?? "GET";
    const callerSymbolId = symbols
      ? findEnclosingFunctionSymbolId(symbols, site.start)
      : undefined;

    const callId = ctx.id.mint({
      path: ctx.file.path,
      localId: `client-call::${method}::${site.url}::${site.start}`,
    });

    const data: ClientCallNodeData = {
      method,
      url: site.url,
      framework: "nextjs",
      ...(callerSymbolId ? { callerSymbolId } : {}),
    };

    ctx.emit({
      id: callId,
      kind: NODE_KIND.CLIENT_CALL,
      label: `${method} ${site.url}`,
      data,
      provenance: provenanceFor(ctx, range),
    } satisfies IrNode<ClientCallNodeData>);

    // Deferred edge: `resolve` will look up matching peer routes.
    const query: MatchRouteQuery = { method, url: site.url };
    const edgeId = ctx.id.mint({
      path: ctx.file.path,
      localId: `http-call::${method}::${site.url}::${site.start}`,
    });
    ctx.emit({
      id: edgeId,
      kind: EDGE_KIND.HTTP_CALL,
      from: callId,
      to: ctx.id.ref(REF_KIND_MATCH_ROUTE, query),
      label: `${method} ${site.url}`,
      provenance: provenanceFor(ctx, range),
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers — symbol queries                                                  */
/* -------------------------------------------------------------------------- */

function isHttpMethodName(name: string): name is HttpMethod {
  return HTTP_METHODS.has(name as HttpMethod);
}

/** Catches near-misses like `Get`/`get` — emit a diagnostic. */
function looksLikeMethodName(name: string): boolean {
  return HTTP_METHODS.has(name.toUpperCase() as HttpMethod) && name !== name.toUpperCase();
}

function isFunctionDef(def: SymbolDef): boolean {
  return def.kind === "function" || def.kind === "method";
}

/**
 * Collect top-level exported symbol defs by their declared name. Some host
 * indexers expose exports via a synthetic `<module>.<name>` fqName; we accept
 * either pattern and fall back to scanning for `export ...` against the raw
 * content if the symbol index doesn't carry export info.
 */
function collectExportedDefs(
  symbols: NonNullable<AnalyzeFileContext["file"]["symbols"]>,
): Map<string, SymbolDef> {
  const out = new Map<string, SymbolDef>();
  for (const def of symbols.definitions) {
    // Heuristic: the App Router checks named module-level exports. Top-level
    // defs have an fqName equal to `<module>.<name>` (one dot) and aren't
    // nested inside another function/class.
    const dots = def.fqName.match(/\./g)?.length ?? 0;
    if (dots <= 1) {
      out.set(def.name, def);
    }
  }
  return out;
}

function findDefaultExportDef(
  symbols: NonNullable<AnalyzeFileContext["file"]["symbols"]>,
): SymbolDef | null {
  for (const def of symbols.definitions) {
    if (def.name === "default" || def.fqName.endsWith(".default")) return def;
  }
  return null;
}

function findEnclosingFunctionSymbolId(
  symbols: NonNullable<AnalyzeFileContext["file"]["symbols"]>,
  byte: number,
): IrId | undefined {
  // `atOffset` returns either a def or a ref; we want a function def whose
  // range contains `byte`.
  let best: SymbolDef | null = null;
  let bestSize = Number.POSITIVE_INFINITY;
  for (const def of symbols.definitions) {
    if (!isFunctionDef(def)) continue;
    if (def.range.startByte <= byte && byte < def.range.endByte) {
      const size = def.range.endByte - def.range.startByte;
      if (size < bestSize) {
        best = def;
        bestSize = size;
      }
    }
  }
  return best?.id;
}

/* -------------------------------------------------------------------------- */
/*  Helpers — directive + async detection from raw content                    */
/* -------------------------------------------------------------------------- */

const STRIP_LEADING_TRIVIA_RE =
  /^(?:﻿|#![^\n]*\n|\s+|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)+/;

/** True if the file's first directive prologue contains `'use server'`. */
export function hasModuleUseServer(content: string): boolean {
  let cursor = 0;
  // Skip BOM + shebang + leading whitespace + comments.
  const trim = content.match(STRIP_LEADING_TRIVIA_RE);
  if (trim) cursor += trim[0].length;
  // Walk directive prologue: a sequence of string-literal expression statements.
  while (cursor < content.length) {
    const slice = content.slice(cursor);
    const m = slice.match(/^(['"])(use [\w\-]+)\1\s*;?\s*/);
    if (!m) break;
    if (m[2] === "use server") return true;
    cursor += m[0].length;
  }
  return false;
}

/**
 * Return byte ranges `[start, end)` of every function body that opens with a
 * `'use server'` directive. Conservative: matches `function`,
 * `async function`, arrow bodies (`=> {`), and method bodies.
 */
export function findFunctionUseServerRanges(
  content: string,
): ReadonlyArray<{ start: number; end: number }> {
  const ranges: { start: number; end: number }[] = [];
  // Find each `{` followed by a 'use server' directive. Then walk to the
  // matching `}` accounting for braces inside strings/comments.
  const re = /\{\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*['"]use server['"]\s*;?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const openBrace = m.index;
    const close = findMatchingBrace(content, openBrace);
    if (close > openBrace) {
      ranges.push({ start: openBrace, end: close + 1 });
    }
  }
  return ranges;
}

function findMatchingBrace(content: string, openBrace: number): number {
  let depth = 0;
  let i = openBrace;
  let inString: string | null = null;
  let inTemplate = false;
  while (i < content.length) {
    const ch = content[i]!;
    if (inString) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (inTemplate) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        inTemplate = false;
        i++;
        continue;
      }
      if (ch === "$" && content[i + 1] === "{") {
        // Treat `${...}` interior as ordinary code so braces still balance.
        depth++;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (ch === "/" && content[i + 1] === "/") {
      const nl = content.indexOf("\n", i + 2);
      i = nl < 0 ? content.length : nl + 1;
      continue;
    }
    if (ch === "/" && content[i + 1] === "*") {
      const end = content.indexOf("*/", i + 2);
      i = end < 0 ? content.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      i++;
      continue;
    }
    if (ch === "`") {
      inTemplate = true;
      i++;
      continue;
    }
    if (ch === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

function containsAny(
  ranges: ReadonlyArray<{ start: number; end: number }>,
  byte: number,
): boolean {
  for (const r of ranges) {
    if (r.start <= byte && byte < r.end) return true;
  }
  return false;
}

/**
 * True if the function definition starts with the `async` keyword. Looks at a
 * window before the def's startByte for `async` followed by whitespace.
 */
export function isAsyncFunctionDef(content: string, def: SymbolDef): boolean {
  const lookback = 64;
  const start = Math.max(0, def.range.startByte - lookback);
  const window = content.slice(start, def.range.startByte);
  return /(^|[\s({,=>])async\s+(?:function\b|\(|[\w$]+\s*\()?\s*$/.test(window) ||
    /\basync\s+(?:function\s+)?[\w$]*\s*\(/.test(content.slice(def.range.startByte, def.range.startByte + lookback));
}

/* -------------------------------------------------------------------------- */
/*  Helpers — fetch() call discovery (regex-based, no AST)                    */
/* -------------------------------------------------------------------------- */

interface FetchSite {
  readonly start: number;
  readonly end: number;
  readonly url: string | null;
  readonly method: HttpMethod | null;
}

/**
 * Find every `fetch(...)` callsite. We use a content scan keyed on
 * `\bfetch\(` and then parse the argument list manually. This avoids a heavy
 * AST dependency in the adapter while remaining deterministic.
 */
export function findFetchCalls(content: string): FetchSite[] {
  const sites: FetchSite[] = [];
  const re = /\bfetch\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    // Skip e.g. `something.fetch(` or `prefetch(` — any identifier char before.
    const before = m.index === 0 ? "" : content[m.index - 1];
    if (before && /[\w$.]/.test(before)) continue;

    const openParen = m.index + m[0].length - 1;
    const closeParen = findMatchingParen(content, openParen);
    if (closeParen < 0) continue;

    const args = parseArgList(content, openParen + 1, closeParen);
    const url = args[0] ? evalStringLiteral(args[0].text) : null;
    const method = args[1] ? extractMethod(args[1].text) : null;

    sites.push({
      start: m.index,
      end: closeParen + 1,
      url,
      method,
    });
  }
  return sites;
}

function findMatchingParen(content: string, openParen: number): number {
  let depth = 0;
  let i = openParen;
  let inString: string | null = null;
  let inTemplate = 0; // template literal nesting depth
  while (i < content.length) {
    const ch = content[i]!;
    if (inString) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (inTemplate > 0) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        inTemplate--;
        i++;
        continue;
      }
      if (ch === "$" && content[i + 1] === "{") {
        depth++;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (ch === "/" && content[i + 1] === "/") {
      const nl = content.indexOf("\n", i + 2);
      i = nl < 0 ? content.length : nl + 1;
      continue;
    }
    if (ch === "/" && content[i + 1] === "*") {
      const end = content.indexOf("*/", i + 2);
      i = end < 0 ? content.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      i++;
      continue;
    }
    if (ch === "`") {
      inTemplate++;
      i++;
      continue;
    }
    if (ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")") {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

interface ArgSpan {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function parseArgList(content: string, start: number, end: number): ArgSpan[] {
  const args: ArgSpan[] = [];
  let depth = 0;
  let inString: string | null = null;
  let inTemplate = 0;
  let argStart = start;

  for (let i = start; i < end; i++) {
    const ch = content[i]!;
    if (inString) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (inTemplate > 0) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === "`") {
        inTemplate--;
        continue;
      }
      if (ch === "$" && content[i + 1] === "{") {
        depth++;
        i += 1;
        continue;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === "`") {
      inTemplate++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      continue;
    }
    if (ch === "," && depth === 0) {
      const text = content.slice(argStart, i).trim();
      if (text.length > 0) {
        args.push({ start: argStart, end: i, text });
      }
      argStart = i + 1;
    }
  }
  const tailText = content.slice(argStart, end).trim();
  if (tailText.length > 0) {
    args.push({ start: argStart, end, text: tailText });
  }
  return args;
}

/**
 * Constant-fold a string-literal expression. Accepts:
 *   - `'foo'` / `"foo"`
 *   - `\`foo\``
 *   - template literal with no interpolations: `\`foo/bar\``
 * Returns null for anything else (variable, dynamic template, expression).
 */
function evalStringLiteral(text: string): string | null {
  const trimmed = text.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    try {
      return JSON.parse(
        '"' + trimmed.slice(1, -1).replace(/\\?"/g, '\\"') + '"',
      );
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("`") && trimmed.endsWith("`") && !trimmed.includes("${")) {
    return trimmed.slice(1, -1);
  }
  return null;
}

/**
 * From a 2nd `fetch()` arg (an init object literal), extract the `method`
 * property if its value is a string literal. Returns null when absent or
 * dynamic.
 */
function extractMethod(text: string): HttpMethod | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  const re = /(?:^|[,{\s])method\s*:\s*(['"`])([A-Za-z]+)\1/;
  const m = trimmed.match(re);
  if (!m) return null;
  const value = m[2]!.toUpperCase();
  return HTTP_METHODS.has(value as HttpMethod) ? (value as HttpMethod) : null;
}

/* -------------------------------------------------------------------------- */
/*  Helpers — provenance / source ranges                                      */
/* -------------------------------------------------------------------------- */

function provenanceFor(ctx: AnalyzeFileContext, range: SourceRange): Provenance {
  // `adapter` and `version` fields get overwritten by the host on emit;
  // we provide placeholders so the local type checks.
  return {
    file: ctx.file.path,
    range,
    adapter: "",
    version: "",
  };
}

function byteRangeToSourceRange(
  content: string,
  startByte: number,
  endByte: number,
): SourceRange {
  const startPos = byteToLineCol(content, startByte);
  const endPos = byteToLineCol(content, endByte);
  return {
    startByte,
    endByte,
    startLine: startPos.line,
    startCol: startPos.col,
    endLine: endPos.line,
    endCol: endPos.col,
  };
}

function byteToLineCol(content: string, byte: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  const upto = Math.min(byte, content.length);
  for (let i = 0; i < upto; i++) {
    if (content.charCodeAt(i) === 10) {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

// Keeps `SymbolRef` referenced for downstream TS compat without forcing a
// runtime use. (Useful when we extend symbol-driven resolution later.)
export type _SymbolRefBrand = SymbolRef;
