/**
 * File-path -> URL conversion for the Next.js App Router.
 *
 * The App Router treats a file's directory as its URL path. We strip the
 * filename (`route.ts` / `page.tsx`), drop `(group)` segments (organizational
 * only), convert `[id]` to `:id`, and convert catch-alls to `*name`.
 */

const FILENAME_RE = /(^|\/)(?:route|page)\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const GROUP_RE = /^\(.*\)$/;
const PRIVATE_RE = /^_/;
const PARALLEL_RE = /^@/;
const OPTIONAL_CATCH_ALL_RE = /^\[\[\.\.\.([\w$]+)\]\]$/;
const CATCH_ALL_RE = /^\[\.\.\.([\w$]+)\]$/;
const DYNAMIC_RE = /^\[([\w$]+)\]$/;

const APP_ROOTS = ["app/", "src/app/"] as const;

/**
 * Return the path under `app/` (or `src/app/`) for a file, or null if the
 * file is not under either.
 *
 * Inputs are normalized to POSIX slashes before matching. Both bare
 * (`app/foo/page.tsx`) and nested (`packages/web/app/foo/page.tsx`) layouts
 * are accepted — for nested layouts the LAST occurrence wins so `app/app/x`
 * keeps the inner segment.
 */
export function appRelativePath(filePath: string): string | null {
  const norm = filePath.replace(/\\/g, "/");
  for (const root of APP_ROOTS) {
    if (norm.startsWith(root)) return norm.slice(root.length);
    const marker = "/" + root;
    const idx = norm.lastIndexOf(marker);
    if (idx >= 0) return norm.slice(idx + marker.length);
  }
  return null;
}

/** True if this is a route.ts (HTTP API) file. */
export function isRouteFile(appRel: string): boolean {
  return /(^|\/)route\.(ts|tsx|js|jsx|mjs|cjs)$/.test(appRel);
}

/** True if this is a page.tsx (rendered page) file. */
export function isPageFile(appRel: string): boolean {
  return /(^|\/)page\.(tsx|jsx)$/.test(appRel);
}

/**
 * Convert an app-relative file path to a Next.js URL route in colon-style
 * form so it lines up with Express/FastAPI route patterns.
 *
 *   "users/[id]/route.ts"          -> "/users/:id"
 *   "users/[id]/page.tsx"          -> "/users/:id"
 *   "(marketing)/about/page.tsx"   -> "/about"
 *   "blog/[...slug]/page.tsx"      -> "/blog/*slug"
 *   "blog/[[...slug]]/page.tsx"    -> "/blog/*slug"   (optional catch-all)
 *   "page.tsx"                     -> "/"
 *
 * Private folders (`_components`) and parallel route slots (`@modal`) are
 * dropped — they're conventions, not URL segments.
 */
export function filePathToRoute(appRel: string): string {
  const trimmed = appRel.replace(FILENAME_RE, "");
  if (trimmed === "" || trimmed === "/") return "/";

  const segments: string[] = [];
  for (const seg of trimmed.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (GROUP_RE.test(seg)) continue;
    if (PRIVATE_RE.test(seg)) continue;
    if (PARALLEL_RE.test(seg)) continue;

    let m = OPTIONAL_CATCH_ALL_RE.exec(seg);
    if (m) {
      segments.push("*" + m[1]);
      continue;
    }
    m = CATCH_ALL_RE.exec(seg);
    if (m) {
      segments.push("*" + m[1]);
      continue;
    }
    m = DYNAMIC_RE.exec(seg);
    if (m) {
      segments.push(":" + m[1]);
      continue;
    }
    segments.push(seg);
  }

  return segments.length === 0 ? "/" : "/" + segments.join("/");
}
