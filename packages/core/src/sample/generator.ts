/**
 * Sample IR generator.
 *
 * Produces deterministic, plausibly-realistic IR JSON for a fictional 3-tier
 * web app (frontend / backend / worker / database). Used for:
 *
 *   - viewer development without a real adapter run
 *   - demo screenshots and marketing assets
 *   - fixture authoring for snapshot tests
 *   - performance testing the viewer (medium / large sizes)
 *
 * Output conforms to the canonical IR document shape exported from
 * `@codegraph/core/ir`: `{schemaVersion, ir: {metadata, nodes, edges}}` with
 * branded `NodeId` values, `parentId`-based hierarchy (no `contains` edges),
 * and `(sourceId, targetId, category)` edge identity.
 *
 * Keep this file dependency-free: no Node built-ins, no third-party imports.
 * Node IDs are deterministic 32-char hex digests of the canonical signature
 * via a fixed non-cryptographic mix (cyrb128). Production analyzers use real
 * BLAKE3-128; the generator's hash function is interchangeable as long as
 * `(size, seed)` keeps producing byte-identical output.
 */

import {
  asNodeId,
  SCHEMA_VERSION,
  type IRDocument,
  type IR,
  type Edge,
  type Node,
  type NodeId,
  type ServiceNode,
  type ModuleNode,
  type TypeNode,
  type FunctionNode,
  type ExpressionNode,
  type CallEdge,
  type ImportEdge,
  type DbReadEdge,
  type DbWriteEdge,
  type NetworkEdge,
  type FunctionParam,
  type TypeRef,
} from '../ir/index.js';

// ---------- public API ----------

export type Size = 'small' | 'medium' | 'large';

export interface GenerateOptions {
  /** Target rough node count band. */
  size?: Size;
  /** Seed for the deterministic RNG. Same seed + size = byte-identical output. */
  seed?: number;
  /** Override the schema version stamped into the output. */
  irVersion?: string;
}

/** Approximate node-count targets per size. Real output lands within ~10%. */
const SIZE_TARGETS: Record<Size, number> = {
  small: 50,
  medium: 500,
  large: 5000,
};

/**
 * Build a sample IR document for a fictional 3-tier app.
 *
 * Topology:
 *   - 1 frontend service (~12 modules: pages, components, api-client, ...)
 *   - 1 backend service  (~15 modules: routes, services, repos, models, ...)
 *   - 1 worker service   (~5  modules)
 *   - 8 database tables  (modeled as `type` nodes under a synthetic db service)
 *
 * Edge mix:
 *   - `import` between modules
 *   - `call` between functions (mostly intra-service; cross-service for
 *      frontend api-client -> backend routes and backend queue -> worker
 *      consumers)
 *   - `db-read`/`db-write` from backend repos and worker tasks into DB tables
 *   - a sprinkle of unresolved (`callKind: "dynamic"`) call edges
 *
 * Hierarchy is encoded via `parentId`, not edges. Function effects are
 * captured by `pure: false` plus appropriate sink-flavored expression nodes
 * where useful at medium/large sizes.
 */
export function generateSampleIR(opts: GenerateOptions = {}): IRDocument {
  const size: Size = opts.size ?? 'small';
  const seed = opts.seed ?? 1;
  const target = SIZE_TARGETS[size];

  const rng = mulberry32(seed);
  const ctx: Ctx = {
    rng,
    nodes: [],
    edges: [],
    target,
    seenIds: new Set<string>(),
  };

  buildTopology(ctx, size);

  const ir: IR = {
    metadata: {
      repo: 'codegraph/sample-app',
      commit: pseudoCommit(rng),
      generatedAt: '2026-05-08T00:00:00.000Z',
      generators: [
        {
          name: '@codegraph/core sample',
          version: '0.1.0',
          size,
          seed,
          nodeCount: ctx.nodes.length,
          edgeCount: ctx.edges.length,
        },
      ],
    },
    nodes: ctx.nodes,
    edges: ctx.edges,
  };

  return {
    schemaVersion: opts.irVersion ?? SCHEMA_VERSION,
    ir,
  };
}

