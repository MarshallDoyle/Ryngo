/**
 * PII / Secret type registry — implements `design/security-insights.md` §5.
 *
 * Three input channels, in priority order:
 *   1. Explicit user-annotated branded types (`codegraph.Pii`, `codegraph.Secret`).
 *   2. Adapter rules (e.g. the auth adapter declares `password` is Secret on
 *      a `POST /login` body).
 *   3. Optional name-pattern auto-detect (off by default; see §5.1.3).
 *
 * The output is a small queryable surface used by `patterns/pii-leak.ts` and
 * the index orchestrator: "given this NodeId, does its valueType (or any
 * tagged ancestor) carry a Pii or Secret tag?"
 */
import type {
  ExpressionNode,
  IR,
  Node,
  NodeId,
  StructuralType,
  TypeRef,
} from "../../ir/types.js";

export type PiiTag = "Pii" | "Secret";

/** Reserved branded-type tag names per §5.1.1. */
export const PII_BRAND = "codegraph.Pii";
export const SECRET_BRAND = "codegraph.Secret";

/** Default name regexes per §5.1.3. Documented as best-effort. */
export const DEFAULT_PII_NAME_RE =
  /^(email|phone|ssn|dob|first[_-]?name|last[_-]?name|address)$/i;
export const DEFAULT_SECRET_NAME_RE =
  /^(password|api[_-]?key|secret|token|private[_-]?key|access[_-]?key)$/i;

export interface PiiTypeRegistryOptions {
  /** Adapter-supplied: NodeId → tag, e.g. the `password` field on POST /login. */
  adapterRules?: Map<NodeId, PiiTag>;
  /** §5.1.3 name-pattern auto-detect — off by default. */
  namePatterns?: { pii?: boolean; secret?: boolean };
  /** Allowlist names that should NOT match the regexes (false-friend list). */
  nameAllowlist?: RegExp[];
}

export interface PiiTypeRegistry {
  /** Resolve a tag for a given expression/function node, if any. */
  tagForNode(nodeId: NodeId): PiiTag | undefined;
  /** Detect a tag from a TypeRef alone (used for §5.2 sticky propagation). */
  tagForType(t: TypeRef | undefined): PiiTag | undefined;
  /** Detect a tag from a field name + the registry's name-pattern config. */
  tagForFieldName(name: string): PiiTag | undefined;
  /** All node ids carrying a Pii or Secret tag. */
  taggedNodes(): ReadonlyMap<NodeId, PiiTag>;
}

export function buildPiiRegistry(
  ir: IR,
  opts: PiiTypeRegistryOptions = {},
): PiiTypeRegistry {
  const adapterRules = opts.adapterRules ?? new Map<NodeId, PiiTag>();
  const namePatterns = opts.namePatterns ?? { pii: false, secret: false };
  const allowlist = opts.nameAllowlist ?? [];

  /** Branded-type detection: walks a `StructuralType` for branded segments. */
  const tagFromStructural = (st: StructuralType | undefined): PiiTag | undefined => {
    if (!st) return undefined;
    switch (st.kind) {
      case "intersection":
      case "union":
      case "tuple":
        for (const a of st.args) {
          const found = tagFromStructural(a);
          if (found) return found;
        }
        return undefined;
      case "generic":
        // Promise<Secret>, Result<Pii, _>, etc. propagate inner tag.
        for (const a of st.args) {
          const found = tagFromStructural(a);
          if (found) return found;
        }
        return undefined;
      case "record":
        for (const f of st.fields) {
          const found = tagFromStructural(f.type);
          if (found) return found;
          const fromName = tagForFieldName(f.name);
          if (fromName) return fromName;
        }
        return undefined;
      case "literal":
        return typeof st.value === "string" ? brandFromDisplay(st.value) : undefined;
      case "ref":
        return brandFromDisplay(st.name);
      case "primitive":
        return brandFromDisplay(st.name);
      case "function":
        return tagFromStructural(st.ret);
      default:
        return undefined;
    }
  };

  const tagForType = (t: TypeRef | undefined): PiiTag | undefined => {
    if (!t) return undefined;
    const fromDisplay = brandFromDisplay(t.display);
    if (fromDisplay) return fromDisplay;
    return tagFromStructural(t.structural);
  };

  const tagForFieldName = (name: string): PiiTag | undefined => {
    if (allowlist.some((re) => re.test(name))) return undefined;
    if (namePatterns.secret && DEFAULT_SECRET_NAME_RE.test(name)) return "Secret";
    if (namePatterns.pii && DEFAULT_PII_NAME_RE.test(name)) return "Pii";
    return undefined;
  };

  // Build the per-node tag map by sweeping the IR once.
  const tagged = new Map<NodeId, PiiTag>(adapterRules);
  for (const node of ir.nodes) {
    if (tagged.has(node.id)) continue;
    const tag = inferTagForNode(node, tagForType);
    if (tag) tagged.set(node.id, tag);
  }

  return {
    tagForNode: (nodeId) => tagged.get(nodeId),
    tagForType,
    tagForFieldName,
    taggedNodes: () => tagged,
  };
}

// ---------- helpers ----------

/** Brand detection from a TypeRef.display surface form. */
function brandFromDisplay(display: string): PiiTag | undefined {
  if (display.includes(SECRET_BRAND)) return "Secret";
  if (display.includes(PII_BRAND)) return "Pii";
  // Common surface forms: `string & Secret`, `string & Pii`, `Secret<...>`.
  if (/(?:^|[\s&|<])Secret(?:[\s>&|]|$)/.test(display)) return "Secret";
  if (/(?:^|[\s&|<])Pii(?:[\s>&|]|$)/.test(display)) return "Pii";
  return undefined;
}

function inferTagForNode(
  node: Node,
  tagForType: (t: TypeRef | undefined) => PiiTag | undefined,
): PiiTag | undefined {
  if (node.tier === "expression") {
    const e = node as ExpressionNode;
    return tagForType(e.valueType);
  }
  if (node.tier === "function") {
    return tagForType(node.returnType);
  }
  if (node.tier === "type" && node.fields) {
    for (const f of node.fields) {
      const t = tagForType(f.type);
      if (t) return t;
    }
  }
  return undefined;
}
