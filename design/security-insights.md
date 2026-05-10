# Security Insights from the IR

> Status: Design spec, v1
> Owner: codegraph core
> Scope: Architectural security findings that fall out of the typed IR for free, without authoring rules. Strictly a complement to real security tools — not a replacement.

## 0. Why this exists

codegraph's IR already carries everything a primitive taint-tracker needs:

- Every effect-bearing call is a categorized edge with a known direction (`source` or `sink` sub-class).
- Every value-passing edge (`type-flow`) carries a typed payload.
- HTTP entry points, database reads/writes, filesystem and exec sinks, outbound network, message brokers — each is a first-class edge category, not a regex match.
- Adapters already classify "this is a sink" / "this is a source"; we don't have to recover that intent from raw AST.

Given that, a small set of **graph reachability queries over the IR** surfaces a useful, low-noise subset of the patterns Semgrep and CodeQL detect — for free, with zero rule authoring, and immediately on PR diff.

This document specifies which patterns we surface, the IR-level rule for each, the false-positive rate we expect, what the PR comment looks like, and — critically — the long list of things this is **not**.

We are not building a SAST tool. We are surfacing **architecturally-suspicious shapes** in the graph. A finding here is "a reviewer should look at this," not "this is a vulnerability." We are deliberately modest about coverage.

---

## 1. Mental model: source → typed edges → sink

Every finding in this document is a reachability question of the form:

> Is there a path in the IR from a node tagged `source: X` to a node tagged `sink: Y`, where every edge on the path is one of `{type-flow, call}`, and (optionally) the path crosses zero edges marked `requires-auth`?

The atoms are:

- **Source nodes**: `source:http-route:*`, `source:message-consume:*`, `source:db-read:*`, `source:env-read:*`, `source:fs-read:*`, plus user-annotated sources.
- **Sink nodes**: `sink:db-write:*`, `sink:fs-write:*`, `sink:exec:*`, `sink:network:*` (outbound HTTP), `sink:message-publish:*`, plus structured logging sinks (`sink:log:*`) emitted by the logging adapter.
- **Path edges**: `type-flow` and `call` — the ones that actually move values.
- **Boundary edges**: `http-route` edges carry an `auth` annotation (`required` / `optional` / `none` / `unknown`) supplied by the framework adapter (e.g. Express middleware chain inspection) or by user annotation.

A finding is a `(source, sink, path, label, severity)` tuple where:

- `path` is the concrete sequence of nodes/edges, displayed in the UI as a highlighted subgraph and in the PR comment as a numbered list.
- `label` names the pattern (`http-input-to-sql`, `http-input-to-exec`, etc.).
- `severity` is derived from the pattern, the auth boundary, and the edge type-confidence on the path (any `unknown`-typed edge in the path raises severity).

Under the hood this is the same query engine that powers the existing edge filter ("show edges carrying `User`") plus a small reachability driver. There is no separate analysis pass.

---

## 2. Built-in source-to-sink patterns

Each pattern below specifies (a) the source node category, (b) the sink node category, (c) the IR-level rule, (d) examples of real code that triggers, (e) honest false-positive rate, (f) severity baseline.

