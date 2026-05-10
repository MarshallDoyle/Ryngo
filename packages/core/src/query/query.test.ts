/**
 * cgql — end-to-end tests over a hand-built fixture IR shaped on the §10
 * worked example in spec/ir-schema.md (web/api/db three-file repo).
 *
 * Coverage: at least the 5 worked examples in design/query-language.md §8.
 * These double as the smoke-test suite the §12 testing strategy calls out.
 */

import { describe, expect, it } from "vitest";

import type {
  Edge,
  ExpressionNode,
  FunctionNode,
  IR,
  ModuleNode,
  Node,
  NodeId,
  ServiceNode,
} from "../ir/types.js";
import { asNodeId } from "../ir/types.js";
import { runQuery } from "./engine.js";
import { parse } from "./parser.js";

// =============================================================================
// Fixture
// =============================================================================

const id = (s: string): NodeId => asNodeId(s.padEnd(32, "0"));

const SERVICE_WEB: ServiceNode = {
  id: id("web0"), tier: "service", name: "web", path: "apps/web",
  signature: "service|repo|apps/web", lang: "ts",
};
const SERVICE_API: ServiceNode = {
  id: id("api0"), tier: "service", name: "api", path: "apps/api",
  signature: "service|repo|apps/api", lang: "ts",
};

const MOD_SIGNUP_FORM: ModuleNode = {
  id: id("modweb"), tier: "module", parentId: SERVICE_WEB.id, name: "SignupForm.tsx",
  path: "apps/web/src/SignupForm.tsx", signature: "module|web|...", lang: "tsx",
};
const MOD_ROUTES_SIGNUP: ModuleNode = {
  id: id("modroutes"), tier: "module", parentId: SERVICE_API.id, name: "routes/signup.ts",
  path: "apps/api/src/routes/signup.ts", signature: "module|api|...", lang: "ts",
};
const MOD_DB: ModuleNode = {
  id: id("moddb"), tier: "module", parentId: SERVICE_API.id, name: "db.ts",
  path: "apps/api/src/db.ts", signature: "module|api|db", lang: "ts",
};
const MOD_AUTH: ModuleNode = {
  id: id("modauth"), tier: "module", parentId: SERVICE_API.id, name: "middleware/auth.ts",
  path: "apps/api/src/auth/middleware.ts", signature: "module|api|auth", lang: "ts",
  // Adapter-emitted hint used by §8.5; the engine resolves it via property access.
  // (The `churn90d` field is open per spec/ir-schema.md §8 — analyzers may stamp it.)
  // We attach it via index signature on Metadata-like extension.
  // @ts-expect-error — open extension field per spec §8.
  churn90d: 35,
};
const MOD_AUTH_LOW_CHURN: ModuleNode = {
  id: id("modauth2"), tier: "module", parentId: SERVICE_API.id, name: "auth/util.ts",
  path: "apps/api/src/auth/util.ts", signature: "module|api|auth-util", lang: "ts",
  // @ts-expect-error — extension field.
  churn90d: 5,
};

const FN_PAYMENTS: FunctionNode = {
  id: id("fnpay"), tier: "function", parentId: MOD_ROUTES_SIGNUP.id,
  name: "paymentsHandler", signature: "function|...", kind: "function",
  pure: false, exported: true, params: [],
  tags: ["route:any", "auth:public"],
};
const FN_HANDLE_SIGNUP: FunctionNode = {
  id: id("fnsignup"), tier: "function", parentId: MOD_ROUTES_SIGNUP.id,
  name: "handleSignup", signature: "function|...", kind: "function",
  pure: false, exported: true, params: [],
};
const FN_CREATE_USER: FunctionNode = {
  id: id("fncreate"), tier: "function", parentId: MOD_DB.id,
  name: "createUser", signature: "function|...", kind: "function",
  pure: false, exported: true, params: [],
};
const FN_VALIDATE: FunctionNode = {
  id: id("fnvalid"), tier: "function", parentId: MOD_ROUTES_SIGNUP.id,
  name: "validateInput", signature: "function|...", kind: "function",
  pure: true, exported: false, params: [],
};
const FN_DEAD: FunctionNode = {
  id: id("fndead"), tier: "function", parentId: MOD_DB.id,
  name: "deprecatedHelper", signature: "function|...", kind: "function",
  pure: true, exported: true, params: [],
};

