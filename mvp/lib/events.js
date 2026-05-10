/**
 * Persist usage and compiler-quality events when DATABASE_URL is configured.
 */
import crypto from "node:crypto";
import { Pool } from "pg";

const GITHUB_URL_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;
const MAX_DIAGNOSTICS_PER_RUN = 50;
const MAX_FILE_OUTCOMES_PER_RUN = 2000;

let pool;
let schemaReady;
let disabled = false;
let warned = false;

/** Return whether event persistence is configured for this process. */
export function eventsEnabled() {
  return Boolean(process.env.DATABASE_URL) && process.env.RYNGO_EVENTS !== "off" && !disabled;
}

/** Check whether the optional event database is reachable. */
export async function eventHealth() {
  const configured = Boolean(process.env.DATABASE_URL) && process.env.RYNGO_EVENTS !== "off";
  if (!configured) {
    return {
      ok: true,
      configured: false,
      databaseUrl: Boolean(process.env.DATABASE_URL),
    };
  }
  if (disabled) {
    return {
      ok: false,
      configured: true,
      databaseUrl: true,
      error: "event writes are disabled after a database error",
    };
  }
  try {
    if (!(await ensureEventSchema())) {
      return {
        ok: false,
        configured: true,
        databaseUrl: true,
        error: "event schema was not initialized",
      };
    }
    await pool.query("select 1");
    return { ok: true, configured: true, databaseUrl: true };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      databaseUrl: true,
      error: cleanText(errorMessage(err), 500),
    };
  }
}

/** Create event tables if Postgres is configured. */
export async function ensureEventSchema() {
  if (!eventsEnabled()) return false;
  if (!schemaReady) schemaReady = createSchema().catch((err) => failClosed(err));
  return schemaReady;
}

/** Record a generic product event. */
export async function recordUsageEvent(eventName, props = {}) {
  if (!(await ensureEventSchema())) return null;
  const repo = repoParts(props.githubUrl || props.github_url || props.repoUrl);
  const id = crypto.randomUUID();
  await safeQuery(
    `insert into usage_events (
      id, source, event_name, repo_host, repo_owner, repo_name, ref, status,
      duration_ms, props, error_message, ip_hash, user_agent_hash
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      id,
      props.source || "internal",
      eventName,
      repo?.host || null,
      repo?.owner || null,
      repo?.name || null,
      cleanText(props.ref, 120),
      cleanText(props.status, 40),
      intOrNull(props.durationMs),
      safeJson(props.props || props),
      cleanText(errorMessage(props.error), 500),
      reqHash(props.req, "ip"),
      reqHash(props.req, "ua"),
    ],
  );
  return id;
}

/** Record a repo submission that was rejected before analysis started. */
export async function recordRejectedSubmission({
  source,
  githubUrl,
  ref,
  reason,
  error,
  req,
}) {
  if (!(await ensureEventSchema())) return null;
  const repo = repoParts(githubUrl);
  const id = crypto.randomUUID();
  await safeQuery(
    `insert into repo_submissions (
      id, source, repo_host, repo_owner, repo_name, ref, accepted, reject_reason,
      ip_hash, user_agent_hash
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      source || "api",
      repo?.host || null,
      repo?.owner || null,
      repo?.name || null,
      cleanText(ref, 120),
      false,
      cleanText(reason || errorMessage(error), 500),
      reqHash(req, "ip"),
      reqHash(req, "ua"),
    ],
  );
  await recordUsageEvent("repo_reject", {
    source,
    githubUrl,
    ref,
    status: "rejected",
    error,
    req,
    props: { reason },
  });
  return id;
}

