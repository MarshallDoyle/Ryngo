/**
 * Ryngo MVP — universal-compiler orchestrator (Phase 5).
 *
 * Pipeline:
 *   Tier 0: parse  — per-file parser from lib/parsers/index.js (regex floor;
 *                    swap-in tree-sitter / SCIP per-language without changing
 *                    the IR shape).
 *   Tier 1: resolve — lib/resolver.js turns ParsedFiles into defs + edges,
 *                     stamps `resolution: 'lexical' | 'imported' | 'name-match'`.
 *   Tier 2: adapters — lib/adapters runs framework adapters (Express, FastAPI,
 *                      Next.js, Prisma, env) and emits extra nodes/edges/sinks.
 *   Tier 3: assemble — merge defs + adapter fragments, dedupe nodes/edges,
 *                      sort, stamp stats.
 *   Tier 2.5: effects — propagate adapter sinks up the call chain.
 *
 * Every tier is additive; the React Flow viewer keeps working with whatever
 * fields it recognizes.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import crypto from "node:crypto";
import { detectLang, isAnalyzable, parseFile } from "./parsers/index.js";
import { resolveSymbols } from "./resolver.js";
import { runAdapters } from "./adapters/index.js";
import { annotateEffects } from "./effects.js";
import { attachDeadCodeWarnings } from "./dead-code.js";
import { buildCompileReport } from "./quality.js";
import { normalizeProvenance } from "./provenance.js";
import { parse as parseRyngoMd } from "./ryngo-md.js";

// No total-file cap. Compilation is deterministic regex / tree-walk —
// fast even at 100k files. Per-file caps below stay (a single 50 MB
// generated bundle blows up the parser's memory ceiling, and a file
// with 5000 def nodes is unrenderable in the viewer regardless).
const MAX_FILES = Infinity;
const MAX_FILE_BYTES = 1_000_000;
const MAX_SOURCE_BYTES_FOR_PARSE = 500_000;
const MAX_DEFS_PER_FILE = 80;
const CLONE_TIMEOUT_MS = 180_000;

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt", ".turbo",
  ".cache", ".parcel-cache", "coverage", "target", "out", "__pycache__",
  ".venv", "venv", "env", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".idea", ".vscode",
]);

const GITHUB_URL_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

export async function analyzeRepo(githubUrl, ref) {
  const trimmed = String(githubUrl || "").trim();
  const m = trimmed.match(GITHUB_URL_RE);
  if (!m) {
    throw new Error(
      "Not a valid github.com repo URL. Expected: https://github.com/owner/repo",
    );
  }
  const [, owner, repo] = m;
  const cleanRef = ref ? String(ref).trim() : "";

  const tmpDir = path.join(
    os.tmpdir(),
    `ryngo-${crypto.randomBytes(6).toString("hex")}`,
  );
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    await runGitClone(
      `https://github.com/${owner}/${repo}.git`,
      tmpDir,
      cleanRef,
    );
    const ir = await buildIR(tmpDir, `${owner}/${repo}`);
    ir.ref = cleanRef || "HEAD";
    return ir;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function runGitClone(url, dir, ref) {
  return new Promise((resolve, reject) => {
    const args = ["clone", "--depth=1", "--single-branch", "--quiet"];
    if (ref && ref !== "HEAD" && ref !== "default") {
      args.push("--branch", ref);
    }
    args.push(url, dir);

    const child = spawn("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`git clone timed out after ${CLONE_TIMEOUT_MS / 1000}s`),
      );
    }, CLONE_TIMEOUT_MS);

    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err.code === "ENOENT" ? new Error("git not found on PATH") : err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const lastLine = stderr.trim().split("\n").slice(-1)[0] || "";
      const refHint = ref ? ` (ref: ${ref})` : "";
      reject(
        new Error(
          `git clone failed (exit ${code})${refHint}${lastLine ? `: ${lastLine}` : ""}`,
        ),
      );
    });
  });
}

async function buildIR(rootDir, repoName) {
  // Walk + capture.
  const files = [];
  const truncated = await walkDir(rootDir, rootDir, files, MAX_FILES);
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  // -- pass 1: file nodes ---------------------------------------------------
  const nodes = [];
  const fileIndex = new Map();
  const fileNodesByPath = new Map();
  for (const f of files) {
    const id = `file:${f.relPath}`;
    const analyzable = isAnalyzable(f.relPath);
    const fileNode = {
      id,
      kind: "file",
      label: path.posix.basename(f.relPath),
      data: {
        path: f.relPath,
        size: f.size,
        ext: path.extname(f.relPath),
        lang: detectLang(f.relPath) || "",
        analyzable,
        parserBackend: analyzable ? null : "unsupported",
        parseStatus: analyzable ? "pending" : "unsupported",
      },
    };
    fileIndex.set(f.relPath, id);
    fileNodesByPath.set(f.relPath, fileNode);
    nodes.push(fileNode);
  }

  // -- Tier 0: parse --------------------------------------------------------
  const parsedFiles = [];
  const parsedMap = new Map();
  const fileTextCache = new Map();
  const parseDiagnostics = [];
  for (const f of files) {
    const fileNode = fileNodesByPath.get(f.relPath);
    if (!isAnalyzable(f.relPath)) continue;
    if (f.size > MAX_SOURCE_BYTES_FOR_PARSE) {
      if (fileNode) {
        fileNode.data.parserBackend = "skipped";
        fileNode.data.parseStatus = "skipped_large";
      }
      parseDiagnostics.push({
        stage: "parse",
        severity: "warning",
        code: "skipped_large_file",
        file: f.relPath,
        message: `Skipped ${f.relPath}; file exceeds parser cap`,
      });
      continue;
    }
    const raw = await fs
      .readFile(path.join(rootDir, f.relPath), "utf8")
      .catch(() => null);
    if (raw == null) {
      if (fileNode) {
        fileNode.data.parserBackend = "error";
        fileNode.data.parseStatus = "error";
      }
      parseDiagnostics.push({
        stage: "parse",
        severity: "warning",
        code: "read_failed",
        file: f.relPath,
        message: `Could not read ${f.relPath}`,
      });
      continue;
    }
    fileTextCache.set(f.relPath, raw);

    const parsed = parseFile(f.relPath, raw);
    if (!parsed) {
      if (fileNode) {
        fileNode.data.parserBackend = "unsupported";
        fileNode.data.parseStatus = "unsupported";
      }
      continue;
    }
    if (parsed.defs?.length > MAX_DEFS_PER_FILE) {
      parsed.defs = parsed.defs.slice(0, MAX_DEFS_PER_FILE);
    }
    if (fileNode) {
      fileNode.data.parserBackend = parsed.backend || "unknown";
      fileNode.data.parseStatus =
        parsed.backend === "stub" || parsed.backend === "error" ? parsed.backend : "ok";
      if (parsed.diagnostics?.length) {
        fileNode.data.diagnostics = parsed.diagnostics.slice(0, 5);
      }
    }
    for (const diagnostic of parsed.diagnostics || []) {
      parseDiagnostics.push({
        stage: "parse",
        severity: parsed.backend === "error" ? "error" : "warning",
        code: parsed.backend === "stub" ? "stub_backend" : "parser_diagnostic",
        file: f.relPath,
        message: diagnostic,
      });
    }
    parsedFiles.push({ relPath: f.relPath, parsed });
    parsedMap.set(f.relPath, parsed);
  }

  // -- Tier 1: resolve ------------------------------------------------------
  const resolved = resolveSymbols(parsedFiles, fileIndex);
  for (const def of resolved.defs) nodes.push(def);
  for (const [, pkg] of resolved.packages) {
    nodes.push({
      id: pkg.id,
      kind: "package",
      label: pkg.label,
      data: { name: pkg.label },
    });
  }

  // -- Tier 2: adapters -----------------------------------------------------
  const readFile = async (relPath) => {
    if (fileTextCache.has(relPath)) return fileTextCache.get(relPath);
    try {
      const raw = await fs.readFile(path.join(rootDir, relPath), "utf8");
      fileTextCache.set(relPath, raw);
      return raw;
    } catch {
      return null;
    }
  };
  const adapterCtx = {
    parsedFiles,
    allFiles: files.map((f) => ({ relPath: f.relPath })),
    fileIndex,
    rootDir,
    readFile,
    repoName,
  };
  const adapterResult = await runAdapters(adapterCtx);
  for (const n of adapterResult.nodes) nodes.push(n);
  const edges = [...resolved.edges, ...adapterResult.edges];

  // -- Tier 3: assemble + dedupe -------------------------------------------
  const nodeById = new Map();
  for (const n of nodes) {
    if (!nodeById.has(n.id)) nodeById.set(n.id, n);
  }
  const dedupedNodes = [...nodeById.values()];

  const edgeById = new Map();
  for (const e of edges) {
    const key = e.id || `${e.source}=>${e.target}@${e.kind}`;
    if (!edgeById.has(key)) edgeById.set(key, { ...e, id: key });
  }
  const dedupedEdges = [...edgeById.values()];

  // -- Tier 2.5: effects ----------------------------------------------------
  const ir = {
    repo: repoName,
    nodes: dedupedNodes,
    edges: dedupedEdges,
  };
  annotateEffects(ir, adapterResult.effects);
  // Phase 10.next — IR-level warnings (dead-function + circular-import).
  // Runs against the fully-resolved edge graph so the dead-function
  // pass sees every inbound call edge; warnings get attached to
  // `node.data.warnings` alongside the per-function ones from
  // warnings.js so the viewer renders them uniformly.
  attachDeadCodeWarnings(ir);

  // -- finalize -------------------------------------------------------------
  ir.nodes.sort((a, b) => {
    const orderA = nodeOrder(a.kind);
    const orderB = nodeOrder(b.kind);
    if (orderA !== orderB) return orderA - orderB;
    return a.id.localeCompare(b.id);
  });
  ir.edges.sort((a, b) => a.id.localeCompare(b.id));

  const defCount = ir.nodes.filter(
    (n) => n.kind === "function" || n.kind === "class",
  ).length;
  const cellCount = ir.nodes.filter((n) => n.kind === "cell").length;
  const callEdgeCount = ir.edges.filter((e) => e.kind === "calls").length;
  const routeCount = ir.nodes.filter((n) => n.kind === "http-route").length;
  const modelCount = ir.nodes.filter((n) => n.kind === "db-model").length;
  const envCount = ir.nodes.filter((n) => n.kind === "env").length;

  ir.stats = {
    files: files.length,
    analyzedFiles: parsedMap.size,
    parsedFiles: parsedFiles.filter(({ parsed }) => parsed.backend !== "stub" && parsed.backend !== "error").length,
    stubbedFiles: parsedFiles.filter(({ parsed }) => parsed.backend === "stub").length,
    parseErrorFiles: parsedFiles.filter(({ parsed }) => parsed.backend === "error").length,
    definitions: defCount,
    cells: cellCount,
    packages: resolved.packages.size,
    edges: ir.edges.length,
    callEdges: callEdgeCount,
    routes: routeCount,
    dbModels: modelCount,
    envReads: envCount,
    truncated,
    ranAdapters: adapterResult.ranAdapters,
  };
  ir.diagnostics = [
    ...parseDiagnostics.slice(0, 20),
    ...resolved.diagnostics.slice(0, 20),
    ...adapterResult.diagnostics.slice(0, 20),
  ];

  // Phase 11.3 — read Ryngo.md from the user's clone root and attach
  // the parsed manifest. Downstream consumers (warnings filter,
  // server endpoints, MCP tools) read `ir.ryngoManifest` so they
  // don't have to re-clone or re-parse.
  const ryngoMdRaw = await fs
    .readFile(path.join(rootDir, "Ryngo.md"), "utf8")
    .catch(() => null);
  if (ryngoMdRaw) {
    ir.ryngoMd = ryngoMdRaw;
    ir.ryngoManifest = parseRyngoMd(ryngoMdRaw);
    // Warnings filter: drop suppressed kinds from def.warnings before
    // the IR leaves the analyzer. Cheap second pass; only runs when
    // a manifest exists.
    applySuppressionsToWarnings(ir);
  }

  normalizeProvenance(ir);
  ir.quality = buildCompileReport(ir);

  return ir;
}

/**
 * Walk every function/class node and remove `data.warnings` entries
 * whose `kind` is suppressed for that node id. Mutates the IR. Cheap.
 */
