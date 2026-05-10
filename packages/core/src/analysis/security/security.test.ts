/**
 * Tests for the built-in security pattern detector.
 *
 * Covers the three worked examples from `design/security-insights.md` §8:
 *   §8.1 — SQLi finding (HTTP route → raw-SQL db sink)
 *   §8.2 — Unauth route writes DB
 *   §8.3 — Secret leaks to log via an `unknown` hop
 *
 * Each example is constructed as a tiny synthetic IR — just enough nodes
 * and edges to trigger the pattern under test. Tests assert finding counts
 * and severity rather than exact path strings, since path-step shapes are a
 * private concern and may evolve.
 */
import { describe, it, expect } from "vitest";
import { runSecurityAnalysis } from "./index.js";
import {
  asNodeId,
  type Edge,
  type ExpressionNode,
  type FunctionNode,
  type IR,
  type ModuleNode,
  type Node,
  type ServiceNode,
} from "../../ir/types.js";

// ---------- IR builders (tiny, hand-rolled — no schema validation) --------

function svc(id: string, name: string): ServiceNode {
  return {
    tier: "service",
    id: asNodeId(id),
    signature: `service|${name}`,
    name,
    path: name,
    lang: "ts",
  };
}

function mod(id: string, parent: string, name: string): ModuleNode {
  return {
    tier: "module",
    id: asNodeId(id),
    parentId: asNodeId(parent),
    signature: `module|${parent}|${name}`,
    name,
    path: name,
    lang: "ts",
  };
}

function fn(
  id: string,
  parent: string,
  name: string,
  extras: Partial<FunctionNode> = {},
): FunctionNode {
  return {
    tier: "function",
    id: asNodeId(id),
    parentId: asNodeId(parent),
    signature: `function|${parent}|${name}`,
    name,
    kind: "function",
    pure: false,
    exported: true,
    params: [],
    ...extras,
  };
}

function expr(
  id: string,
  parent: string,
  extras: Partial<ExpressionNode> = {},
): ExpressionNode {
  return {
    tier: "expression",
    id: asNodeId(id),
    parentId: asNodeId(parent),
    signature: `expression|${parent}|${id}`,
    pure: false,
    ...extras,
  };
}

function edge(
  source: string,
  target: string,
  category: Edge["category"],
  extras: Record<string, unknown> = {},
): Edge {
  return {
    sourceId: asNodeId(source),
    targetId: asNodeId(target),
    category,
    ...extras,
  } as Edge;
}

function ir(nodes: Node[], edges: Edge[]): IR {
  return {
    metadata: {
      repo: "",
      commit: "test",
      generatedAt: "2026-05-09T00:00:00Z",
      generators: [{ name: "test", version: "0.0.0" }],
    },
    nodes,
    edges,
  };
}

// =========================================================================
// §8.1 — SQLi-flavored finding
// =========================================================================

