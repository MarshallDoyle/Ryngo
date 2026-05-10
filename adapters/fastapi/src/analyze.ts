/**
 * analyzeFile — per-Python-file extraction of FastAPI routes.
 *
 * Walks the file's AST (host-provided via the py-indexer) and:
 *
 *   1. Tracks `app = FastAPI(...)` and `router = APIRouter(prefix="/x")`
 *      bindings. APIRouter's `prefix` kwarg is captured here; cross-router
 *      composition happens in `resolve`.
 *   2. Records `parent.include_router(child, prefix="/extra")` calls so
 *      `resolve` can compose a child router's full mounted path(s).
 *   3. Finds `@<binding>.<verb>(path, response_model=..., status_code=..., tags=[...])`
 *      decorators on `def`/`async def` and emits one `http.route` node per
 *      decorator, plus an `http.handler` edge from the route to the handler
 *      symbol.
 *   4. Extracts request-body and parameter types from the function signature:
 *      - path params: argument name appears in the path template `{name}`;
 *      - body params: argument annotation is a Pydantic BaseModel subclass;
 *      - query params: anything else with a non-`Depends` annotation;
 *      - `Depends(...)` (including `Annotated[T, Depends(...)]`) is skipped.
 *
 * The file's local state (binding table + include_router calls + minted
 * route IDs) is stashed on the adapter-level state map so `resolve` can
 * find it. analyzeFile itself is purely local — it never looks at other
 * files. The host parallelizes across files; per the spec, this is safe
 * because each file's state lives at a per-file key in the shared map and
 * we only mutate that key.
 */
import type {
  AnalyzeFileContext,
  AstHandle,
  IrId,
  Provenance,
  SourceRange,
} from "@codegraph/adapter-sdk";
import {
  type AdapterState,
  type FileState,
  type HttpMethod,
  type IncludeInfo,
  type ParamLocation,
  type RouteData,
  type RouteParam,
  type TypeShape,
  HTTP_VERBS,
  K,
  normalizeRoutePath,
} from "./types.js";

// ---------------------------------------------------------------------------
// AST shape (informal). We don't redefine the full Python AST here; we just
// list the shapes we *use*. The host's py-indexer produces tree-sitter-shaped
// nodes; the adapter SDK normalizes the field names below.
// ---------------------------------------------------------------------------
interface PyNode {
  readonly type: string;
  readonly range?: SourceRange;
  // open: every Python AST production has its own fields
  readonly [key: string]: unknown;
}

interface PyVisitor {
  readonly Assign?: (node: PyNode) => void;
  readonly Expr?: (node: PyNode) => void;
  readonly FunctionDef?: (node: PyNode) => void;
  readonly AsyncFunctionDef?: (node: PyNode) => void;
}

interface AstWalker {
  walk(visitor: PyVisitor): void;
}

/** Adapter-SDK extension shape we rely on for Python source files. */
interface PyFileExtras {
  /** Resolve an annotation expression to a type shape (Pydantic-aware). */
  resolveTypeFromExpr(expr: PyNode): TypeShape | undefined;
  /** Resolve a function-def node to a host-minted symbol id (for the
   *  route-handler edge target). */
  symbolFor(node: PyNode): { readonly id: IrId; readonly fqName: string };
}

