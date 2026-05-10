/**
 * Prisma adapter — emits `db-model` nodes from `schema.prisma` and
 * `db-read`/`db-write` edges from any caller of `prisma.MODEL.OP(...)`.
 *
 * Detection: presence of a Prisma schema file, OR an import of
 * `@prisma/client`.
 */

const SCHEMA_NAMES = [
  "schema.prisma",
  "prisma/schema.prisma",
  "prisma.schema",
];

const READ_OPS = new Set([
  "findUnique",
  "findFirst",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

const WRITE_OPS = new Set([
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "executeRaw",
  "queryRaw",
]);

export default {
  name: "prisma",
  apiVersion: 1,

  scanUnparsed(relPath) {
    return SCHEMA_NAMES.some(
      (n) => relPath === n || relPath.endsWith("/" + n),
    );
  },

  async detect(ctx) {
    for (const { relPath } of ctx.allFiles || []) {
      if (SCHEMA_NAMES.some((n) => relPath === n || relPath.endsWith("/" + n))) {
        return true;
      }
    }
    for (const { parsed } of ctx.parsedFiles) {
      if (parsed.lang === "ts") {
        for (const imp of parsed.imports || []) {
          if (
            imp.spec === "@prisma/client" ||
            imp.spec.startsWith("@prisma/client/")
          ) {
            return true;
          }
        }
      }
    }
    return false;
  },

  async analyzeFile(pf, ctx) {
    const nodes = [];
    const edges = [];
    const effects = [];

    // Parse schema.prisma → model nodes.
    if (
      SCHEMA_NAMES.some(
        (n) => pf.relPath === n || pf.relPath.endsWith("/" + n),
      )
    ) {
      const text = await ctx.readFile(pf.relPath);
      if (!text) return null;
      const fileId = ctx.fileIndex.get(pf.relPath);
      const modelRe = /(?:^|\n)model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
      let m;
      while ((m = modelRe.exec(text)) !== null) {
        const name = m[1];
        const body = m[2];
        const fields = parsePrismaFields(body);
        const id = `db-model:${name}`;
        nodes.push({
          id,
          kind: "db-model",
          label: name,
          parentId: fileId,
          data: {
            name,
            file: pf.relPath,
            line: lineOf(text, m.index),
            fields,
            framework: "prisma",
          },
        });
      }
      return { nodes, edges, effects };
    }

    // For TS/JS files: scan for prisma.MODEL.OP() call sites and emit edges.
    if (pf.parsed.lang !== "ts") return null;
    const text = await ctx.readFile(pf.relPath);
    if (!text) return null;
    const fileId = ctx.fileIndex.get(pf.relPath);
    if (!fileId) return null;

    // Match: prisma.user.findMany(...) / db.post.create(...) / this.prisma.user.update(...)
    const callRe = /\b(?:[\w$]+\.)*?(\w+)\.(\w+)\s*\(/g;
    let m;
    while ((m = callRe.exec(text)) !== null) {
      const op = m[2];
      if (!READ_OPS.has(op) && !WRITE_OPS.has(op)) continue;
      const modelName = capitalize(m[1]);
      const targetId = `db-model:${modelName}`;
      const kind = WRITE_OPS.has(op) ? "db-write" : "db-read";
      edges.push({
        source: fileId,
        target: targetId,
        kind,
        resolution: "name-match",
        op,
      });
      effects.push({ ownerId: fileId, sink: kind });
    }

    return { nodes, edges, effects };
  },
};

function parsePrismaFields(body) {
  const fields = [];
  for (const ln of body.split("\n")) {
    const t = ln.trim();
    if (!t || t.startsWith("//") || t.startsWith("@@")) continue;
    const m = t.match(/^(\w+)\s+([^\s]+)/);
    if (m) fields.push({ name: m[1], typeDisplay: m[2] });
  }
  return fields;
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function lineOf(src, charIndex) {
  let line = 1;
  for (let i = 0; i < charIndex; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}
