/**
 * Plinth MVP — HTTP server.
 *
 * - POST /api/analyze {url}  → { ir }  on success, { error } on failure
 * - GET /api/health          → { ok: true }
 * - GET /*                   → static frontend (only after `npm run build`)
 *
 * In dev, the Vite dev server (port 5173) proxies /api here. In production,
 * this is the only process; the built SPA is served from ./dist.
 */
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { analyzeRepo } from "./lib/analyze.js";
import { diffIRs } from "./lib/diff.js";
import * as annotations from "./lib/annotations.js";
import * as regions from "./lib/regions.js";
import * as intents from "./lib/intents.js";
import {
  saveIntentSnapshot,
  loadIntentSnapshot,
} from "./lib/snapshots.js";
import { verifyIntent } from "./lib/verify.js";
import { readMaybe } from "./lib/storage.js";
import {
  compactJson,
  englishSignature,
  topology,
  slice as projectionSlice,
  prd as projectionPrd,
} from "./lib/projection-llm.js";
import { buildViewModel } from "./lib/view-model.js";
import { handleMcpHttpRequest } from "./lib/mcp.js";
import { eventsEnabled, recordAnalysisRun, recordUsageEvent } from "./lib/events.js";
import * as regionsLib from "./lib/regions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === "production";

const app = express();
app.use(express.json({ limit: "32kb" }));

// Simple per-IP concurrency cap so a single client can't queue many clones.
const inFlightByIp = new Map();
const MAX_INFLIGHT_PER_IP = 2;

app.get("/api/health", async (_req, res) => {
  const git = await gitHealth();
  const checks = {
    git,
    events: {
      configured: eventsEnabled(),
      databaseUrl: Boolean(process.env.DATABASE_URL),
    },
    mcp: {
      chatgpt: "/mcp",
      plain: "/mcp/plain",
    },
    storage: {
      ryngoDir: path.join(__dirname, ".ryngo"),
      mounted: existsSync(path.join(__dirname, ".ryngo")),
    },
  };
  res.status(git.ok ? 200 : 503).json({
    ok: git.ok,
    mode: isProd ? "production" : "development",
    revision: process.env.K_REVISION || null,
    commit: process.env.GIT_SHA || null,
    checks,
  });
});

// Streamable HTTP MCP endpoint for ChatGPT Apps / hosted MCP connectors.
// Stdio remains available through `npm run mcp`.
app.options("/mcp", (_req, res) => {
  res
    .set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "content-type, mcp-session-id, mcp-protocol-version",
    })
    .status(204)
    .end();
});
app.post("/mcp", (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  handleMcpHttpRequest(req, res, { enableWidgets: true });
});
app.options("/mcp/plain", (_req, res) => {
  res
    .set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "content-type, mcp-session-id, mcp-protocol-version",
    })
    .status(204)
    .end();
});
app.post("/mcp/plain", (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  handleMcpHttpRequest(req, res, { enableWidgets: false });
});
app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});
app.get("/mcp/plain", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});
app.delete("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});
app.delete("/mcp/plain", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});

// ---------------------------------------------------------------------------
// /api/source — fetch raw file content from GitHub for the focus view.
//
// Request: GET /api/source?repo=owner/repo&path=relative/file.py
// Response: { source: string }   |   { error: string }
//
// Caches in-memory for SOURCE_CACHE_MS so drilling into multiple defs in the
// same file doesn't re-hit GitHub.
// ---------------------------------------------------------------------------

const SOURCE_CACHE_MS = 5 * 60 * 1000;
const SOURCE_MAX_BYTES = 750_000;
const sourceCache = new Map(); // key → { ts, source }

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

