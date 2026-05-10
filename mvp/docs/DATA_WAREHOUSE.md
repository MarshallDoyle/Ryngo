# Ryngo — usage database & compiler-quality warehouse

Partly implemented. The first slice lives in `mvp/lib/events.js` and is
enabled only when `DATABASE_URL` is present. Without Postgres configured,
Ryngo keeps running and event writes become no-ops.

Current shipped tables:

- `repo_submissions`
- `analysis_runs`
- `file_outcomes`
- `compiler_diagnostics`
- `adapter_outcomes`
- `usage_events`
- `mcp_tool_calls`

Current event boundaries:

- MCP tool calls, including `get_view_model` node/edge/truncation counts.
- Compiler-quality reports, including parser backends, parse statuses,
  weak files, and quality flags.
- Web `/api/analyze` successes and failures.
- Web `/api/diff` submissions.
- Source opens, annotations, intent creation, and intent verification.

This is the data spine for learning which repos, files, languages, adapters,
and code patterns Ryngo compiles well, and which ones need better parser /
resolver / adapter work.

## Why this exists

Ryngo should not only answer "what does this repo look like?" It should learn,
deterministically, where its compiler succeeds and where it lies, drops edges,
or falls back to stubs. The product loop is:

1. User submits a repo / ref.
2. Ryngo clones, parses, resolves, runs adapters, renders a graph.
3. Ryngo records structured facts about that run.
4. Corpus / production data show which language and framework shapes are weak.
5. Parser and adapter changes are measured against real misses.

The database is a product-quality system, not vanity analytics.

## Principles

- **Raw source is not stored by default.** Store metadata, counts,
  diagnostics, hashes, and short redacted excerpts only when explicitly
  enabled.
- **Every event links to an analysis run.** A repo submission, API error,
  annotation write, compiler diagnostic, and frontend interaction should all
  be joinable through `analysis_run_id` or `session_id`.
- **Compiler facts are first-class.** "File parsed", "parser backend stubbed",
  "adapter emitted route", "resolver missed import", and "diagnostic produced"
  are more important than page-view counts.
- **Privacy is a schema feature.** Each field is classified as public,
  operational, sensitive, or prohibited. Prohibited data should never enter the
  database.
- **Local dev keeps working.** Production uses Postgres + object storage; local
  can use SQLite or a local Postgres container behind the same repository API.

## Recommended architecture

Use **Cloud SQL Postgres** for queryable relational data and **GCS** for large
artifacts.

```
Cloud Run
  server.js
    |
    | structured event writes
    v
Cloud SQL Postgres
  sessions
  repo_submissions
  analysis_runs
  file_outcomes
  compiler_diagnostics
  adapter_outcomes
  user_events
  feedback_events
    |
    | optional large blobs
    v
GCS
  ir-snapshots/
  corpus-runs/
  redacted-debug-bundles/
```

Why not Firestore for this layer: it is fine for `.ryngo/` annotation
persistence, but this use case needs joins, aggregates, trends, constraints,
and ad-hoc quality queries like "show files where Python parser emitted zero
defs but imports > 10" or "adapter routes dropped after deploy X." Postgres is
the better analytical foundation.

BigQuery can be added later by exporting events from Postgres or Cloud Logging.
Do not start there; it slows down product iteration.

## Data model

### `sessions`

One browser / API client session. Anonymous until auth exists.

| Field | Purpose |
|---|---|
| `id` | UUID |
| `created_at`, `last_seen_at` | Session lifecycle |
| `client_kind` | `web`, `mcp`, `api`, `corpus`, `internal` |
| `ip_hash` | Salted hash, not raw IP |
| `user_agent_hash` | Salted hash; full UA stays in logs only if needed |
| `auth_subject` | Nullable future user/org id |

### `repo_submissions`

One attempt to analyze a repo URL.

| Field | Purpose |
|---|---|
| `id` | UUID |
| `session_id` | Nullable FK |
| `submitted_at` | Timestamp |
| `repo_host` | `github.com` for now |
| `repo_owner`, `repo_name` | Public repo coordinates |
| `repo_visibility` | `public`, `private`, `unknown` |
| `ref` | Branch/tag/SHA as submitted |
| `source` | `web_form`, `pr_compare`, `mcp`, `corpus`, `api` |
| `accepted` | URL passed validation / rate checks |
| `reject_reason` | Invalid URL, rate-limited, blocked, too large |

### `analysis_runs`

One compiler execution against a repo/ref.