/** Record one MCP tool call boundary. */
export async function recordMcpToolCall({ toolName, args = {}, result, status, durationMs, error }) {
  if (!(await ensureEventSchema())) return null;
  const repo = repoParts(args.github_url);
  const vm = result?.structuredContent?.version === 1 ? result.structuredContent : null;
  const id = crypto.randomUUID();
  const props = {
    mode: args.mode || null,
    max_nodes: args.max_nodes ?? null,
    has_ref: Boolean(args.ref),
    contract: vm ? "RyngoViewModel v1" : null,
    prompts: vm?.prompts?.length ?? null,
  };
  await safeQuery(
    `insert into mcp_tool_calls (
      id, tool_name, repo_host, repo_owner, repo_name, ref, status, duration_ms,
      returned_nodes, omitted_nodes, returned_edges, omitted_edges, props, error_message
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id,
      cleanText(toolName, 80),
      repo?.host || null,
      repo?.owner || null,
      repo?.name || null,
      cleanText(args.ref, 120),
      status,
      intOrNull(durationMs),
      intOrNull(vm?.nodes?.length),
      intOrNull(vm?.limits?.omittedNodes),
      intOrNull(vm?.edges?.length),
      intOrNull(vm?.limits?.omittedEdges),
      safeJson(props),
      cleanText(errorMessage(error), 500),
    ],
  );
  await recordUsageEvent("mcp_tool_call", {
    source: "mcp",
    githubUrl: args.github_url,
    ref: args.ref,
    status,
    durationMs,
    props: { tool_name: toolName, ...props },
    error,
  });
  return id;
}

/** Record an analysis run and compiler-quality rows derived from its IR. */
export async function recordAnalysisRun({
  source,
  githubUrl,
  ref,
  status,
  durationMs,
  ir,
  error,
  req,
}) {
  if (!(await ensureEventSchema())) return null;
  const repo = repoParts(githubUrl) || repoPartsFromName(ir?.repo);
  const submissionId = crypto.randomUUID();
  const analysisRunId = crypto.randomUUID();
  const ok = status === "ok";
  await safeQuery(
    `insert into repo_submissions (
      id, source, repo_host, repo_owner, repo_name, ref, accepted, reject_reason,
      ip_hash, user_agent_hash
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      submissionId,
      source || "api",
      repo?.host || null,
      repo?.owner || null,
      repo?.name || null,
      cleanText(ref || ir?.ref, 120),
      Boolean(ok),
      ok ? null : cleanText(errorMessage(error), 500),
      reqHash(req, "ip"),
      reqHash(req, "ua"),
    ],
  );
  await safeQuery(
    `insert into analysis_runs (
      id, submission_id, source, status, started_at, finished_at, duration_ms,
      file_count, analyzed_file_count, truncated, node_count, edge_count,
      route_count, db_model_count, env_var_count, package_count,
      diagnostic_count, error_message, app_version
    ) values (
      $1,$2,$3,$4,now() - (coalesce($5::int, 0) * interval '1 millisecond'),now(),$5,
      $6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
    )`,
    [
      analysisRunId,
      submissionId,
      source || "api",
      status,
      intOrNull(durationMs),
      intOrNull(ir?.stats?.files),
      intOrNull(ir?.stats?.analyzedFiles),
      Boolean(ir?.stats?.truncated),
      intOrNull(ir?.nodes?.length),
      intOrNull(ir?.edges?.length),
      intOrNull(ir?.stats?.routes),
      intOrNull(ir?.stats?.dbModels),
      intOrNull(ir?.stats?.envReads),
      intOrNull(ir?.stats?.packages),
      intOrNull(ir?.diagnostics?.length),
      cleanText(errorMessage(error), 500),
      cleanText(process.env.K_REVISION || process.env.GIT_SHA || "local", 120),
    ],
  );
  if (ir && ok) {
    await insertFileOutcomes(analysisRunId, ir);
    await insertDiagnostics(analysisRunId, ir);
    await insertAdapterOutcomes(analysisRunId, ir);
  }
  await recordUsageEvent(ok ? "analysis_complete" : "analysis_error", {
    source,
    githubUrl,
    ref: ref || ir?.ref,
    status,
    durationMs,
    props: { analysis_run_id: analysisRunId, submission_id: submissionId },
    error,
    req,
  });
  return { submissionId, analysisRunId };
}