describe("§8.1 SQLi finding (http-input → raw-sql db)", () => {
  // Builds an IR mirroring the worked example:
  //   route handler → req.query.q → db.query (raw-sql) → posts table sink
  function buildSqliIR(): IR {
    const s = svc("svc_api", "api");
    const m = mod("mod_search", "svc_api", "src/routes/search.ts");
    const handler = fn("fn_handler", "mod_search", "searchHandler");
    const dbQueryFn = fn("fn_dbquery", "mod_search", "query");
    const routeLiteral = expr("ex_route", "fn_handler", {
      leaf: { flavor: "literal", value: "/api/search", valueLang: "ts" },
      pure: true,
    });
    const httpInput = expr("ex_q", "fn_handler", {
      leaf: { flavor: "http-input", from: "query", field: "q" },
      pure: true,
    });
    const dbSink = expr("ex_dbsink", "fn_dbquery", {
      sink: { flavor: "db-write", store: "postgres", entity: "posts", op: "select" },
      tags: ["classification:raw-sql"],
      name: "db.query",
    });

    return ir(
      [s, m, handler, dbQueryFn, routeLiteral, httpInput, dbSink],
      [
        // Express adapter pairs the handler with a route literal.
        edge("fn_handler", "ex_route", "http-route", {
          method: "GET",
          tags: ["path:/api/search", "auth:none"],
        }),
        // q flows from req.query into the handler local.
        edge("fn_handler", "ex_q", "type-flow", {
          valueType: { lang: "ts", display: "string", source: "inferred" },
          role: "read",
        }),
        // q flows into db.query's argv[0].
        edge("ex_q", "fn_dbquery", "type-flow", {
          valueType: { lang: "ts", display: "string", source: "inferred" },
          role: "argument",
          argIndex: 0,
        }),
        // db.query reaches the raw-sql sink.
        edge("fn_dbquery", "ex_dbsink", "db-write", {
          valueType: { lang: "ts", display: "Row[]", source: "inferred" },
        }),
      ],
    );
  }

  it("emits exactly one http-input-to-raw-sql finding at high severity", () => {
    const result = runSecurityAnalysis(buildSqliIR());
    const sqli = result.findings.filter((f) => f.pattern === "http-input-to-raw-sql");
    expect(sqli).toHaveLength(1);
    const f = sqli[0]!;
    expect(f.severity).toBe("high");
    expect(f.componentScore).toBe(80);
    expect(f.evidence.classification).toBe("raw-sql");
    expect(f.evidence.routeAuth).toBe("none");
    expect(f.path.length).toBeGreaterThanOrEqual(2);
    expect(f.path[0]!.nodeId).toBe("fn_handler");
    expect(f.path[f.path.length - 1]!.nodeId).toBe("ex_dbsink");
    expect(f.suppressionKey).toContain("http-input-to-raw-sql");
  });

  it("disappears when the path crosses a configured sanitizer", () => {
    // Re-route q through a `sanitize` function and mark it as a sanitizer.
    const base = buildSqliIR();
    base.nodes.push(
      fn("fn_sanitize", "mod_search", "sanitize"),
    );
    // Replace direct ex_q -> fn_dbquery with ex_q -> fn_sanitize -> fn_dbquery.
    base.edges = base.edges.filter(
      (e) => !(e.sourceId === "ex_q" && e.targetId === "fn_dbquery"),
    );
    base.edges.push(
      edge("ex_q", "fn_sanitize", "type-flow", {
        valueType: { lang: "ts", display: "string", source: "inferred" },
      }),
      edge("fn_sanitize", "fn_dbquery", "type-flow", {
        valueType: { lang: "ts", display: "string", source: "inferred" },
      }),
    );

    const result = runSecurityAnalysis(base, {
      sanitizers: ["fn_sanitize"],
    });
    expect(
      result.findings.filter((f) => f.pattern === "http-input-to-raw-sql"),
    ).toHaveLength(0);
  });
});

// =========================================================================
// §8.2 — unauth route writes DB
// =========================================================================

describe("§8.2 unauth route writes DB", () => {
  function buildFeedbackIR(): IR {
    const s = svc("svc_api", "api");
    const m = mod("mod_feedback", "svc_api", "src/routes/feedback.ts");
    const handler = fn("fn_handler", "mod_feedback", "feedbackHandler");
    const dbInsert = expr("ex_dbsink", "fn_handler", {
      sink: { flavor: "db-write", store: "postgres", entity: "feedback", op: "insert" },
      name: "db.feedback.insert",
    });
    return ir(
      [s, m, handler, dbInsert],
      [
        edge("fn_handler", "fn_handler", "http-route", {
          method: "POST",
          tags: ["path:/api/feedback"], // no middleware, no auth tag
        }),
        edge("fn_handler", "ex_dbsink", "db-write", {
          valueType: { lang: "ts", display: "Feedback", source: "annotated" },
        }),
      ],
    );
  }

  it("flags an unauth route writing DB as high severity", () => {
    const result = runSecurityAnalysis(buildFeedbackIR(), {
      auth: { defaultRequired: true, publicRoutes: ["/health", "/login"] },
    });
    const unauth = result.findings.filter((f) => f.pattern === "unauth-sink");
    expect(unauth).toHaveLength(1);
    const f = unauth[0]!;
    expect(f.severity).toBe("high");
    expect(f.componentScore).toBe(75);
    expect(f.evidence.routeAuth === "none" || f.evidence.routeAuth === "unknown").toBe(true);
    expect(f.evidence.sinkLabel).toContain("feedback");
  });

  it("does not flag once the route is in publicRoutes", () => {
    const irDoc = buildFeedbackIR();
    const result = runSecurityAnalysis(irDoc, {
      auth: {
        defaultRequired: true,
        publicRoutes: ["/api/feedback", "/health", "/login"],
      },
    });
    expect(
      result.findings.filter((f) => f.pattern === "unauth-sink"),
    ).toHaveLength(0);
  });

  it("does not flag once an auth middleware is present on the route", () => {
    const irDoc = buildFeedbackIR();
    // Add an auth middleware tag.
    for (const e of irDoc.edges) {
      if (e.category === "http-route") {
        const tags = ((e as { tags?: string[] }).tags ?? []).slice();
        tags.push("middleware:requireAuth");
        (e as { tags: string[] }).tags = tags;
      }
    }
    const result = runSecurityAnalysis(irDoc);
    expect(
      result.findings.filter((f) => f.pattern === "unauth-sink"),
    ).toHaveLength(0);
  });
});

// =========================================================================
// §8.3 — secret leaks to log through an unknown hop
// =========================================================================