// ---------- internals ----------

interface Ctx {
  rng: () => number;
  nodes: Node[];
  edges: Edge[];
  target: number;
  /** Tracks signatures we've already minted ids for; used to disambiguate. */
  seenIds: Set<string>;
}

const FRONTEND_MODULES = [
  'pages',
  'components',
  'api-client',
  'state',
  'hooks',
  'router',
  'auth',
  'forms',
  'icons',
  'theme',
  'utils',
  'analytics',
] as const;

const BACKEND_MODULES = [
  'routes',
  'services',
  'repositories',
  'models',
  'middleware',
  'auth',
  'config',
  'logger',
  'queue',
  'mailer',
  'errors',
  'validators',
  'jobs',
  'db',
  'utils',
] as const;

const WORKER_MODULES = ['main', 'consumers', 'tasks', 'retry', 'metrics'] as const;

const DB_TABLES = [
  { name: 'users', cols: ['id', 'email', 'name', 'created_at', 'role'] },
  { name: 'sessions', cols: ['id', 'user_id', 'expires_at', 'token_hash'] },
  { name: 'orders', cols: ['id', 'user_id', 'total_cents', 'status', 'placed_at'] },
  { name: 'order_items', cols: ['id', 'order_id', 'product_id', 'qty', 'unit_cents'] },
  { name: 'products', cols: ['id', 'sku', 'name', 'price_cents', 'inventory'] },
  { name: 'invoices', cols: ['id', 'order_id', 'total_cents', 'paid_at'] },
  { name: 'audit_log', cols: ['id', 'actor_id', 'action', 'at'] },
  { name: 'jobs', cols: ['id', 'kind', 'payload', 'run_at', 'attempts'] },
] as const;

const HOT_MODULES = new Set(['routes', 'services', 'pages', 'components']);

/** Marker stored on nodes whose function is "dead" — tag survives in `tags`. */
const DEAD_TAG = 'dead';

interface ModuleEntry {
  node: ModuleNode;
  name: string;
  path: string;
}