async function insertFileOutcomes(analysisRunId, ir) {
  const fileNodes = (ir.nodes || [])
    .filter((node) => node.kind === "file")
    .slice(0, MAX_FILE_OUTCOMES_PER_RUN);
  const nodesByParent = new Map();
  for (const node of ir.nodes || []) {
    if (!node.parentId) continue;
    if (!nodesByParent.has(node.parentId)) nodesByParent.set(node.parentId, []);
    nodesByParent.get(node.parentId).push(node);
  }
  const degree = new Map();
  for (const edge of ir.edges || []) {
    bump(degree, `${edge.source}:out`);
    bump(degree, `${edge.target}:in`);
  }
  for (const file of fileNodes) {
    const children = nodesByParent.get(file.id) || [];
    const data = file.data || {};
    const path = data.path || file.id.replace(/^file:/, "");
    const defs = children.filter((node) => node.kind === "function").length;
    const classes = children.filter((node) => node.kind === "class").length;
    const outgoing = degree.get(`${file.id}:out`) || 0;
    const incoming = degree.get(`${file.id}:in`) || 0;
    const flags = [];
    if (!data.analyzable) flags.push("unsupported");
    if (data.analyzable && (data.size || 0) > 200 && defs + classes === 0) {
      flags.push("zero_defs_nontrivial_file");
    }
    if (incoming + outgoing === 0) flags.push("isolated_file");
    await safeQuery(
      `insert into file_outcomes (
        id, analysis_run_id, path_hash, path_display, ext, lang, size_bytes,
        analyzable, parser_backend, parse_status, defs_count, classes_count,
        edges_out_count, edges_in_count, quality_flags
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        crypto.randomUUID(),
        analysisRunId,
        hashValue(path),
        cleanText(path, 500),
        cleanText(data.ext, 30),
        cleanText(data.lang, 30),
        intOrNull(data.size),
        Boolean(data.analyzable),
        data.parserBackend || (data.analyzable ? "unknown" : "unsupported"),
        data.parseStatus || (data.analyzable ? "unknown" : "unsupported"),
        defs,
        classes,
        outgoing,
        incoming,
        safeJson(flags),
      ],
    );
  }
}

async function insertDiagnostics(analysisRunId, ir) {
  for (const diagnostic of (ir.diagnostics || []).slice(0, MAX_DIAGNOSTICS_PER_RUN)) {
    const diag = normalizeDiagnostic(diagnostic);
    await safeQuery(
      `insert into compiler_diagnostics (
        id, analysis_run_id, stage, severity, code, message_template, details
      ) values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        crypto.randomUUID(),
        analysisRunId,
        cleanText(diag.stage, 40),
        cleanText(diag.severity, 20),
        cleanText(diag.code, 80),
        cleanText(diag.message, 500),
        safeJson(diagnostic),
      ],
    );
  }
}