// ---------------------------------------------------------------------------
export async function analyzeFile(
  ctx: AnalyzeFileContext,
  state: AdapterState,
): Promise<void> {
  const { file } = ctx;
  if (file.language !== "python") return;
  if (file.ast === null) return;

  const ast = file.ast as unknown as AstHandle & AstWalker;
  // Host-provided Python helpers. Optional: when null we still emit routes
  // but with empty `params`/no body shape.
  const py = (file as unknown as { py?: PyFileExtras }).py;

  const fileState: FileState = {
    file: file.path,
    bindings: new Map(),
    includes: [],
    routeIds: [],
    pendingRouterRoutes: [],
  };
  state.perFile.set(file.path, fileState);

  ast.walk({
    // -------------------------------------------------------------------
    // Bind  app = FastAPI(...)   /   router = APIRouter(prefix="/users")
    // -------------------------------------------------------------------
    Assign(node) {
      const targets = arr(node["targets"]);
      if (targets.length !== 1) return; // tuple unpacking not idiomatic here
      const t0 = targets[0]!;
      if (t0.type !== "Name") return;
      const name = str(t0["id"]);
      if (name === undefined) return;

      const value = obj(node["value"]);
      if (!value || value.type !== "Call") return;

      const callee = stringifyCallee(obj(value["func"]));
      if (callee === "FastAPI" || callee === "fastapi.FastAPI") {
        fileState.bindings.set(name, { kind: "app", prefix: "" });
        return;
      }
      if (callee === "APIRouter" || callee === "fastapi.APIRouter") {
        const prefix = getKwargString(value, "prefix") ?? "";
        fileState.bindings.set(name, { kind: "router", prefix });
      }
    },

    // -------------------------------------------------------------------
    // include_router(child, prefix="/extra")
    // -------------------------------------------------------------------
    Expr(node) {
      const value = obj(node["value"]);
      if (!value || value.type !== "Call") return;
      const func = obj(value["func"]);
      if (!func || func.type !== "Attribute") return;
      if (str(func["attr"]) !== "include_router") return;
      const owner = obj(func["value"]);
      if (!owner || owner.type !== "Name") return;

      const parentVar = str(owner["id"]);
      if (parentVar === undefined) return;
      const args = arr(value["args"]);
      const firstArg = args[0];
      if (!firstArg || firstArg.type !== "Name") return;
      const childVar = str(firstArg["id"]);
      if (childVar === undefined) return;

      // Note: we don't gate on `parentVar in bindings` here. The parent might
      // be bound in a different file (e.g. a top-level `app` imported from
      // main.py). resolve() merges all file states before composing prefixes,
      // so cross-file include_router works correctly.
      const extraPrefix = getKwargString(value, "prefix") ?? "";
      const include: IncludeInfo = { parentVar, childVar, extraPrefix };
      fileState.includes.push(include);
    },

    FunctionDef(node) {
      handleFunctionDef(node, fileState, ctx, py);
    },
    AsyncFunctionDef(node) {
      handleFunctionDef(node, fileState, ctx, py);
    },
  });
}