// expressions
const EXPR_HTTP_INPUT: ExpressionNode = {
  id: id("expinput"), tier: "expression", parentId: FN_HANDLE_SIGNUP.id,
  signature: "expression|...", pure: true,
  leaf: { flavor: "http-input", from: "body", field: "email" },
};
const EXPR_DB_WRITE: ExpressionNode = {
  id: id("expdbwrite"), tier: "expression", parentId: FN_CREATE_USER.id,
  signature: "expression|...", pure: false,
  sink: { flavor: "db-write", store: "postgres", entity: "User", op: "insert" },
};
const EXPR_HTTP_ROUTE_LITERAL: ExpressionNode = {
  id: id("explit"), tier: "expression", parentId: FN_HANDLE_SIGNUP.id,
  signature: "expression|...", pure: true,
  leaf: { flavor: "literal", value: "/api/signup" },
};
const EXPR_PAY_DB: ExpressionNode = {
  id: id("exppdb"), tier: "expression", parentId: FN_PAYMENTS.id,
  signature: "expression|...", pure: false,
  sink: { flavor: "db-write", store: "postgres", entity: "Payment", op: "insert" },
};

// edges
const ed = (s: NodeId, t: NodeId, c: string, extra: Partial<Edge> = {}): Edge =>
  ({ sourceId: s, targetId: t, category: c as never, ...extra }) as Edge;

const FIXTURE_IR: IR = {
  metadata: {
    repo: "test", commit: "abc", generatedAt: "2026-05-09T00:00:00Z",
    generators: [{ name: "test", version: "0.0.0" }],
  },
  nodes: [
    SERVICE_WEB, SERVICE_API,
    MOD_SIGNUP_FORM, MOD_ROUTES_SIGNUP, MOD_DB, MOD_AUTH, MOD_AUTH_LOW_CHURN,
    FN_PAYMENTS, FN_HANDLE_SIGNUP, FN_CREATE_USER, FN_VALIDATE, FN_DEAD,
    EXPR_HTTP_INPUT, EXPR_DB_WRITE, EXPR_HTTP_ROUTE_LITERAL, EXPR_PAY_DB,
  ] as Node[],
  edges: [
    ed(FN_HANDLE_SIGNUP.id, FN_VALIDATE.id, "call"),
    ed(FN_HANDLE_SIGNUP.id, FN_CREATE_USER.id, "call"),
    ed(FN_HANDLE_SIGNUP.id, EXPR_HTTP_INPUT.id, "type-flow", { role: "read" } as never),
    ed(FN_HANDLE_SIGNUP.id, EXPR_HTTP_ROUTE_LITERAL.id, "http-route", { method: "POST" } as never),
    ed(FN_CREATE_USER.id, EXPR_DB_WRITE.id, "db-write"),
    ed(FN_CREATE_USER.id, EXPR_DB_WRITE.id, "call"),  // also reachable via call→sink-expr
    ed(FN_PAYMENTS.id, EXPR_HTTP_ROUTE_LITERAL.id, "http-route", { method: "POST" } as never),
    ed(FN_PAYMENTS.id, FN_CREATE_USER.id, "call"),
    ed(FN_PAYMENTS.id, EXPR_PAY_DB.id, "call"),
    ed(FN_PAYMENTS.id, EXPR_PAY_DB.id, "db-write"),
  ],
};

// =============================================================================
// Parser smoke
// =============================================================================

