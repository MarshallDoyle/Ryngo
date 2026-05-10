# Security

This document covers vulnerability disclosure, supply-chain
commitments, and the runtime security posture of codegraph. For the
companion data-handling statement see `PRIVACY.md`.

## Reporting a vulnerability

Please report vulnerabilities privately. Do not open a public GitHub
issue.

- **Email:** security@codegraph.dev
- **PGP key:** published at `https://codegraph.dev/.well-known/pgp.asc`
  (fingerprint also pinned in `SECURITY.md` once the key is rotated)
- **GitHub Security Advisory:** also accepted via "Report a
  vulnerability" on the repository's Security tab

Include, when you can: a description, affected versions, reproduction
steps or a proof of concept, the impact you believe is realistic, and
whether you have already disclosed publicly anywhere.

### Response SLA

| Stage                        | Target                           |
| ---------------------------- | -------------------------------- |
| First human acknowledgement  | within 2 business days           |
| Triage decision (in/out)     | within 5 business days           |
| Fix ETA communicated         | within 10 business days          |
| Coordinated public disclosure | 90 days from triage, or earlier by mutual agreement |

If we miss any of these, escalate by replying to the original thread —
the maintainers rotate triage and someone will pick it up. We will
credit reporters in the advisory unless you ask us not to.

### Scope

In scope: every package under `packages/*` and `adapters/*` published
to npm under the `@codegraph/*` scope, the `@codegraph/action` GitHub
Action, and the bundled viewer.

Out of scope: third-party adapters not published by us (report to
their authors), the docs website's CMS, our Discord, anything labeled
"experimental" or "v0.0.x". Volumetric DoS that requires sustained
external traffic against a public service we operate is out of scope —
we operate no public services.

### Safe-harbor

We will not pursue legal action against good-faith research that
follows this policy: stays within scope, does not access data
belonging to other users, does not exfiltrate beyond a minimal proof
of concept, and follows the disclosure timeline above.

## Supply-chain commitments

These are the commitments codegraph maintainers make to keep the
shipped binary trustworthy. They are not aspirational — each is
enforced by tooling described below.

1. **No `postinstall`, `preinstall`, or `install` scripts in any
   package we publish.** Run `pnpm publish --ignore-scripts` against
   any of our packages and you get the same artifact you would
   otherwise. Enforced by a CI step that greps every `package.json`
   under `packages/*` and `adapters/*` for those script keys and
   fails the build if any are present.
2. **Pinned dependencies.** Direct dependencies in published packages
   use exact versions, not ranges. Renovate proposes upgrades; a human
   reviews each diff. The lockfile is checked in.
3. **Provenance via `npm publish --provenance`.** Every release builds
   from a tagged commit on GitHub Actions and publishes with npm
   provenance attached. Consumers can verify with `npm audit
   signatures`.
4. **Releases via Changesets.** Versioning and changelogs are
   generated from changesets, not authored by hand at release time.
   The release workflow is the only path that has the `NPM_TOKEN`
   secret; no maintainer publishes from a laptop.
5. **Two-factor on the npm scope.** The `@codegraph` npm
   organization requires 2FA for both publish and access changes.
6. **Signed Git tags.** Release tags are GPG-signed by a maintainer
   key listed in `MAINTAINERS.md`. CI refuses to publish a tag that is
   not signed by a key on the allowlist.
7. **No telemetry, no analytics dependencies.** Enforced by
   `scripts/audit-network-calls.ts` (see `PRIVACY.md`) and by a
   dependency allowlist that rejects `@sentry/*`, `posthog-*`,
   `@datadog/*`, and similar at lint time.
8. **SBOM published per release.** `pnpm dlx @cyclonedx/cyclonedx-npm
   --output-file sbom.json` runs in the release workflow and the SBOM
   is attached to the GitHub Release.

## Runtime security posture

codegraph is a static-analysis tool. It reads source files. It does
not execute them.

- **No code evaluation.** The CLI never `eval()`s, `Function()`s, or
  `child_process.spawn`s anything from the analyzed repository.
  Adapters parse source with tree-sitter and lift to IR — they do not
  invoke `require()` on user code, do not start a TypeScript program
  for type-aware lookups in a way that runs decorators or top-level
  side effects, and do not execute user-defined functions.
- **No shell-out on user paths.** The CLI does not call `git`, `pnpm`,
  `node`, or any other binary with user-supplied path arguments.
  Where we need git history (the diff command), we use a pure-JS git
  reader (`isomorphic-git`) on the local repository directory. No
  shell, no command injection surface.
- **Read-only file access.** `codegraph index` reads. The only paths
  the CLI writes are inside `.codegraph/` at the project root and the
  per-user grammar cache (see `PRIVACY.md`). Adapters cannot write
  outside this allowlist; the SDK exposes only a read-oriented file
  API.
- **No network at index time.** Verified by
  `scripts/audit-network-calls.ts`.
- **Loopback viewer by default.** `codegraph serve` binds
  `127.0.0.1`. Pass `--host 0.0.0.0` only on a trusted network.
- **No deserialization of attacker-controlled data.** The CLI parses
  user JSON only via `JSON.parse` plus Zod validation. There are no
  YAML loaders configured to instantiate types, no `eval`-shaped
  loaders, no pickle equivalents.
- **Adapter sandboxing.** Adapters are loaded via dynamic `import()`
  and run in the same Node process. We do not claim adapter
  isolation: a malicious adapter installed in your `node_modules`
  could read files the CLI can read. Treat adapters with the same
  trust as any other npm dependency, and prefer first-party adapters
  unless you have reviewed the source. We are tracking a future
  Worker-based adapter sandbox in `ROADMAP.md`.

## Known non-issues we get asked about

- **"Does the viewer phone home?"** No. See `PRIVACY.md`.
- **"Can a malicious repo cause RCE during indexing?"** Not by any
  mechanism we are aware of. We do not execute, eval, or shell out to
  source-controlled inputs. A specific malicious repo could try to
  make the indexer slow or memory-hungry; we treat that as a
  reliability issue, not a security one, and we have per-file timeouts
  and resource caps configured in `packages/cli/src/limits.ts`.
- **"What about prototype pollution in the IR?"** The IR is built
  through Zod-validated constructors that use `Object.create(null)`
  or class instances. There is no merging of user JSON into shared
  objects.

## Versions we patch

Current major and the previous major. Anything older is end-of-life
unless a critical issue affects a large user we know about, in which
case we may backport at our discretion.

| codegraph version | Status                       |
| ----------------- | ---------------------------- |
| 0.x               | Active, security-fixed       |

We will update this table at the 1.0 release.

## Changes to this document

Changes to security commitments require a maintainer review and a
note in the release changelog. The CODEOWNERS file requires a
maintainer review on `SECURITY.md`.