// ---------------------------------------------------------------------------
function handleFunctionDef(
  node: PyNode,
  fileState: FileState,
  ctx: AnalyzeFileContext,
  py: PyFileExtras | undefined,
): void {
  const decorators = arr(node["decorator_list"]);
  if (decorators.length === 0) return;

  for (const dec of decorators) {
    if (dec.type !== "Call") continue;
    const decFunc = obj(dec["func"]);
    if (!decFunc || decFunc.type !== "Attribute") continue;
    const owner = obj(decFunc["value"]);
    if (!owner || owner.type !== "Name") continue;

    const ownerVar = str(owner["id"]);
    const verb = str(decFunc["attr"])?.toLowerCase();
    if (ownerVar === undefined || verb === undefined) continue;

    const binding = fileState.bindings.get(ownerVar);
    if (!binding) continue;
    if (!HTTP_VERBS.includes(verb as Lowercase<HttpMethod>)) continue;

    // First positional arg of the decorator is the path string literal.
    const decArgs = arr(dec["args"]);
    const pathArg = decArgs[0];
    if (!pathArg || pathArg.type !== "Constant" || typeof pathArg["value"] !== "string") {
      const r = rangeOf(dec);
      ctx.diagnostic({
        severity: "warn",
        code: "fastapi/route-path-not-literal",
        message: `Skipping @${ownerVar}.${verb}(...) — path is not a string literal.`,
        file: ctx.file.path,
        ...(r ? { range: r } : {}),
        hint: "codegraph only lifts statically-resolvable route paths.",
      });
      continue;
    }
    const localPath = pathArg["value"] as string;

    // Decorator metadata.
    const responseExpr = getKwargExpr(dec, "response_model");
    const responseType = responseExpr && py ? py.resolveTypeFromExpr(responseExpr) : undefined;
    const statusCode = getKwargNumber(dec, "status_code");
    const tags = getKwargStringList(dec, "tags");

    // Walk the function signature for params + body.
    const pathParams = extractPathParamNames(localPath);
    const params: RouteParam[] = [];
    let requestBody: TypeShape | undefined;

    const args = obj(node["args"]);
    const argList = args ? arr(args["args"]) : [];
    for (const arg of argList) {
      const argName = str(arg["arg"]);
      const annotation = obj(arg["annotation"]);
      if (argName === undefined || !annotation) continue;
      if (isDependsAnnotation(annotation)) continue;

      const shape: TypeShape | undefined = py ? py.resolveTypeFromExpr(annotation) : undefined;
      if (!shape) continue;

      const where: ParamLocation = pathParams.has(argName)
        ? "path"
        : shape.kind === "pydantic-model"
        ? "body"
        : "query";

      if (where === "body") {
        if (!requestBody) {
          // FastAPI's first Pydantic-typed arg is THE request body. Subsequent
          // Pydantic args become a merged JSON object — we model the rest as
          // `in: "body"` params so downstream tooling sees them all.
          requestBody = shape;
          continue;
        }
        params.push({ in: "body", name: argName, type: shape });
      } else {
        params.push({ in: where, name: argName, type: shape });
      }
    }

    // Normalize the path to colon-style at emit-time. Path-param names were
    // already extracted from the raw `{name}` form above; everything from
    // here on uses the normalized form so peer adapters (nextjs's matcher)
    // see one canonical shape regardless of which server framework
    // produced the route.
    const normalizedPath = normalizeRoutePath(localPath);
    const method = verb.toUpperCase() as HttpMethod;

    // Handler symbol — the Python function the decorator sits on. Resolved
    // here (in analyze) because the AST node is only available in this
    // phase; the result is forwarded to resolve() via PendingRouterRoute
    // for router-owned routes.
    const handler = py?.symbolFor(node);
    if (!handler) {
      const r = rangeOf(node);
      ctx.diagnostic({
        severity: "warn",
        code: "fastapi/handler-symbol-not-resolved",
        message: `Could not resolve handler symbol for ${method} ${normalizedPath}.`,
        file: ctx.file.path,
        ...(r ? { range: r } : {}),
      });
    }

    const provenance = provenanceOf(ctx, node);

    if (binding.kind === "app") {
      // App-owned route: path is final. Emit the route node + handler edge
      // directly, no resolve-phase rewrite needed.
      const localId = `route::${method}:${normalizedPath}@${ownerVar}`;
      const routeId = ctx.id.mint({ path: ctx.file.path, localId });
      const data: RouteData = {
        framework: "fastapi",
        method,
        path: normalizedPath,
        ownerKind: "app",
        ownerVar,
        params,
        ...(requestBody ? { requestBody } : {}),
        ...(responseType ? { responseType } : {}),
        ...(statusCode !== undefined ? { statusCode } : {}),
        ...(tags ? { tags } : {}),
        ...(handler ? { handlerSymbolId: handler.id } : {}),
      };
      ctx.emit({
        id: routeId,
        kind: K.route,
        label: `${method} ${normalizedPath}`,
        data,
        provenance,
      });
      fileState.routeIds.push(routeId);

      if (handler) {
        ctx.emit({
          id: ctx.id.mint({ path: ctx.file.path, localId: `${localId}#handler` }),
          kind: K.handler,
          from: routeId,
          to: handler.id,
          label: handler.fqName,
          data: { method, path: normalizedPath } satisfies HandlerEdgeData,
          provenance,
        });
      }
      continue;
    }

    // Router-owned route: defer emission until resolve() composes the
    // mount prefixes. We capture everything resolve needs (no AST, no
    // closures, JSON-serializable) on the per-file scratch state.
    fileState.pendingRouterRoutes.push({
      method,
      localPath: normalizedPath,
      ownerVar,
      params,
      ...(requestBody ? { requestBody } : {}),
      ...(responseType ? { responseType } : {}),
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(tags ? { tags } : {}),
      ...(handler ? { handlerSymbolId: handler.id, handlerFqName: handler.fqName } : {}),
      provenance,
    });
  }
}

// ---------------------------------------------------------------------------
// Edge data (kept here because it's only emitted from analyzeFile)
// ---------------------------------------------------------------------------
interface HandlerEdgeData extends Record<string, unknown> {
  readonly method: HttpMethod;
  readonly path: string;
}

