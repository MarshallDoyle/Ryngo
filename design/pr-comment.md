# codegraph PR Comment Format

This document specifies the markdown format codegraph posts as a sticky comment on every pull request, plus three fully rendered examples (small / medium / architectural) that can be pasted into a real PR for visual verification.

---

## 1. Goals

The PR comment is a reviewer's first encounter with codegraph on every PR. It must:

1. Be **scannable in 5 seconds** — header + summary + high-severity bullets fit "above the fold" before any reader has to scroll or expand a `<details>` block.
2. **Drill into specifics on click** — full per-node breakdown lives inside `<details>` so the default view stays short.
3. **Surface high-severity changes prominently** — new sinks (DB writes, network calls), new cross-service edges, new untyped/`unknown` edges into auth or payment paths, new dead code.
4. **Don't drown reviewers in low-severity changes** — renames, formatting-only edits, and intra-module reshuffles collapse into the breakdown section.
5. **Update in place** — the same comment is edited on every push (sticky). Identified by the leading `<!-- codegraph -->` HTML comment marker. Never post a second comment.

## 2. Length budget

- Soft cap: ~10 KB rendered markdown.
- Hard cap: 65 KB (GitHub's per-comment max minus headroom).
- Anything that would push past 10 KB is truncated with `… N more (view full diff →)` and the rest is moved to the hosted viewer.

## 3. Section order (all required)

| # | Section                  | Always shown | Notes                                                       |
| - | ------------------------ | ------------ | ----------------------------------------------------------- |
| 1 | Header                   | yes          | `<!-- codegraph -->` marker, branding, PR title/sha, viewer link |
| 2 | Summary stats            | yes          | Single 2-row table                                          |
| 3 | High-severity changes    | only if any  | Max 5 bullets. If none, skip the section entirely.          |
| 4 | Architectural changes    | only if any  | Services, modules, routes added/removed                     |
| 5 | Type changes on edges    | only if any  | Table of edge type drift                                    |
| 6 | Full breakdown           | yes          | `<details>` block, every node added/removed/changed         |
| 7 | Footer                   | yes          | Viewer / local-run / configure links                        |

Empty sections are omitted, not rendered as "(none)" — keeps small-PR comments tight.

## 4. Severity scoring

The header shows a single severity score 0–100 for at-a-glance triage.

| Score   | Label    | Trigger                                                                          |
| ------- | -------- | -------------------------------------------------------------------------------- |
| 0–9     | trivial  | Pure formatting, comments, or renames with no edge changes.                      |
| 10–29   | low      | Internal refactor; edges shift but no new sinks, no new cross-service edges.     |
| 30–59   | medium   | New sinks, new routes, or new cross-service edges within already-linked services.|
| 60–84   | high     | New cross-service edge to a service this PR has not touched before; new sink in auth/payment path. |
| 85–100  | critical | New `unknown`-typed edge into auth/payment; new public route with no auth edge.   |

Score is computed as `max(component_scores)` so one critical change isn't averaged away by a long tail of low-severity ones.

### Component score rubric

Each detected change contributes a component score; the overall PR score is the max.

| Change kind                                                                | Score |
| -------------------------------------------------------------------------- | ----- |
| Renamed symbol with no edge changes                                        | 0     |
| Added/removed pure function (no sinks reachable)                           | 5     |
| Added function that calls only same-module nodes                           | 10    |
| Added function that calls a same-service module across module boundaries   | 20    |
| Added DB read sink                                                         | 30    |
| Added DB write sink                                                        | 45    |
| Added network sink (outbound HTTP, queue publish)                          | 50    |
| Added route (any HTTP method, any prefix)                                  | 55    |
| Added route with auth-edge present                                         | 55    |
| Added route with no auth-edge                                              | 90    |
| New cross-service edge between already-linked services                     | 60    |
| New cross-service edge to a service with no prior inbound edges            | 75    |
| New `unknown`-typed edge into a function in `paths.critical`               | 85    |
| New `unknown`-typed edge into auth or payment path specifically            | 95    |
| New dead-code region (>= 1 reachable-from-entry node became unreachable)   | 40    |

Critical-path classification is governed by `.codegraph.yml`:

```yaml
paths:
  critical:
    - apps/api/src/auth/**
    - apps/api/src/payments/**
    - services/billing/**
```

## 5. Sticky update mechanism

The Action does the following on every push to a PR:

1. `gh api repos/:owner/:repo/issues/:pr/comments` — list comments.
2. Find the first comment whose body starts with `<!-- codegraph -->`.
3. If found → `PATCH` it. If not → `POST` a new one.
4. The marker is on its own line so it's invisible in the rendered comment but trivial to grep.

---

## 6. Format specification

Below is the canonical template. `{{...}}` are substitution points filled by the renderer. Sections 3, 4, 5 are conditionally emitted.

```markdown
<!-- codegraph -->
<sub><img src="https://codegraph.dev/badge.svg" height="14" alt="codegraph"> &nbsp;<b>codegraph</b> &middot; <a href="{{viewer_url}}">view full diff →</a></sub>

**{{pr_title}}** &middot; <code>{{base_sha_short}}…{{head_sha_short}}</code> &middot; severity <b>{{severity_score}}</b> ({{severity_label}})

| | nodes | edges | services touched |
|---|---|---|---|
| **change** | {{n_added}} added · {{n_removed}} removed · {{n_changed}} changed | {{e_added}} added · {{e_removed}} removed · {{e_changed}} changed | {{services_touched}} |

{{#if high_severity}}
### High-severity changes
{{#each high_severity_items max 5}}
- **{{kind}}** — {{description}} &nbsp;<sub>[{{location}}]({{viewer_link}})</sub>
{{/each}}
{{/if}}

{{#if architectural}}
### Architectural changes

| change | kind | name | scope |
|---|---|---|---|
{{#each arch_rows}}
| {{change}} | {{kind}} | `{{name}}` | {{scope}} |
{{/each}}
{{/if}}

{{#if type_changes}}
### Type changes on edges

| edge | before | after |
|---|---|---|
{{#each type_rows}}
| `{{edge}}` | `{{before}}` | `{{after}}` |
{{/each}}
{{/if}}

<details>
<summary>Full breakdown ({{total_changes}} changes)</summary>

#### Added
{{#each added_nodes}}
- `{{path}}::{{symbol}}` &nbsp;<sub>{{kind}}</sub>
{{/each}}

#### Removed
{{#each removed_nodes}}
- `{{path}}::{{symbol}}` &nbsp;<sub>{{kind}}</sub>
{{/each}}

#### Changed
{{#each changed_nodes}}
- `{{path}}::{{symbol}}` — {{summary}}
{{/each}}

</details>

<sub><a href="{{viewer_url}}">open in viewer</a> · <a href="https://codegraph.dev/run-locally">run locally</a> · <a href="https://codegraph.dev/config">configure</a></sub>
```

---

## 6a. Node and edge kind vocabulary

The breakdown lists tag every node with a `<sub>kind</sub>` label so reviewers can tell a route handler apart from a pure function at a glance. Kinds are deliberately small and stable:

| Kind            | Meaning                                                                |
| --------------- | ---------------------------------------------------------------------- |
| `function`      | Plain function with no IO sinks reachable in 1 hop                     |
| `route-handler` | Function bound to an HTTP route                                        |
| `entry`         | Process entry point (`main`, server bootstrap, top-level Lambda)       |
| `class`         | Class declaration; methods are separate `function` nodes               |
| `type`          | Type alias / interface — appears in breakdown only when on edges       |
| `db-read`       | Sink: reads from a database table                                      |
| `db-write`      | Sink: writes to a database table                                       |
| `network-sink`  | Sink: outbound HTTP, queue publish, RPC                                |
| `fs-sink`       | Sink: filesystem write                                                 |
| `env-source`    | Reads from process env (e.g. credentials)                              |
| `cron`          | Scheduled trigger (cron, queue consumer)                               |

Edge kinds in the type-change table follow this vocabulary:

| Edge kind   | Meaning                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| `calls`     | Direct function call within the same service                            |
| `rpc`       | Cross-service call (HTTP, gRPC, queue)                                  |
| `reads`     | Reads from a sink node (db, env)                                        |
| `writes`    | Writes to a sink node (db, queue, fs)                                   |
| `mounts`    | Route handler mounted under a router                                    |
| `auth-gate` | Edge that asserts authentication before downstream nodes are reachable  |

The auth-gate edge kind is what powers the "no auth-edge" critical bullet — codegraph computes whether every path from a public route to a sensitive sink crosses at least one `auth-gate` edge.

---

## 7. Rendering rules

- **Branding**: a 14px badge image + the word `codegraph`. No giant logos. Inside `<sub>` so it stays small.
- **Severity score** is bold inline in the title line, never a separate row — reviewers spot it in peripheral vision.
- **Tables** use compact column counts (3 or 4 cols max). GitHub renders wider tables but they wrap badly on mobile.
- **Code identifiers** use backticks. Path::symbol form keeps things searchable with `Cmd-F`.
- **Locations** in high-severity bullets are deep-links into the hosted viewer pre-loaded with that node selected.
- **No emoji in the canonical template** — they render inconsistently across themes and screen readers. (The brand badge SVG carries the visual identity.)
- **`<details>` is always closed by default** so the comment is short on first paint.
- **Footer links** are in `<sub>` to keep them visually de-emphasized.

---

## 8. Truncation strategy

When the rendered comment would exceed 10 KB:

1. Trim the **Full breakdown** section first — it's already inside `<details>`.
2. Replace truncated lists with `… {n} more — [view in viewer]({{viewer_url}})`.
3. Never truncate sections 1–3. The high-severity list is capped at 5 by design, so it's already bounded.
4. Type-change table caps at 20 rows; spillover is moved to the viewer.

---

## 9. Example A — Small PR (1 function added)

> Scenario: a contributor adds a pure utility function `formatTimestamp(ts)` in `packages/core/src/util/time.ts` and one new edge: the existing `logEvent` function now calls it. No sinks, no cross-service, no type drift.

### Raw markdown

```markdown
<!-- codegraph -->
<sub><img src="https://codegraph.dev/badge.svg" height="14" alt="codegraph"> &nbsp;<b>codegraph</b> &middot; <a href="https://viewer.codegraph.dev/r/acme/web/pr/482">view full diff →</a></sub>

**Add formatTimestamp helper for log events** &middot; <code>a3f9c01…b27e4d8</code> &middot; severity <b>4</b> (trivial)

| | nodes | edges | services touched |
|---|---|---|---|
| **change** | 1 added · 0 removed · 0 changed | 1 added · 0 removed · 0 changed | 1 (`web`) |

<details>
<summary>Full breakdown (2 changes)</summary>

#### Added
- `packages/core/src/util/time.ts::formatTimestamp` &nbsp;<sub>function</sub>

#### Changed
- `packages/core/src/log/logEvent.ts::logEvent` — now calls `formatTimestamp`

</details>

<sub><a href="https://viewer.codegraph.dev/r/acme/web/pr/482">open in viewer</a> · <a href="https://codegraph.dev/run-locally">run locally</a> · <a href="https://codegraph.dev/config">configure</a></sub>
```

### Rendered preview

---

<!-- codegraph -->
<sub><b>codegraph</b> &middot; <a href="https://viewer.codegraph.dev/r/acme/web/pr/482">view full diff →</a></sub>

**Add formatTimestamp helper for log events** &middot; <code>a3f9c01…b27e4d8</code> &middot; severity <b>4</b> (trivial)

| | nodes | edges | services touched |
|---|---|---|---|
| **change** | 1 added · 0 removed · 0 changed | 1 added · 0 removed · 0 changed | 1 (`web`) |

<details>
<summary>Full breakdown (2 changes)</summary>

#### Added
- `packages/core/src/util/time.ts::formatTimestamp` &nbsp;<sub>function</sub>

#### Changed
- `packages/core/src/log/logEvent.ts::logEvent` — now calls `formatTimestamp`

</details>

<sub><a href="https://viewer.codegraph.dev/r/acme/web/pr/482">open in viewer</a> · <a href="https://codegraph.dev/run-locally">run locally</a> · <a href="https://codegraph.dev/config">configure</a></sub>

---

### Why this works

- No high-severity section emitted — the PR doesn't introduce sinks or cross-service edges, so we don't fabricate one.
- No architectural section emitted — no services/modules/routes changed.
- No type-change section — no edge type drift.
- Total comment renders in ~600 bytes. A reviewer scans it in two seconds and moves on. The `<details>` is collapsed but available if they want the per-node view.

---

## 10. Example B — Medium PR (new HTTP route + DB write)

> Scenario: a backend dev adds `POST /api/v1/orders/:id/refund` which calls a new internal `processRefund` function which writes to the `refunds` table and calls the existing `notifyCustomer` function. Two new sinks (DB write, network call to email service), one new public route, and a new `unknown`-typed edge from the route handler into `processRefund` because the request body schema isn't fully typed.

### Raw markdown

```markdown
<!-- codegraph -->
<sub><img src="https://codegraph.dev/badge.svg" height="14" alt="codegraph"> &nbsp;<b>codegraph</b> &middot; <a href="https://viewer.codegraph.dev/r/acme/api/pr/731">view full diff →</a></sub>

**Add refund endpoint to orders API** &middot; <code>71b03ea…fd2189c</code> &middot; severity <b>62</b> (high)

| | nodes | edges | services touched |
|---|---|---|---|
| **change** | 4 added · 0 removed · 1 changed | 7 added · 0 removed · 0 changed | 2 (`api`, `email`) |

### High-severity changes

- **new public route** — `POST /api/v1/orders/:id/refund` exposed, auth edge present (`requireAuth` middleware) &nbsp;<sub>[orders.routes.ts](https://viewer.codegraph.dev/r/acme/api/pr/731#node=routes:POST_/api/v1/orders/:id/refund)</sub>
- **new DB sink** — `processRefund` writes to table `refunds` &nbsp;<sub>[refunds.repo.ts](https://viewer.codegraph.dev/r/acme/api/pr/731#node=db:refunds)</sub>
- **new cross-service edge** — `api` → `email` (new edge between previously linked services) &nbsp;<sub>[notifyCustomer](https://viewer.codegraph.dev/r/acme/api/pr/731#edge=api:processRefund-email:notifyCustomer)</sub>
- **untyped edge** — `routes::refund` → `processRefund` carries `unknown` (request body not validated against a schema) &nbsp;<sub>[orders.routes.ts:42](https://viewer.codegraph.dev/r/acme/api/pr/731#node=routes:refund)</sub>

### Architectural changes

| change | kind  | name                                    | scope |
|--------|-------|-----------------------------------------|-------|
| added  | route | `POST /api/v1/orders/:id/refund`        | api   |
| added  | table | `refunds`                               | api   |

### Type changes on edges

| edge                                  | before | after     |
|---------------------------------------|--------|-----------|
| `routes::refund → processRefund`      | —      | `unknown` |
| `processRefund → notifyCustomer`      | —      | `{ orderId: string; amount: number }` |

<details>
<summary>Full breakdown (5 changes)</summary>

#### Added
- `apps/api/src/routes/orders.routes.ts::refundHandler` &nbsp;<sub>route-handler</sub>
- `apps/api/src/services/refund.service.ts::processRefund` &nbsp;<sub>function</sub>
- `apps/api/src/repos/refunds.repo.ts::insertRefund` &nbsp;<sub>db-write</sub>
- `apps/api/src/schemas/refund.schema.ts::RefundRequest` &nbsp;<sub>type</sub>

#### Changed
- `apps/api/src/routes/orders.routes.ts::orderRouter` — registers new `/refund` subroute

</details>

<sub><a href="https://viewer.codegraph.dev/r/acme/api/pr/731">open in viewer</a> · <a href="https://codegraph.dev/run-locally">run locally</a> · <a href="https://codegraph.dev/config">configure</a></sub>
```

### Rendered preview

---

<!-- codegraph -->
<sub><b>codegraph</b> &middot; <a href="https://viewer.codegraph.dev/r/acme/api/pr/731">view full diff →</a></sub>

**Add refund endpoint to orders API** &middot; <code>71b03ea…fd2189c</code> &middot; severity <b>62</b> (high)

| | nodes | edges | services touched |
|---|---|---|---|
| **change** | 4 added · 0 removed · 1 changed | 7 added · 0 removed · 0 changed | 2 (`api`, `email`) |

### High-severity changes

- **new public route** — `POST /api/v1/orders/:id/refund` exposed, auth edge present (`requireAuth` middleware) &nbsp;<sub>[orders.routes.ts](https://viewer.codegraph.dev/r/acme/api/pr/731#node=routes:POST_/api/v1/orders/:id/refund)</sub>
- **new DB sink** — `processRefund` writes to table `refunds` &nbsp;<sub>[refunds.repo.ts](https://viewer.codegraph.dev/r/acme/api/pr/731#node=db:refunds)</sub>
- **new cross-service edge** — `api` → `email` (new edge between previously linked services) &nbsp;<sub>[notifyCustomer](https://viewer.codegraph.dev/r/acme/api/pr/731#edge=api:processRefund-email:notifyCustomer)</sub>
- **untyped edge** — `routes::refund` → `processRefund` carries `unknown` (request body not validated against a schema) &nbsp;<sub>[orders.routes.ts:42](https://viewer.codegraph.dev/r/acme/api/pr/731#node=routes:refund)</sub>

### Architectural changes

| change | kind  | name                                    | scope |
|--------|-------|-----------------------------------------|-------|
| added  | route | `POST /api/v1/orders/:id/refund`        | api   |
| added  | table | `refunds`                               | api   |

### Type changes on edges

| edge                                  | before | after     |
|---------------------------------------|--------|-----------|
| `routes::refund → processRefund`      | —      | `unknown` |
| `processRefund → notifyCustomer`      | —      | `{ orderId: string; amount: number }` |

<details>
<summary>Full breakdown (5 changes)</summary>

#### Added
- `apps/api/src/routes/orders.routes.ts::refundHandler` &nbsp;<sub>route-handler</sub>
- `apps/api/src/services/refund.service.ts::processRefund` &nbsp;<sub>function</sub>
- `apps/api/src/repos/refunds.repo.ts::insertRefund` &nbsp;<sub>db-write</sub>
- `apps/api/src/schemas/refund.schema.ts::RefundRequest` &nbsp;<sub>type</sub>

#### Changed
- `apps/api/src/routes/orders.routes.ts::orderRouter` — registers new `/refund` subroute

</details>

<sub><a href="https://viewer.codegraph.dev/r/acme/api/pr/731">open in viewer</a> · <a href="https://codegraph.dev/run-locally">run locally</a> · <a href="https://codegraph.dev/config">configure</a></sub>

---

### Why this works

- The `unknown`-typed edge is bullet-pointed prominently because untyped flow into a function that issues a DB write is exactly the class of regression a reviewer should catch but might miss in a 200-line diff.
- Severity 62 ("high") not 85+ because the new route does have an auth edge and the DB write is in the same service, just a new sink. A reviewer who's busy can act on the four bullets and skip everything else.
- Architectural and type-change tables are short enough to stay above the fold.
- Full breakdown stays collapsed; reviewers who want the per-file picture can open it without leaving the PR.

---

## 11. Example C — Architectural PR (new microservice)

> Scenario: a platform team introduces a new `notifications` service that owns push-notification delivery. The PR adds the service entirely (new package, new deployment), wires the existing `api` service to call it, removes the old inline `sendPushFromApi` function, and introduces 14 new functions / 23 new edges across 2 services. One of the new edges into `notifications::dispatch` is currently `unknown`-typed because the SDK isn't generated yet.

### Raw markdown

```markdown
<!-- codegraph -->
<sub><img src="https://codegraph.dev/badge.svg" height="14" alt="codegraph"> &nbsp;<b>codegraph</b> &middot; <a href="https://viewer.codegraph.dev/r/acme/platform/pr/1024">view full diff →</a></sub>

**Extract notifications microservice** &middot; <code>9c14ab2…e7d0f31</code> &middot; severity <b>88</b> (critical)

| | nodes | edges | services touched |
|---|---|---|---|
| **change** | 14 added · 3 removed · 2 changed | 23 added · 5 removed · 1 changed | 3 (`api`, `notifications`, `worker`) |

### High-severity changes

- **new service** — `notifications` introduced, owns push delivery; deployed independently &nbsp;<sub>[services/notifications](https://viewer.codegraph.dev/r/acme/platform/pr/1024#service=notifications)</sub>
- **new cross-service edge** — `api` → `notifications` (first edge to this service) &nbsp;<sub>[client.ts](https://viewer.codegraph.dev/r/acme/platform/pr/1024#edge=api-notifications)</sub>
- **new cross-service edge** — `worker` → `notifications` (first edge to this service) &nbsp;<sub>[retry.worker.ts](https://viewer.codegraph.dev/r/acme/platform/pr/1024#edge=worker-notifications)</sub>
- **untyped edge into critical path** — `api::sendPush` → `notifications::dispatch` carries `unknown` (SDK not generated) &nbsp;<sub>[notifications.client.ts:18](https://viewer.codegraph.dev/r/acme/platform/pr/1024#edge=api:sendPush-notifications:dispatch)</sub>
- **dead code** — `apps/api/src/legacy/sendPushFromApi.ts::sendPushFromApi` no longer reachable &nbsp;<sub>[sendPushFromApi.ts](https://viewer.codegraph.dev/r/acme/platform/pr/1024#node=api:sendPushFromApi)</sub>

### Architectural changes

| change  | kind    | name                                  | scope          |
|---------|---------|---------------------------------------|----------------|
| added   | service | `notifications`                       | repo           |
| added   | module  | `notifications/src/dispatch`          | notifications  |
| added   | module  | `notifications/src/transport/apns`    | notifications  |
| added   | module  | `notifications/src/transport/fcm`     | notifications  |
| added   | route   | `POST /internal/dispatch`             | notifications  |
| added   | route   | `GET /internal/health`                | notifications  |
| removed | module  | `api/src/legacy/push`                 | api            |
| changed | module  | `api/src/services/push`               | api            |

### Type changes on edges

| edge                                              | before                          | after     |
|---------------------------------------------------|---------------------------------|-----------|
| `api::sendPush → notifications::dispatch`         | —                               | `unknown` |
| `worker::retryPush → notifications::dispatch`     | —                               | `unknown` |
| `api::sendPush → api::sendPushFromApi`            | `{ userId: string; body: string }` | —      |

<details>
<summary>Full breakdown (19 changes)</summary>

#### Added
- `services/notifications/src/index.ts::main` &nbsp;<sub>entry</sub>
- `services/notifications/src/dispatch.ts::dispatch` &nbsp;<sub>route-handler</sub>
- `services/notifications/src/dispatch.ts::validateRequest` &nbsp;<sub>function</sub>
- `services/notifications/src/transport/apns.ts::sendApns` &nbsp;<sub>network-sink</sub>
- `services/notifications/src/transport/fcm.ts::sendFcm` &nbsp;<sub>network-sink</sub>
- `services/notifications/src/queue/enqueue.ts::enqueueRetry` &nbsp;<sub>function</sub>
- `services/notifications/src/queue/enqueue.ts::redisClient` &nbsp;<sub>network-sink</sub>
- `services/notifications/src/health.ts::healthHandler` &nbsp;<sub>route-handler</sub>
- `services/notifications/src/config.ts::loadConfig` &nbsp;<sub>function</sub>
- `services/notifications/src/log.ts::logger` &nbsp;<sub>function</sub>
- `apps/api/src/clients/notifications.client.ts::sendPush` &nbsp;<sub>function</sub>
- `apps/api/src/clients/notifications.client.ts::NotificationsClient` &nbsp;<sub>class</sub>
- `apps/worker/src/retry.worker.ts::retryPush` &nbsp;<sub>function</sub>
- `apps/worker/src/retry.worker.ts::onJob` &nbsp;<sub>function</sub>

#### Removed
- `apps/api/src/legacy/sendPushFromApi.ts::sendPushFromApi` &nbsp;<sub>function</sub>
- `apps/api/src/legacy/apns-direct.ts::apnsDirect` &nbsp;<sub>network-sink</sub>
- `apps/api/src/legacy/fcm-direct.ts::fcmDirect` &nbsp;<sub>network-sink</sub>

#### Changed
- `apps/api/src/services/push.ts::pushService` — now delegates to `NotificationsClient`
- `apps/api/src/index.ts::registerServices` — registers `NotificationsClient` in DI container

… 0 more

</details>

<sub><a href="https://viewer.codegraph.dev/r/acme/platform/pr/1024">open in viewer</a> · <a href="https://codegraph.dev/run-locally">run locally</a> · <a href="https://codegraph.dev/config">configure</a></sub>
```

### Rendered preview

---

<!-- codegraph -->
<sub><b>codegraph</b> &middot; <a href="https://viewer.codegraph.dev/r/acme/platform/pr/1024">view full diff →</a></sub>

**Extract notifications microservice** &middot; <code>9c14ab2…e7d0f31</code> &middot; severity <b>88</b> (critical)

| | nodes | edges | services touched |
|---|---|---|---|
| **change** | 14 added · 3 removed · 2 changed | 23 added · 5 removed · 1 changed | 3 (`api`, `notifications`, `worker`) |

### High-severity changes

- **new service** — `notifications` introduced, owns push delivery; deployed independently &nbsp;<sub>[services/notifications](https://viewer.codegraph.dev/r/acme/platform/pr/1024#service=notifications)</sub>
- **new cross-service edge** — `api` → `notifications` (first edge to this service) &nbsp;<sub>[client.ts](https://viewer.codegraph.dev/r/acme/platform/pr/1024#edge=api-notifications)</sub>
- **new cross-service edge** — `worker` → `notifications` (first edge to this service) &nbsp;<sub>[retry.worker.ts](https://viewer.codegraph.dev/r/acme/platform/pr/1024#edge=worker-notifications)</sub>
- **untyped edge into critical path** — `api::sendPush` → `notifications::dispatch` carries `unknown` (SDK not generated) &nbsp;<sub>[notifications.client.ts:18](https://viewer.codegraph.dev/r/acme/platform/pr/1024#edge=api:sendPush-notifications:dispatch)</sub>
- **dead code** — `apps/api/src/legacy/sendPushFromApi.ts::sendPushFromApi` no longer reachable &nbsp;<sub>[sendPushFromApi.ts](https://viewer.codegraph.dev/r/acme/platform/pr/1024#node=api:sendPushFromApi)</sub>

### Architectural changes

| change  | kind    | name                                  | scope          |
|---------|---------|---------------------------------------|----------------|
| added   | service | `notifications`                       | repo           |
| added   | module  | `notifications/src/dispatch`          | notifications  |
| added   | module  | `notifications/src/transport/apns`    | notifications  |
| added   | module  | `notifications/src/transport/fcm`     | notifications  |
| added   | route   | `POST /internal/dispatch`             | notifications  |
| added   | route   | `GET /internal/health`                | notifications  |
| removed | module  | `api/src/legacy/push`                 | api            |
| changed | module  | `api/src/services/push`               | api            |

### Type changes on edges

| edge                                              | before                          | after     |
|---------------------------------------------------|---------------------------------|-----------|
| `api::sendPush → notifications::dispatch`         | —                               | `unknown` |
| `worker::retryPush → notifications::dispatch`     | —                               | `unknown` |
| `api::sendPush → api::sendPushFromApi`            | `{ userId: string; body: string }` | —      |

<details>
<summary>Full breakdown (19 changes)</summary>

#### Added
- `services/notifications/src/index.ts::main` &nbsp;<sub>entry</sub>
- `services/notifications/src/dispatch.ts::dispatch` &nbsp;<sub>route-handler</sub>
- `services/notifications/src/dispatch.ts::validateRequest` &nbsp;<sub>function</sub>
- `services/notifications/src/transport/apns.ts::sendApns` &nbsp;<sub>network-sink</sub>
- `services/notifications/src/transport/fcm.ts::sendFcm` &nbsp;<sub>network-sink</sub>
- `services/notifications/src/queue/enqueue.ts::enqueueRetry` &nbsp;<sub>function</sub>
- `services/notifications/src/queue/enqueue.ts::redisClient` &nbsp;<sub>network-sink</sub>
- `services/notifications/src/health.ts::healthHandler` &nbsp;<sub>route-handler</sub>
- `services/notifications/src/config.ts::loadConfig` &nbsp;<sub>function</sub>
- `services/notifications/src/log.ts::logger` &nbsp;<sub>function</sub>
- `apps/api/src/clients/notifications.client.ts::sendPush` &nbsp;<sub>function</sub>
- `apps/api/src/clients/notifications.client.ts::NotificationsClient` &nbsp;<sub>class</sub>
- `apps/worker/src/retry.worker.ts::retryPush` &nbsp;<sub>function</sub>
- `apps/worker/src/retry.worker.ts::onJob` &nbsp;<sub>function</sub>

#### Removed
- `apps/api/src/legacy/sendPushFromApi.ts::sendPushFromApi` &nbsp;<sub>function</sub>
- `apps/api/src/legacy/apns-direct.ts::apnsDirect` &nbsp;<sub>network-sink</sub>
- `apps/api/src/legacy/fcm-direct.ts::fcmDirect` &nbsp;<sub>network-sink</sub>

#### Changed
- `apps/api/src/services/push.ts::pushService` — now delegates to `NotificationsClient`
- `apps/api/src/index.ts::registerServices` — registers `NotificationsClient` in DI container

… 0 more

</details>

<sub><a href="https://viewer.codegraph.dev/r/acme/platform/pr/1024">open in viewer</a> · <a href="https://codegraph.dev/run-locally">run locally</a> · <a href="https://codegraph.dev/config">configure</a></sub>

---

### Why this works

- Severity 88 ("critical") is justified by two firsts: a new service node and `unknown`-typed edges into the new critical path. The reviewer should not approve this PR without confirming the SDK generation follow-up is tracked.
- The high-severity bullets make all five reasons obvious without expansion: new service, two new cross-service edges, untyped flow, dead code.
- The architectural table is the right shape for "are we adding the right thing?" — service / module / route names and scope, all in one ~8-row table.
- Type-change table flags the two `unknown`-typed edges plus the now-dangling type from the removed legacy function (the dash in the "after" column tells you the edge is gone, not just changed).
- The full breakdown is comprehensive but inside `<details>`, and the comment is still well under 10 KB. A reviewer who only reads the bullets gets the right mental model.

---

## 11a. Bonus — what an "empty diff" comment looks like

> Scenario: PR rebased onto a base that already includes its commits, or a docs-only PR that touches no code paths. codegraph still posts a comment so reviewers see the system is alive.

```markdown
<!-- codegraph -->
<sub><img src="https://codegraph.dev/badge.svg" height="14" alt="codegraph"> &nbsp;<b>codegraph</b> &middot; <a href="https://viewer.codegraph.dev/r/acme/web/pr/489">view full diff →</a></sub>

**Update README install instructions** &middot; <code>e10b22f…f01a9c4</code> &middot; severity <b>0</b> (trivial)

| | nodes | edges | services touched |
|---|---|---|---|
| **change** | 0 added · 0 removed · 0 changed | 0 added · 0 removed · 0 changed | 0 |

_No graph changes detected._

<sub><a href="https://viewer.codegraph.dev/r/acme/web/pr/489">open in viewer</a> · <a href="https://codegraph.dev/run-locally">run locally</a> · <a href="https://codegraph.dev/config">configure</a></sub>
```

Rendered:

---

<!-- codegraph -->
<sub><b>codegraph</b> &middot; <a href="https://viewer.codegraph.dev/r/acme/web/pr/489">view full diff →</a></sub>

**Update README install instructions** &middot; <code>e10b22f…f01a9c4</code> &middot; severity <b>0</b> (trivial)

| | nodes | edges | services touched |
|---|---|---|---|
| **change** | 0 added · 0 removed · 0 changed | 0 added · 0 removed · 0 changed | 0 |

_No graph changes detected._

<sub><a href="https://viewer.codegraph.dev/r/acme/web/pr/489">open in viewer</a> · <a href="https://codegraph.dev/run-locally">run locally</a> · <a href="https://codegraph.dev/config">configure</a></sub>

---

This is the smallest possible payload — about 350 bytes. Reviewers learn at a glance that codegraph ran and confirmed nothing structural changed.

---

## 11b. Conditional rendering decision table

A single source of truth for which sections appear when. The renderer evaluates each row top-down; the first match wins for each section.

| Condition                                                              | Header | Summary | High-sev | Architectural | Type changes | Breakdown | Footer |
| ---------------------------------------------------------------------- | ------ | ------- | -------- | ------------- | ------------ | --------- | ------ |
| Empty diff                                                             | yes    | yes     | no       | no            | no           | no        | yes    |
| Diff with only function-body edits (no edge changes)                   | yes    | yes     | no       | no            | no           | yes       | yes    |
| Diff with edge changes but no high-sev components                      | yes    | yes     | no       | conditional   | conditional  | yes       | yes    |
| Diff with high-sev components, no architectural changes                | yes    | yes     | yes      | no            | conditional  | yes       | yes    |
| Diff with architectural changes                                        | yes    | yes     | yes      | yes           | conditional  | yes       | yes    |

"conditional" means the section is rendered iff there's at least one row to render. There is no placeholder text for empty sections — empty equals omitted.

---

## 12. Edge cases handled

| Case                                | Behavior                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| First push (no prior comment)       | Post a new comment with the marker.                                                               |
| Subsequent pushes                   | Edit the marker comment. Never post a duplicate.                                                  |
| Empty diff (rebased onto base)      | Render summary table with all zeros and the line `_No graph changes detected._` after the table. |
| Action runs from forked PR          | Same — the marker lookup and edit work regardless of fork status; the token has comment scope.    |
| 1000+ changes                       | Truncate breakdown to first 50 added / 50 removed / 50 changed; spillover line links to viewer.   |
| Identical IR (only formatting)      | Severity 0; "No graph changes detected" line; full breakdown omitted entirely.                    |
| Comment hits 65 KB even truncated   | Final fallback: replace breakdown contents with a single link "{n} changes — view in viewer".     |
| Viewer URL not configured           | Omit "view in viewer" links; use plain text for locations. Footer collapses to "run locally" only.|
| Severity bumps mid-PR (push 2)      | Score updates in place; reviewer sees the new score on next visit. No new notification.           |
| Author edits the comment            | The marker is preserved on edit (it's an HTML comment, GitHub doesn't strip it). Next push wins. |

---

## 13. What we deliberately don't include

- **No "approve / request changes" UI.** codegraph is read-only on the PR. Reviewer agency stays with humans.
- **No file-level diff view.** GitHub already does that. We add the structural view, not a duplicate.
- **No coverage / test-result claims.** Out of scope for static analysis.
- **No emoji severity badges.** A bold integer is more accessible and doesn't fight with `<sub>` rendering.
- **No collapsed "advice" section.** We surface facts; advice belongs in the viewer where reviewers can opt in.
- **No social-share buttons / "powered by" CTAs.** The footer link to codegraph.dev is enough.

---

## 14. Open questions for follow-up

1. Should the severity score be configurable per-repo via `.codegraph.yml`? E.g., a repo where every PR adds a route shouldn't see severity 60 every time.
2. Should we render the high-severity section even when empty, with text like "No high-severity changes detected" — to reassure reviewers that the section was actually evaluated? Current default: omit. Alternative: render once below the summary as a single italic line.
3. For very small PRs (severity ≤ 4, ≤ 2 nodes changed), should we collapse the entire comment into one line so it doesn't add noise to PR threads? E.g.: `<sub>codegraph: 2 changes, severity 4 (trivial). [view →]</sub>`. Worth A/B testing on real repos.
4. Should the comment include a per-PR opt-out instruction, like "add `[skip codegraph]` to the PR title to disable"? Probably yes; needs a separate spec.
5. Mobile rendering: tables wider than ~3 columns wrap awkwardly on the GitHub mobile app. Worth measuring and trimming the architectural table to 3 columns (drop "scope" and put it in the name cell?) on a follow-up.

---

## 15. Summary

The format optimizes for reviewer attention: one short header line with severity, one summary table, up to five high-severity bullets, two short tables, and everything else inside `<details>`. The same comment is edited on every push via the `<!-- codegraph -->` marker. The 10 KB budget is comfortable for typical PRs and the truncation strategy keeps even huge diffs renderable. The three rendered examples above can be pasted directly into a real PR to confirm GitHub renders them as designed.