async function insertAdapterOutcomes(analysisRunId, ir) {
  for (const adapter of ir.stats?.ranAdapters || []) {
    await safeQuery(
      `insert into adapter_outcomes (
        id, analysis_run_id, adapter, detected, evidence_count,
        nodes_emitted, edges_emitted, diagnostic_count
      ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        crypto.randomUUID(),
        analysisRunId,
        cleanText(adapter, 80),
        true,
        null,
        null,
        null,
        intOrNull((ir.diagnostics || []).filter((d) => d.adapter === adapter).length),
      ],
    );
  }
}

async function createSchema() {
  pool = pool || new Pool(poolOptions());
  await pool.query(`
    create table if not exists repo_submissions (
      id uuid primary key,
      submitted_at timestamptz not null default now(),
      source text not null,
      repo_host text,
      repo_owner text,
      repo_name text,
      ref text,
      accepted boolean not null default false,
      reject_reason text,
      ip_hash text,
      user_agent_hash text
    );

    create table if not exists analysis_runs (
      id uuid primary key,
      submission_id uuid references repo_submissions(id) on delete set null,
      source text not null,
      status text not null,
      started_at timestamptz not null default now(),
      finished_at timestamptz,
      duration_ms integer,
      file_count integer,
      analyzed_file_count integer,
      truncated boolean not null default false,
      node_count integer,
      edge_count integer,
      route_count integer,
      db_model_count integer,
      env_var_count integer,
      package_count integer,
      diagnostic_count integer,
      error_message text,
      app_version text
    );

    create table if not exists file_outcomes (
      id uuid primary key,
      analysis_run_id uuid not null references analysis_runs(id) on delete cascade,
      path_hash text not null,
      path_display text,
      ext text,
      lang text,
      size_bytes integer,
      analyzable boolean not null default false,
      parser_backend text,
      parse_status text,
      defs_count integer not null default 0,
      classes_count integer not null default 0,
      edges_out_count integer not null default 0,
      edges_in_count integer not null default 0,
      diagnostic_count integer not null default 0,
      quality_flags jsonb not null default '[]'::jsonb
    );

    create table if not exists compiler_diagnostics (
      id uuid primary key,
      analysis_run_id uuid not null references analysis_runs(id) on delete cascade,
      file_outcome_id uuid references file_outcomes(id) on delete set null,
      stage text,
      severity text,
      code text,
      message_template text,
      details jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );

    create table if not exists adapter_outcomes (
      id uuid primary key,
      analysis_run_id uuid not null references analysis_runs(id) on delete cascade,
      adapter text not null,
      detected boolean not null default false,
      evidence_count integer,
      nodes_emitted integer,
      edges_emitted integer,
      effects_emitted integer,
      diagnostic_count integer,
      duration_ms integer
    );

    create table if not exists usage_events (
      id uuid primary key,
      created_at timestamptz not null default now(),
      source text not null,
      event_name text not null,
      repo_host text,
      repo_owner text,
      repo_name text,
      ref text,
      status text,
      duration_ms integer,
      props jsonb not null default '{}'::jsonb,
      error_message text,
      ip_hash text,
      user_agent_hash text
    );

    create table if not exists mcp_tool_calls (
      id uuid primary key,
      created_at timestamptz not null default now(),
      tool_name text not null,
      repo_host text,
      repo_owner text,
      repo_name text,
      ref text,
      status text not null,
      duration_ms integer,
      returned_nodes integer,
      omitted_nodes integer,
      returned_edges integer,
      omitted_edges integer,
      props jsonb not null default '{}'::jsonb,
      error_message text
    );

    create index if not exists repo_submissions_repo_idx
      on repo_submissions(repo_host, repo_owner, repo_name, submitted_at desc);
    create index if not exists analysis_runs_status_idx
      on analysis_runs(status, finished_at desc);
    create index if not exists file_outcomes_run_idx
      on file_outcomes(analysis_run_id);
    create index if not exists usage_events_name_idx
      on usage_events(event_name, created_at desc);
    create index if not exists mcp_tool_calls_tool_idx
      on mcp_tool_calls(tool_name, created_at desc);
  `);
  return true;
}

function poolOptions() {
  if (process.env.CLOUD_SQL_CONNECTION_NAME) {
    const url = new URL(process.env.DATABASE_URL);
    return {
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ""),
      host: `/cloudsql/${process.env.CLOUD_SQL_CONNECTION_NAME}`,
    };
  }
  return { connectionString: process.env.DATABASE_URL };
}

async function safeQuery(sql, params) {
  if (!eventsEnabled()) return null;
  try {
    await ensureEventSchema();
    return await pool.query(sql, params);
  } catch (err) {
    failClosed(err);
    return null;
  }
}

function failClosed(err) {
  disabled = true;
  if (!warned) {
    warned = true;
    console.warn(`[ryngo-events] disabled: ${err.message || String(err)}`);
  }
  return false;
}

function repoParts(url) {
  const m = String(url || "").trim().match(GITHUB_URL_RE);
  if (!m) return null;
  return { host: "github.com", owner: m[1], name: m[2] };
}

function repoPartsFromName(name) {
  const [owner, repo] = String(name || "").split("/");
  if (!owner || !repo) return null;
  return { host: "github.com", owner, name: repo };
}

function safeJson(value) {
  return JSON.stringify(scrub(value));
}

function scrub(value, depth = 0) {
  if (depth > 4) return "[depth-limit]";
  if (value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value).slice(0, 80)) {
      if (/token|secret|password|authorization|cookie/i.test(key)) continue;
      out[key] = scrub(val, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") return cleanText(value, 500);
  if (typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

function cleanText(value, max) {
  if (value == null) return null;
  return String(value).slice(0, max);
}

function errorMessage(error) {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

function normalizeDiagnostic(diagnostic) {
  if (typeof diagnostic === "string") {
    return {
      stage: "unknown",
      severity: "info",
      code: "diagnostic",
      message: diagnostic,
    };
  }
  return {
    stage: diagnostic?.stage || "unknown",
    severity: diagnostic?.severity || "info",
    code: diagnostic?.code || diagnostic?.kind || "diagnostic",
    message: diagnostic?.message || diagnostic?.message_template || "",
  };
}

function intOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function reqHash(req, kind) {
  if (!req) return null;
  const raw = kind === "ip" ? req.ip : req.get?.("user-agent");
  return raw ? hashValue(raw) : null;
}

function hashValue(value) {
  const salt = process.env.RYNGO_EVENT_SALT || "local-dev";
  return crypto.createHash("sha256").update(`${salt}:${value}`).digest("hex");
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}