app.get("/api/source", async (req, res) => {
  const repo = String(req.query.repo || "");
  const filePath = String(req.query.path || "");
  const explicitRef = String(req.query.ref || "");

  if (!REPO_RE.test(repo)) {
    return res.status(400).json({ error: "Invalid `repo` (owner/name)." });
  }
  if (!filePath || filePath.includes("..") || filePath.startsWith("/")) {
    return res.status(400).json({ error: "Invalid `path`." });
  }

  // Cache key includes ref so base/head copies don't collide.
  const key = `${repo}::${explicitRef || "HEAD"}::${filePath}`;
  const now = Date.now();
  const cached = sourceCache.get(key);
  if (cached && now - cached.ts < SOURCE_CACHE_MS) {
    return res.json({ source: cached.source, cached: true });
  }

  // Caller-provided ref tried first, then sensible defaults.
  const refs = explicitRef
    ? [explicitRef, "HEAD", "main", "master"]
    : ["HEAD", "main", "master"];
  let lastStatus = 0;
  for (const ref of refs) {
    const url = `https://raw.githubusercontent.com/${repo}/${ref}/${encodeURI(filePath)}`;
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
      });
      lastStatus = r.status;
      if (!r.ok) continue;
      const cl = Number(r.headers.get("content-length") || 0);
      if (cl && cl > SOURCE_MAX_BYTES) {
        return res.status(413).json({
          error: `File is ${cl} bytes; viewer cap is ${SOURCE_MAX_BYTES}.`,
        });
      }
      const source = await r.text();
      if (source.length > SOURCE_MAX_BYTES) {
        return res.status(413).json({
          error: `File is ${source.length} bytes; viewer cap is ${SOURCE_MAX_BYTES}.`,
        });
      }
      sourceCache.set(key, { ts: now, source });
      // Best-effort cache eviction.
      if (sourceCache.size > 200) {
        const oldest = [...sourceCache.entries()].sort(
          (a, b) => a[1].ts - b[1].ts,
        )[0];
        if (oldest) sourceCache.delete(oldest[0]);
      }
      void recordUsageEvent("source_open", {
        source: "web",
        githubUrl: `https://github.com/${repo}`,
        ref: explicitRef || "HEAD",
        status: "ok",
        req,
        props: { path: filePath, cached: false },
      });
      return res.json({ source });
    } catch (err) {
      lastStatus = 599;
    }
  }
  res
    .status(lastStatus === 404 ? 404 : 502)
    .json({
      error:
        lastStatus === 404
          ? "File not found on default branch / main / master."
          : `Upstream fetch failed (status ${lastStatus}).`,
    });
});

app.post("/api/analyze", async (req, res) => {
  const url = typeof req.body?.url === "string" ? req.body.url : "";
  const ref = typeof req.body?.ref === "string" ? req.body.ref : "";
  if (!url) {
    return res.status(400).json({ error: "Body must include a `url` string." });
  }

  const ip = req.ip || "unknown";
  const current = inFlightByIp.get(ip) || 0;
  if (current >= MAX_INFLIGHT_PER_IP) {
    return res.status(429).json({
      error: `Too many concurrent analyses from this client (max ${MAX_INFLIGHT_PER_IP}). Wait for the previous one.`,
    });
  }
  inFlightByIp.set(ip, current + 1);

  const startedAt = Date.now();
  try {
    const ir = await analyzeRepo(url, ref);
    const ms = Date.now() - startedAt;
    void recordAnalysisRun({
      source: "web",
      githubUrl: url,
      ref: ref || ir.ref,
      status: "ok",
      durationMs: ms,
      ir,
      req,
    });
    console.log(
      `[analyze ok] ${ir.repo}@${ir.ref}  files=${ir.stats.files} analyzed=${ir.stats.analyzedFiles} edges=${ir.stats.edges} pkg=${ir.stats.packages} ${ms}ms${ir.stats.truncated ? " (truncated)" : ""}`,
    );
    res.json({ ir });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const ms = Date.now() - startedAt;
    void recordAnalysisRun({
      source: "web",
      githubUrl: url,
      ref,
      status: "error",
      durationMs: ms,
      error: err,
      req,
    });
    console.warn(`[analyze err] ${url}@${ref || "HEAD"}  ${ms}ms  ${message}`);
    res.status(400).json({ error: message });
  } finally {
    const next = (inFlightByIp.get(ip) || 1) - 1;
    if (next <= 0) inFlightByIp.delete(ip);
    else inFlightByIp.set(ip, next);
  }
});

