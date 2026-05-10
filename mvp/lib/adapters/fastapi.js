/**
 * FastAPI adapter — emits `http-route` nodes per `@app.get('/x')` decorator,
 * plus `route-handler` edges from the route to the decorated def.
 *
 * Detection: a Python file that imports `fastapi` or `from fastapi import ...`.
 */

const HTTP_DECORATORS = [
  "get", "post", "put", "patch", "delete", "head", "options",
  "websocket",
];

export default {
  name: "fastapi",
  apiVersion: 1,

  async detect(ctx) {
    for (const { parsed } of ctx.parsedFiles) {
      if (parsed.lang !== "py") continue;
      for (const imp of parsed.imports || []) {
        if (imp.spec === "fastapi" || imp.spec.startsWith("fastapi.")) {
          return true;
        }
      }
    }
    return false;
  },

  async analyzeFile(pf, ctx) {
    if (pf.parsed.lang !== "py") return null;
    const text = await ctx.readFile(pf.relPath);
    if (!text) return null;
    const fileId = ctx.fileIndex.get(pf.relPath);
    if (!fileId) return null;

    const nodes = [];
    const edges = [];
    const effects = [];

    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const trim = ln.trim();
      if (!trim.startsWith("@")) continue;

      const decoMatch = trim.match(
        new RegExp(
          `^@\\s*(\\w+)\\.(${HTTP_DECORATORS.join("|")})\\s*\\(\\s*['"]([^'"]+)['"]`,
        ),
      );
      if (!decoMatch) continue;
      const subject = decoMatch[1]; // "app" or "router"
      const method = decoMatch[2].toUpperCase();
      const routePath = decoMatch[3];

      // Find the next `def` line for the handler name.
      let handlerName = null;
      for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
        const dm = lines[j].match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/);
        if (dm) {
          handlerName = dm[1];
          break;
        }
        if (!lines[j].trim().startsWith("@") && lines[j].trim()) break;
      }

      const id = `route:${pf.relPath}#${method}:${routePath}`;
      nodes.push({
        id,
        kind: "http-route",
        label: `${method} ${routePath}`,
        parentId: fileId,
        data: {
          method,
          path: routePath,
          file: pf.relPath,
          line: i + 1,
          framework: "fastapi",
          handler: handlerName,
          owner: subject,
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
      if (handlerName) {
        const handlerId = `def:${pf.relPath}#${handlerName}`;
        edges.push({
          source: id,
          target: handlerId,
          kind: "route-handler",
          resolution: "scip-precise",
        });
      }
    }

    return { nodes, edges, effects };
  },
};