The "FP rate" column is the rate we *expect* on a typical TypeScript/Python web service after dogfooding on ~10 OSS repos. It is **not** measured against a benchmark suite (we don't have one); it is an honest-best-guess that we will recalibrate as users report.

### 2.1 HTTP input → SQL query — potential SQL injection

| Field | Value |
| --- | --- |
| Source | any node with an inbound `http-route` edge whose `request` type carries fields read by user code |
| Sink | any `db-write` or `db-read` edge whose adapter classification is `raw-sql` (not `parameterized`) |
| Path | `type-flow` edges from request body / query / params / headers to the raw-SQL sink, optionally through `call` |
| Pattern label | `http-input-to-raw-sql` |
| Severity baseline | High |
| Expected FP rate | **~30–50%**. We see the value reach a raw-SQL site; we do *not* know if the user sanitized it via `mysql.escape`, a `sql-template-strings` tag, or a homegrown allowlist. We err on flagging. |

**IR rule (pseudocode):**

```
findings.sqli = paths(
  from:  nodes where any inbound edge.category == "http-route",
  to:    nodes where any outbound edge.category in {"db-read","db-write"}
                  and edge.classification == "raw-sql",
  via:   edge.category in {"type-flow","call"},
  carry: type touches request.body | request.query | request.params | request.headers,
)
```

**What "raw-sql" means**: the database adapter inspects the call site. `prisma.user.findMany(...)`, `knex(...).where(...)`, `db.query(SQL\`SELECT ...\`)` (tagged template), `pg.query("SELECT $1", [x])` are all `parameterized`. `db.query("SELECT * FROM u WHERE id=" + x)` is `raw-sql`. Adapter heuristic: if the SQL string is built via `+` or template literal interpolation *and* one of the interpolands is the same edge type as a tracked `type-flow`, classify as `raw-sql`. If the call uses a template-tag function from a known safe library, it's `parameterized`. If the adapter cannot tell, classification is `unknown` and we still flag, but at lower severity.

**Why this is a free win**: codegraph already needed `db-read` / `db-write` edges and the `raw-sql`-vs-`parameterized` classification to render the database panel of the canvas. The reachability query is the cheap part.

**Why we'll be wrong sometimes**: we don't track sanitization. A path through `escape()` looks identical to a path through identity. A user-defined wrapper that internally does parameterization is invisible to us until they annotate it (see §4).

### 2.2 HTTP input → filesystem path — potential path traversal

| Field | Value |
| --- | --- |
| Source | inbound `http-route` |
| Sink | `fs-read` or `fs-write` whose path argument is a `type-flow` from the source |
| Pattern label | `http-input-to-fs-path` |
| Severity baseline | High |
| Expected FP rate | **~40%**. Many codebases compose a safe path via `path.join(rootDir, sanitize(input))`; we see only that the input reaches the call. |

**IR rule:** as §2.1 with the sink set restricted to `fs-*`, and the *path argument* of the call must be on the type-flow line (we have to track which argument index the value flows into; this comes from the existing call-site type info).

**Tightening**: we lower severity to medium when an intermediate node on the path is a function whose name matches `^(sanitize|normalize|safe|resolve|validate)Path$`. This is a heuristic. We document it. We don't pretend it's a security guarantee.

### 2.3 HTTP input → exec/spawn — potential RCE

| Field | Value |
| --- | --- |
| Source | inbound `http-route` |
| Sink | `exec` edge |
| Pattern label | `http-input-to-exec` |
| Severity baseline | Critical |
| Expected FP rate | **~10%**. Genuinely rare in modern code. When it happens, it's almost always worth a look. |

**IR rule:** as §2.1 with sink set restricted to `exec`. We do not bother to distinguish `argv[0]` (the binary) from later `argv` entries; an attacker-controlled argument is bad enough on its own.

**What we cannot tell**: whether the binary is a hardened, escape-aware tool (`git`, with a strict allowlist) or `sh`. The exec adapter does record the command name when it's a string literal, and we display it; the reviewer makes the call.

### 2.4 HTTP input → outbound HTTP — potential SSRF

| Field | Value |
| --- | --- |
| Source | inbound `http-route` |
| Sink | `network` edge whose `request.url` argument is a `type-flow` from the source |
| Pattern label | `http-input-to-outbound-url` |
| Severity baseline | High |
| Expected FP rate | **~50%**. URL passthrough is common (proxying, webhooks, OAuth redirects). Most aren't SSRF. |

**IR rule:** as §2.1, sink is `network`, and the URL argument of the outbound call must be on the type-flow line. Adapters for `fetch` / `axios` / `requests` know which argument is the URL.

**Tightening**: if the source is a route handler whose route string contains a literal segment naming the upstream (`/proxy/github/*`, `/webhook/stripe`), and the URL argument is built by string-concatenation that begins with a literal hostname matching a small allowlist (we extract and display it), severity drops to low. We do *not* try to prove SSRF safety; we only de-rank obvious proxy patterns.

### 2.5 HTTP input → log — potential log injection / PII leak

| Field | Value |
| --- | --- |
| Source | inbound `http-route` |
| Sink | logging adapter sink (`sink:log:*`) |
| Pattern label | `http-input-to-log` |
| Severity baseline | Low (alone), elevates if the type carries `Pii` / `Secret` (see §5) |
| Expected FP rate | **~70%** for log-injection alone. Most logs of user input are intentional. |

**IR rule:** as §2.1, sink is the log sink. We split this into two sub-findings:

- `http-input-to-log` (low) — informational, off by default.
- `pii-to-log` / `secret-to-log` (high / critical) — see §5. These remain on by default.

**Why log-injection alone is low**: the actual exploit (newline-injecting fake log lines, ANSI sequence smuggling) is real but rarely material. The PII / secret variant is what matters in practice.

### 2.6 DB read → HTTP response — potential IDOR

| Field | Value |
| --- | --- |
| Source | `db-read` edge whose row type contains a field marked as a tenant/owner key |
| Sink | the response of an `http-route` |
| Pattern label | `db-read-to-response-no-auth` |
| Severity baseline | Medium |
| Expected FP rate | **High without annotations** — ~80%. With type annotations (see §5), drops to ~30%. |

**Why this needs annotations.** Nothing in the IR tells us "this row belongs to a user." The `User` row type and the `Order` row type look the same to us — both are objects with fields. To detect IDOR we need a hint that *some* field is the access-control key. Two ways to provide it:

1. **Type annotation** in user code: `userId: string & Tenant` (TypeScript branded type), or a `# tenant-key` Python comment, or a JSDoc `@tenant` tag on the field.
2. **Adapter rule**: e.g. the Prisma adapter can be told "rows of model `Order` are tenant-keyed by `userId`."

When that annotation exists, we then check: does the route that returns this row carry an `auth.userId == row.userId` check? We *do not* try to prove this in general. We look for a much weaker pattern: is there *any* `type-flow` edge from the `auth` context (the request's authenticated principal, supplied by the auth adapter) into the same query that produced the row? If not, we flag.

This is genuinely heuristic. We mark these findings explicitly with `low-confidence` and put them under a separate header in the PR comment so reviewers don't conflate them with the higher-confidence patterns.

### 2.7 Summary table

| Pattern | Source | Sink | Severity | FP rate | On by default |
| --- | --- | --- | --- | --- | --- |
| `http-input-to-raw-sql` | http-route | db-{read,write} raw-sql | high | 30–50% | yes |
| `http-input-to-fs-path` | http-route | fs-{read,write} | high | ~40% | yes |
| `http-input-to-exec` | http-route | exec | critical | ~10% | yes |
| `http-input-to-outbound-url` | http-route | network | high | ~50% | yes |
| `http-input-to-log` | http-route | log | low | ~70% | no |
| `pii-to-log` | type marked `Pii` | log | high | ~20% | yes |
| `secret-to-log` | type marked `Secret` | log,network,exec | critical | ~10% | yes |
| `db-read-to-response-no-auth` | db-read with tenant-key | http-route response | medium (low-confidence) | depends | yes (with banner) |

These are the only built-in patterns at v1. We will add more once we have user signal on which of these are pulling weight.

---

## 3. Auth boundary tracking

A modest but high-signal feature: the user marks routes as "this requires auth," and codegraph flags any path from a non-authenticated route to a sensitive sink.

### 3.1 How a route gets marked

Three sources, in priority order:

1. **Adapter inference.** The Express adapter inspects the middleware chain on each route. If `requireAuth`, `passport.authenticate`, `verifyJwt` (or any callable named `^(auth|require|verify|jwt)` per a small allowlist) appears in the chain, the `http-route` edge gets `auth=required`. If the chain is empty, `auth=none`. If it's some other middleware whose role we don't know, `auth=unknown`. The same logic applies to FastAPI dependencies, NestJS guards, Rails `before_action`, etc.
2. **User annotation in code.** A JSDoc / docstring tag the adapter recognizes:
   ```ts
   /** @codegraph-auth required */
   app.get("/admin/users", listUsers);
   ```
   Overrides adapter inference.
3. **Workspace config.** `codegraph.config.ts` can declare:
   ```ts
   auth: {
     publicRoutes: ["/health", "/login", "/webhook/*"],
     defaultRequired: true,
   }
   ```
   Routes not matching `publicRoutes` default to `auth=required`.

The `auth` value lives on the `http-route` edge alongside the type fields. It's already part of the IR. No new graph plumbing is needed.

### 3.2 The flagged pattern

```
findings.unauthSink = paths(
  from:  http-route nodes where edge.auth in {"none", "unknown"},
  to:    nodes where any outbound edge.category in {"db-write", "exec", "fs-write", "message-publish"},
  via:   edge.category in {"type-flow", "call"},
)
```

Severity: **high** when `auth=none` and the sink is `db-write` or `exec`; **medium** when `auth=unknown`; **low** if the only sink reachable is a read or a benign write (logging).

We display the auth boundary visually on the canvas: routes are wrapped in a halo whose color encodes auth state (green = required, yellow = unknown, red = none). A finding is just "this red halo has a path into an effects-warm sink."

### 3.3 What this catches well, and what it doesn't

**Catches:**

- New routes added in a PR with no auth middleware that write to the database. This is the single most common accidental-public-endpoint bug in web apps. We catch it cheaply.
- `auth=unknown` routes near sensitive sinks — i.e. somebody added a custom middleware whose role we can't infer. The message isn't "this is broken" but "we don't understand this middleware; please confirm it gates auth."

**Doesn't catch:**

- Authorization (the *who* check) — we only see authentication (the *whether* check). A route that does `requireAuth` but lets any user delete any other user's record is invisible to us. See §2.6 for our weak IDOR heuristic.
- Auth performed *inside* the handler body via custom code (`if (!req.user) throw ...`). The adapter does pattern-match a few of these idioms but it's brittle. We document this and prefer middleware-level auth.

---

## 4. Untyped edge highlighting

`unknown`-typed edges into security-sensitive code are a higher-signal risk indicator: when the analyzer can't tell what's flowing, we cannot reason about the path, and an attacker only needs one such edge.

### 4.1 The pattern

```
findings.unknownIntoSink = edges where
  edge.type == "unknown" and
  edge.target reaches (via type-flow / call) a node with an outbound effect-warm sink (db-write, fs-write, exec, network, message-publish).
```

We don't require a path *from* an HTTP source. The presence of an `unknown` edge near a sink is itself a smell, regardless of whether we proved it traces back to user input. (If the `unknown` blob really is fixed config data, the user can mark the type and the warning disappears.)

### 4.2 Why it's a smell, not a finding

Some `unknown` edges are perfectly fine — `JSON.parse` of a known config file, for example. We surface them in a separate section of the PR comment ("Untyped edges near sinks: 3") and on the canvas as bright dashed edges, not as a numbered finding. Reviewers can dismiss the section once.

Severity in the PR comment is **medium** if the `unknown` edge is *new in this PR* and lands within two hops of an effect-warm sink. Older `unknown` edges that pre-existed the PR don't surface unless the path to the sink is new.

### 4.3 Interaction with `any`

In TypeScript, `any` is treated identically to `unknown` for this purpose. In Python, `Any` from `typing` is. In Go, `interface{}` and `any` are. We do *not* treat narrow types like `string` as suspicious; only the truly opaque ones.

---

## 5. PII / secret type tracking

Same machinery as §2, with the source side of the path being not "an HTTP entry" but "a type tagged as PII or Secret."

### 5.1 How types get tagged

Three sources, in priority order:

1. **Explicit user annotation.**
   ```ts
   type Password = string & { readonly __brand: "codegraph.Secret" };
   type Email    = string & { readonly __brand: "codegraph.Pii" };
   ```
   The brand strings `codegraph.Secret` and `codegraph.Pii` are reserved. Any value whose canonical type contains a branded segment carries that tag through the IR.
2. **Adapter rule.** The auth adapter can declare `password` (in the body of a known auth route) is `Secret`. The Stripe adapter declares `card.number` is `Secret`. These are first-class adapter outputs.
3. **Name-pattern auto-detect (off by default).** Field names matching `(?i)password|api[_-]?key|secret|token|private[_-]?key|access[_-]?key` are auto-tagged `Secret`. Field names matching `(?i)email|phone|ssn|dob|first[_-]?name|last[_-]?name|address` are auto-tagged `Pii`. This is documented as **best-effort, expect false positives** (e.g. a field named `apiKeyDescription` is not a key). Users can opt in via `codegraph.config.ts` and add allowlist regexes.

A type tag is sticky: once a field is tagged, every `type-flow` edge whose payload contains that field is itself tagged. Wrapping in `Promise`, `Result`, arrays, etc. preserves the tag (canonical type tracking from §2 of `edge-typing.md`).

### 5.2 The flagged patterns

| Tag | Sink | Severity |
| --- | --- | --- |
| `Secret` | `log` | critical |
| `Secret` | `network` (outbound) | critical (unless the outbound is known-OK, see below) |
| `Secret` | `exec` (as argv) | critical |
| `Secret` | response of an `http-route` | critical |
| `Secret` | `fs-write` | high |
| `Pii` | `log` | high |
| `Pii` | response of `http-route` whose `auth=none` | high |
| `Pii` | `network` (outbound) to a host not in an allowlist | medium |

**Known-OK outbounds for secrets**: an adapter can mark a `network` sink as the legitimate destination for a secret. The Stripe adapter says `network → api.stripe.com` is the right place to send the Stripe API key; that's not a leak. Without such an annotation, every secret going out the wire is a finding.

### 5.3 Limitations we own up to

- **Only types we see.** If the secret is read from `process.env` and assigned to a variable typed `string`, we lose the tag at the assignment unless `process.env.STRIPE_KEY` is wrapped by an adapter helper (`getSecret("STRIPE_KEY")`). Documented.
- **No control flow.** A code path that *only* logs the secret in a debug branch is flagged the same as one that always logs. We don't reason about branches. This is a deliberate scope limit (see §7).
- **Auto-detect false positives.** `apiKeyDescription`, `passwordPolicy`, `emailTemplate` all match the name regexes and aren't actually sensitive. Users will need to allowlist; we ship a starter list of common false friends.

---

## 6. PR diff integration

Security findings flow through the same PR-comment pipeline described in `pr-comment.md`, with the additions below.

### 6.1 What's new in PR

A finding is "new in PR" iff:

- The exact `(source-node, sink-node, pattern-label)` triple was not present in the base-branch graph, **or**
- The path between them was not present in the base-branch graph (a new `type-flow` or `call` edge made the connection), **or**
- The source or sink was not present in the base-branch graph.

Findings that pre-existed and didn't change are *not* surfaced in PR comments. They live in the dashboard. Otherwise every PR would get the full backlog of the codebase's existing smells.

### 6.2 Severity escalation

The PR-comment severity rubric (`pr-comment.md` §4) gets these additions:

| Change | Score |
| --- | --- |
| New `http-input-to-raw-sql` finding | 80 |
| New `http-input-to-exec` finding | 95 |
| New `http-input-to-fs-path` finding | 75 |
| New `http-input-to-outbound-url` finding | 70 |
| New `secret-to-*` finding | 90 |
| New `pii-to-log` finding | 60 |
| New unauth route reaching db-write | 75 |
| New `unknown`-typed edge within 2 hops of an effect-warm sink | 50 |
| New `db-read-to-response-no-auth` (tenant-keyed) | 55 (low-confidence) |

These are component scores; the PR's overall score is `max(component_scores)` per the existing rubric. A single high-severity finding lights up the comment; low-confidence findings don't dominate.

### 6.3 Where it appears

Inside the PR comment, security findings get their own section between "High-severity changes" (§3 of the existing pr-comment spec) and "Architectural changes":

```
### Security insights

> codegraph surfaces architecturally-suspicious patterns. These are not
> verified vulnerabilities. Treat as "a reviewer should look here."
> [Calibrate sensitivity →](…)

- 🔴 **Potential SQL injection** — `POST /api/search` body field `q`
  reaches a raw-SQL call in `db.searchPosts`. New in this PR.
  [view path](…) · [dismiss](…)
- 🟠 **Unauth route writes DB** — new route `POST /api/feedback` has no
  auth middleware and reaches `db.feedback.insert`. Add `requireAuth` or
  mark the route public.
  [view path](…) · [mark public](…)
```

Each finding has:
- A one-line summary including the pattern label (humanized).
- The concrete entry point (route, function, etc.).
- The terminal sink.
- A "view path" link to the canvas with the path pre-highlighted.
- A "dismiss" link that records a workspace-level suppression keyed by `(pattern, source-symbol-id, sink-symbol-id)`. Suppressions are reviewable in the dashboard and require a justification string ("verified safe via x.y.z sanitizer").

If the section is empty (nothing new), it is **omitted entirely** — no "(none)" placeholder, consistent with the pr-comment spec's empty-section policy.

---

## 7. What this is NOT

This list is the most important section of this document. We are explicit about what we don't do, because over-promising security capability is worse than under-promising it.

### 7.1 We are not Semgrep / CodeQL / Snyk

| Capability | Semgrep / CodeQL | codegraph |
| --- | --- | --- |
| Custom security rules in a query language | Yes | No (built-ins only at v1) |
| Inter-procedural taint with control-flow sensitivity | Yes (CodeQL) | No |
| Sanitizer recognition / taint cleansing | Yes | No (path is a path; sanitizers are invisible) |
| CVE / dependency database (Snyk, Dependabot) | Yes | No |
| Secrets in repo history | Various tools | No |
| AST-precise pattern matching | Yes | No (we operate on the IR/graph) |
| Configurable per-rule severity / per-rule suppressions | Yes | Yes, but only the built-in patterns |
| Verifies a vulnerability | Best-effort | No, never |
| Output suitable for compliance attestation | Sometimes | No |

If you want certification, fuzzing, secret-scanning, dependency-CVE alerting, license audits, or detailed taint analysis — use a real security tool. We are not it.

### 7.2 No taint propagation through complex control flow

We do not:

- Track values through `Array.prototype.map`-then-`reduce` chains (we'd need to model the closure).
- Track values through arbitrary higher-order functions where the arrow flow we already have isn't enough.
- Track values through serialization/deserialization round-trips (e.g. into Redis and back out — the value type is `string` in between).
- Track values through `eval`, dynamic property access, reflective calls beyond what the host type system already resolves.

Where the IR has an `unknown` or dashed edge, we lose the trail. We surface the loss-of-trail as its own signal (§4) so users know.

### 7.3 No dynamic analysis

- We do not run the code.
- We do not require runtime traces (though we can consume an OpenTelemetry profile to fatten edges per `edge-typing.md` §3.3 — this is not a security feature).
- We do not perform fuzzing, symbolic execution, abstract interpretation beyond simple type tracking.
- A path that "looks reachable" in the graph but is dead at runtime (e.g. behind a feature flag that's always off) is still flagged.

### 7.4 No CVE database

- We do not know that `lodash@4.17.4` has a prototype-pollution CVE.
- We do not check `package.json` against advisory databases.
- We do not detect license issues.
- Users should run `npm audit`, `pip-audit`, Snyk, or GitHub Dependabot for that. We won't duplicate the function.

### 7.5 No sanitizer recognition

We do not have a list of known-safe wrappers (no equivalent of CodeQL's sanitizer specifications). A path through `escape(input)` to a raw-SQL sink is flagged identically to a path through `identity(input)`. Users can:

- Mark a function as a sanitizer in `codegraph.config.ts` (`sanitizers: ["src/lib/escape.ts:escape"]`). codegraph will then treat any path through that function as broken (the source taint stops at the sanitizer's input, not its output).
- This is an explicit, named opt-in. We will not auto-recognize sanitizers — too many false negatives.

### 7.6 No authorization analysis

We track *authentication* boundaries (§3). We do not track *authorization* (the access-control logic *inside* a handler). The IDOR pattern in §2.6 is an explicit, low-confidence heuristic, not a finding we stand behind.

### 7.7 No HTTP / cookie / CSRF / CORS / header-level analysis

- We don't check whether `Set-Cookie` has `HttpOnly`.
- We don't check CORS configuration.
- We don't detect missing CSRF tokens.
- These are AST-level facts about specific calls. Semgrep is the right tool.

### 7.8 We don't certify anything

- A clean codegraph report does not mean the code is safe.
- An empty `Security insights` section in a PR comment means *nothing about new security risk in that PR* — just that no patterns matched.
- We are a reviewer aid, not a gate. We deliberately do not provide a "block PR if any finding" mode in v1; experience with low-precision tools doing so is uniformly bad.

### 7.9 We are at IR/graph level; Semgrep is at AST level — these are complementary

This is worth stating positively. Semgrep is precise and narrow: a Semgrep rule matches a specific code shape (`db.query("..." + $X)`) and tells you exactly what's wrong. codegraph is broad and structural: we see "a value flowing from one architectural region to another" without caring about the exact syntactic shape at either end.

The trade:

- Semgrep finds known-bad shapes. codegraph finds unknown-shaped paths.
- Semgrep needs rules; codegraph needs adapters.
- Semgrep's findings are about a **single line**; codegraph's are about a **path of N lines** and may surface bugs whose individual lines look fine.
- Semgrep is a precise scalpel; codegraph is a coarse heat map. Use both.

We will likely build a Semgrep export at some point: "for each finding in the codegraph dashboard, emit a starter Semgrep rule the user can refine." That's a v2 idea, not v1.

---

## 8. Worked examples

Three concrete examples showing how a finding moves from code → IR pattern → PR comment. Each example uses a small TypeScript Express service.

### 8.1 Example A: SQLi-flavored finding

**The code.** A reviewer adds a search endpoint:

```ts
// src/routes/search.ts
import { db } from "../db";

app.get("/api/search", async (req, res) => {
  const q = req.query.q as string;
  const rows = await db.query(
    "SELECT id, title FROM posts WHERE title LIKE '%" + q + "%'"
  );
  res.json(rows);
});
```

**The IR after the PR.** New nodes/edges:

```
node  symbol:src/routes/search.ts:<anonymous>      (route handler)
edge  http-route → handler                         auth=none, request={ query: { q: string } }
edge  type-flow  q : string                        from req.query → local q
edge  call       db.query                          from handler → db.query
edge  db-write?  no — db.query is read; classified as db-read raw-sql
edge  type-flow  q : string                        flows into argv[0] of db.query (concatenation site)
node  sink:postgres:posts                          (existing)
```

(Note: this example is `db-read` raw-SQL, not `db-write`, but the SQLi pattern fires on either — see §2.1.)

**The reachability query.**

```
paths(
  from:  symbol:src/routes/search.ts:<anonymous>,
  to:    sink:postgres:posts (via db-read[classification=raw-sql]),
  via:   {type-flow, call},
  carry: type touches request.query,
)
→ 1 path:
  http-route → handler → [type-flow q:string] → call db.query → sink:postgres:posts
```

The `db.query` call site classifies as `raw-sql` because the SQL string is built by `+` and one operand is the `q` variable on the type-flow path.

**Severity computation.**

- Pattern `http-input-to-raw-sql`: baseline 80 (PR table §6.2).
- The route's auth is `none`: no extra escalation (auth doesn't affect this pattern's score, only the unauth-sink pattern).
- No sanitizer node on the path: no de-rank.
- All edges typed (no `unknown`): no escalation.
- Final component score: **80** → "high" → contributes to PR header severity.

**The PR comment fragment.**

```markdown
### Security insights

> codegraph surfaces architecturally-suspicious patterns. These are not
> verified vulnerabilities — treat as "a reviewer should look here."
> [Calibrate sensitivity →](…)

- 🔴 **Potential SQL injection** — `GET /api/search` query field `q`
  reaches a raw-SQL string in `db.query` at `src/routes/search.ts:6`.
  - Path: `req.query.q` → `q` → `db.query("SELECT ... '%" + q + "%'")`
  - Why flagged: query string is built via `+` concatenation with a
    user-controlled value; no parameterized binding detected on this
    path; no node on the path matches the configured sanitizers list.
  - [view path on canvas](…) · [mark as parameterized](…) ·
    [dismiss with justification](…)
```

The "mark as parameterized" link adds the call site to a workspace-level allowlist; the "dismiss" link records a justification on this `(source, sink, pattern)` tuple.

**The reviewer experience.** Either: (a) the reviewer agrees and asks the PR author to switch to `db.query("SELECT ... LIKE $1", ["%" + q + "%"])` — after which the next push re-runs the analysis, the call site reclassifies as `parameterized`, and the finding disappears from the comment automatically; or (b) the reviewer marks it dismissed with a justification (rare for a clean SQLi shape).

**Honesty check.** This was an obvious case. We picked a flagrant one for clarity. Real PRs will more often look like:

```ts
const q = sanitize(req.query.q as string);  // user-defined wrapper
const rows = await db.query("SELECT ... WHERE title LIKE '%" + q + "%'");
```

We will still flag this, because we don't know `sanitize` is a sanitizer. The user adds it to `sanitizers:` in the workspace config; the next analysis run drops the finding. This is the expected workflow, not a defect — we'd rather flag-and-let-user-suppress than miss.

### 8.2 Example B: unauth route writes DB

**The code.**

```ts
// src/routes/feedback.ts
app.post("/api/feedback", async (req, res) => {
  const { user, message } = req.body;
  await db.feedback.insert({ user, message, ts: Date.now() });
  res.status(204).end();
});
```

No middleware in the chain. Workspace config has `auth.defaultRequired: true` and `publicRoutes: ["/health", "/login", "/webhook/*"]`.

**IR after the PR.**

```
edge  http-route → handler                  auth=none  (defaulted; route not in publicRoutes)
edge  type-flow  { user, message } : ...    from req.body
edge  call       db.feedback.insert
edge  db-write   sink:postgres:feedback     payload={user, message, ts}
```

**The reachability query (§3.2).**

```
paths(
  from:  http-route nodes where edge.auth in {"none","unknown"},
  to:    nodes with outbound edge in {db-write, exec, fs-write, message-publish},
  via:   {type-flow, call},
)
→ 1 new path:
  POST /api/feedback (auth=none) → handler → call db.feedback.insert → sink:postgres:feedback
```

**Severity.** Pattern is `unauth-route-to-db-write`, baseline 75 (PR table §6.2).

**The PR comment fragment.**

```markdown
- 🟠 **Unauthenticated route writes to database** — new route
  `POST /api/feedback` reaches `db.feedback.insert`. No auth middleware
  detected; route is not in `publicRoutes`.
  - Path: `POST /api/feedback` → handler → `db.feedback.insert`
  - To resolve: add `requireAuth` middleware, mark the route public in
    `codegraph.config.ts`, or add `/** @codegraph-auth none */` above
    the handler.
  - [view path on canvas](…) · [mark as public](…) · [dismiss](…)
```

**Reviewer experience.** Three good outcomes: (a) author was wrong and adds the middleware; (b) the route really is public (e.g. anonymous feedback) and gets added to `publicRoutes`; (c) reviewer dismisses with justification.

This is the single highest-value finding in the document. The cost of adding it is essentially zero (auth state is already on the edge for the canvas), and the false-positive rate on "auth=none and writes the DB" is genuinely low for any team that has a default-auth posture.

### 8.3 Example C: secret leaks to log via `unknown` hop

**The code.** A diff that introduces an audit logger:

```ts
// src/audit.ts
import { logger } from "./logger";

export function audit(event: string, data: unknown) {
  logger.info({ event, data });
}

// src/routes/auth.ts (existing)
import { audit } from "../audit";
app.post("/login", async (req, res) => {
  const { email, password } = req.body;          // password is tagged Secret by auth adapter
  const ok = await checkPassword(email, password);
  audit("login", { email, password, ok });       // ← new in this PR
  if (!ok) return res.status(401).end();
  // …
});
```

The auth adapter declares the `password` field of `POST /login`'s body as type `Secret`. The `audit` function takes `data: unknown` — so the type-flow edge from `audit`'s `data` parameter into `logger.info` is **`unknown`-typed**.

**IR after the PR.**

```
edge  http-route → /login handler          request={body: {email: Pii, password: Secret, …}}
edge  type-flow  { email, password, ok }   from handler → audit  (carries Secret, Pii)
edge  call       audit
edge  type-flow  data : unknown            from audit param → logger.info  (UNKNOWN-typed)
edge  call       logger.info
edge  log        sink:log:default
```

The first type-flow into `audit` carries the canonical type `{ email: Pii, password: Secret, ok: boolean }` (sticky tag from the route's request type). The flow *out* of `audit` to `logger.info` is `unknown` because the function signature said `unknown`.

**The reachability check.** We do not lose the tag at the `unknown` boundary here, because we propagate the tag through the *source type* whenever a tagged value reaches a function whose argument is `unknown` and the function then forwards that value to a sink. (This is a deliberate, narrow exception to our usual "we don't infer through `unknown`" stance — for tagged types only, because losing PII/Secret at every `unknown` hop would gut the feature.)

This is documented in §5.3 as a limitation: we propagate the tag through *one* `unknown` hop, not arbitrarily many.

**The query and the result.**

```
findings.secretToLog → 1 path:
  POST /login.body.password (Secret) → audit.data (unknown, but tag preserved one hop)
                                     → logger.info → sink:log:default
findings.unknownIntoSink → 1 finding:
  edge `audit.data → logger.info` is `unknown`-typed and lands within 2
  hops of a sink. (Same edge.)
```

We deduplicate: when the same edge triggers both a Secret-leak finding and an `unknown`-near-sink finding, we report the Secret-leak (more specific) and silently drop the `unknown` finding.

**Severity.** `secret-to-log` → component score 90.

**The PR comment fragment.**

```markdown
- 🔴 **Secret reaches log sink** — `POST /login` body field `password`
  (tagged `Secret`) flows into `logger.info` via `audit()` at
  `src/routes/auth.ts:9`.
  - Path: `req.body.password` → `audit({…, password})` → `logger.info`
  - The intermediate function `audit(event, data: unknown)` accepts
    `unknown`; codegraph propagated the `Secret` tag through this single
    `unknown` hop. If `audit` is in fact a redactor, mark it as a
    sanitizer in `codegraph.config.ts → sanitizers`.
  - [view path on canvas](…) · [mark `audit` as sanitizer](…) ·
    [retag `password` as not-secret](…) · [dismiss](…)
```

**Reviewer experience.** The likely real fix: change `audit` to redact, then mark `audit` as a sanitizer in the config so codegraph knows the `unknown` hop is safe. After the next push, the finding disappears.

This example is also the cleanest demonstration of why `unknown`-typed edges near sinks (§4) matter: even without the Secret tag, the `audit.data → logger.info` edge would surface as a smell in §4's section, prompting a reviewer to look.

---

## 9. Configuration surface

`codegraph.config.ts` gets one new top-level key, `security`:

```ts
security: {
  enabled: true,
  patterns: {
    "http-input-to-raw-sql":      { enabled: true },
    "http-input-to-fs-path":      { enabled: true },
    "http-input-to-exec":         { enabled: true },
    "http-input-to-outbound-url": { enabled: true },
    "http-input-to-log":          { enabled: false }, // off by default
    "pii-to-log":                 { enabled: true },
    "secret-to-log":              { enabled: true },
    "secret-to-network":          { enabled: true },
    "db-read-to-response-no-auth":{ enabled: true, lowConfidence: true },
    "unauth-sink":                { enabled: true },
    "unknown-near-sink":          { enabled: true },
  },
  sanitizers: [
    "src/lib/escape.ts:escapeSql",
    "src/lib/redact.ts:redactSecret",
  ],
  piiNamePatterns: { enabled: false }, // off by default; opt in
  secretNamePatterns: { enabled: false },
  knownOkOutbounds: [
    { sink: "api.stripe.com",   forSecrets: ["STRIPE_KEY"] },
    { sink: "hooks.slack.com",  forSecrets: [] },
  ],
  suppressions: [
    // generated as users click "dismiss" in the PR comment;
    // human-editable.
    { pattern: "http-input-to-raw-sql",
      sourceSymbol: "src/routes/legacy.ts:listOldPosts",
      sinkSymbol:   "sink:postgres:posts",
      reason:       "Read-only raw SQL, value passed through legacyEscape; not migrating.",
      addedBy:      "alice@…",
      addedAt:      "2026-04-…",
    },
  ],
}
```

There is no `severity` override per pattern in v1; severities are baked into the rubric so they're consistent across teams. We may add overrides later if there's demand.

---

## 10. Performance

Reachability queries scale as `O(V + E)` per source set. For a typical web service (~5K nodes, ~15K edges), each pattern runs in well under 100ms. All built-in patterns run as part of the same incremental graph build (`incremental.md`); only the subgraph touched by the diff is re-checked.

We cache `(source-node, sink-node)` reachability per build and invalidate per the existing IR-incremental pipeline.

---

## 11. Out of scope explicitly listed (one more time)

Because we'd rather over-list:

- Container / Dockerfile / Kubernetes manifest scanning
- IaC (Terraform, CloudFormation) misconfigurations
- Cloud IAM analysis
- Secrets in env files / `.env` files / git history
- License compliance
- Cryptographic-primitive misuse (weak hashes, ECB mode, hardcoded IVs)
- Race conditions, TOCTOU, concurrency bugs
- Memory safety
- Deserialization gadgets in dynamic languages
- XSS in rendered HTML / SSR templates
- Open redirects (we'd surface the underlying outbound-URL flow but not classify it as "open redirect")
- Auth token rotation / expiry
- Rate limiting / abuse protection
- Supply chain / dependency confusion

If a user asks "does codegraph find X?" and X is on this list, the answer is no, and the docs should make that easy to find.

---

## 12. Roadmap (informative, not v1 commitment)

Things we might add once v1 is in users' hands:

- **Custom patterns**: a small DSL — really, a typed query over the IR — letting users write their own `(source, sink, via, carry)` rules. Likely shaped like the pseudocode in §2 but real syntax.
- **Sanitizer auto-recognition**: very narrow, e.g. recognizing the `mysql.escape` family by package + name. Always opt-in.
- **Semgrep export**: emit a starter Semgrep rule per finding.
- **SARIF output**: integrate with GitHub code scanning so findings appear inline on the diff, not just in the PR comment.
- **Diff-aware suppression decay**: suppressions that match no current finding for N days are auto-archived.

Each of these is its own design doc when its time comes.

---

## 13. Final framing

codegraph's security insights are a free side-effect of having a typed, categorized IR. They cost us very little to ship and cost users very little to enable. They will catch a small but useful set of architectural smells — the kind of "wait, when did that route get added?" findings that are easy for reviewers to miss in a 40-file PR but obvious once a path is highlighted on a graph.

They will not replace your security tools. We will repeat that fact in the docs, in the PR comment, in the dashboard banner, and in the marketing page. Every place a user might form a wrong impression of what this feature is, we correct it explicitly. The cost of a single user shipping a vulnerability because they thought codegraph had their back is much higher than the cost of being repetitive about scope.

Be modest. Surface signal. Let real tools do the verification.