app.post("/api/compile-report", async (req, res) => {
  const url = typeof req.body?.url === "string" ? req.body.url : "";
  const ref = typeof req.body?.ref === "string" ? req.body.ref : "";
  if (!url) {
    return res.status(400).json({ error: "Body must include a `url` string." });
  }

  const ip = req.ip || "unknown";
  const current = inFlightByIp.get(ip) || 0;
  if (current >= MAX_INFLIGHT_PER_IP) {
    return res.status(429).json({
      error: `Too many concurrent analyses from this client (max ${MAX_INFLIGHT_PER_IP}). Wait for the previous one.`,
    });
  }
  inFlightByIp.set(ip, current + 1);

  const startedAt = Date.now();
  try {
    const ir = await analyzeRepo(url, ref);
    const ms = Date.now() - startedAt;
    void recordAnalysisRun({
      source: "web",
      githubUrl: url,
      ref: ref || ir.ref,
      status: "ok",
      durationMs: ms,
      ir,
      req,
    });
    res.json({ report: ir.quality });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const ms = Date.now() - startedAt;
    void recordAnalysisRun({
      source: "web",
      githubUrl: url,
      ref,
      status: "error",
      durationMs: ms,
      error: err,
      req,
    });
    res.status(400).json({ error: message });
  } finally {
    const next = (inFlightByIp.get(ip) || 1) - 1;
    if (next <= 0) inFlightByIp.delete(ip);
    else inFlightByIp.set(ip, next);
  }
});

// ---------------------------------------------------------------------------
// /api/diff — analyze the same repo at two refs and return a combined diff IR.
// Body: { url, base, head }
// Response: { ir }   ir.nodes/edges each carry _diff: 'added'|'removed'|'unchanged'
// ---------------------------------------------------------------------------

app.post("/api/diff", async (req, res) => {
  const url = typeof req.body?.url === "string" ? req.body.url : "";
  const base = typeof req.body?.base === "string" ? req.body.base : "";
  const head = typeof req.body?.head === "string" ? req.body.head : "";
  if (!url || !base || !head) {
    return res
      .status(400)
      .json({ error: "Body must include `url`, `base`, and `head`." });
  }
  if (base === head) {
    return res
      .status(400)
      .json({ error: "`base` and `head` must be different refs." });
  }

  const ip = req.ip || "unknown";
  const current = inFlightByIp.get(ip) || 0;
  // Diff costs two clones, so charge each request as two units.
  if (current + 2 > MAX_INFLIGHT_PER_IP) {
    return res.status(429).json({
      error: `Too many concurrent analyses from this client (max ${MAX_INFLIGHT_PER_IP}). Wait for the previous one.`,
    });
  }
  inFlightByIp.set(ip, current + 2);

  const startedAt = Date.now();
  try {
    const [baseIR, headIR] = await Promise.all([
      analyzeRepo(url, base),
      analyzeRepo(url, head),
    ]);
    const ir = diffIRs(baseIR, headIR);
    const ms = Date.now() - startedAt;
    void recordUsageEvent("diff_submit", {
      source: "web",
      githubUrl: url,
      ref: `${base}..${head}`,
      status: "ok",
      durationMs: ms,
      req,
      props: {
        base,
        head,
        base_nodes: baseIR.nodes.length,
        head_nodes: headIR.nodes.length,
      },
    });
    console.log(
      `[diff ok] ${ir.repo}  ${baseIR.ref}…${headIR.ref}  +${ir.diff.counts.nodes.added}/-${ir.diff.counts.nodes.removed} nodes  +${ir.diff.counts.edges.added}/-${ir.diff.counts.edges.removed} edges  ${ms}ms`,
    );
    res.json({ ir });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const ms = Date.now() - startedAt;
    void recordUsageEvent("diff_submit", {
      source: "web",
      githubUrl: url,
      ref: `${base}..${head}`,
      status: "error",
      durationMs: ms,
      req,
      error: err,
      props: { base, head },
    });
    console.warn(`[diff err] ${url}  ${base}..${head}  ${ms}ms  ${message}`);
    res.status(400).json({ error: message });
  } finally {
    const next = (inFlightByIp.get(ip) || 2) - 2;
    if (next <= 0) inFlightByIp.delete(ip);
    else inFlightByIp.set(ip, next);
  }
});

