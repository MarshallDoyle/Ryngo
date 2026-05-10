/**
 * Tier-1 symbol resolver.
 *
 * Input: an array of { relPath, parsed } where `parsed` is a ParsedFile from
 * the Tier-0 parser registry, plus a fileIndex mapping posix relPath → file
 * node id.
 *
 * Output: { defs, edges, packages } — ready for the IR assembler to merge.
 *   defs:     [{ id, kind, label, parentId, data }]
 *   edges:    [{ id, source, target, kind, resolution, valueType? }]
 *   packages: Map<pkgName, { id, label }>
 *   diagnostics: string[]
 *
 * Resolution algorithm (per `research/tree-sitter.md` §4):
 *   1. Lexical: same-file def by name.
 *   2. Imported: if `to` is bound to an import, follow to that file/pkg.
 *   3. Project-wide unique name match.
 *   4. Otherwise drop (default) or emit unresolved (configurable).
 *
 * The `resolution` field on every edge lets the viewer render confidence:
 *   'lexical' | 'imported' | 'name-match' | 'unresolved' | 'scip-precise'.
 */
import path from "node:path";

export function resolveSymbols(parsedFiles, fileIndex) {
  const defs = [];
  const edges = [];
  const packages = new Map();
  const diagnostics = [];
  const seenEdgeKeys = new Set();
  const defByName = new Map();

  // -- pass 1: emit def + cell nodes ----------------------------------------
  for (const { relPath, parsed } of parsedFiles) {
    const fileId = fileIndex.get(relPath);
    if (!fileId) continue;

    if (parsed.cells) {
      // Notebook: cell nodes only
      for (const cell of parsed.cells) {
        defs.push({
          id: `cell:${relPath}#${cell.index}`,
          kind: "cell",
          label: `[${cell.index + 1}] ${cell.label}`,
          parentId: fileId,
          data: {
            file: relPath,
            index: cell.index,
            lang: parsed.lang === "jupyter" ? "py" : parsed.lang,
            source: cell.source,
            line: 1,
          },
        });
      }
      continue;
    }

    for (const def of parsed.defs) {
      const id = `def:${relPath}#${def.name}`;
      defs.push({
        id,
        kind: def.kind,
        label: def.name,
        parentId: fileId,
        data: {
          file: relPath,
          name: def.name,
          line: def.line,
          lang: parsed.lang,
          params: def.params || null,
          returnType: def.returnType || null,
          members: def.members || null,
          baseClasses: def.baseClasses || null,
          warnings: def.warnings || null,
        },
      });
      if (!defByName.has(def.name)) defByName.set(def.name, []);
      defByName.get(def.name).push({ fileRel: relPath, defId: id, kind: def.kind });
    }
  }

  // -- pass 2: emit edges ---------------------------------------------------
  for (const { relPath, parsed } of parsedFiles) {
    const fileId = fileIndex.get(relPath);
    if (!fileId) continue;

    if (parsed.cells) {
      for (const cell of parsed.cells) {
        const cellId = `cell:${relPath}#${cell.index}`;
        emitEdgesFor(
          relPath,
          cellId,
          cell.imports,
          cell.calls,
          /* callerIsScope */ true,
        );
      }
      continue;
    }

    emitEdgesFor(
      relPath,
      fileId,
      parsed.imports,
      parsed.calls,
      /* callerIsScope */ false,
    );
  }

  function addEdge(source, target, kind, resolution, extras = {}) {
    if (source === target) return;
    const key = `${source}=>${target}@${kind}`;
    if (seenEdgeKeys.has(key)) return;
    seenEdgeKeys.add(key);
    edges.push({
      id: key,
      source,
      target,
      kind,
      resolution,
      ...extras,
    });
  }

  function ensurePackage(name) {
    if (!packages.has(name)) {
      packages.set(name, { id: `pkg:${name}`, label: name });
    }
    return packages.get(name).id;
  }

  function emitEdgesFor(relPath, fromId, imports, calls, callerIsScope) {
    const localBindings = new Map();

    for (const imp of imports || []) {
      if (imp.isRelative) {
        const targetRel = resolveRelative(relPath, imp.spec, fileIndex);
        if (!targetRel) {
          diagnostics.push(
            `unresolved relative import: ${relPath} → ${imp.spec}`,
          );
          continue;
        }
        const targetFileId = fileIndex.get(targetRel);
        addEdge(fromId, targetFileId, "imports-file", "imported");
        for (const [local, orig] of Object.entries(imp.bindings || {})) {
          localBindings.set(local, {
            kind: "file",
            target: targetRel,
            originalName: orig,
          });
        }
      } else {
        const pkgName = extractPackageName(imp.spec);
        if (!pkgName) continue;
        const pkgId = ensurePackage(pkgName);
        addEdge(fromId, pkgId, "imports-package", "imported");
        for (const [local, orig] of Object.entries(imp.bindings || {})) {
          localBindings.set(local, {
            kind: "package",
            target: pkgName,
            originalName: orig,
          });
        }
      }
    }

    for (const call of calls || []) {
      const fromCallerId = callerIsScope
        ? fromId
        : `def:${relPath}#${call.from}`;

      const binding = localBindings.get(call.to);
      if (binding) {
        if (binding.kind === "file") {
          const targetDefId = `def:${binding.target}#${binding.originalName}`;
          if (defExists(defByName, binding.originalName, binding.target)) {
            addEdge(fromCallerId, targetDefId, "calls", "imported");
          } else {
            const targetFileId = fileIndex.get(binding.target);
            if (targetFileId) {
              addEdge(fromCallerId, targetFileId, "calls", "imported");
            }
          }
        } else {
          addEdge(fromCallerId, ensurePackage(binding.target), "calls", "imported");
        }
        continue;
      }

      const sameFile = defByName.get(call.to)?.find((d) => d.fileRel === relPath);
      if (sameFile) {
        addEdge(fromCallerId, sameFile.defId, "calls", "lexical");
        continue;
      }

      const candidates = defByName.get(call.to);
      if (candidates && candidates.length === 1) {
        addEdge(fromCallerId, candidates[0].defId, "calls", "name-match");
        continue;
      }
      // ambiguous / unknown — drop. Better under-edge than spam.
    }
  }

  return { defs, edges, packages, diagnostics, defByName };
}

