/**
 * IR loader.
 *
 * Types come from `@codegraph/core/ir` — the canonical IR shape. This module
 * is the viewer's I/O boundary: it fetches an `IRDocument`, runs a cheap
 * structural sniff to catch the common "wrong file" case (e.g. uploading a
 * package.json by mistake), and returns the inner `IR` graph for the rest of
 * the viewer to consume.
 *
 * The full Zod-backed validator lives in `@codegraph/core/ir/validate.ts` —
 * appropriate for CLI use, but pulling Zod into the viewer bundle is too
 * heavy for what the viewer needs. The structural sniff here is intentionally
 * lax so the viewer can render slightly-newer IRs that include unknown
 * fields, tiers, or edge categories.
 */

import type {
  IRDocument,
  IR as CoreIR,
  Node as CoreNode,
  Edge as CoreEdge,
  NodeTier,
  SourceLoc,
  EdgeCategory,
} from '@codegraph/core/ir';

// Re-export the canonical IR types under the viewer's historical names so
// existing components that imported `Node`, `Edge`, `IR`, `Tier` from this
// module keep working without churn.
export type IR = CoreIR;
export type Node = CoreNode;
export type Edge = CoreEdge;
export type Tier = NodeTier;
export type EdgeKind = EdgeCategory;
/** Legacy alias for `loc` field — viewer code that imported `Provenance`. */
export type Provenance = SourceLoc;

// ---------- Loader ----------

/**
 * Load and validate an IR document, returning the inner `IR` graph.
 *
 * Accepts either a URL string (relative or absolute) or a `File` from a file
 * input. Throws a descriptive `Error` on fetch / parse / shape failure so the
 * caller can surface it in the UI.
 */
export async function loadIR(source: string | File): Promise<IR> {
  let raw: unknown;

  if (typeof source === 'string') {
    let res: Response;
    try {
      res = await fetch(source, { cache: 'no-cache' });
    } catch (err) {
      throw new Error(`failed to fetch IR from ${source}: ${stringifyErr(err)}`);
    }
    if (!res.ok) {
      throw new Error(`fetching IR from ${source} returned HTTP ${res.status}`);
    }
    try {
      raw = await res.json();
    } catch (err) {
      throw new Error(`IR at ${source} is not valid JSON: ${stringifyErr(err)}`);
    }
  } else {
    let text: string;
    try {
      text = await source.text();
    } catch (err) {
      throw new Error(`failed to read file ${source.name}: ${stringifyErr(err)}`);
    }
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`file ${source.name} is not valid JSON: ${stringifyErr(err)}`);
    }
  }

  return validateIR(raw);
}

/**
 * Cheap structural sniff for the canonical IR document shape:
 * `{ schemaVersion: string, ir: { metadata, nodes: [...], edges: [...] } }`.
 *
 * Verifies just enough to catch the common "wrong file" case and to keep the
 * rest of the viewer from blowing up on missing arrays. Does NOT validate
 * tier values, edge categories, or per-node fields — viewers must tolerate
 * unknown enum values per the IR forward-compatibility rules.
 *
 * Returns the inner `IR` (graph) so callers can do `ir.nodes` / `ir.edges`.
 */
export function validateIR(raw: unknown): IR {
  if (!isObject(raw)) {
    throw new Error('IR document root is not an object');
  }
  const root = raw as Record<string, unknown>;
  if (typeof root.schemaVersion !== 'string') {
    throw new Error(
      'IR document is missing the "schemaVersion" field (got ' +
        typeOf(root.schemaVersion) +
        '). Expected the canonical {schemaVersion, ir} shape.',
    );
  }
  if (!isObject(root.ir)) {
    throw new Error(
      'IR document is missing the "ir" object — got ' + typeOf(root.ir),
    );
  }

  const ir = root.ir as Record<string, unknown>;
  if (!isObject(ir.metadata)) {
    throw new Error('IR.metadata must be an object');
  }
  if (!Array.isArray(ir.nodes)) {
    throw new Error('IR.nodes must be an array');
  }
  if (!Array.isArray(ir.edges)) {
    throw new Error('IR.edges must be an array');
  }

  const seenNodeIds = new Set<string>();
  ir.nodes.forEach((n, i) => {
    if (!isObject(n)) throw new Error(`IR.nodes[${i}] is not an object`);
    const id = (n as Record<string, unknown>).id;
    const tier = (n as Record<string, unknown>).tier;
    if (typeof id !== 'string') throw new Error(`IR.nodes[${i}].id must be a string`);
    if (typeof tier !== 'string') throw new Error(`IR.nodes[${i}].tier must be a string`);
    if (seenNodeIds.has(id)) throw new Error(`duplicate node id: ${id}`);
    seenNodeIds.add(id);
  });

  ir.edges.forEach((e, i) => {
    if (!isObject(e)) throw new Error(`IR.edges[${i}] is not an object`);
    const rec = e as Record<string, unknown>;
    if (typeof rec.sourceId !== 'string') {
      throw new Error(`IR.edges[${i}].sourceId must be a string`);
    }
    if (typeof rec.targetId !== 'string') {
      throw new Error(`IR.edges[${i}].targetId must be a string`);
    }
    if (typeof rec.category !== 'string') {
      throw new Error(`IR.edges[${i}].category must be a string`);
    }
    if (!seenNodeIds.has(rec.sourceId as string)) {
      throw new Error(
        `IR.edges[${i}].sourceId references unknown node ${rec.sourceId as string}`,
      );
    }
    if (!seenNodeIds.has(rec.targetId as string)) {
      throw new Error(
        `IR.edges[${i}].targetId references unknown node ${rec.targetId as string}`,
      );
    }
  });

  return ir as unknown as IR;
}

// Re-exporting `IRDocument` so callers that explicitly want the document
// wrapper (rare — most just want the graph from `loadIR`) can pull it from
// the same module.
export type { IRDocument };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function stringifyErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