// ---------------------------------------------------------------------------
// /api/branches — list the repo's branches and tags via the GitHub API.
// Anonymous (no token), so it shares the public 60-req/hr/IP rate limit. Cached
// in-process for 5 min.
// ---------------------------------------------------------------------------

const branchCache = new Map(); // repo → { ts, data }
const BRANCH_CACHE_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// /api/pr?repo=…&number=… — resolve a GitHub PR number to its base/head refs
// so the frontend can switch into diff mode. Anonymous (no token), so this
// shares the public 60/hr/IP rate limit. Cached briefly with branchCache.
// ---------------------------------------------------------------------------

app.get("/api/pr", async (req, res) => {
  const repo = String(req.query.repo || "");
  const number = String(req.query.number || "");
  if (!REPO_RE.test(repo)) {
    return res.status(400).json({ error: "Invalid `repo` (owner/name)." });
  }
  if (!/^\d+$/.test(number)) {
    return res
      .status(400)
      .json({ error: "Invalid `number` (must be digits only)." });
  }
  const cacheKey = `pr:${repo}#${number}`;
  const cached = branchCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < BRANCH_CACHE_MS) {
    return res.json({ ...cached.data, cached: true });
  }
  try {
    const r = await fetch(
      `https://api.github.com/repos/${repo}/pulls/${number}`,
      {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      return res
        .status(r.status)
        .json({ error: j.message || `GitHub: ${r.status}` });
    }
    const pr = await r.json();
    const data = {
      number: pr.number,
      title: pr.title,
      base: pr.base?.ref || "",
      head: pr.head?.ref || "",
      headRepo: pr.head?.repo?.full_name || "",
      state: pr.state || "",
      author: pr.user?.login || "",
    };
    branchCache.set(cacheKey, { ts: Date.now(), data });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message || String(err) });
  }
});

app.get("/api/branches", async (req, res) => {
  const repo = String(req.query.repo || "");
  if (!REPO_RE.test(repo)) {
    return res.status(400).json({ error: "Invalid `repo` (owner/name)." });
  }

  const cached = branchCache.get(repo);
  if (cached && Date.now() - cached.ts < BRANCH_CACHE_MS) {
    return res.json({ ...cached.data, cached: true });
  }

  const headers = { Accept: "application/vnd.github+json" };
  try {
    const [metaR, branchesR, tagsR] = await Promise.all([
      fetch(`https://api.github.com/repos/${repo}`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      }),
      fetch(
        `https://api.github.com/repos/${repo}/branches?per_page=100`,
        { headers, signal: AbortSignal.timeout(10_000) },
      ),
      fetch(`https://api.github.com/repos/${repo}/tags?per_page=30`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      }),
    ]);

    if (!metaR.ok) {
      const j = await metaR.json().catch(() => ({}));
      return res
        .status(metaR.status)
        .json({ error: j.message || `GitHub: ${metaR.status}` });
    }
    const meta = await metaR.json();
    const branchesJson = branchesR.ok ? await branchesR.json() : [];
    const tagsJson = tagsR.ok ? await tagsR.json() : [];

    const data = {
      default: meta.default_branch || "main",
      branches: Array.isArray(branchesJson)
        ? branchesJson.map((b) => b.name)
        : [],
      tags: Array.isArray(tagsJson) ? tagsJson.map((t) => t.name) : [],
    };
    branchCache.set(repo, { ts: Date.now(), data });
    if (branchCache.size > 200) {
      const oldest = [...branchCache.entries()].sort(
        (a, b) => a[1].ts - b[1].ts,
      )[0];
      if (oldest) branchCache.delete(oldest[0]);
    }
    res.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: message });
  }
});

