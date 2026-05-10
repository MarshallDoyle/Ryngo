/**
 * SQLAlchemy adapter — emits `db-model` nodes from classes that extend
 * a SQLAlchemy declarative base.
 *
 * Detection: any Python file in the repo imports `sqlalchemy`,
 * `sqlmodel` (which builds on SQLA), or `flask_sqlalchemy`.
 *
 * Recognition heuristic for model classes: a class declared with one
 * of these base shapes:
 *   class Foo(Base):                       # declarative_base()
 *   class Foo(db.Model):                   # flask_sqlalchemy
 *   class Foo(SQLModel, table=True):       # tiangolo/sqlmodel
 *   class Foo(DeclarativeBase):            # sqlalchemy 2.x
 *
 * Field detail is left to the regular Python parser — its
 * `members.fields` already captures `name = Column(...)` declarations
 * with their default values.
 */

const SQLA_PACKAGES = new Set([
  "sqlalchemy",
  "sqlmodel",
  "flask_sqlalchemy",
  "asyncpg-sqlalchemy",
]);

export default {
  name: "sqlalchemy",
  apiVersion: 1,

  async detect(ctx) {
    for (const { parsed } of ctx.parsedFiles) {
      if (parsed.lang !== "py") continue;
      for (const imp of parsed.imports || []) {
        const head = (imp.spec || "").split(".")[0];
        if (SQLA_PACKAGES.has(head)) return true;
      }
    }
    return false;
  },

  async analyzeFile(pf, ctx) {
    if (pf.parsed.lang !== "py") return null;
    const fileId = ctx.fileIndex.get(pf.relPath);
    if (!fileId) return null;
    const text = await ctx.readFile(pf.relPath);
    if (!text) return null;

    const nodes = [];
    const edges = [];
    const re = /(?:^|\n)class\s+(\w+)\s*\(([^)]*)\)\s*:/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = m[1];
      const bases = m[2];
      if (!isSqlaBase(bases)) continue;
      const id = `db-model:${name}`;
      const line = lineOf(text, m.index);
      nodes.push({
        id,
        kind: "db-model",
        label: name,
        parentId: fileId,
        data: { name, file: pf.relPath, line, framework: "sqlalchemy" },
      });
      edges.push({
        source: `def:${pf.relPath}#${name}`,
        target: id,
        kind: "defines-model",
        resolution: "scip-precise",
      });
    }
    if (nodes.length === 0) return null;
    return { nodes, edges };
  },
};

function isSqlaBase(basesText) {
  // Recognise the declarative-base patterns. Conservative: requires an
  // explicit Base / Model / DeclarativeBase / SQLModel keyword. Avoids
  // picking up plain `class Foo(Bar):` from unrelated code.
  if (/\bSQLModel\b/.test(basesText)) return true;
  if (/\bDeclarativeBase\b/.test(basesText)) return true;
  if (/\b(?:db|database|sa|sqla)\.Model\b/.test(basesText)) return true;
  if (/\b(?:Base|MappedBase|ModelBase)\b/.test(basesText)) return true;
  return false;
}

function lineOf(src, charIndex) {
  let line = 1;
  for (let i = 0; i < charIndex; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}
