# Contributing to Plinth

Thanks for being here. Plinth is MIT-licensed, runs on a small group
of maintainers and a much larger group of contributors, and the
adapter ecosystem is the highest-leverage place outside contributors
can move the project forward.

This document covers the mechanics: setup, branching, commit style,
changesets, and the PR checklist. For the *what to build* side, the
public roadmap lives in [`ROADMAP.md`](ROADMAP.md) and the repo
layout lives in [`STRUCTURE.md`](STRUCTURE.md). Read those first if
you haven't.

## Code of conduct

Participation in this project is governed by the
[Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
Be kind, assume good faith, file issues respectfully. Maintainers
follow the same rules; if a maintainer falls short, escalate to
another maintainer or to the address listed in the Code of Conduct.

## Prerequisites

- **Node.js >= 20.11.0.** Pinned via `package.json#engines.node`.
- **pnpm >= 9.12.0.** Pinned via `package.json#packageManager`. The
  easiest path is to enable Corepack so the right pnpm version is
  selected automatically:
  ```bash
  corepack enable
  ```
- **Git.** Any modern version. We use ordinary `git` workflows; no
  signed commits or `git lfs` required.

## Getting set up

```bash
git clone https://github.com/<plinth-org>/<plinth-repo>
cd <plinth-repo>
pnpm install
pnpm build       # full topological build via turbo
pnpm test        # all tests
pnpm typecheck   # strict tsc --noEmit per package
pnpm lint
```

If `pnpm build` succeeds end-to-end on a clean clone, you're ready.

To work on a single package without rebuilding the world:

```bash
pnpm --filter @codegraph/core build
pnpm --filter @codegraph/core test
pnpm --filter @codegraph/core typecheck
```

The viewer's dev server:

```bash
pnpm dev:viewer
# → http://localhost:5173 (vite default)
```

## Branching and forks

- **Internal contributors**: branch off `main`. Branch names are free
  form — `feat/`, `fix/`, `refactor/`, `docs/` prefixes are common
  but not enforced.
- **External contributors**: fork the repo, branch off `main` in your
  fork, open a PR back to upstream `main`. The PR template will guide
  you the rest of the way.

We do **not** accept PRs that target a long-lived release branch.
Plinth uses Changesets for releases (see below) so there is only ever
one mainline.

## Conventional Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).
This is enforced softly — the CI does not block PRs on it, but
maintainers will rewrite squash-commit titles to conform before
merge. Doing it yourself saves a round trip.

Format:

```
<type>(<scope>): <short imperative summary>

<optional longer body explaining the why>

<optional footers, e.g. BREAKING CHANGE: ...>
```

Common types:

| Type        | Use for                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| `feat`      | A new user-visible capability.                                          |
| `fix`       | A bug fix.                                                              |
| `refactor`  | Internal restructuring, no behavior change.                             |
| `perf`      | Performance improvements.                                               |
| `docs`      | Documentation only.                                                     |
| `test`      | Adding or fixing tests.                                                 |
| `chore`     | Tooling, deps, repo housekeeping. Does not need a changeset by itself.  |
| `ci`        | Workflow / GitHub Actions changes.                                      |
| `build`     | Build system, bundler config.                                           |
| `revert`    | Revert a prior commit.                                                  |

Common scopes (not exhaustive):

- `core`, `cli`, `viewer`, `action`, `adapter-sdk`
- `adapter-express`, `adapter-fastapi`, `adapter-nextjs`, `adapter-prisma`
- `release`, `ci`, `docs`

A breaking change is denoted by a `!` after the type/scope **and** a
`BREAKING CHANGE:` footer:

```
feat(core)!: rename `Adapter.detect()` to `Adapter.matches()`

The old name caused confusion with the runtime feature-detection
adapters were doing inside `detect()`.

BREAKING CHANGE: third-party adapters need to rename `detect` to
`matches`. No other behavior changes.
```

Pre-1.0 we still call breaking changes out — see `STRUCTURE.md`
§6.2 for the version-policy implication.

## Adding a changeset

**Every PR that ships a user-visible change to a published package
needs a changeset.** A changeset is a short Markdown file that
declares which packages bump and why. Run:

```bash
pnpm changeset
```

The CLI prompts you to select packages and bump levels. It writes a
file like `.changeset/curly-pandas-dance.md`; commit it with the
rest of your PR.

PRs that don't need a changeset:

- Repo tooling (CI workflows, lint config, formatting).
- Private packages (anything with `"private": true`).
- Documentation that isn't published with a package.
- Tests, fixtures, comments.

If you're not sure, run `pnpm changeset` anyway — `patch` is always
a safe default. Or wait for the `changeset-bot` to leave a comment
on your PR.

The full changeset workflow (and how releases happen on merge) is
documented in [`.changeset/README.md`](.changeset/README.md).

## Code style

We use Prettier and ESLint. Both run in CI.

```bash
pnpm format         # rewrite files
pnpm format:check   # CI-style check
pnpm lint
pnpm lint:fix
```

Editor setup is up to you, but the repo includes Prettier and
ESLint configs that any modern editor with the matching extensions
will pick up automatically.

A few conventions that aren't auto-fixable:

1. **No emoji in source code, CLI output, or docs.** See
   `STRUCTURE.md` §9.1. The CLI uses `picocolors` for terminal
   coloring (and respects `NO_COLOR=1`). Docs follow the same
   convention.
2. **No default exports from libraries.** `core`, `adapter-sdk`, and
   `cli` use named exports only. Adapters are the sole exception —
   they `export default` an `Adapter` per the discovery contract.
3. **Tests live next to source.** `packages/core/src/diff/diff.test.ts`,
   not `packages/core/test/diff.test.ts`. Integration tests that need
   a fixture project go under `packages/<pkg>/test/integration/`.
4. **Strict TypeScript everywhere.** `tsconfig.base.json` sets every
   `strict` flag plus `noUncheckedIndexedAccess` and
   `exactOptionalPropertyTypes`. We don't make those opt-in.
5. **Public API is `src/index.ts`.** Anything else is private and
   unsupported. The lint config bans deep cross-package imports.

## Tests

- Unit tests use Vitest. `pnpm test:unit` runs them.
- Integration tests use the projects under `test-fixtures/`.
  `pnpm test:integration` runs them.
- New code that interacts with the IR (any change to types, schema,
  or the indexer) must have at least one test. New CLI subcommands
  must have a smoke test that runs the binary against a fixture.

## Adding a new adapter

The condensed checklist is in `STRUCTURE.md` §11. The longer guide
will live at `docs/adapter-authoring.md` (planned for v0.5+).

For first-party adapters, the workflow is:

1. Scaffold under `adapters/<framework>/`.
2. Implement and `export default` an `Adapter` (`@codegraph/adapter-sdk`).
3. Add `"codegraph-adapter"` to `keywords`.
4. Add a fixture under `test-fixtures/<framework>/`.
5. Wire a smoke test that runs `codegraph index` against the fixture.
6. Add a changeset.

Third-party adapters live in their own repo and publish to npm.
The CLI auto-discovers them via the `codegraph-adapter` keyword.

## PR checklist

Before opening a PR, run through this list:

- [ ] **Scope.** The PR touches one logical change. If it could
      reasonably be split into separate-and-mergeable PRs, split it.
- [ ] **Build.** `pnpm build` is green.
- [ ] **Tests.** `pnpm test` is green. New behavior has a test.
- [ ] **Typecheck.** `pnpm typecheck` is green.
- [ ] **Lint + format.** `pnpm lint` and `pnpm format:check` are
      green. (`pnpm format` rewrites; `pnpm format:check` is what
      CI runs.)
- [ ] **Changeset.** If the PR ships a user-visible change to a
      published package, `pnpm changeset` was run and the resulting
      file is committed.
- [ ] **Conventional Commit.** PR title follows `type(scope): summary`.
- [ ] **Docs.** README, STRUCTURE.md, ROADMAP.md, or per-package
      README updated when relevant. Especially:
      - New public export → reflected in package's section in
        `STRUCTURE.md`.
      - New CLI flag → reflected in `STRUCTURE.md` §4.2 table.
      - New adapter → reflected in the supported-frameworks table in
        the root `README.md`.
- [ ] **`packages/action/dist/`.** If you changed action source,
      rebuilt the bundle and committed `dist/`. CI will fail if the
      bundle is stale (`STRUCTURE.md` §4.4, §10 assumption 6).

The PR template will remind you of these on every PR.

## Reporting bugs and proposing features

- **Bugs.** Open an issue with the `bug` label. Include reproduction
  steps, the version of `@codegraph/cli` and any adapters, and the
  expected vs. actual graph output. If it's a graph-correctness bug,
  attaching a minimal `test-fixtures/` style reproduction is the
  fastest path to a fix.
- **Features.** Check `ROADMAP.md` first — your idea may already be
  on a milestone. If not, open an issue with the `proposal` label.
  Don't open a PR for a feature that hasn't been discussed in an
  issue first; we'd rather catch design feedback at the issue stage
  than at code-review stage.

## Maintainers

The current maintainers are listed in the `MAINTAINERS.md` file
(forthcoming). Until that exists, route maintainer-level questions
to the address in the Code of Conduct.

## Thanks

Plinth depends on every contribution. If this is your first time —
welcome.