// In production, serve two static surfaces:
//   /         → the marketing landing (mvp/landing/, hand-authored HTML)
//   /app      → the SPA (mvp/dist/, vite-built)
// Shared assets at /assets/* come from the SPA's vite-built bundle.
// /api/* and /mcp are bound above and take precedence over the static
// fall-throughs because they were registered earlier on `app`.
const distDir = path.join(__dirname, "dist");
const landingDir = path.join(__dirname, "landing");
if (isProd) {
  if (!existsSync(distDir)) {
    console.warn(
      `[startup] NODE_ENV=production but ${distDir} doesn't exist. Run \`npm run build\` first.`,
    );
  }
  if (!existsSync(landingDir)) {
    console.warn(
      `[startup] NODE_ENV=production but ${landingDir} doesn't exist.`,
    );
  }

  // SPA assets (/assets/*) — must come before the landing.
  app.use("/assets", express.static(path.join(distDir, "assets")));

  // SPA at /app — every /app/* path serves the SPA's index.html so the
  // client-side router takes over.
  app.use("/app", express.static(distDir));
  app.get(/^\/app(\/.*)?$/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });

  // Landing at root. Static for the HTML + landing.css, then a final
  // wildcard sends anything else to the landing's index (no 404 page).
  app.use(express.static(landingDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(landingDir, "index.html"));
  });
}

// ---------------------------------------------------------------------------
// Ryngo annotation state — the LLM-native loop.
//
// All four endpoints below operate on `mvp/.ryngo/<owner>__<repo>/`. The
// underlying read/write helpers live in lib/{annotations,regions,intents,storage}.js.
// Errors return 4xx with `{ error }`; success returns the relevant resource.
// ---------------------------------------------------------------------------

function takeRepo(req, fallback) {
  const repo = (
    req.body?.repo ||
    req.query?.repo ||
    fallback ||
    ""
  ).toString();
  if (!REPO_RE.test(repo)) {
    const err = new Error("Invalid `repo` (owner/name).");
    err.status = 400;
    throw err;
  }
  return repo;
}

app.get("/api/ryngo-state", async (req, res) => {
  try {
    const repo = takeRepo(req);
    const [ann, annByNode, regs, intentList, intentsByNode, rules, wires] =
      await Promise.all([
        annotations.read(repo),
        annotations.countsByNode(repo),
        regions.listRegions(repo),
        intents.listIntents(repo),
        intents.indexByNode(repo),
        readMaybe(repo, "rules.md"),
        readMaybe(repo, "wires.md"),
      ]);
    res.json({
      repo,
      annotations: ann,
      annotationsByNode: annByNode,
      regions: regs,
      intents: intentList.map((i) => {
        const parsed = intents.parseIntent(i.text);
        return {
          id: i.id,
          file: i.file,
          status: parsed?.meta?.status || "open",
          type: parsed?.meta?.type || "intent",
          node: parsed?.meta?.node || parsed?.nodeIds?.[0] || null,
        };
      }),
      intentsByNode,
      rules,
      wires,
    });
  } catch (err) {
    res
      .status(err.status || 500)
      .json({ error: err.message || String(err) });
  }
});

app.post("/api/annotations", async (req, res) => {
  try {
    const repo = takeRepo(req);
    const { nodeId, text, author } = req.body || {};
    if (!nodeId || !text) {
      return res
        .status(400)
        .json({ error: "Body must include `nodeId` and `text`." });
    }
    const entry = await annotations.append(repo, { nodeId, text, author });
    void recordUsageEvent("annotation_create", {
      source: "web",
      githubUrl: repoUrlFromStorageKey(repo),
      status: "ok",
      req,
      props: { node_id: nodeId, text_length: String(text).length },
    });
    console.log(`[ryngo annot] ${repo}  ${nodeId}`);
    res.json({ ok: true, entry });
  } catch (err) {
    res
      .status(err.status || 500)
      .json({ error: err.message || String(err) });
  }
});

app.post("/api/regions", async (req, res) => {
  try {
    const repo = takeRepo(req);
    const { label, nodes, color } = req.body || {};
    const region = await regions.addRegion(repo, { label, nodes, color });
    console.log(
      `[ryngo region] ${repo}  ${region.id} (${region.nodes.length} nodes)`,
    );
    res.json({ ok: true, region });
  } catch (err) {
    res
      .status(err.status || 500)
      .json({ error: err.message || String(err) });
  }
});