| Field | Purpose |
|---|---|
| `id` | UUID |
| `submission_id` | FK |
| `started_at`, `finished_at` | Runtime |
| `status` | `ok`, `error`, `timeout`, `rate_limited`, `cancelled` |
| `commit_sha` | Resolved commit when available |
| `duration_ms` | End-to-end |
| `clone_ms`, `walk_ms`, `parse_ms`, `resolve_ms`, `adapter_ms` | Stage timing |
| `file_count`, `analyzed_file_count`, `truncated` | Top-level size |
| `node_count`, `edge_count` | Graph size |
| `diagnostic_count`, `error_message` | Health |
| `ir_snapshot_uri` | Optional GCS object for sampled/debug runs |
| `app_version`, `git_sha` | Ryngo version that produced it |

### `file_outcomes`

One row per walked file per analysis run. This is the core compiler-quality
table.

| Field | Purpose |
|---|---|
| `id` | UUID |
| `analysis_run_id` | FK |
| `path_hash` | Stable hash of repo-relative path |
| `path_display` | Repo-relative path for public repos only; hash-only for private |
| `ext`, `lang` | File type |
| `size_bytes`, `line_count` | Shape |
| `analyzable` | Whether Ryngo attempted parsing |
| `parser_backend` | `regex`, `tree-sitter`, `stub`, `error` |
| `parse_status` | `ok`, `skipped_large`, `unsupported`, `error` |
| `defs_count`, `classes_count`, `imports_count`, `calls_count` | Extracted facts |
| `edges_out_count`, `edges_in_count` | Resolved graph connectivity |
| `diagnostic_count` | File-local issues |
| `quality_flags` | JSON array: `no_defs`, `unresolved_imports`, `stub_backend`, etc. |

### `compiler_diagnostics`

Structured diagnostic facts, not free-form logs.

| Field | Purpose |
|---|---|
| `id` | UUID |
| `analysis_run_id` | FK |
| `file_outcome_id` | Nullable FK |
| `stage` | `clone`, `walk`, `parse`, `resolve`, `adapter`, `render` |
| `severity` | `info`, `warning`, `error` |
| `code` | Stable machine-readable code |
| `message_template` | No raw code or secrets |
| `details` | JSON metadata, scrubbed |

### `adapter_outcomes`

Per adapter / framework coverage.

| Field | Purpose |
|---|---|
| `id` | UUID |
| `analysis_run_id` | FK |
| `adapter` | `express`, `fastapi`, `nextjs`, `prisma`, `env`, etc. |
| `detected` | Adapter ran |
| `evidence_count` | Detection evidence count |
| `nodes_emitted`, `edges_emitted`, `effects_emitted` | Output |
| `diagnostic_count` | Adapter-local issues |
| `duration_ms` | Adapter timing |

### `user_events`

Product interaction stream.

| Field | Purpose |
|---|---|
| `id` | UUID |
| `session_id` | FK |
| `analysis_run_id` | Nullable FK |
| `created_at` | Timestamp |
| `event_name` | `repo_submit`, `node_focus`, `diff_run`, `annotation_create`, etc. |
| `event_props` | JSON, schema-checked per event |

Initial events:

- `repo_submit`
- `analysis_complete`
- `analysis_error`
- `diff_submit`
- `node_focus`
- `source_open`
- `annotation_create`
- `intent_create`
- `intent_verify`
- `cart_export`
- `mcp_tool_call`

### `feedback_events`

Human or automated labels about compiler quality.

| Field | Purpose |
|---|---|
| `id` | UUID |
| `analysis_run_id` | FK |
| `file_outcome_id` | Nullable FK |
| `node_id_hash` | Nullable |
| `feedback_kind` | `good_graph`, `bad_graph`, `missing_node`, `bad_edge`, `wrong_route`, `wrong_type` |
| `source` | `user`, `corpus_expectation`, `internal_review` |
| `notes` | Optional user note, length-limited and scrubbed |
| `created_at` | Timestamp |

This is how production usage becomes compiler work: a PM saying "this graph
missed my routes" should land in the same quality loop as a corpus regression.

## Privacy and retention

Default retention:

| Data | Retention |
|---|---|
| Sessions and user events | 90 days |
| Repo submissions and analysis summaries | 1 year |
| File outcomes for public repos | 1 year |
| File outcomes for private repos | 30 days, hash-only paths |
| Diagnostics | 1 year if scrubbed |
| IR snapshots | 7 days unless explicitly pinned for debugging |
| Redacted debug bundles | 7 days |

