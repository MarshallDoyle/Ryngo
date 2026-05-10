# Privacy

codegraph collects no telemetry. There is no analytics service, no error
reporter, no opt-in "help us improve" toggle, no remote configuration
fetch. Your source code never leaves your machine, your CI runner, or
your network. This document is the audit-ready statement of that
promise.

If you find a network call from `packages/core` or `packages/cli` that
this document does not list, treat it as a bug and file an issue. The
`scripts/audit-network-calls.ts` job in CI is the mechanical
counterpart to this document — it fails the build on any new outbound
call that is not explicitly justified.

## What we do not do

- We do not ship a telemetry SDK (no Sentry, Datadog, PostHog, Segment,
  Amplitude, Mixpanel, Google Analytics, Plausible, Fathom, or anything
  similar).
- We do not collect crash reports. Errors stay in your terminal or your
  CI logs.
- We do not check for updates over the network. The CLI does not call
  the npm registry, GitHub, or any "latest version" endpoint at runtime.
- We do not phone home from `codegraph index`, `codegraph diff`,
  `codegraph serve`, or `codegraph export`. These commands are
  hermetic — same input, same output, no sockets opened.
- We do not embed a hosted backend. There is no codegraph.com API. The
  product is the binary in your `node_modules` and the static viewer it
  bundles.
- We do not run a license server. MIT means MIT.
- We do not require an account, an API key, or a token of any kind to
  use the CLI.

## The complete list of reasons the binary may make a network call

This is exhaustive. If you find a call that does not match one of these
entries, that is a bug.

### 1. The user explicitly invokes a subcommand that needs the network

Today the CLI has zero such subcommands. If a future release adds one
(for example, `codegraph publish` to upload an IR to a self-hosted
artifact store), it will be (a) opt-in by an explicit subcommand the
user types, (b) documented in `docs/cli.md`, and (c) listed here in a
new entry before the release ships.

### 2. The GitHub Action posts a PR comment

`packages/action` runs on your GitHub-hosted or self-hosted runner. It
calls the GitHub REST API exactly twice per run:

- `POST /repos/{owner}/{repo}/issues/{pr}/comments` to post the diff
  comment (only when `comment: true`, which is the default).
- `POST /repos/{owner}/{repo}/check-runs` to mark the check status
  (only when `fail-on:` is configured with at least one rule).

These calls go to the GitHub API your workflow already authenticates
against via `GITHUB_TOKEN`. They are made by `@actions/github`, not by
`@codegraph/core` or `@codegraph/cli`, and they only happen inside the
Action wrapper. Running the CLI locally never makes these calls.

### 3. Integration tests clone a fixture repo

The integration suite under `packages/cli/test/integration/` may clone
small public fixture repositories from GitHub during `pnpm
test:integration`. This happens only when running the project's own
test suite — never when an end user runs the CLI. The fixtures are
listed in `test-fixtures/README.md` and are pinned to specific commit
SHAs.

### 4. Tree-sitter grammars at install time

The CLI depends on `tree-sitter` language grammar packages. Some
grammars (notably `tree-sitter-rust`, `tree-sitter-go`) ship as
prebuilt native binaries that npm/pnpm fetch from
`https://github.com/<grammar>/releases` during `pnpm install`. This is
the package manager's normal install behavior, not codegraph code, and
it happens once at install — never during `codegraph index` or any
other runtime command. We deliberately do not list any grammar with a
postinstall download script in our direct dependencies; transitive
grammar binaries are the only exception, and we audit them on each
upgrade.

### 5. Nothing else

There are no other reasons. The audit script enforces it.

## Where the rule is enforced in code

- `scripts/audit-network-calls.ts` greps `packages/core/src/` and
  `packages/cli/src/` for `fetch(`, `https.request(`, `http.request(`,
  `XMLHttpRequest`, `axios`, `got`, `node-fetch`, `undici`. Any match
  without an immediately preceding `// codegraph:network-ok <reason>`
  comment fails the build.
- The CI workflow runs the audit script on every PR. A PR that
  introduces an unjustified network call cannot merge.
- `packages/cli/src/net.ts` is intentionally a single file with a
  single export: a function that throws. It exists so a future
  contributor who reaches for `fetch` finds a clear "we do not do this
  here" landing pad first.

## Local data the CLI writes

For completeness, here is everything the CLI writes to disk. None of
it leaves your machine.

| Path                                  | What                              | When                                  |
| ------------------------------------- | --------------------------------- | ------------------------------------- |
| `./.codegraph/graph.json`             | The IR document                   | `codegraph index`                     |
| `./.codegraph/cache/`                 | Per-file SCIP + adapter cache     | `codegraph index` (incremental)       |
| `./.codegraph/diff.json`              | Last computed diff                | `codegraph diff`                      |
| `~/.cache/codegraph/grammars/`        | Tree-sitter grammar artifacts     | First `codegraph index` per machine   |

Delete any of these at any time. The CLI will rebuild what it needs.

## The viewer

`codegraph serve` binds to `127.0.0.1:4747` by default. It serves the
prebuilt static viewer from `node_modules/@codegraph/viewer/dist/` and
reads the local IR file. It does not open an outbound socket. Pass
`--host` to bind to another interface; we do not change the loopback
default because we believe most users want a localhost-only viewer.

The viewer itself, when loaded in the browser, fetches only the IR
JSON from the same origin the CLI is serving. It loads no third-party
scripts, no fonts from CDNs, no analytics beacons.

## Reporting a privacy concern

If you believe codegraph is making a network call this document does
not cover, please file an issue with the `privacy` label, or, if the
issue is sensitive, email **security@codegraph.dev** (see
`SECURITY.md`).

## Changes to this document

This file is versioned with the source. Any change to the network
behavior of the CLI or core packages must update this document in the
same PR — that is enforced by a `CODEOWNERS` review requirement on
`PRIVACY.md` and by the audit script which reads its whitelist from
this file's reasons table.
