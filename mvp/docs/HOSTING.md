# Ryngo — hosting & deployment plan

This is now partly implemented. The current focus is the MCP endpoint:
one Docker image serves the Ryngo web app, the REST projection APIs, and
the Streamable HTTP MCP server at `/mcp`.

## Current Cloud Build UI values

Use these in the Cloud Run "Set up with Cloud Build" wizard:

| Field | Value |
|---|---|
| Branch | `^main$` |
| Build type | Dockerfile |
| Source location | `/Dockerfile` |

`origin` currently has `refs/heads/main`, so `^main$` is the right
branch regex for normal deploys. The checked-in root `Dockerfile`
exists specifically because the Cloud Run console-generated trigger
builds from repo root. That Dockerfile copies only `mvp/` into the image,
so the deployed app is still the MVP server and MCP endpoint.

`cloudbuild.yaml` is kept for a later cleaner trigger/GitHub Actions
path, but the currently working console trigger is the root-Dockerfile
trigger.

The deployed MCP connector URL will be:

```text
https://<cloud-run-service-url>/mcp
```

After deploy, verify it from this checkout:

```bash
cd mvp
npm run smoke:mcp:http -- https://<cloud-run-service-url>/mcp
```

## Goals (in priority order)

1. **One git push deploys to dev.** No manual steps. Fast feedback.
2. **Prod is gated.** Promotion from dev → prod requires either a tag /
   release OR a separate merge to a `production` branch, plus the corpus
   harness has stayed green.