function buildTopology(ctx: Ctx, size: Size): void {
  const fe = addService(ctx, 'web', 'apps/web', 'ts');
  const feMods = FRONTEND_MODULES.map((m) =>
    addModule(ctx, fe, m, `apps/web/src/${m}/index.ts`),
  );

  const be = addService(ctx, 'api', 'apps/api', 'ts');
  const beMods = BACKEND_MODULES.map((m) =>
    addModule(ctx, be, m, `apps/api/src/${m}/index.ts`),
  );

  const wk = addService(ctx, 'worker', 'apps/worker', 'ts');
  const wkMods = WORKER_MODULES.map((m) =>
    addModule(ctx, wk, m, `apps/worker/src/${m}/index.ts`),
  );

  // Database "service" + per-table type nodes. Tables aren't modules, but we
  // need a parent for them — the db service plays that role.
  const db = addService(ctx, 'db', 'db', 'sql');
  const tableNodes: TypeNode[] = [];
  for (const t of DB_TABLES) {
    const table = addType(ctx, db.id, t.name, 'class', `db/migrations/${t.name}.sql`);
    tableNodes.push(table);
    if (size !== 'small') {
      // Per-column expression nodes for medium / large to exercise expression
      // rendering. These are just role-tagged literals, not sinks/leaves.
      let i = 0;
      for (const col of t.cols) {
        addExpression(ctx, table.id, `column|${col}|${i++}`, {
          role: 'column',
          pure: true,
        });
      }
    }
  }

  // Per-size scale factor for function fan-out.
  const [hotN, coldN] =
    size === 'small' ? [3, 1] : size === 'medium' ? [10, 3] : [70, 25];

  const fnByModule = new Map<NodeId, FunctionNode[]>();
  const allMods: ModuleEntry[] = [
    ...feMods.map((n) => ({ node: n, name: n.name, path: n.path })),
    ...beMods.map((n) => ({ node: n, name: n.name, path: n.path })),
    ...wkMods.map((n) => ({ node: n, name: n.name, path: n.path })),
  ];
  for (const mod of allMods) {
    const isHot = HOT_MODULES.has(mod.name);
    const count = isHot ? hotN : coldN;
    const fns: FunctionNode[] = [];
    for (let i = 0; i < count; i++) {
      fns.push(makeFunction(ctx, mod, i, isHot));
    }
    fnByModule.set(mod.node.id, fns);
  }

  // Module-level imports (within the same service).
  for (const svcMods of [feMods, beMods, wkMods]) {
    for (const mod of svcMods) {
      const others = svcMods.filter((m) => m.id !== mod.id);
      const importCount = pickInt(ctx.rng, 1, Math.min(4, others.length));
      const picks = sample(ctx.rng, others, importCount);
      for (const tgt of picks) {
        const edge: ImportEdge = {
          sourceId: mod.id,
          targetId: tgt.id,
          category: 'import',
          kind: 'static',
          specifier: `./${tgt.name}`,
        };
        ctx.edges.push(edge);
      }
    }
  }

  // Intra-service calls.
  for (const mod of allMods) {
    const myFns = fnByModule.get(mod.node.id) ?? [];
    const svcId = mod.node.parentId;
    const siblingMods = allMods.filter(
      (m) => m.node.parentId === svcId && m.node.id !== mod.node.id,
    );
    const siblingFns = siblingMods.flatMap((m) => fnByModule.get(m.node.id) ?? []);
    if (siblingFns.length === 0) continue;
    for (const fn of myFns) {
      const calls = pickInt(ctx.rng, 0, 3);
      const callees = sample(ctx.rng, siblingFns, calls);
      for (const callee of callees) {
        const dynamic = ctx.rng() < 0.08;
        const edge: CallEdge = {
          sourceId: fn.id,
          targetId: callee.id,
          category: 'call',
          callKind: dynamic ? 'dynamic' : 'direct',
        };
        ctx.edges.push(edge);
      }
    }
  }

  // Cross-service: frontend api-client -> backend routes (network calls).
  const apiClientMod = feMods.find((m) => m.name === 'api-client');
  const routesMod = beMods.find((m) => m.name === 'routes');
  if (apiClientMod && routesMod) {
    const callers = fnByModule.get(apiClientMod.id) ?? [];
    const callees = fnByModule.get(routesMod.id) ?? [];
    for (const caller of callers) {
      if (callees.length === 0) break;
      const target = pick(ctx.rng, callees);
      const edge: NetworkEdge = {
        sourceId: caller.id,
        targetId: target.id,
        category: 'network',
        kind: 'http',
        method: 'GET',
      };
      ctx.edges.push(edge);
    }
  }

  // Backend repositories -> DB tables.
  const repoMod = beMods.find((m) => m.name === 'repositories');
  if (repoMod) {
    const repoFns = fnByModule.get(repoMod.id) ?? [];
    for (const fn of repoFns) {
      if (tableNodes.length === 0) break;
      const tbl = pick(ctx.rng, tableNodes);
      const isWrite = ctx.rng() < 0.4;
      if (isWrite) {
        const e: DbWriteEdge = {
          sourceId: fn.id,
          targetId: tbl.id,
          category: 'db-write',
          store: 'postgres',
          entity: tbl.name,
          op: 'insert',
        };
        ctx.edges.push(e);
      } else {
        const e: DbReadEdge = {
          sourceId: fn.id,
          targetId: tbl.id,
          category: 'db-read',
          store: 'postgres',
          entity: tbl.name,
        };
        ctx.edges.push(e);
      }
    }
  }

  // Worker tasks -> DB writes (mostly jobs / audit_log).
  const tasksMod = wkMods.find((m) => m.name === 'tasks');
  if (tasksMod) {
    const fns = fnByModule.get(tasksMod.id) ?? [];
    const writeTargets = tableNodes.filter((t) =>
      ['jobs', 'audit_log', 'invoices', 'orders'].includes(t.name),
    );
    for (const fn of fns) {
      if (writeTargets.length === 0) break;
      const tbl = pick(ctx.rng, writeTargets);
      const e: DbWriteEdge = {
        sourceId: fn.id,
        targetId: tbl.id,
        category: 'db-write',
        store: 'postgres',
        entity: tbl.name,
        op: 'insert',
      };
      ctx.edges.push(e);
    }
  }

  // Backend queue -> worker consumers (cross-service calls).
  const queueMod = beMods.find((m) => m.name === 'queue');
  const consumerMod = wkMods.find((m) => m.name === 'consumers');
  if (queueMod && consumerMod) {
    const callers = fnByModule.get(queueMod.id) ?? [];
    const callees = fnByModule.get(consumerMod.id) ?? [];
    for (const caller of callers) {
      if (callees.length === 0) break;
      if (ctx.rng() < 0.6) {
        const target = pick(ctx.rng, callees);
        const e: CallEdge = {
          sourceId: caller.id,
          targetId: target.id,
          category: 'call',
          callKind: 'dynamic',
        };
        ctx.edges.push(e);
      }
    }
  }

  // Mark a few isolated functions as dead via a `dead` tag.
  const deadCount = size === 'small' ? 2 : size === 'medium' ? 6 : 25;
  const deadCandidates = pickDeadCandidates(allMods, fnByModule);
  const dead = sample(ctx.rng, deadCandidates, Math.min(deadCount, deadCandidates.length));
  for (const fn of dead) {
    fn.tags = [...(fn.tags ?? []), DEAD_TAG];
  }

  // Top up to the small target with cheap filler functions if needed.
  if (size === 'small') {
    while (ctx.nodes.length < 50) {
      const mod = pick(ctx.rng, [...feMods, ...beMods] as ModuleNode[]);
      const entry: ModuleEntry = { node: mod, name: mod.name, path: mod.path };
      const i = (fnByModule.get(mod.id)?.length ?? 0);
      const fn = makeFunction(ctx, entry, i, false);
      fnByModule.get(mod.id)!.push(fn);
    }
  }
}

