/**
 * Type → CSS color mapping (Phase 4.2c).
 *
 * Stable, deterministic. Same type string → same color across runs.
 *
 * - Closed map for primitives (string / number / boolean / void / etc.)
 * - Hash-based hue for named types (User / Order / Foo<T>) so the same
 *   type carries the same color end-to-end across the graph
 * - Fallback gray for missing or unknown types
 *
 * Usage:
 *   import { typeColor } from "../lib/type-color.js";
 *   typeColor("string")           → "#22c55e"
 *   typeColor("Promise<User>")    → hue(User) (Promise unwrapped)
 *   typeColor(null)               → "#6b7280" (gray)
 */

const PRIMITIVES = new Map([
  ["string", "#22c55e"],
  ["str", "#22c55e"],
  ["number", "#60a5fa"],
  ["int", "#60a5fa"],
  ["float", "#60a5fa"],
  ["double", "#60a5fa"],
  ["bigint", "#60a5fa"],
  ["boolean", "#fbbf24"],
  ["bool", "#fbbf24"],
  ["void", "#9ca3af"],
  ["null", "#9ca3af"],
  ["undefined", "#9ca3af"],
  ["none", "#9ca3af"],
  ["any", "#a1a1aa"],
  ["unknown", "#a1a1aa"],
  ["object", "#c084fc"],
  ["dict", "#c084fc"],
  ["list", "#fb923c"],
  ["array", "#fb923c"],
  ["tuple", "#fb923c"],
  ["bytes", "#f97316"],
  ["buffer", "#f97316"],
  ["date", "#f472b6"],
  ["datetime", "#f472b6"],
]);

const FALLBACK = "#6b7280";

/**
 * Normalise a TypeScript / Python type string for color lookup.
 * - "Promise<User>" → "User"  (unwrap Promise/Awaitable/Future)
 * - "User | null"   → "User"  (drop null branch for color, the null
 *                              variation can be conveyed by stroke style)
 * - "Optional[User]" → "User"
 * - "List[User]"     → "User" (let "User" drive the color, not "List")
 * - "Dict[str, User]" → "User"
 * - All trimmed; no quotes; underscores/dots preserved
 */
export function canonicalType(raw) {
  if (raw == null) return null;
  let t = String(raw).trim();
  if (!t) return null;

  // Strip outer parens
  while (t.startsWith("(") && t.endsWith(")")) t = t.slice(1, -1).trim();

  // Drop trailing nullable markers
  t = t.replace(/\s*\|\s*(?:null|undefined|None)\s*$/, "");
  t = t.replace(/^\s*(?:null|undefined|None)\s*\|\s*/, "");

  // Optional[T] / Awaitable[T] / Promise<T> / Future[T] / Coroutine[Any, Any, T]
  const wrappers = [
    /^Optional\s*\[\s*(.+)\s*\]$/,
    /^Promise\s*<\s*(.+)\s*>$/,
    /^Awaitable\s*\[\s*(.+)\s*\]$/,
    /^Future\s*\[\s*(.+)\s*\]$/,
    /^Coroutine\s*\[[^\]]*?,\s*[^\]]*?,\s*(.+)\s*\]$/,
  ];
  for (const w of wrappers) {
    const m = t.match(w);
    if (m) {
      t = m[1].trim();
      break;
    }
  }

  // List[T] / Dict[K, V] / Tuple[...] — pick the most informative element
  const list = t.match(/^(?:List|list|Set|set|Iterable|Iterator|Sequence)\s*\[\s*(.+)\s*\]$/);
  if (list) return canonicalType(list[1]);
  const dict = t.match(/^(?:Dict|dict|Mapping)\s*\[\s*[^,]+,\s*(.+)\s*\]$/);
  if (dict) return canonicalType(dict[1]);
  const tuple = t.match(/^(?:Tuple|tuple)\s*\[\s*(.+?)(?:,|$)/);
  if (tuple) return canonicalType(tuple[1]);

  // Generic <T,U> — strip angles
  t = t.replace(/<.*$/, "").trim();
  // Generic [T,U] — strip square brackets if not handled above
  t = t.replace(/\[.*$/, "").trim();

  // Final cleanup
  return t || null;
}

export function typeColor(raw) {
  const t = canonicalType(raw);
  if (!t) return FALLBACK;
  const key = t.toLowerCase();
  if (PRIMITIVES.has(key)) return PRIMITIVES.get(key);
  // Hash to HSL hue for named types — fixed sat/lightness so the palette
  // stays cohesive.
  let h = 0;
  for (let i = 0; i < t.length; i++) {
    h = (h * 31 + t.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue} 65% 60%)`;
}

/**
 * Slightly darker / desaturated variant for borders or muted contexts.
 */
export function typeColorMuted(raw) {
  const c = typeColor(raw);
  if (c.startsWith("hsl")) return c.replace("65% 60%", "55% 45%");
  return c;
}

export function typeLabel(raw) {
  return canonicalType(raw) || "any";
}
