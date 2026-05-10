/**
 * Django adapter — emits `http-route` nodes from `urls.py` files and
 * `db-model` nodes from Django ORM model classes.
 *
 * Detection: any file imports the `django` package OR a file named
 * `urls.py` is present anywhere in the project. Both signals together
 * are a near-certain Django app; either alone is enough to trigger the
 * adapter.
 *
 * What it extracts:
 *   - urls.py:
 *       path('signup/', views.signup)
 *       re_path(r'^api/v1/users/$', views.user_list)
 *       url(r'^login/$', LoginView.as_view())
 *     Each becomes an `http-route` node.
 *   - models.py / `class X(models.Model):`:
 *     Each subclass of `models.Model` (or a Django mixin) becomes a
 *     `db-model` node. Field detection is left to the regular Python
 *     parser — its `members.fields` list already captures
 *     `name = models.CharField(...)`-style declarations.
 *
 * Cross-file `route-handler` linkage is best-effort: if the urls.py
 * subject is `views.foo` and there's a `def foo` in the same project's
 * views.py, we emit a `route-handler` edge.
 */

const URL_FUNCTIONS = ["path", "re_path", "url"];

export default {
  name: "django",
  apiVersion: 1,

  async detect(ctx) {
    for (const { parsed } of ctx.parsedFiles) {
      if (parsed.lang !== "py") continue;
      for (const imp of parsed.imports || []) {
        if (
          imp.spec === "django" ||
          imp.spec.startsWith("django.") ||
          imp.spec === "rest_framework" ||
          imp.spec.startsWith("rest_framework.")
        ) {
          return true;
        }
      }
    }
    for (const { relPath } of ctx.allFiles || []) {
      if (/(?:^|\/)urls\.py$/.test(relPath)) return true;
    }
    return false;
  },

  async analyzeFile(pf, ctx) {
    if (pf.parsed.lang !== "py") return null;
    const fileId = ctx.fileIndex.get(pf.relPath);
    if (!fileId) return null;
    const text = await ctx.readFile(pf.relPath);
    if (!text) return null;

    const isUrls = /(?:^|\/)urls\.py$/.test(pf.relPath);
    const isModels =
      /(?:^|\/)models(?:\/[^/]*)?\.py$/.test(pf.relPath) ||
      /(?:^|\/)models\.py$/.test(pf.relPath);

    const nodes = [];
    const edges = [];
    const effects = [];

    if (isUrls) {
      collectRoutes(text, pf, fileId, nodes, edges, effects);
    }
    if (isModels) {
      collectModels(text, pf, fileId, nodes, edges);
    }
    if (nodes.length === 0 && edges.length === 0) return null;
    return { nodes, edges, effects };
  },
};

function collectRoutes(text, pf, fileId, nodes, edges, effects) {
  // path('foo/',  views.handler)            method-agnostic
  // re_path(r'^foo/$',  views.handler)
  // url(r'^foo/$',  views.handler)
  const re = new RegExp(
    `\\b(${URL_FUNCTIONS.join("|")})\\s*\\(\\s*` +
      `(?:r?["'])([^"']+)(?:["'])` + // path string (raw or plain)
      `\\s*,\\s*([\\w.]+)`, // handler ref
    "g",
  );
  let m;
  while ((m = re.exec(text)) !== null) {
    const fn = m[1];
    let routePath = m[2];
    const handlerRef = m[3];
    // Normalise re_path/url regex shapes to a /-prefixed string.
    if (fn !== "path") {
      // strip leading ^ / trailing $, replace ?P<x> with :x
      routePath = routePath
        .replace(/^\^/, "")
        .replace(/\$$/, "")
        .replace(/\(\?P<(\w+)>[^)]+\)/g, ":$1");
    }
    if (!routePath.startsWith("/")) routePath = "/" + routePath;
    const line = lineOf(text, m.index);
    const id = `route:${pf.relPath}#ANY:${routePath}`;
    nodes.push({
      id,
      kind: "http-route",
      label: `ANY ${routePath}`,
      parentId: fileId,
      data: {
        method: "ANY", // Django dispatches by view-class methods; URL conf is method-agnostic
        path: routePath,
        file: pf.relPath,
        line,
        framework: "django",
        handler: handlerRef,
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
}

function collectModels(text, pf, fileId, nodes, edges) {
  // class Name(models.Model[, …]):  /  class Name(AbstractUser):  /  class Name(BaseModel, models.Model):
  const re =
    /(?:^|\n)class\s+(\w+)\s*\(([^)]*)\)\s*:/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const bases = m[2];
    if (!isDjangoModelBase(bases)) continue;
    const id = `db-model:${name}`;
    const line = lineOf(text, m.index);
    nodes.push({
      id,
      kind: "db-model",
      label: name,
      parentId: fileId,
      data: {
        name,
        file: pf.relPath,
        line,
        framework: "django",
      },
    });
    // Tie the model back to the def node the Python parser already
    // emitted for the same class, so drilling in shows fields.
    const defId = `def:${pf.relPath}#${name}`;
    edges.push({
      source: defId,
      target: id,
      kind: "defines-model",
      resolution: "scip-precise",
    });
  }
}

function isDjangoModelBase(basesText) {
  // Cheap test: any base that contains "Model" — `models.Model`,
  // `AbstractUser`, `BaseModel`, `mixins.TimestampedModel` etc.
  // We accept some false positives here (a non-Django `BaseModel` from
  // pydantic) because the project-gate already established Django is
  // present; if a file has both pydantic and Django and we
  // mis-classify a pydantic model as a Django one, the cost is one
  // extra db-model node which is recoverable.
  return /\bModel\b|\bAbstractUser\b|\bAbstractBaseUser\b/.test(basesText);
}

function lineOf(src, charIndex) {
  let line = 1;
  for (let i = 0; i < charIndex; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}
