# Changesets

This directory holds **pending release notes**. Every PR that ships a
user-visible change in any published package adds one Markdown file
here describing the bump. The release workflow consumes them; do not
hand-edit version numbers in `package.json`.

> Plinth uses **independent versioning** for every published package.
> See `STRUCTURE.md` §6 for the rationale (TL;DR: adapters churn at a
> different cadence than core, and the IR schema version — not npm
> versions — is the real compatibility contract).

## Adding a changeset

```bash
pnpm changeset
```

The CLI walks you through:

1. **Which packages are affected.** Tick every package whose published
   surface changes, even if the change is internal — a refactor in
   `@codegraph/core` that doesn't alter exported types still gets a
   `patch`. Workspace packages that depend on a bumped package are
   updated automatically per `updateInternalDependencies` in
   `config.json`.
2. **Bump level per package.** Pre-1.0 (see §6.2 of `STRUCTURE.md`) we
   treat all changes as potentially breaking and use `minor` for
   anything user-visible. Reserve `major` for the eventual 1.0 cut.
   `patch` is for internal-only changes that need a republish.
3. **A summary line.** First line is the changelog entry — write it for
   a user reading `CHANGELOG.md`, not for a reviewer. The body is
   optional; use it for migration notes when needed.

The CLI writes a file like `.changeset/curly-pandas-dance.md`. Commit
it with the rest of your PR.

## What if my PR doesn't need a changeset?

Some PRs touch only:

- repo tooling (CI, lint, formatting),
- private packages (anything with `"private": true`),
- documentation that isn't published,
- comments / tests / fixtures.

These don't need a changeset. The `changeset-bot` workflow will leave
a comment on the PR if it can't tell whether one is needed; reply with
`/empty-changeset` (or run `pnpm changeset --empty`) to record the
intent.

## How the release happens

When a PR with changesets merges to `main`:

1. The `release` workflow runs the Changesets GitHub action, which
   either:
   - Opens / updates a **"Version Packages"** PR that consumes the
     pending changesets, bumps `package.json` versions, regenerates
     `CHANGELOG.md` files, and rewrites `workspace:*` ranges to the
     resolved semver, OR
   - If a Version Packages PR already exists and the new merge brought
     more changesets, updates that same PR.
2. A maintainer reviews the Version Packages PR. The diff is purely
   mechanical — verify the bump levels match expectations and the
   changelog entries read well, then merge.
3. On merge of the Version Packages PR, the same `release` workflow
   runs `changeset publish`, which publishes the bumped packages to
   npm with `provenance: true` (see §6 of `STRUCTURE.md` and the npm
   provenance docs) and pushes the matching git tags.

## What about `@codegraph/action`?

The GitHub Action is **not** published to npm — GitHub Actions are
consumed by reference (`uses: plinth/action@v1`). It is listed under
`ignore` in `config.json` so Changesets won't try to publish it.

Releasing the action is a separate flow:

- Tag a commit on `main` with `action-v<X.Y.Z>` (e.g. `action-v1.4.0`).
- The `release-action` job runs `scripts/publish-action.sh`, which
  bundles the action's `dist/` and force-pushes it to two ref names:
  the exact-version tag (`v1.4.0`) and the major-version moving tag
  (`v1`). Consumers pin via `uses: plinth/action@v1` for the moving
  major or `uses: plinth/action@v1.4.0` for an exact pin.

The action version is intentionally separate from the npm packages so
GitHub Action consumers and npm consumers can move at independent
cadences. See `scripts/publish-action.sh` for the publish mechanics.

## Concretely: a typical PR flow

```bash
git checkout -b feat/some-thing
# ... write code, tests pass, lint clean ...
pnpm changeset
# answer the prompts; one .changeset/*.md file is written
git add .changeset/some-name.md
git commit -m "feat(core): add Some Thing"
git push -u origin feat/some-thing
# open PR, merge when green
```

The Version Packages PR will show up shortly after merge. Don't be
surprised.

## More

- Changesets docs: <https://github.com/changesets/changesets>
- Repo structure & version policy: `STRUCTURE.md` §6
- Contributing in general: `CONTRIBUTING.md`
