/**
 * Terraform adapter — emits `infra-resource` nodes from `.tf` files.
 *
 * Detection: any `.tf` file present. HCL is declarative so we don't
 * need a parser per se — a stable regex over the canonical
 *   resource "<type>" "<name>" { ... }
 *   data     "<type>" "<name>" { ... }
 *   module   "<name>"          { ... }
 * shapes is enough for the layer view to anchor an Infra section.
 *
 * Each block becomes a node with a stable id like
 *   infra-resource:aws_s3_bucket.assets
 * so cross-file `${aws_s3_bucket.assets.arn}` references can be
 * pointed at it in a future pass.
 */

const RESOURCE_RE = /(?:^|\n)\s*(resource|data|module)\s+(?:"([^"]+)"\s+)?"([^"]+)"\s*\{/g;

export default {
  name: "terraform",
  apiVersion: 1,

  scanUnparsed(relPath) {
    const lower = relPath.toLowerCase();
    return lower.endsWith(".tf") || lower.endsWith(".tfvars") || lower.endsWith(".hcl");
  },

  async detect(ctx) {
    for (const { relPath } of ctx.allFiles || []) {
      if (this.scanUnparsed(relPath)) return true;
    }
    return false;
  },

  async analyzeFile(pf, ctx) {
    if (!this.scanUnparsed(pf.relPath)) return null;
    const fileId = ctx.fileIndex.get(pf.relPath);
    if (!fileId) return null;
    const text = await ctx.readFile(pf.relPath);
    if (!text) return null;

    const nodes = [];
    const edges = [];
    let m;
    while ((m = RESOURCE_RE.exec(text)) !== null) {
      const blockType = m[1]; // "resource" | "data" | "module"
      const tfType = m[2] || "module"; // module blocks have no type
      const name = m[3];
      const id =
        blockType === "module"
          ? `infra-resource:module.${name}`
          : `infra-resource:${tfType}.${name}`;
      const line = lineOf(text, m.index);
      nodes.push({
        id,
        kind: "infra-resource",
        label: blockType === "module" ? `module.${name}` : `${tfType}.${name}`,
        parentId: fileId,
        data: {
          blockType,
          resourceType: tfType,
          name,
          file: pf.relPath,
          line,
          framework: "terraform",
        },
      });
      edges.push({
        source: fileId,
        target: id,
        kind: "defines-resource",
        resolution: "scip-precise",
      });
    }
    if (nodes.length === 0) return null;
    return { nodes, edges };
  },
};

function lineOf(src, charIndex) {
  let line = 1;
  for (let i = 0; i < charIndex; i++) {
    if (src.charCodeAt(i) === 10) line++;
  }
  return line;
}