function defExists(defByName, name, fileRel) {
  const list = defByName.get(name);
  if (!list) return false;
  return list.some((d) => d.fileRel === fileRel);
}

function resolveRelative(fromRel, importSpec, fileIndex) {
  let importPath = importSpec;
  if (
    importPath.startsWith(".") &&
    !importPath.includes("/") &&
    !importPath.includes("\\")
  ) {
    if (/^\.+[a-zA-Z_]/.test(importPath) || /^\.+$/.test(importPath)) {
      importPath = pyDottedToPath(importPath);
    }
  }

  const fromDir = path.posix.dirname(fromRel);
  let target = path.posix.normalize(path.posix.join(fromDir, importPath));
  if (target.startsWith("../")) return null;
  if (target === ".") target = "";

  const candidates = [target];
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
    candidates.push(target + ext);
    candidates.push(target + "/index" + ext);
  }
  candidates.push(target + ".py");
  candidates.push(target + "/__init__.py");
  candidates.push(target + ".json");

  for (const c of candidates) {
    if (fileIndex.has(c)) return c;
  }
  return null;
}

function pyDottedToPath(dotted) {
  let leadingDots = 0;
  while (leadingDots < dotted.length && dotted[leadingDots] === ".") {
    leadingDots++;
  }
  const tail = dotted.slice(leadingDots).split(".").join("/");
  if (leadingDots <= 1) return tail || ".";
  const ups = "../".repeat(leadingDots - 1);
  return ups + tail;
}

function extractPackageName(spec) {
  if (!spec || spec.startsWith(".") || spec.startsWith("/")) return null;
  if (spec.startsWith("node:")) return spec;
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    if (parts.length < 2) return null;
    return parts[0] + "/" + parts[1];
  }
  return spec.split("/")[0].split(".")[0];
}