app.delete("/api/regions/:id", async (req, res) => {
  try {
    const repo = takeRepo(req);
    const id = String(req.params.id || "");
    const ok = await regions.deleteRegion(repo, id);
    res.json({ ok });
  } catch (err) {
    res
      .status(err.status || 500)
      .json({ error: err.message || String(err) });
  }
});

app.post("/api/intents", async (req, res) => {
  try {
    const repo = takeRepo(req);
    const { kind, nodeId, nodeLabel, ir } = req.body || {};
    const out = await intents.createIntent(repo, { kind, nodeId, nodeLabel });
    // Snapshot the current IR alongside the intent so Apply-and-verify can
    // diff against the as-marked state later. The frontend ships the IR it
    // already has — the backend doesn't re-clone here.
    if (ir && Array.isArray(ir.nodes) && Array.isArray(ir.edges)) {
      try {
        await saveIntentSnapshot(repo, out.id, ir);
      } catch (e) {
        console.warn(`[ryngo intent] snapshot failed: ${e.message}`);
      }
    }
    void recordUsageEvent("intent_create", {
      source: "web",
      githubUrl: repoUrlFromStorageKey(repo),
      status: "ok",
      req,
      props: {
        intent_id: out.id,
        kind,
        node_id: nodeId,
        has_snapshot: Boolean(ir),
      },
    });
    console.log(`[ryngo intent] ${repo}  ${out.id}`);
    res.json({ ok: true, ...out });
  } catch (err) {
    res
      .status(err.status || 500)
      .json({ error: err.message || String(err) });
  }
});

/**
 * /api/intents/:id/verify — diff the supplied current IR against the snapshot
 * we took when the intent was created, judge the result by intent type, and
 * (if satisfied) flip the intent's `status:` from `open` to `done`.
 *
 * Body: { repo, ir }   ir = current IR from the analyze response.
 * Response: { status, evidence, diff, intent }
 */
app.post("/api/intents/:id/verify", async (req, res) => {
  try {
    const repo = takeRepo(req);
    const id = String(req.params.id || "");
    const { ir: currentIR } = req.body || {};
    if (!currentIR || !Array.isArray(currentIR.nodes)) {
      return res
        .status(400)
        .json({ error: "Body must include `ir` (current IR)." });
    }
    const intentText = await intents.readIntent(repo, id);
    if (!intentText) {
      return res.status(404).json({ error: `intent ${id} not found` });
    }
    const intent = intents.parseIntent(intentText);
    if (!intent) {
      return res
        .status(400)
        .json({ error: `intent ${id} could not be parsed` });
    }
    const snapshot = await loadIntentSnapshot(repo, id);
    if (!snapshot) {
      return res.status(404).json({
        error: `no snapshot found for intent ${id} (was the intent created before snapshots shipped?)`,
      });
    }
    const result = verifyIntent(intent, snapshot, currentIR);
    // Auto-flip status when fully satisfied.
    if (result.status === "satisfied" && intent.meta.status !== "done") {
      await intents.setStatus(repo, id, "done");
    }
    void recordUsageEvent("intent_verify", {
      source: "web",
      githubUrl: repoUrlFromStorageKey(repo),
      status: result.status,
      req,
      props: { intent_id: id, evidence_count: result.evidence?.length || 0 },
    });
    console.log(`[ryngo verify] ${repo}  ${id}  → ${result.status}`);
    res.json({
      ok: true,
      intent: { id, kind: intent.meta.type, nodeIds: intent.nodeIds },
      status: result.status,
      evidence: result.evidence,
      diff: result.diff,
    });
  } catch (err) {
    res
      .status(err.status || 500)
      .json({ error: err.message || String(err) });
  }
});

app.get("/api/intents", async (req, res) => {
  try {
    const repo = takeRepo(req);
    const list = await intents.listIntents(repo);
    const enriched = list.map((it) => {
      const parsed = intents.parseIntent(it.text);
      return {
        id: it.id,
        file: it.file,
        status: parsed?.meta?.status || "open",
        type: parsed?.meta?.type || "intent",
        node: parsed?.meta?.node || parsed?.nodeIds?.[0] || null,
        nodeIds: parsed?.nodeIds || [],
        created: parsed?.meta?.created || null,
      };
    });
    res.json({ intents: enriched });
  } catch (err) {
    res
      .status(err.status || 500)
      .json({ error: err.message || String(err) });
  }
});