// ---------------------------------------------------------------------------
// AST helpers — narrow + safe-by-default. The Python AST is dynamically typed
// from our perspective so we lean on explicit shape checks at every step.
// ---------------------------------------------------------------------------

function obj(v: unknown): PyNode | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as PyNode) : undefined;
}
function arr(v: unknown): ReadonlyArray<PyNode> {
  return Array.isArray(v) ? (v as PyNode[]) : [];
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** "fastapi.FastAPI" or "FastAPI" — flatten an Attribute chain to a dotted string. */
function stringifyCallee(node: PyNode | undefined): string {
  if (!node) return "<unknown>";
  if (node.type === "Name") return str(node["id"]) ?? "<unknown>";
  if (node.type === "Attribute") {
    return `${stringifyCallee(obj(node["value"]))}.${str(node["attr"]) ?? "<?>"}`;
  }
  return "<unknown>";
}

function getKwargs(call: PyNode): ReadonlyArray<PyNode> {
  return arr(call["keywords"]);
}
function getKwarg(call: PyNode, name: string): PyNode | undefined {
  for (const kw of getKwargs(call)) {
    if (str(kw["arg"]) === name) return obj(kw["value"]);
  }
  return undefined;
}
function getKwargString(call: PyNode, name: string): string | undefined {
  const v = getKwarg(call, name);
  if (!v || v.type !== "Constant") return undefined;
  return typeof v["value"] === "string" ? (v["value"] as string) : undefined;
}
function getKwargNumber(call: PyNode, name: string): number | undefined {
  const v = getKwarg(call, name);
  if (!v || v.type !== "Constant") return undefined;
  return typeof v["value"] === "number" ? (v["value"] as number) : undefined;
}
function getKwargStringList(call: PyNode, name: string): string[] | undefined {
  const v = getKwarg(call, name);
  if (!v || v.type !== "List") return undefined;
  const elts = arr(v["elts"]);
  const out: string[] = [];
  for (const e of elts) {
    if (e.type === "Constant" && typeof e["value"] === "string") {
      out.push(e["value"] as string);
    }
  }
  return out.length > 0 ? out : undefined;
}
function getKwargExpr(call: PyNode, name: string): PyNode | undefined {
  return getKwarg(call, name);
}

/** `/users/{id}` → Set("id"); `/items/{item_id:int}` → Set("item_id"). */
function extractPathParamNames(path: string): Set<string> {
  const out = new Set<string>();
  for (const m of path.matchAll(/\{([^}:]+)(?::[^}]+)?\}/g)) {
    if (m[1]) out.add(m[1]);
  }
  return out;
}

/**
 * Detect `Annotated[T, Depends(...)]`. Plain `def fn(x = Depends(get_db))`
 * (default-value form) shows up on the arg's `default`, not the annotation;
 * we conservatively skip an arg when *either* place mentions Depends.
 */
function isDependsAnnotation(ann: PyNode): boolean {
  if (ann.type !== "Subscript") return false;
  const base = obj(ann["value"]);
  if (!base || base.type !== "Name") return false;
  if (str(base["id"]) !== "Annotated") return false;
  // The slice can be a Tuple node or, on some parsers, an Index wrapping one.
  const slice = obj(ann["slice"]);
  const tup = slice?.type === "Tuple" ? slice : slice?.type === "Index" ? obj(slice["value"]) : undefined;
  if (!tup || tup.type !== "Tuple") return false;
  for (const e of arr(tup["elts"])) {
    if (e.type !== "Call") continue;
    const f = obj(e["func"]);
    if (!f) continue;
    if (f.type === "Name" && str(f["id"]) === "Depends") return true;
    if (f.type === "Attribute" && str(f["attr"]) === "Depends") return true;
  }
  return false;
}

function rangeOf(node: PyNode): SourceRange | undefined {
  return node.range;
}

function provenanceOf(ctx: AnalyzeFileContext, node: PyNode): Provenance {
  const range = node.range ?? {
    startByte: 0,
    endByte: 0,
    startLine: 1,
    startCol: 1,
    endLine: 1,
    endCol: 1,
  };
  // The host overwrites adapter+version per the SDK contract; our values
  // here are placeholders.
  return { file: ctx.file.path, range, adapter: "fastapi", version: "0.0.0" };
}