Never store:

- Raw source by default.
- `.env` values or secrets.
- Full private repo paths unless user has opted in.
- GitHub tokens.
- Raw IP addresses.

Explicit debug mode can store a redacted IR snapshot or source excerpt only
when an authenticated user opts in for that run.

## Compiler-quality scoring

Every `file_outcome` gets flags and a derived score. Start simple:

| Signal | Meaning |
|---|---|
| `stub_backend` | Language recognized but parser unavailable |
| `parse_error` | Parser threw |
| `zero_defs_large_file` | Analyzable file had enough lines but no defs |
| `many_imports_no_edges` | Imports extracted but not resolved |
| `many_calls_no_targets` | Calls extracted but unresolved |
| `adapter_detected_no_output` | Framework detected but no nodes emitted |
| `route_without_handler` | HTTP route emitted without handler edge |
| `env_heavy` | Env reads found; useful for config graph |

The dashboard for us, not end users, should sort by:

1. Most common quality flags.
2. Repos with highest diagnostic rate.
3. Languages with highest stub / parse-error rate.
4. Adapters with high detection but low emission.
5. Files where user feedback says the graph was wrong.

## Implementation phases

### Phase 9.1 — Event schema and local sink

- Add `mvp/lib/events.js` with `recordEvent(name, props, ctx)`.
- Validate event names and required props.
- Local mode writes JSONL to `mvp/.ryngo/events/YYYY-MM-DD.jsonl`.
- No database dependency yet.
- Wire only server-side events: submit, complete, error, diff, MCP tool call.

### Local container setup

Local development uses `mvp/compose.yml`:

```bash
cd mvp
npm run db:up       # starts postgres:16-alpine with a named volume
npm run db:down     # stops containers, keeps data
npm run db:reset    # stops containers and deletes the database volume
```

Defaults live in `mvp/.env.example`, but the compose file works without a
local `.env`. The app will use this URL once database writes are wired:

```bash
postgres://ryngo:ryngo_dev_password@localhost:55432/ryngo
```

The named volume is `ryngo-postgres-data`. This mirrors production closely
enough to keep migrations and instrumentation honest, while still letting a
developer reset the warehouse with one command.

### Phase 9.2 — Postgres schema

- Add migrations under `mvp/db/migrations/`.
- Add `DATABASE_URL` support.
- Use the local Docker Compose Postgres service in `mvp/compose.yml`.
- Add tables listed above.
- Keep JSONL fallback when DB is unavailable in dev.

### Phase 9.3 — Analysis run instrumentation

- Wrap `analyzeRepo` stages with timers.
- Emit `analysis_runs`, `file_outcomes`, `compiler_diagnostics`,
  `adapter_outcomes`.
- Add stable diagnostic codes where messages are currently free text.
- Ensure corpus runs write with `source = corpus`.

### Phase 9.4 — Frontend interaction events

- Add `POST /api/events`.
- Add minimal client event helper.
- Track node focus, source open, annotations, intents, cart export.
- Keep event payloads small and schema-checked.

### Phase 9.5 — Quality dashboard

- Internal-only route or script:
  - `npm run quality:report`
  - top weak languages
  - top diagnostic codes
  - worst files by quality flags
  - adapter coverage trends
- This becomes the compiler roadmap input.

### Phase 9.6 — Feedback loop

- Add UI affordance: "Graph is wrong" on focused node / file.
- Store `feedback_events`.
- Connect feedback to corpus expectations when possible.
- Add regression tests for repeated high-value misses.

### Phase 9.7 — Production retention and exports

- Scheduled cleanup job.
- GCS lifecycle rules for IR snapshots / debug bundles.
- Admin export script for CSV/JSON analysis.
- Optional BigQuery export once volume justifies it.

## Hosting plan changes

Phase 7 should still ship with simple GCS `.ryngo/` persistence if we need a
demo quickly. The database can land independently:

- **Before public beta:** Phase 9.1 and 9.3 at minimum.
- **Before real growth:** Phase 9.2, 9.4, and retention.
- **Before private repos:** privacy mode, hash-only paths, and explicit debug
  opt-in must be complete.

## Open questions

1. Do we want Cloud SQL Postgres from day one, or JSONL first and Postgres
   before public beta?
2. Are private repos in scope for the first hosted version?
3. Should users be able to opt out of usage collection entirely?
4. Do we store public repo paths in clear text, or hash all paths uniformly?
5. What internal admin surface do we want first: SQL scripts, a static report,
   or a password-protected dashboard?