// ---------- node constructors ----------

function addService(
  ctx: Ctx,
  name: string,
  path: string,
  lang: string,
): ServiceNode {
  const signature = `service|codegraph/sample-app|${path}`;
  const id = mintId(ctx, signature);
  const node: ServiceNode = {
    id,
    tier: 'service',
    name,
    path,
    signature,
    lang,
    manifest: `${path}/package.json`,
  };
  ctx.nodes.push(node);
  return node;
}

function addModule(
  ctx: Ctx,
  service: ServiceNode,
  name: string,
  path: string,
): ModuleNode {
  const signature = `module|${service.id}|${path}`;
  const id = mintId(ctx, signature);
  const node: ModuleNode = {
    id,
    tier: 'module',
    parentId: service.id,
    name,
    path,
    signature,
    lang: service.lang,
  };
  ctx.nodes.push(node);
  return node;
}

function addType(
  ctx: Ctx,
  parentId: NodeId,
  name: string,
  kind: string,
  loc: string,
): TypeNode {
  const signature = `type|${parentId}|${name}`;
  const id = mintId(ctx, signature);
  const node: TypeNode = {
    id,
    tier: 'type',
    parentId,
    name,
    kind,
    signature,
    loc: { path: loc, startLine: 1 },
  };
  ctx.nodes.push(node);
  return node;
}

function addExpression(
  ctx: Ctx,
  parentId: NodeId,
  payload: string,
  opts: { role?: string; pure: boolean },
): ExpressionNode {
  const signature = `expression|${parentId}|${payload}`;
  const id = mintId(ctx, signature);
  const node: ExpressionNode = {
    id,
    tier: 'expression',
    parentId,
    pure: opts.pure,
    signature,
    ...(opts.role ? { role: opts.role } : {}),
  };
  ctx.nodes.push(node);
  return node;
}

