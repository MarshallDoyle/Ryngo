# codegraph GitHub Action

A composite GitHub Action that runs the [codegraph](https://github.com/codegraph/codegraph) CLI on every pull request, diffs the typed graph IR between the PR base and head, and posts a sticky markdown comment summarizing the structural changes. Optionally publishes a static, click-through viewer of the diff to `gh-pages`.

codegraph is a deterministic, no-LLM static analyzer. The action is pure CI glue: every step is reproducible from your repo's source and `.codegraph.yml`.

---

## Quick start

Create `.github/workflows/codegraph.yml` in your repo:

```yaml
name: codegraph
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write
  pages: write

jobs:
  diff:
    runs-on: ubuntu-latest
    steps:
      - uses: codegraph/codegraph/packages/action@v1
        with:
          config-path: .codegraph.yml
          comment-mode: on-change
          severity-threshold: warning
```

That's the whole install. The action checks out both refs itself, so you do **not** need a separate `actions/checkout` step.

A more complete example with viewer publishing, concurrency, and merge-queue gating lives at [`.github/workflows/example.yml`](../../.github/workflows/example.yml) in this repo.

---

## How it works

1. **Validate event.** The action runs on `pull_request`, `pull_request_target`, and `merge_group`. It exits cleanly with a notice on draft PRs unless `CODEGRAPH_RUN_ON_DRAFT=true` is set.
2. **Setup Node 20** and install `@codegraph/cli` globally at the version pinned by `codegraph-version` (default: `latest`).
3. **Restore cache** keyed on OS, the user-supplied `cache-key`, and a hash of the config + lockfiles. A `restore-keys` fallback gives you a soft hit on the most recent cache for the same key.
4. **Resolve refs** from the event payload — *not* from `git rev-parse HEAD`, which on `pull_request` is a synthetic merge commit. This makes the diff stable across force-pushes.
5. **Checkout the base ref** into `__codegraph_base/` with `fetch-depth: 0` and run `codegraph index`, writing `base.ir.json`.
6. **Checkout the head ref** into the workspace root and run `codegraph index` again, writing `head.ir.json`.
7. **Run `codegraph diff`** in both `markdown` (for the comment) and `json` (for the viewer / outputs) formats.
8. **Post a sticky comment** via `actions/github-script`, finding the previous comment by an HTML marker (`<!-- codegraph:comment:v1 -->`) and updating it in place.
9. **Optionally publish the viewer** to `gh-pages/pr-<number>/` via `peaceiris/actions-gh-pages`.

The full diff is also written to `$GITHUB_STEP_SUMMARY` regardless of the comment mode, so it shows up in the Actions UI for archival.

---

## Inputs

| Input                | Required | Default            | Description |
| -------------------- | -------- | ------------------ | ----------- |
| `config-path`        | no       | `.codegraph.yml`   | Path (relative to repo root) of the codegraph config. Missing file falls back to CLI defaults. |
| `cache-key`          | no       | `v1`               | Suffix added to the cache key. Bump to invalidate after a CLI/adapter upgrade. The action also keys on config + lockfile hashes automatically. |
| `viewer-publish`     | no       | `'false'`          | When `'true'`, build the static viewer and push it to the `gh-pages` branch under `pr-<number>/`. Requires `contents: write` and `pages: write` permissions. |
| `comment-mode`       | no       | `on-change`        | `always` (post even when nothing changed), `on-change` (post only on a non-empty diff), or `never` (write to job summary only). |
| `severity-threshold` | no       | `warning`          | Forwarded to `codegraph diff --fail-on`. One of `none`, `info`, `warning`, `error`. `none` disables the gate. |
| `github-token`       | no       | `${{ github.token }}` | Token used to comment and (optionally) push to `gh-pages`. |
| `codegraph-version`  | no       | `latest`           | npm dist-tag or semver of `@codegraph/cli` to install. Pin (e.g. `0.1.0`) for reproducible CI. |
| `working-directory`  | no       | `.`                | Subdirectory to treat as the repo root when indexing. Use this in monorepos to scope the diff to one package. |

## Outputs

| Output         | Description |
| -------------- | ----------- |
| `diff-summary` | Path to the markdown diff file on the runner (relative to `$GITHUB_WORKSPACE`). Empty when no diff was produced. |
| `viewer-url`   | Public URL of the published viewer when `viewer-publish: true`. Empty otherwise. |

---

## Triggers and edge cases

### Force-pushes
Refs are resolved from `github.event.pull_request.head.sha` (and `base.sha`), so a force-push triggers a fresh `synchronize` event with a new head SHA and the action re-diffs against the up-to-date base. The sticky comment is updated in place — no orphan comments accumulate.

### Merge commits and merge queue
On `pull_request` the default checkout SHA is a synthetic merge commit; we ignore it and fetch `head.sha` directly. On `merge_group` events, refs come from `github.event.merge_group.{base_sha,head_sha}` so the merge-queue gate runs against the same IR a maintainer saw on the PR. Comment posting is skipped on `merge_group` (no PR number) — the diff is still written to the step summary.

### Draft PRs
Skipped by default with a notice. Set `env: CODEGRAPH_RUN_ON_DRAFT: 'true'` on the step (or remove the workflow's `if: github.event.pull_request.draft != true` guard) to run on drafts too.

### Monorepos / sparse checkouts
Set `working-directory:` to the package root. The action passes the same path to both `codegraph index` invocations, so the diff is scoped to that subtree. The cache directory is also nested under that path so multiple jobs (one per package) don't collide.

### First PR introducing `.codegraph.yml`
The base ref won't have the config yet. The action detects this and falls back to CLI defaults for the base IR, so the diff still works. The head IR uses the new config.

### Long-running indexes
The CLI's `--cache-dir` flag enables incremental indexing keyed on file content hashes; warm runs typically finish in seconds. For a cold first run on a large monorepo, see the troubleshooting section below.

---

## Security

### `pull_request` vs `pull_request_target`

The example workflow uses `pull_request`, which is the safe default:

- The workflow runs in the context of the **fork's code** with a read-only `GITHUB_TOKEN`.
- Fork PRs do **not** have access to repo secrets.
- A malicious PR cannot exfiltrate secrets or push to your repo via this workflow.

`pull_request_target` runs in the context of the **base repo** with a write-capable token, but checks out fork code. This is dangerous: any code in the fork's `package.json` (`postinstall` scripts, custom adapters, build steps invoked by `codegraph index`) executes with your repo's permissions and can read your secrets.

**If you must use `pull_request_target`** (e.g. because you want to comment on PRs from new contributors without the first-time-contributor approval flow):

1. Pin `codegraph-version` to a specific semver — never `latest`.
2. Disable any user-supplied build hooks. The CLI itself does not execute fork code, but your `.codegraph.yml` may register adapters that do (e.g. a TypeScript adapter that runs `tsc`). Vet your adapter list.
3. Run the analysis job with no secrets in scope, and split the comment-posting into a separate `workflow_run`-triggered job that has the write token. This is the [pattern recommended by GitHub](https://securitylab.github.com/research/github-actions-preventing-pwn-requests/).
4. Never check out the fork's HEAD into a directory you also publish from gh-pages without sanitizing — fork-controlled HTML/JS uploaded to your `*.github.io` domain is a same-origin XSS surface.

### Token scope

The default `${{ github.token }}` is sufficient for same-repo PRs. For cross-repo or org-wide rollouts, prefer a [fine-grained PAT](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) or a GitHub App token with the minimum scopes:

- `pull-requests: write` (comment)
- `contents: write` (only if `viewer-publish: true`)
- `pages: write` (only if `viewer-publish: true`)

### Viewer publishing risk

Publishing the viewer to `gh-pages` makes the IR JSON of every PR publicly readable on the project's `*.github.io` domain — including the IR of contributor branches before they merge. If your repo is private or your IR could leak proprietary structure, leave `viewer-publish: false` and run the viewer locally with `codegraph serve`.

---

## Troubleshooting

### Cache misses on every run
- Confirm the cache step's `key` is stable across runs. `actions/cache` keys on `inputs.cache-key` plus a hash of the config and lockfiles — if any of those change, the cache rebuilds.
- The action falls back to `restore-keys: codegraph-${runner.os}-${cache-key}-`, which gives you a partial hit on dependency churn. Misses on the *first* run for a key are expected.
- If you bumped `codegraph-version`, also bump `cache-key`. The cache format is not guaranteed across minor versions of the CLI.

### `Resource not accessible by integration` on comment post
The workflow needs `permissions: pull-requests: write`. The default `GITHUB_TOKEN` for `pull_request` from a fork has read-only scope — you must declare elevated permissions explicitly in the workflow file (top-level `permissions:` block).

If you're using an org-level required-workflows setup that strips `permissions:`, switch to a GitHub App token via `inputs.github-token`.

### `403` on `gh-pages` push
- The workflow needs `permissions: contents: write`. This is **not** granted by default on a `pull_request` from a fork — the action will fail unless you split the publish into a `workflow_run`-triggered job with elevated permissions, or use `pull_request_target` (with the caveats above).
- Repos with branch protection on `gh-pages` may reject the push. Either exempt the bot account or relax protection on `gh-pages` (it's a generated branch).

### Large-repo timeouts
The default job `timeout-minutes` in the example is 15. For monorepos with >500k LoC:
- Set `working-directory:` to scope the index to the changed package.
- Pre-warm the cache by running the action on `push` to your default branch (write the cache once a day; the PR job restores it).
- Add `--since origin/${{ github.base_ref }}` semantics by ensuring the `cache-dir` is restored — the CLI uses cached file hashes to skip unchanged files.
- If your indexer adapter is the bottleneck (e.g. a TypeScript adapter on a deeply interconnected codebase), bump the runner to `ubuntu-latest-large` or a self-hosted runner.

### Diff is empty on a PR you know changed code
- Check that your `.codegraph.yml` adapter list includes the language(s) the PR touched. The CLI silently no-ops files no adapter claims.
- Confirm `working-directory:` covers the changed paths. A `working-directory: ./apps/web` won't see changes under `./packages/shared`.
- Check the job summary — the IR may have changed in a way that doesn't surface at the default scope. Try `--scope` in your config or rerun with `severity-threshold: info` to see lower-severity findings.

### Action fails on a draft PR you wanted to test
By design the action skips drafts. Either mark the PR ready for review, or set `env: CODEGRAPH_RUN_ON_DRAFT: 'true'` on the step.

### `peaceiris/actions-gh-pages` step skipped
The viewer-publish steps gate on `inputs.viewer-publish == 'true'` (string, not boolean — composite actions stringify all inputs). Make sure you're passing `'true'` in quotes if your YAML serializer is converting an unquoted `true` to something else.

### Comment shows up twice
The sticky-comment marker is `<!-- codegraph:comment:v1 -->`. If you see duplicates, you likely have two copies of the action installed (e.g. one in `.github/workflows/codegraph.yml` and another in a reusable workflow). Remove one — the marker only deduplicates within a single comment-update call.

---

## Versioning

The action follows the codegraph CLI's semver. Pin to a major (`@v1`) for automatic non-breaking updates, or a full SHA for reproducibility:

```yaml
- uses: codegraph/codegraph/packages/action@v1                         # latest v1.x.x
- uses: codegraph/codegraph/packages/action@v1.2.0                     # exact tag
- uses: codegraph/codegraph/packages/action@a1b2c3d4e5f6...            # exact SHA
```

For maximum safety in untrusted contexts (`pull_request_target`), pin to a SHA.

---

## License

MIT — same as the rest of codegraph.