/**
 * /api/cart — bundle the pinned nodes into a markdown chunk ready to paste
 * into any LLM prompt. Includes:
 *   - the IR slice (nodes + their immediate edges)
 *   - any annotations attached to those nodes
 *   - any regions overlapping the selection
 *   - file paths so the LLM can look up source itself
 *
 * Intentionally does NOT include source code text — that bloats the prompt
 * and the LLM has its own file-read tools. We give it the map, not the text.
 */
app.post("/api/cart", async (req, res) => {
  try {
    const repo = takeRepo(req);
    const { nodeIds, ir, label } = req.body || {};
    if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
      return res
        .status(400)
        .json({ error: "`nodeIds` must be a non-empty array." });
    }
    if (!ir || !Array.isArray(ir.nodes) || !Array.isArray(ir.edges)) {
      return res
        .status(400)
        .json({ error: "Body must include the `ir` payload (nodes+edges)." });
    }

    const idSet = new Set(nodeIds);
    const sliceNodes = ir.nodes.filter((n) => idSet.has(n.id));
    const sliceEdges = ir.edges.filter(
      (e) => idSet.has(e.source) || idSet.has(e.target),
    );
    const ann = await annotations.read(repo);
    const regs = await regions.listRegions(repo);
    const overlapping = regs.filter((r) =>
      r.nodes.some((nid) => idSet.has(nid)),
    );

    const date = new Date().toISOString();
    const md = renderCart({
      repo,
      label,
      date,
      pinnedIds: nodeIds,
      sliceNodes,
      sliceEdges,
      annotations: ann,
      overlappingRegions: overlapping,
    });

    res.type("text/markdown").send(md);
  } catch (err) {
    res
      .status(err.status || 500)
      .json({ error: err.message || String(err) });
  }
});

function renderCart({
  repo,
  label,
  date,
  pinnedIds,
  sliceNodes,
  sliceEdges,
  annotations: annText,
  overlappingRegions,
}) {
  const heading = label ? `# ${label}` : "# Ryngo cart";
  const nodeLines = sliceNodes
    .map((n) => {
      const file = n.data?.file || n.data?.path || "";
      const fileSuffix = file ? `  (${file}${n.data?.line ? `:${n.data.line}` : ""})` : "";
      return `- \`${n.id}\` — ${n.kind} **${n.label}**${fileSuffix}`;
    })
    .join("\n");
  const edgeLines = sliceEdges
    .map(
      (e) =>
        `- \`${e.source}\` —[${e.kind}]→ \`${e.target}\``,
    )
    .join("\n");
  const regionLines = overlappingRegions.length
    ? overlappingRegions
        .map((r) => `- \`${r.id}\` — ${r.label} (${r.nodes.length} nodes)`)
        .join("\n")
    : "_no regions touch the selection_";

  const annotationSection = annText.trim()
    ? "## Annotations on these nodes\n\n" +
      "Filtered slice from `.ryngo/annotations.md`:\n\n```markdown\n" +
      filterAnnotationsTo(annText, pinnedIds) +
      "\n```"
    : "## Annotations on these nodes\n\n_no annotations yet_";

  return `${heading}

> Generated by Ryngo · repo: \`${repo}\` · ${date}
> ${pinnedIds.length} nodes pinned. Paste this whole block into your AI of choice.

## Pinned nodes

${nodeLines || "_none_"}

## Edges in the selection

${edgeLines || "_no edges within the selection_"}

## Overlapping regions

${regionLines}

${annotationSection}

## How to use this

This is a Ryngo *cart* — a structured slice of one repo at one moment in
time. Each node id (\`file:…\`, \`def:…\`, \`cell:…\`, \`pkg:…\`) is stable
across runs of Ryngo, so when your AI applies a change and Ryngo
re-analyses the repo, the diff lines up against the same ids you see here.

Read the full annotations and architectural rules in \`.ryngo/\` at the
project root (or whichever \`.ryngo/\` your AI tool was pointed at).
`;
}