function applySuppressionsToWarnings(ir) {
  const sup = ir.ryngoManifest?.suppressions;
  if (!sup || sup.size === 0) return;
  for (const node of ir.nodes) {
    if (!node.data?.warnings?.length) continue;
    const list = sup.get(node.id);
    if (!list) continue;
    const kinds = new Set(list.map((s) => s.kind));
    node.data.warnings = node.data.warnings.filter((w) => !kinds.has(w.kind));
    if (node.data.warnings.length === 0) delete node.data.warnings;
  }
}

function nodeOrder(kind) {
  return (
    {
      file: 0,
      function: 1,
      class: 1,
      cell: 1,
      "db-model": 1,
      "http-route": 1,
      package: 2,
      env: 2,
      "infra-resource": 2,
    }[kind] ?? 99
  );
}

async function walkDir(rootDir, dir, out, maxFiles) {
  if (out.length >= maxFiles) return true;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  let truncated = false;
  for (const e of entries) {
    if (out.length >= maxFiles) {
      truncated = true;
      break;
    }
    if (SKIP_DIRS.has(e.name)) continue;
    if (
      e.name.startsWith(".") &&
      e.name !== ".env.example" &&
      e.name !== ".env" &&
      e.name !== ".github"
    ) {
      continue;
    }
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const subTruncated = await walkDir(rootDir, full, out, maxFiles);
      truncated = truncated || subTruncated;
    } else if (e.isFile()) {
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      if (stat.size > MAX_FILE_BYTES) continue;
      const relPath = path
        .relative(rootDir, full)
        .split(path.sep)
        .join("/");
      out.push({ relPath, size: stat.size });
    }
  }
  return truncated;
}
