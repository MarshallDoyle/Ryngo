/**
 * env-var adapter — emits `env` leaf nodes for every distinct env var read
 * across the codebase, plus `env-read` edges from each reading file to the
 * shared env node.
 *
 * Detection: always runs (env reads are useful in any repo).
 *
 * Recognized patterns:
 *   - JS/TS: `process.env.NAME` or `process.env["NAME"]`
 *   - Py:    `os.environ['NAME']`, `os.environ.get('NAME')`,
 *            `os.getenv('NAME')`
 *   - .env:  `NAME=…` (each line)
 */

export default {
  name: "env",
  apiVersion: 1,

  async detect() {
    return true;
  },

  scanUnparsed(relPath) {
    return /(?:^|\/)\.env(?:\.[\w-]+)?$/.test(relPath);
  },

  async analyzeFile(pf, ctx) {
    const text = await ctx.readFile(pf.relPath);
    if (!text) return null;
    const fileId = ctx.fileIndex.get(pf.relPath);
    if (!fileId) return null;

    const names = new Set();

    if (pf.parsed.lang === "ts") {
      const re1 = /\bprocess\.env\.(\w+)\b/g;
      const re2 = /\bprocess\.env\[['"]([^'"]+)['"]\]/g;
      let m;
      while ((m = re1.exec(text)) !== null) names.add(m[1]);
      while ((m = re2.exec(text)) !== null) names.add(m[1]);
    } else if (pf.parsed.lang === "py") {
      const re1 = /\bos\.environ\[\s*['"]([^'"]+)['"]\s*\]/g;
      const re2 = /\bos\.environ\.get\s*\(\s*['"]([^'"]+)['"]/g;
      const re3 = /\bos\.getenv\s*\(\s*['"]([^'"]+)['"]/g;
      let m;
      while ((m = re1.exec(text)) !== null) names.add(m[1]);
      while ((m = re2.exec(text)) !== null) names.add(m[1]);
      while ((m = re3.exec(text)) !== null) names.add(m[1]);
    } else if (/(?:^|\/)\.env(?:\.[\w-]+)?$/.test(pf.relPath)) {
      // Plain .env: each non-comment NAME=… line.
      for (const ln of text.split("\n")) {
        const t = ln.trim();
        if (!t || t.startsWith("#")) continue;
        const m = t.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
        if (m) names.add(m[1]);
      }
    }

    if (names.size === 0) return null;

    const nodes = [];
    const edges = [];
    const effects = [];
    for (const name of names) {
      const id = `env:${name}`;
      nodes.push({
        id,
        kind: "env",
        label: name,
        data: { name },
      });
      edges.push({
        source: fileId,
        target: id,
        kind: "env-read",
        resolution: "scip-precise",
      });
      effects.push({ ownerId: fileId, sink: "env-read" });
    }
    return { nodes, edges, effects };
  },
};