describe("§8.3 secret-to-log through an unknown hop", () => {
  // Mimics the audit logger example:
  //   POST /login.body.password (Secret) → audit.data (unknown hop)
  //                                     → logger.info → log sink
  function buildSecretLeakIR(): IR {
    const s = svc("svc_api", "api");
    const m1 = mod("mod_audit", "svc_api", "src/audit.ts");
    const m2 = mod("mod_auth", "svc_api", "src/routes/auth.ts");
    const auditFn = fn("fn_audit", "mod_audit", "audit", {
      params: [
        { name: "event", type: { lang: "ts", display: "string", source: "annotated" } },
        { name: "data", type: { lang: "ts", display: "unknown", source: "annotated" } },
      ],
    });
    const loginHandler = fn("fn_login", "mod_auth", "loginHandler");
    const passwordLeaf = expr("ex_password", "fn_login", {
      leaf: { flavor: "http-input", from: "body", field: "password" },
      valueType: {
        lang: "ts",
        display: "string & codegraph.Secret",
        source: "annotated",
      },
      pure: true,
      name: "req.body.password",
    });
    const logSink = expr("ex_logsink", "fn_audit", {
      sink: { flavor: "log", level: "info" },
      name: "logger.info",
    });
    return ir(
      [s, m1, m2, auditFn, loginHandler, passwordLeaf, logSink],
      [
        edge("fn_login", "fn_login", "http-route", {
          method: "POST",
          tags: ["path:/login", "middleware:requireAuth"],
        }),
        // password leaf flows into the handler.
        edge("fn_login", "ex_password", "type-flow", {
          valueType: {
            lang: "ts",
            display: "string & codegraph.Secret",
            source: "annotated",
          },
          role: "read",
        }),
        // password flows into audit (typed: carries Secret tag).
        edge("ex_password", "fn_audit", "type-flow", {
          valueType: {
            lang: "ts",
            display: "{ email: string, password: string & codegraph.Secret, ok: boolean }",
            source: "inferred",
          },
          role: "argument",
          argIndex: 1,
        }),
        // audit's data parameter forwards to logger.info — UNKNOWN-typed edge.
        edge("fn_audit", "ex_logsink", "type-flow", {
          valueType: { lang: "ts", display: "unknown", source: "annotated" },
        }),
      ],
    );
  }

  it("emits one secret-to-log finding at critical severity", () => {
    const result = runSecurityAnalysis(buildSecretLeakIR());
    const leaks = result.findings.filter((f) => f.pattern === "secret-to-log");
    expect(leaks).toHaveLength(1);
    const f = leaks[0]!;
    expect(f.severity).toBe("critical");
    expect(f.componentScore).toBe(90);
    expect(f.typeCarried).toBe("Secret");
    // The path should include exactly one unknown hop (audit -> logger).
    const unknownHops = f.path.filter((p) => p.unknownEdge).length;
    expect(unknownHops).toBe(1);
    expect(f.evidence.note).toMatch(/unknown-typed hop/i);
  });

  it("dedupes the unknown-near-sink finding for the same sink", () => {
    const result = runSecurityAnalysis(buildSecretLeakIR());
    const sinkId = result.findings
      .find((f) => f.pattern === "secret-to-log")!.sink;
    // No unknown-near-sink for the same sink; secret-leak is more specific.
    expect(
      result.findings.filter(
        (f) => f.pattern === "unknown-near-sink" && f.sink === sinkId,
      ),
    ).toHaveLength(0);
  });

  it("vanishes when audit is marked as a sanitizer", () => {
    const result = runSecurityAnalysis(buildSecretLeakIR(), {
      sanitizers: ["fn_audit"],
    });
    const leaks = result.findings.filter(
      (f) => f.pattern === "secret-to-log" || f.pattern === "secret-to-network",
    );
    expect(leaks).toHaveLength(0);
  });
});

// =========================================================================
// Determinism / smoke
// =========================================================================

describe("determinism", () => {
  it("two runs over the same IR produce identical findings", () => {
    const irDoc: IR = {
      metadata: {
        repo: "",
        commit: "x",
        generatedAt: "2026-05-09T00:00:00Z",
        generators: [],
      },
      nodes: [
        svc("s", "api"),
        mod("m", "s", "f.ts"),
        fn("h", "m", "h"),
        expr("sink", "h", {
          sink: { flavor: "db-write", store: "pg", entity: "x", op: "insert" },
        }),
      ],
      edges: [
        edge("h", "h", "http-route", { method: "POST", tags: ["path:/x"] }),
        edge("h", "sink", "db-write"),
      ],
    };
    const a = runSecurityAnalysis(irDoc, { auth: { defaultRequired: true } });
    const b = runSecurityAnalysis(irDoc, { auth: { defaultRequired: true } });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
