/**
 * Spring adapter — emits `http-route` nodes from `@GetMapping` /
 * `@PostMapping` / etc. annotations and `db-model` nodes from
 * `@Entity` classes.
 *
 * Detection: any `pom.xml` / `build.gradle` / `build.gradle.kts` that
 * mentions `spring`, OR any `.java` file with a Spring annotation
 * we recognise.
 *
 * Java is a stub language today (no parser bundled); the adapter
 * scans `.java` files via `scanUnparsed` so we still surface the
 * Spring shape in the Layers view + LLM projections without needing
 * scip-java in the build environment.
 */

const HTTP_ANNOS = [
  "GetMapping",
  "PostMapping",
  "PutMapping",
  "PatchMapping",
  "DeleteMapping",
  "RequestMapping",
];

export default {
  name: "spring",
  apiVersion: 1,

  scanUnparsed(relPath) {
    return relPath.endsWith(".java");
  },

  async detect(ctx) {
    // Cheap: any Java file with a Spring annotation.
    for (const { relPath } of ctx.allFiles || []) {
      if (!relPath.endsWith(".java")) continue;
      // We only see file paths here, not contents — the per-file
      // analyzeFile pass will filter; the project gate is satisfied
      // by the existence of any .java file paired with a Spring
      // build manifest.
    }
    let hasJava = false;
    let hasSpringManifest = false;
    for (const { relPath } of ctx.allFiles || []) {
      if (relPath.endsWith(".java")) hasJava = true;
      if (
        relPath === "pom.xml" ||
        relPath.endsWith("/pom.xml") ||
        relPath === "build.gradle" ||
        relPath.endsWith("/build.gradle") ||
        relPath.endsWith("/build.gradle.kts")
      ) {
        const text = await ctx.readFile(relPath);
        if (text && /\bspring(?:-boot|-framework|-web|-data)?\b/i.test(text)) {
          hasSpringManifest = true;
        }
      }
    }
    return hasJava && hasSpringManifest;
  },

  async analyzeFile(pf, ctx) {
    if (!pf.relPath.endsWith(".java")) return null;
    const fileId = ctx.fileIndex.get(pf.relPath);
    if (!fileId) return null;
    const text = await ctx.readFile(pf.relPath);
    if (!text) return null;

    const nodes = [];
    const edges = [];
    const effects = [];

    // Class-level @RequestMapping("/api/users") sets the base path; we
    // resolve it once per file (Spring controllers are typically one
    // class per file).
    const classPathMatch = text.match(
      /@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/,
    );
    const classPath = classPathMatch ? classPathMatch[1] : "";

    // Method-level routes. Two shapes:
    //   @GetMapping("/users")
    //   @GetMapping(value = "/users", produces = ...)
    const re = new RegExp(
      `@(${HTTP_ANNOS.join("|")})\\s*(?:\\(\\s*(?:value\\s*=\\s*)?` +
        `["']([^"']+)["'])?`,
      "g",
    );
    let m;
    while ((m = re.exec(text)) !== null) {
      const anno = m[1];
      const subPath = m[2] || "";
      const method = anno.replace("Mapping", "").toUpperCase() || "ANY";
      const route = (classPath + (subPath.startsWith("/") ? "" : "/") + subPath) || "/";
      const cleaned = route.startsWith("/") ? route : "/" + route;
      const httpMethod =
        anno === "RequestMapping" ? "ANY" : method.replace("REQUEST", "ANY");
      const id = `route:${pf.relPath}#${httpMethod}:${cleaned}`;
      const line = lineOf(text, m.index);
      nodes.push({
        id,
        kind: "http-route",
        label: `${httpMethod} ${cleaned}`,
        parentId: fileId,
        data: {
          method: httpMethod,
          path: cleaned,
          file: pf.relPath,
          line,
          framework: "spring",
        },
      });
      effects.push({ ownerId: fileId, sink: "network" });
      effects.push({ ownerId: id, sink: "network" });
      edges.push({
        source: fileId,
        target: id,
        kind: "defines-route",
        resolution: "scip-precise",
      });
    }

    // @Entity → db-model. Single entity per file is the canonical Spring
    // pattern; we capture the first matching class.
    if (/@Entity\b/.test(text)) {
      const cls = text.match(/(?:@Entity[^{]*?)\bclass\s+(\w+)/);
      if (cls) {
        const id = `db-model:${cls[1]}`;
        const line = lineOf(text, text.indexOf(cls[0]));
        nodes.push({
          id,
          kind: "db-model",
          label: cls[1],
          parentId: fileId,
          data: { name: cls[1], file: pf.relPath, line, framework: "spring" },
        });
      }
    }

    if (nodes.length === 0) return null;
    return { nodes, edges, effects };
  },
};

function lineOf(src, charIndex) {
  let line = 1;
  for (let i = 0; i < charIndex; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}