function filterAnnotationsTo(annText, ids) {
  const idSet = new Set(ids);
  const lines = annText.split("\n");
  const out = [];
  let keep = false;
  for (const line of lines) {
    const m = line.match(/^## node:\s*(\S+)/);
    if (m) {
      keep = idSet.has(m[1]);
    }
    if (keep) out.push(line);
  }
  return out.length ? out.join("\n").trim() : "_no annotations on the pinned nodes_";
}

function repoUrlFromStorageKey(repo) {
  const parts = String(repo || "").split("__");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return "";
  return `https://github.com/${parts[0]}/${parts[1]}`;
}

function gitHealth() {
  return new Promise((resolve) => {
    const child = spawn("git", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, error: "git --version timed out" });
    }, 3000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.code === "ENOENT" ? "git not found on PATH" : err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, version: stdout.trim() });
      } else {
        resolve({ ok: false, error: stderr.trim() || `git exited ${code}` });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// /api/projection/* — Tier-4 LLM-friendly projections of an IR.
//
// Body for all four POSTs: { ir }   (the IR returned by /api/analyze).
// Slice and prd take additional parameters.
// ---------------------------------------------------------------------------

function takeIR(req) {
  const ir = req.body?.ir;
  if (!ir || !Array.isArray(ir.nodes) || !Array.isArray(ir.edges)) {
    const err = new Error("Body must include `ir` (with nodes + edges).");
    err.status = 400;
    throw err;
  }
  return ir;
}

app.post("/api/projection/compact", (req, res) => {
  try {
    const ir = takeIR(req);
    const out = compactJson(ir, req.body?.opts || {});
    res.json(out);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post("/api/projection/view-model", (req, res) => {
  try {
    const ir = takeIR(req);
    const out = buildViewModel(ir, {
      mode: req.body?.mode,
      maxNodes: req.body?.maxNodes ?? req.body?.max_nodes,
    });
    res.json(out);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post("/api/projection/topology", (req, res) => {
  try {
    const ir = takeIR(req);
    res.type("text/markdown").send(topology(ir));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post("/api/projection/signature", (req, res) => {
  try {
    const ir = takeIR(req);
    const nodeId = String(req.body?.nodeId || "");
    if (!nodeId) {
      return res.status(400).json({ error: "Body must include `nodeId`." });
    }
    const node = ir.nodes.find((n) => n.id === nodeId);
    if (!node) {
      return res.status(404).json({ error: `node ${nodeId} not in IR` });
    }
    res.json({ nodeId, signature: englishSignature(node) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post("/api/projection/slice", async (req, res) => {
  try {
    const ir = takeIR(req);
    const rootId = String(req.body?.rootId || "");
    const hops = Number(req.body?.hops) || 1;
    const includeAnnotations = Boolean(req.body?.includeAnnotations);
    if (!rootId) {
      return res.status(400).json({ error: "Body must include `rootId`." });
    }
    let annotations = "";
    if (includeAnnotations && req.body?.repo) {
      const { read } = await import("./lib/annotations.js");
      annotations = await read(String(req.body.repo));
    }
    const out = projectionSlice(ir, rootId, {
      hops,
      includeAnnotations,
      annotations,
    });
    res.json(out);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.post("/api/projection/prd", async (req, res) => {
  try {
    const ir = takeIR(req);
    const repo = takeRepo(req);
    const regionId = String(req.body?.regionId || "");
    const kind = String(req.body?.kind || "overview");
    if (!regionId) {
      return res.status(400).json({ error: "Body must include `regionId`." });
    }
    const all = await regionsLib.listRegions(repo);
    const region = all.find((r) => r.id === regionId);
    if (!region) {
      return res.status(404).json({ error: `region ${regionId} not found` });
    }
    const md = projectionPrd(ir, region, kind, { title: req.body?.title });
    res.type("text/markdown").send(md);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(
    `Ryngo MVP API listening on http://localhost:${PORT} (${isProd ? "production" : "development"} mode)`,
  );
});