describe("parser", () => {
  it("parses single-MATCH RETURN", () => {
    const ast = parse(`MATCH (f:function) RETURN f.id, f.name`);
    expect(ast.matches).toHaveLength(1);
    expect(ast.ret.items).toHaveLength(2);
  });

  it("parses variable-length paths", () => {
    const ast = parse(`MATCH p = (a:function)-[:call*1..5]->(b:function) RETURN p`);
    const m = ast.matches[0]!;
    expect(m.pathVar).toBe("p");
    expect(m.pattern.edges[0]!.varLen).toEqual({ min: 1, max: 5 });
    expect(m.pattern.edges[0]!.categories).toEqual(["call"]);
  });

  it("substitutes $params before parsing", () => {
    const ast = parse(`MATCH (f:function) WHERE f.name = $nm RETURN f`, { nm: "handleSignup" });
    expect(ast.where).toBeDefined();
  });

  it("rejects unbound $params with a precise span", () => {
    expect(() => parse(`MATCH (f:function) WHERE f.name = $missing RETURN f`)).toThrowError(/\$missing/);
  });

  it("supports comments", () => {
    const ast = parse(`
      // a comment
      MATCH (n) /* and another */ RETURN n.id
    `);
    expect(ast.ret.items).toHaveLength(1);
  });
});

// =============================================================================
// §8 worked examples
// =============================================================================

describe("§8.1 — paths from any HTTP route to any DB write", () => {
  it("returns at least one path", async () => {
    const q = `
      MATCH p = (h:function)-[:call|type-flow*1..8]->(s:expression {tag:"sink:db-write"})
      WHERE EXISTS { (h)-[:http-route]->() }
      RETURN p
      ORDER BY length(p)
      LIMIT 200
    `;
    const r = await runQuery(FIXTURE_IR, q);
    expect(r.shape).toBe("paths");
    expect(r.rows.length).toBeGreaterThanOrEqual(1);
    // every path should start at handleSignup or paymentsHandler (both have http-route).
    for (const row of r.rows) {
      const path = row[0] as { nodes: string[] };
      const start = path.nodes[0]!;
      expect([FN_HANDLE_SIGNUP.id, FN_PAYMENTS.id]).toContain(start);
    }
  });
});

describe("§8.2 — functions reachable from paymentsHandler that are impure", () => {
  it("returns createUser (impure descendant), but never validateInput (pure)", async () => {
    const q = `
      MATCH (start:function {name:"paymentsHandler"})
      MATCH p = (start)-[:call*1..]->(f:function)
      WHERE f.pure = false
      RETURN DISTINCT f.id, f.name, length(p) AS hops
      ORDER BY hops, f.name
    `;
    const r = await runQuery(FIXTURE_IR, q);
    expect(r.shape).toBe("table");
    const names = r.rows.map((row) => row[1] as string);
    expect(names).toContain("createUser");
    expect(names).not.toContain("validateInput");
  });
});

describe("§8.4 — functions changed in this PR reachable from auth routes", () => {
  it("filters by changedInPR()", async () => {
    const q = `
      MATCH (route:function)
      WHERE hasTag(route, "route:any") AND hasTag(route, "auth:public")
      MATCH p = (route)-[:call*1..]->(f:function)
      WHERE f.id IN changedInPR()
      RETURN DISTINCT f.name, length(p) AS distance
      ORDER BY distance, f.name
    `;
    const r = await runQuery(FIXTURE_IR, q, { prChanges: [FN_CREATE_USER.id] });
    expect(r.shape).toBe("table");
    const names = r.rows.map((row) => row[0] as string);
    expect(names).toContain("createUser");
  });

  it("returns empty when nothing changed", async () => {
    const q = `
      MATCH (route:function)
      WHERE hasTag(route, "auth:public")
      MATCH p = (route)-[:call*1..]->(f:function)
      WHERE f.id IN changedInPR()
      RETURN f.name
    `;
    const r = await runQuery(FIXTURE_IR, q);
    expect(r.rows).toEqual([]);
  });
});

describe("§8.5 — files with high churn AND in the auth subsystem", () => {
  it("uses glob() and an open property field", async () => {
    const q = `
      MATCH (m:module)
      WHERE glob(m.path, "**/auth/**")
        AND m.churn90d > 20
      WITH m, m.churn90d AS churn
      RETURN m.path, churn
      ORDER BY churn DESC
      LIMIT 50
    `;
    const r = await runQuery(FIXTURE_IR, q);
    expect(r.shape).toBe("table");
    const paths = r.rows.map((row) => row[0] as string);
    expect(paths).toContain("apps/api/src/auth/middleware.ts");
    expect(paths).not.toContain("apps/api/src/auth/util.ts"); // churn=5, below threshold
  });
});

