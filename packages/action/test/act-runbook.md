# Local end-to-end testing with `act`

This runbook walks through running `packages/action/action.yml` against a fixture repository on your laptop using [`nektos/act`](https://github.com/nektos/act). It's the closest thing to "what GitHub will do" without pushing a PR.

`act` simulates the runner in a Docker container, replays an event payload of your choosing, and runs the workflow file you point it at. The codegraph action is a composite, so `act` invokes each step in sequence — same as production.

---

## 1. Prerequisites

- `docker` running (any modern desktop install).
- [`act`](https://github.com/nektos/act/releases) v0.2.60+ on `$PATH`. macOS: `brew install act`. Linux: `gh extension install nektos/gh-act` or grab the release tarball.
- `node` 20+ on the host (only needed for the helper scripts in `packages/action/scripts/`; the action runs Node inside the container).
- A clone of this repo. The runbook assumes `pwd` is the repo root.

`act` ships with several runner images. The `medium` image (`catthehacker/ubuntu:act-latest`) is the right size for codegraph — it has Node, git, and the GitHub CLI pre-installed:

```bash
act --container-architecture linux/amd64 -P ubuntu-latest=catthehacker/ubuntu:act-latest --version
```

(The `--container-architecture` flag is only needed on Apple Silicon. On Intel/Linux drop it.)

---

## 2. Fixture repository

The action expects to be invoked on a real PR: it reads `github.event.pull_request.head.sha` (and `base.sha`) from the event payload. We fake both with a fixture repo and a hand-written event JSON.

A minimal fixture lives under `test-fixtures/` in the codegraph monorepo. If yours has been cleaned up, build a throwaway one:

```bash
mkdir -p /tmp/codegraph-fixture && cd /tmp/codegraph-fixture
git init -q
git commit --allow-empty -m "base" -q
BASE_SHA=$(git rev-parse HEAD)
git checkout -b feature -q
mkdir -p src && cat > src/util.ts <<'EOF'
export function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString();
}
EOF
git add . && git commit -m "add util" -q
HEAD_SHA=$(git rev-parse HEAD)
echo "BASE=$BASE_SHA"
echo "HEAD=$HEAD_SHA"
```

Keep the two SHAs — you'll paste them into the event payload.

---

## 3. Build the event payload

Save as `/tmp/codegraph-fixture/.act-event.json`. Replace the `$BASE` and `$HEAD` strings with the SHAs from above:

```json
{
  "action": "synchronize",
  "number": 1,
  "pull_request": {
    "number": 1,
    "draft": false,
    "title": "add util",
    "base": { "sha": "$BASE", "ref": "main" },
    "head": {
      "sha": "$HEAD",
      "ref": "feature",
      "repo": { "full_name": "local/codegraph-fixture" }
    }
  },
  "repository": {
    "full_name": "local/codegraph-fixture",
    "name": "codegraph-fixture",
    "owner": { "login": "local" }
  }
}
```

The shape matches what GitHub posts on a real `pull_request` `synchronize` event. `compute-refs.js` is the source of truth for which fields are read — see `packages/action/scripts/compute-refs.js` for the canonical list.

Sanity-check the payload against the helper without booting `act`:

```bash
GITHUB_EVENT_NAME=pull_request \
GITHUB_EVENT_PATH=/tmp/codegraph-fixture/.act-event.json \
node /path/to/codegraph/packages/action/scripts/compute-refs.js --print
```

You should see `base-sha=…`, `head-sha=…`, `pr-number=1`, `skip=false`. If `skip=true`, your fixture marked the PR as draft.

---

## 4. Wrapper workflow

`act` runs *workflows*, not actions, so write a one-step workflow that uses the local action by relative path. Save as `.github/workflows/act-local.yml` in the fixture repo (or the codegraph repo root — `act` finds it either way):

```yaml
name: act-local
on:
  pull_request:
    types: [synchronize]

permissions:
  contents: read
  pull-requests: write

jobs:
  diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: codegraph
        uses: ./packages/action
        with:
          config-path: .codegraph.yml
          cache-key: act-local
          comment-mode: never           # `act` cannot post real comments
          severity-threshold: none      # don't fail the local run on findings
          codegraph-version: 0.0.0-local
```

`comment-mode: never` is important — `act` mints a fake `GITHUB_TOKEN` that has no real GitHub backend; trying to POST a comment will fail with a 401 and obscure the diff failures we actually care about. `severity-threshold: none` mirrors what you'd want when iterating: see all output, fail nothing.

If you're testing the viewer publish path, leave `viewer-publish: false` here too — `peaceiris/actions-gh-pages` needs a real token. Use `act -j publish-viewer --secret-file ...` only with a scratch repo and a scratch PAT.

---

## 5. Running the action under act

From the *codegraph repo root* (so the relative path `./packages/action` resolves):

```bash
act pull_request \
  --eventpath /tmp/codegraph-fixture/.act-event.json \
  --workflows .github/workflows/act-local.yml \
  -P ubuntu-latest=catthehacker/ubuntu:act-latest \
  --container-architecture linux/amd64 \
  --bind /tmp/codegraph-fixture:/github/workspace
```

Flag-by-flag:

- `pull_request` — the event name. Must match `on:` in the workflow.
- `--eventpath` — your hand-rolled JSON. Read as-is; not validated against a schema.
- `--workflows` — limit `act` to the wrapper workflow so the rest of the repo's workflows don't run.
- `-P ubuntu-latest=...` — pin to a runner image with Node + git pre-installed.
- `--bind` — share the fixture repo with the container so `actions/checkout` has somewhere to clone into and the head/base checkouts don't tar/untar across the bind boundary. Without `--bind` you'll see "remote not found" because the fixture exists only on the host.

Expected console output:

1. `Validate event` — prints `event=pull_request`, `skip=false`.
2. `Setup Node.js 20` — pulls Node 20 into the container.
3. `Install codegraph CLI` — `npm install -g @codegraph/cli@latest`. If you're testing a local CLI build, swap for `npm install -g /github/workspace/packages/cli` via a workflow tweak.
4. `Restore codegraph cache` — first run is a miss; that's expected.
5. `Resolve base and head refs` — prints both SHAs; should match what you put in `.act-event.json`.
6. `Checkout base` / `Build base IR` / `Checkout head` / `Build head IR` — should each end with `IR written to …`.
7. `Diff IR` — produces `diff.md` and `diff.json` under `__codegraph_artifacts/` *inside the container*.
8. `Post PR comment` — skipped because `comment-mode: never`.
9. `Build viewer bundle` / `Publish viewer to gh-pages` — skipped because `viewer-publish: false`.

Recover the artifacts:

```bash
ls -la /tmp/codegraph-fixture/__codegraph_artifacts/
cat /tmp/codegraph-fixture/__codegraph_artifacts/diff.md
```

The bind mount means the container's `$GITHUB_WORKSPACE/__codegraph_artifacts/` is the same directory as `/tmp/codegraph-fixture/__codegraph_artifacts/` on the host.

---

## 6. Common failure modes

### `Error: Cannot find module 'js-yaml'` (or similar) during `Install codegraph CLI`
The runner image you picked is too small. Switch to `catthehacker/ubuntu:act-latest` — the `slim` images don't bundle the npm cache.

### `fatal: not a git repository` during `Checkout base`
You forgot `--bind`, or the fixture path isn't a git repo. `actions/checkout@v4` clones from a URL by default, but with a local bind it falls through to an existing `.git`. Run `git init && git commit --allow-empty -m base` in the fixture if you started from scratch.

### `compute-refs: GITHUB_EVENT_NAME is not set`
You're invoking `compute-refs.js` directly without exporting `GITHUB_EVENT_NAME=pull_request`. The action sets this automatically via `act`'s event handling — only an issue when running the script standalone.

### Comment step times out
You forgot `comment-mode: never`. `act` mints a fake token that points at `https://api.github.com` and will hang on the first 401 retry loop. Always set `comment-mode: never` for `act` runs.

### `Unable to resolve action: codegraph/codegraph/packages/action@v1`
You're running the consumer-style workflow (`uses: codegraph/codegraph/packages/action@v1`) inside `act`. Switch to the wrapper workflow above, which uses `uses: ./packages/action` (a relative path from the workspace root).

### `EACCES: permission denied, open '/github/workspace/.codegraph-cache'`
`act` containers run as root by default but the bind mount may have host-owned files. Either `chmod -R 777 /tmp/codegraph-fixture` (scratch dir, fine) or run `act --userns host`.

---

## 7. Iterating on the action

`act` re-pulls the runner image and re-installs `npm` packages every run unless you pass `--reuse`:

```bash
act pull_request --reuse --eventpath ... --workflows ...
```

That keeps the container alive between runs (10–30 s per iteration instead of 2–5 min). Combine with `act -v` for the verbose log when a step fails inside `composite/runner.js`.

For a tighter inner loop on shell-only step changes, edit `action.yml`, run the validator, and re-run `act`:

```bash
node packages/action/scripts/validate-action.js && \
  act pull_request --reuse \
    --eventpath /tmp/codegraph-fixture/.act-event.json \
    --workflows .github/workflows/act-local.yml \
    -P ubuntu-latest=catthehacker/ubuntu:act-latest
```

The validator catches typo'd input names, missing step ids, and `::set-output ::` regressions in ~50 ms — much faster than letting `act` discover them.

---

## 8. What `act` cannot test

Two things `act` *can't* exercise faithfully — both require a real GitHub backend:

- **Sticky comment update path** in step 10 (`actions/github-script`). The comment list / patch round-trip needs a real repo. Test in a scratch GitHub repo with a draft PR.
- **gh-pages publish** in step 11. `peaceiris/actions-gh-pages` pushes to a real branch. Same workaround: scratch repo, scratch PAT.

For both, the recommended flow is to push a branch to a scratch repo (`codegraph-action-test`) and open a PR there. The full action runs end-to-end against a real GitHub event in 30–60 seconds.