3. **One-click ad-hoc deploys** for early demos (Cloud Run "Deploy
   button" / `gcloud run deploy`).
4. **No long-lived secrets in CI.** GitHub OIDC → Google Workload
   Identity Federation. Keyless.
5. **Cheap when idle.** Scale-to-zero so the bill stays in pennies/day
   while we're not under load. Accept the 1–3 s cold-start tradeoff.
6. **Stateful annotations survive deploys.** The `.ryngo/` directory
   currently lives on the host filesystem; in serverless it has to
   move.

## Constraints we already have

- Domain: **`ryngo.ai`** owned (registrar TBD; let's confirm before we
  start so DNS can be pre-staged).
- Repo: `https://github.com/MarshallDoyle/Ryngo`. The active Cloud Build
  trigger targets `main`.
- Stack: Node 20+, Express, Vite-built React SPA. Requires `git` CLI
  on the host (for `analyzeRepo`'s shallow clones). No database yet;
  the usage / compiler-quality warehouse is planned separately in
  [`DATA_WAREHOUSE.md`](DATA_WAREHOUSE.md).

## Recommended architecture: Cloud Run + GitHub Actions

```
┌─────────────────────┐
│  GitHub repo (main) │  ──push──┐
└──────────┬──────────┘          │
           │                     │
           ▼                     ▼
   .github/workflows/        .github/workflows/
       deploy-dev.yml          deploy-prod.yml
   (on push to main)         (on tag v*.*.*)
           │                     │
           ▼                     ▼
   ┌──────────────────┐   ┌──────────────────┐
   │  GCP Artifact    │   │  GCP Artifact    │
   │  Registry        │   │  Registry        │
   │  ryngo-dev:sha   │   │  ryngo-prod:sha  │
   └────────┬─────────┘   └────────┬─────────┘
            ▼                      ▼
   ┌──────────────────┐   ┌──────────────────┐
   │  Cloud Run       │   │  Cloud Run       │
   │  ryngo-dev       │   │  ryngo-prod      │
   │  dev.ryngo.ai    │   │  ryngo.ai        │
   └────────┬─────────┘   └────────┬─────────┘
            ▼                      ▼
   ┌──────────────────┐   ┌──────────────────┐
   │  GCS bucket      │   │  GCS bucket      │
   │  ryngo-dev-state │   │  ryngo-prod-state│
   │  (.ryngo/ mount) │   │  (.ryngo/ mount) │
   └──────────────────┘   └──────────────────┘
```

**Why Cloud Run vs alternatives:**

| Option | Pro | Con | Verdict |
|---|---|---|---|
| Cloud Run | scale-to-zero, HTTPS+domain mapping baked in, GCS volume mount, fits Docker | cold starts, 60-min request limit | **chosen** |
| App Engine Flexible | persistent disks, GA | legacy ergonomics, slower to deploy | no |
| GKE | full control | overkill, paying for control plane idle | no |
| Compute Engine + COS | full control + persistent disk | manage VM, manage TLS, manage scaling | no |
| Vercel / Render / Fly | one-click, less infra | costlier at scale, lock-in, the user picked Google | no |

## Phased rollout

### Phase 7.1 — Repo + container

Status: mostly done.

1. `git init` in the project root, add a sane `.gitignore`
   (`node_modules`, `dist`, `.ryngo/`, `test/results/`, `.env*`).
2. Create GitHub repo (public or private — your call), push.
   - Done: `MarshallDoyle/Ryngo` exists as `origin`.
3. Add `mvp/Dockerfile`:
   ```Dockerfile
   FROM node:20-alpine AS build
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci
   COPY . .
   RUN npm run build

   FROM node:20-alpine AS runtime
   RUN apk add --no-cache git ca-certificates
   WORKDIR /app
   COPY --from=build /app/node_modules ./node_modules
   COPY --from=build /app/dist ./dist
   COPY --from=build /app/server.js ./server.js
   COPY --from=build /app/lib ./lib
   COPY --from=build /app/package.json ./package.json
   ENV NODE_ENV=production
   ENV PORT=8080
   EXPOSE 8080
   CMD ["node", "server.js"]
   ```
   - The `git` package is required because `analyzeRepo` shells out
     to `git clone --depth=1`.
   - Cloud Run injects `PORT=8080`; our `server.js` already reads
     `process.env.PORT` so no code change.
   - Done.
4. Add `mvp/.dockerignore` (mirrors `.gitignore` plus `dist` —
   the build stage rebuilds it).
   - Done.
5. Local smoke: `docker build -t ryngo:local mvp/ && docker run --rm
   -p 8080:8080 ryngo:local`. Hit `http://localhost:8080/api/health`.
   - Also run `npm run smoke:mcp:http -- http://localhost:8080/mcp`.

### Phase 7.2 — Google Cloud project + Workload Identity (45 min)

1. Create GCP project: `ryngo-prod`. (Single project for both
   environments keeps billing simple; services within it are isolated.)
2. Enable APIs: Cloud Run, Artifact Registry, IAM, Cloud Build (only
   if we want server-side builds; we'll do GitHub-side builds instead),
   Cloud DNS.
3. Create Artifact Registry: `us-central1-docker.pkg.dev/ryngo-prod/containers`.
4. Create Workload Identity Pool + Provider for GitHub OIDC:
   ```
   gcloud iam workload-identity-pools create github-pool …
   gcloud iam workload-identity-pools providers create-oidc github-actions …
   ```
5. Create deploy service account `github-deployer@ryngo-prod.iam.gserviceaccount.com`
   with `roles/run.admin`, `roles/artifactregistry.writer`,
   `roles/iam.serviceAccountUser`.
6. Bind the GitHub repo to the SA via WIF binding (so any push to
   `MarshallDoyle/Ryngo` can impersonate the SA — no JSON keys).

### Phase 7.3 — GitHub Actions deploy pipelines (1 hour)

Two workflow files:

**`.github/workflows/deploy-dev.yml`** — on push to `main`:
```yaml
on:
  push:
    branches: [main]
permissions:
  contents: read
  id-token: write     # required for OIDC → GCP
jobs:
  build-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.WIF_PROVIDER }}
          service_account: github-deployer@ryngo-prod.iam.gserviceaccount.com
      - uses: google-github-actions/setup-gcloud@v2
      - run: gcloud auth configure-docker us-central1-docker.pkg.dev
      - run: |
          docker build -t us-central1-docker.pkg.dev/ryngo-prod/containers/ryngo:${{ github.sha }} mvp/
          docker push   us-central1-docker.pkg.dev/ryngo-prod/containers/ryngo:${{ github.sha }}
      - run: |
          gcloud run deploy ryngo-dev \
            --region us-central1 \
            --image us-central1-docker.pkg.dev/ryngo-prod/containers/ryngo:${{ github.sha }} \
            --platform managed \
            --allow-unauthenticated \
            --memory 1Gi --cpu 1 \
            --concurrency 50 \
            --max-instances 5 \
            --min-instances 0 \
            --add-volume name=state,type=cloud-storage,bucket=ryngo-dev-state \
            --add-volume-mount volume=state,mount-path=/app/.ryngo
```

**`.github/workflows/deploy-prod.yml`** — on tag `v*.*.*`:
- Same shape, but `gcloud run deploy ryngo-prod`, bucket
  `ryngo-prod-state`, `--max-instances 20`.

**Optional gate** — block prod deploys until the corpus stays green:
```yaml
- name: Run corpus harness against the new image
  run: |
    docker run --rm -e CORPUS_TIMEOUT_MS=60000 \
      us-central1-docker.pkg.dev/ryngo-prod/containers/ryngo:${{ github.sha }} \
      npm run corpus
```
(We probably skip this on the prod side because corpus runs on every
push to dev already; prod inherits the same image.)

### Phase 7.4 — DNS + domain mapping (30 min)

1. Cloud Run domain mapping:
   ```
   gcloud beta run domain-mappings create --service ryngo-dev  --domain dev.ryngo.ai --region us-central1
   gcloud beta run domain-mappings create --service ryngo-prod --domain ryngo.ai     --region us-central1
   ```
2. Pull the records from the response and add to your registrar:
   - `ryngo.ai`     → `A` records (4 IPs printed by Cloud Run)
   - `dev.ryngo.ai` → `CNAME` to `ghs.googlehosted.com`
   (The exact records depend on whether the apex `ryngo.ai` allows
   ALIAS / ANAME records on your registrar. Cloudflare does; many
   registrars don't, in which case we use Google's IPs at the apex.)
3. Cloud Run auto-provisions the LE TLS cert once DNS resolves.
   Allow ~15 min.

### Phase 7.5 — Persistence: where `.ryngo/` lives (45 min)

The current MVP stores annotations / intents / regions on the host
filesystem at `mvp/.ryngo/<owner>__<repo>/`. In serverless this needs
to move.

**Option A (recommended for now): GCS bucket mounted as volume.**
- `gcloud run services add-volume … --type=cloud-storage --bucket=ryngo-dev-state`
- Mount at `/app/.ryngo`. The existing code (`storage.js` / `annotations.js`)
  works unchanged because it just writes files to that path.
- Trade-off: GCS is eventually consistent (~ms scale), so two clients
  writing the same intent file in the same second can see one
  overwrite the other. Acceptable risk for an MVP.

**Option B (better long-term): Firestore.**
- Each annotation / intent / region becomes a Firestore document.
- Strongly consistent, queryable, integrates with auth.
- Requires a small abstraction layer between the existing file
  helpers and the storage backend.
- 30–60 min of refactoring + 1 hr of testing. Worth doing once we
  have any real users.

**Option C (most aligned with the mission): commit to user repo.**
- `.ryngo/` lives in the user's own GitHub repo, not ours.
- Ryngo authenticates as the user (GitHub OAuth) and pushes commits
  back when annotations change.
- This is the "your annotations live in your repo, your AI agents
  read them from there" thesis from `missionStatement.md`.
- Heaviest lift — needs OAuth, auth-protected endpoints, commit
  signing, conflict resolution. Phase 8+ work.

**For initial deploy: ship Option A.** Migrate annotation persistence to B + C
later. This is separate from the usage / compiler-quality database in
[`DATA_WAREHOUSE.md`](DATA_WAREHOUSE.md), which should use Postgres because it
needs joins, aggregates, retention, and quality reports.

### Phase 7.6 — Public-deploy hardening (1 hour)

The current server has minimal abuse protection. Before exposing
ryngo.ai to the world:

1. **Per-IP rate limit on `/api/analyze` and `/api/diff`**
   (`express-rate-limit` package). 10 / hour anon, 60 / hour with
   API key.
2. **Concurrent-clone limit globally** (today: 2 per IP; add a
   process-wide cap of ~6 to prevent CPU DoS).
3. **Repo allowlist / blocklist**: optional flag to restrict
   which org/users can be analyzed (private MVP mode).
4. **Cap clone size**: refuse repos > 200 MB at the `git clone`
   layer (already capped indirectly by MAX_FILES, but a top-line
   reject is faster).
5. **Structured logs**: switch `console.log` over to `pino` (or
   keep console but emit JSON) so Cloud Logging can index them.
6. **Error tracking**: Sentry or GCP Error Reporting. Sentry's
   free tier covers this fine.
7. **Health endpoint enrichment**: `/api/health` now reports git
   availability, event database configuration, MCP endpoint paths, revision
   metadata, and whether `.ryngo/` is visible to the container. The next
   hardening pass should add a real GCS write/read probe once the bucket is
   mounted.

### Phase 7.7 — Cost model

**Estimate at "MVP traffic" (≤ 1k req/day):**

| Item | Cost / month |
|---|---|
| Cloud Run dev (idle most of the time) | $0–$2 |
| Cloud Run prod (1k req/day, ~5 s each) | $1–$5 |
| Artifact Registry (a few GB of images) | < $1 |
| GCS state buckets (annotations) | < $1 |
| Cloud DNS | $0.40 |
| Egress (HTML+JSON, no big files) | $1–$3 |
| **Total** | **~$5–$12 / month** |

At 50k req/day: maybe $50–100/month, dominated by CPU-seconds on
analyze. We'd add a clone-cache (Phase 5 #33 from the original
roadmap) to cut that.

### Phase 7.8 — Pre-launch checklist

- [ ] `git` repo on GitHub
- [ ] `Dockerfile` + `.dockerignore` in `mvp/`
- [ ] GCP project + Artifact Registry + WIF set up
- [ ] Both deploy workflows in `.github/workflows/`
- [ ] First successful auto-deploy to dev
- [ ] DNS records in registrar; both domains issuing TLS
- [ ] GCS bucket mounted; smoke test that an annotation persists
- [ ] Rate limiter wired
- [ ] Structured logs flowing to Cloud Logging
- [ ] Error tracking wired (Sentry DSN as a Cloud Run env var)
- [x] `/api/health` reports green from prod URL
- [ ] First production-tagged release deployed

### Phase 7.9 — When to do this work

Not yet. The right cue is "MVP feels close to done — corpus is at
~95% of where we want it, the typed-port viewer matches the demo
target, and there's at least one external person who'd use the dev
URL." Until that bar's met, deploying just adds operational
overhead without product upside.

When you say "go", the order is **7.1 → 7.2 → 7.3 → 7.4 → 7.5 →
7.6 → 7.7-7.8 (final checks)**. Each phase is independently shippable
and reversible — if 7.4 (DNS) breaks, dev is still up at the Cloud
Run hostname.

---

## What this plan deliberately doesn't include

- **Multi-region.** us-central1 only. Add regions if latency outside
  North America becomes a real complaint.
- **CDN / edge caching.** The SPA bundle is < 500 kB; not worth a
  CDN until traffic grows.
- **Usage database.** The relational usage / compiler-quality warehouse is
  scoped in [`DATA_WAREHOUSE.md`](DATA_WAREHOUSE.md). It can ship after the
  first deploy path, but Phase 9.1/9.3 should land before public beta so repo
  submissions, analysis runs, file outcomes, and diagnostics are captured.
- **Background workers.** Everything is request-scoped today.
  Cloud Run handles bursts; we don't need a queue.
- **Mobile clients.** SPA only.
- **Self-hosted enterprise install.** The Dockerfile makes it
  possible (run anywhere with Docker), but we don't promise it as a
  product yet. Phase 9+ when we have demand.