function makeFunction(
  ctx: Ctx,
  mod: ModuleEntry,
  i: number,
  isHot: boolean,
): FunctionNode {
  const verbs = ['get', 'list', 'create', 'update', 'delete', 'sync', 'render', 'parse', 'load'];
  const nouns = ['user', 'order', 'invoice', 'session', 'config', 'event', 'item', 'page'];
  const verb = verbs[i % verbs.length]!;
  const noun = nouns[Math.floor(i / verbs.length) % nouns.length]!;
  const fnName = `${verb}${capitalize(noun)}${i === 0 ? '' : i}`;
  // Pure if effect-free in this fixture's model. Hot functions are net-effectful.
  const pure = !isHot && ctx.rng() < 0.45;
  const paramTypeDisplay = capitalize(noun);
  const returnDisplay = pure
    ? capitalize(noun)
    : `Promise<${capitalize(noun)}>`;
  const params: FunctionParam[] = [
    { name: noun, type: tsType(paramTypeDisplay) },
  ];
  const signature = `function|${mod.node.id}|${fnName}|1|${paramTypeDisplay}`;
  const id = mintId(ctx, signature);
  const node: FunctionNode = {
    id,
    tier: 'function',
    parentId: mod.node.id,
    name: fnName,
    kind: pure ? 'function' : 'async',
    pure,
    params,
    signature,
    returnType: tsType(returnDisplay),
    asyncness: pure ? 'sync' : 'async',
    exported: i === 0,
  };
  ctx.nodes.push(node);
  return node;
}

function tsType(display: string): TypeRef {
  return { lang: 'ts', display, source: 'annotated' };
}

function pickDeadCandidates(
  modules: ModuleEntry[],
  fnByModule: Map<NodeId, FunctionNode[]>,
): FunctionNode[] {
  const cold = modules.filter((m) => !HOT_MODULES.has(m.name));
  return cold.flatMap((m) => fnByModule.get(m.node.id) ?? []);
}

// ---------- ID minting ----------

/**
 * Mint a deterministic 32-char hex NodeId from the canonical signature
 * string. Disambiguates collisions by appending a counter to the signature
 * and re-hashing — collisions are vanishingly rare for cyrb128, but the
 * defense matches the production indexer's de-dup behavior.
 */
function mintId(ctx: Ctx, signature: string): NodeId {
  let candidate = signature;
  let bump = 1;
  let hex = cyrb128hex(candidate);
  while (ctx.seenIds.has(hex)) {
    bump += 1;
    candidate = `${signature}#${bump}`;
    hex = cyrb128hex(candidate);
  }
  ctx.seenIds.add(hex);
  return asNodeId(hex);
}

/**
 * cyrb128 — a tiny, dependency-free 128-bit non-cryptographic hash over a
 * UTF-16 code-unit stream. Returns a 32-character lowercase hex string. The
 * production indexer uses BLAKE3-128; cyrb128 is interchangeable here as long
 * as the determinism contract holds. Source: bryc, public domain.
 */
function cyrb128hex(str: string): string {
  let h1 = 1779033703 ^ str.length;
  let h2 = 3144134277 ^ str.length;
  let h3 = 1013904242 ^ str.length;
  let h4 = 2773480762 ^ str.length;
  for (let i = 0, k: number; i < str.length; i++) {
    k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1; h3 ^= h1; h4 ^= h1;
  return (
    toHex8(h1 >>> 0) +
    toHex8(h2 >>> 0) +
    toHex8(h3 >>> 0) +
    toHex8(h4 >>> 0)
  );
}

function toHex8(n: number): string {
  return n.toString(16).padStart(8, '0');
}

// ---------- RNG and helpers ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function sample<T>(rng: () => number, arr: readonly T[], n: number): T[] {
  if (n <= 0 || arr.length === 0) return [];
  if (n >= arr.length) return [...arr];
  const copy = [...arr];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function pseudoCommit(rng: () => number): string {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 40; i++) s += hex[Math.floor(rng() * 16)];
  return s;
}
