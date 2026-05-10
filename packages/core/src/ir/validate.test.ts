import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "./types";
import { validateIR } from "./validate";

const SVC = "0".repeat(32);
const MOD = "1".repeat(32);

const minimalDoc = () => ({
  schemaVersion: SCHEMA_VERSION,
  ir: {
    metadata: {
      repo: "",
      commit: "deadbeef",
      generatedAt: "2026-05-09T00:00:00Z",
      generators: [{ name: "test", version: "0.0.0" }],
    },
    nodes: [
      { id: SVC, signature: "svc", tier: "service", name: "api", path: "apps/api" },
      { id: MOD, signature: "mod", tier: "module", parentId: SVC, name: "index", path: "apps/api/src/index.ts" },
    ],
    edges: [{ sourceId: MOD, targetId: SVC, category: "import" }],
  },
});

describe("validateIR", () => {
  it("accepts a valid minimal IR", () => {
    const r = validateIR(minimalDoc());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ir.ir.nodes).toHaveLength(2);
  });

  it("rejects a document missing schemaVersion", () => {
    const d = minimalDoc() as Record<string, unknown>;
    delete d.schemaVersion;
    const r = validateIR(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.path === "/schemaVersion")).toBe(true);
  });

  it("rejects an unknown node tier (not in known set, not x-*)", () => {
    const d = minimalDoc();
    (d.ir.nodes[0] as Record<string, unknown>).tier = "galaxy";
    const r = validateIR(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /tier/.test(e.path) || /tier/.test(e.message))).toBe(true);
  });

  it("rejects an edge whose endpoint is not in the node set", () => {
    const d = minimalDoc();
    d.ir.edges.push({ sourceId: MOD, targetId: "f".repeat(32), category: "call" });
    const r = validateIR(d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.path === "/ir/edges/1/targetId")).toBe(true);
    }
  });

  it("rejects an unknown edge category that is not x-* prefixed", () => {
    const d = minimalDoc();
    (d.ir.edges[0] as Record<string, unknown>).category = "telepathy";
    const r = validateIR(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /category/.test(e.message) || /category/.test(e.path))).toBe(true);
  });

  it("rejects a schemaVersion that does not match the current SCHEMA_VERSION", () => {
    const d = minimalDoc();
    d.schemaVersion = "9.9.9";
    const r = validateIR(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /schemaVersion mismatch/i.test(e.message))).toBe(true);
  });
});