describe("§8.7 — exported functions never imported externally", () => {
  it("returns dead exports via NOT EXISTS", async () => {
    const q = `
      MATCH (f:function {exported:true})
      WHERE NOT EXISTS { ()-[:import]->(f) }
      RETURN f.name
      ORDER BY f.name
    `;
    const r = await runQuery(FIXTURE_IR, q);
    expect(r.shape).toBe("table");
    const names = r.rows.map((row) => row[0] as string);
    // None of the fixture functions have inbound import edges.
    expect(names).toEqual(expect.arrayContaining(["createUser", "deprecatedHelper", "handleSignup", "paymentsHandler"]));
  });
});

describe("§8.10 — callgraph diamond (mutual recursion)", () => {
  it("returns nothing on this fixture (no mutual recursion)", async () => {
    const q = `
      MATCH (a:function)-[:call]->(b:function), (b)-[:call]->(a)
      WHERE a.id < b.id
      RETURN a.name, b.name
    `;
    const r = await runQuery(FIXTURE_IR, q);
    expect(r.rows).toEqual([]);
  });
});

// =============================================================================
// Indexing + planner heuristics
// =============================================================================

describe("planner heuristics", () => {
  it("--explain includes the chosen plan and Index hints", async () => {
    const q = `MATCH (s:expression {tag:"sink:db-write"}) RETURN s.id`;
    const r = await runQuery(FIXTURE_IR, q, { explain: true });
    expect(r.rows[0]![0]).toMatch(/Scan/);
  });

  it("clamps unbounded *", async () => {
    const q = `MATCH p = (a:function)-[:call*]->(b:function) RETURN p LIMIT 1`;
    const r = await runQuery(FIXTURE_IR, q);
    expect(r.diagnostics.some((d) => /clamped/.test(d.message))).toBe(true);
  });

  it("respects --max-path-length override", async () => {
    const q = `MATCH p = (a:function)-[:call*]->(b:function) RETURN p LIMIT 1`;
    const r = await runQuery(FIXTURE_IR, q, { maxPathLength: 4 });
    expect(r.diagnostics.some((d) => /clamped to \*1\.\.4/.test(d.message))).toBe(true);
  });

  it("scans by sink flavor (heuristic 2)", async () => {
    const q = `MATCH (s:expression {tag:"sink:db-write"}) RETURN s.id`;
    const r = await runQuery(FIXTURE_IR, q);
    const ids = r.rows.map((row) => row[0]);
    expect(ids.length).toBe(2); // EXPR_DB_WRITE + EXPR_PAY_DB
  });
});

// =============================================================================
// Output shapes
// =============================================================================

describe("result envelope", () => {
  it("populates schemaVersion + cgqlVersion", async () => {
    const r = await runQuery(FIXTURE_IR, `MATCH (n:service) RETURN n.name`);
    expect(r.schemaVersion).toBe("0.1.0");
    expect(r.cgqlVersion).toBe("0.1.0");
  });

  it("populates stats.planNodes", async () => {
    const r = await runQuery(FIXTURE_IR, `MATCH (n:service) RETURN n.name`);
    expect(r.stats.planNodes).toBeGreaterThan(0);
  });

  it("returns subgraph shape for RETURN subgraph(p)", async () => {
    const q = `
      MATCH p = (a:function {name:"handleSignup"})-[:call*1..3]->(b:function)
      RETURN subgraph(p)
    `;
    const r = await runQuery(FIXTURE_IR, q);
    expect(r.shape).toBe("subgraph");
    expect(r.rows[0]![0]).toMatchObject({ nodes: expect.any(Array), edges: expect.any(Array) });
  });
});

// =============================================================================
// Determinism
// =============================================================================

describe("determinism (§7.5)", () => {
  it("two runs produce byte-identical rows", async () => {
    const q = `MATCH (f:function) RETURN f.id, f.name`;
    const a = await runQuery(FIXTURE_IR, q);
    const b = await runQuery(FIXTURE_IR, q);
    expect(JSON.stringify(a.rows)).toBe(JSON.stringify(b.rows));
  });
});
