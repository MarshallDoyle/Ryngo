/**
 * GraphQL adapter — emits `gql-type` nodes for every type / interface /
 * input / enum declared in `.graphql` / `.gqls` SDL files, plus
 * `gql-resolver` nodes for object-typed resolver maps in JS / TS.
 *
 * Detection: a `.graphql` schema file exists OR a JS/TS file imports
 * a known GraphQL package (`graphql`, `apollo-server*`, `@apollo/*`,
 * `graphql-yoga`, `nexus`, `type-graphql`, `pothos-*`, `mercurius`).
 *
 * What we extract today:
 *   - SDL types: `type Query { … }`, `input UserInput { … }`,
 *     `interface Node { … }`, `enum Role { … }`. Each becomes a
 *     `gql-type` node. Field detail is left for a future pass.
 *   - Resolver maps: a `Query` / `Mutation` / `Subscription` / pascal-named
 *     object literal with arrow / function-valued fields, e.g.
 *       const Query = { user: (_, { id }) => …, listBooks: …, };
 *     Each value becomes a `gql-resolver` node.
 *
 * Cross-link: when a resolver name matches an SDL field name (root-level
 * Query/Mutation/Subscription only, in this initial pass), we emit a
 * `resolver-of` edge. Field-level introspection inside types is deferred
 * to a follow-up.
 */

const GQL_PACKAGES = [
  "graphql",
  "graphql-tag",
  "graphql-yoga",
  "graphql-tools",
  "@graphql-tools/",
  "apollo-server",
  "apollo-server-express",
  "apollo-server-fastify",
  "@apollo/server",
  "@apollo/client",
  "nexus",
  "type-graphql",
  "@pothos/core",
  "pothos",
  "mercurius",
];

const SDL_EXTENSIONS = [".graphql", ".graphqls", ".gql"];

export default {
  name: "graphql",
  apiVersion: 1,

  scanUnparsed(relPath) {
    return SDL_EXTENSIONS.some((ext) => relPath.toLowerCase().endsWith(ext));
  },

  async detect(ctx) {
    for (const { relPath } of ctx.allFiles || []) {
      if (SDL_EXTENSIONS.some((ext) => relPath.toLowerCase().endsWith(ext))) {
        return true;
      }
    }
    for (const { parsed } of ctx.parsedFiles) {
      if (parsed.lang !== "ts") continue;
      for (const imp of parsed.imports || []) {
        for (const pkg of GQL_PACKAGES) {
          if (imp.spec === pkg || imp.spec.startsWith(pkg + "/")) return true;
        }
      }
    }
    return false;
  },

  async analyzeFile(pf, ctx) {
    const fileId = ctx.fileIndex.get(pf.relPath);
    if (!fileId) return null;
    const lower = pf.relPath.toLowerCase();
    const isSdl = SDL_EXTENSIONS.some((ext) => lower.endsWith(ext));
    if (!isSdl && pf.parsed.lang !== "ts") return null;
    const text = await ctx.readFile(pf.relPath);
    if (!text) return null;

    const nodes = [];
    const edges = [];

    if (isSdl) {
      collectSdlTypes(text, pf, fileId, nodes);
    } else {
      collectResolverMaps(text, pf, fileId, nodes, edges);
    }
    if (nodes.length === 0 && edges.length === 0) return null;
    return { nodes, edges };
  },
};

function collectSdlTypes(text, pf, fileId, nodes) {
  // type X { … }  /  input X { … }  /  interface X { … }  /  enum X { … }
  const re =
    /(?:^|\n)\s*(type|input|interface|enum|union|scalar)\s+(\w+)(?:\s+implements\s+([^{]+))?\s*(?:=\s*([^\n]+)|\{)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const kind = m[1];
    const name = m[2];
    const id = `gql-type:${name}`;
    nodes.push({
      id,
      kind: "gql-type",
      label: name,
      parentId: fileId,
      data: {
        name,
        kindOfType: kind, // "type" | "input" | "interface" | "enum" | "union" | "scalar"
        file: pf.relPath,
        line: lineOf(text, m.index),
        framework: "graphql",
      },
    });
  }
}

function collectResolverMaps(text, pf, fileId, nodes, edges) {
  // const Query = { … }  /  export const Query = { … }
  // Pascal-cased identifier on the LHS, object literal on the RHS.
  // We accept Query / Mutation / Subscription specifically; other
  // resolver objects are too easy to false-positive on (e.g.
  // `const User = { ... }` could be anything).
  const ROOTS = ["Query", "Mutation", "Subscription"];
  for (const root of ROOTS) {
    const re = new RegExp(
      `(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var)\\s+${root}\\s*(?::[^=]+)?=\\s*\\{`,
      "g",
    );
    let m;
    while ((m = re.exec(text)) !== null) {
      const bodyStart = m.index + m[0].length;
      const body = sliceBalancedBraces(text, bodyStart - 1);
      if (!body) continue;
      const fields = extractObjectFieldNames(body);
      for (const field of fields) {
        const id = `gql-resolver:${root}.${field}`;
        nodes.push({
          id,
          kind: "gql-resolver",
          label: `${root}.${field}`,
          parentId: fileId,
          data: {
            root,
            name: field,
            file: pf.relPath,
            line: lineOf(text, m.index),
            framework: "graphql",
          },
        });
        // If we can find a matching gql-type node (e.g. `type Query`
        // declared elsewhere with a `field` member), emit a
        // `resolver-of` edge. We can't verify the field membership at
        // this layer without the SDL field index — left for v2.
        edges.push({
          source: id,
          target: `gql-type:${root}`,
          kind: "resolver-of",
          resolution: "name-match",
        });
      }
    }
  }
}

/**
 * Given a string and the index of an opening brace, return the inside
 * text up to the matching close brace. Naive (doesn't track strings) —
 * acceptable here because resolvers are mostly arrow-fn shaped.
 */
function sliceBalancedBraces(src, openIdx) {
  if (src[openIdx] !== "{") return null;
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return null;
}

/**
 * Extract top-level field names from an object literal body. Matches:
 *   foo: …,
 *   foo(args) { … },
 *   foo: () => …
 * Skips spread (`...mixin`) and computed keys (`[expr]: …`) — both
 * extremely rare in resolver maps.
 */
function extractObjectFieldNames(body) {
  const names = new Set();
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (depth === 0 && /\w/.test(c)) {
      const remainder = body.slice(i);
      const m = remainder.match(/^(\w+)\s*[:(]/);
      if (m) {
        names.add(m[1]);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return [...names];
}

function lineOf(src, charIndex) {
  let line = 1;
  for (let i = 0; i < charIndex; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}
