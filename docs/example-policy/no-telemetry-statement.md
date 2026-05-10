---
title: "Why codegraph collects no telemetry"
description: "The reasoning, the enforcement, and the small print behind codegraph's no-telemetry posture."
---

# Why codegraph collects no telemetry

Most developer tools you install today report something back to their
authors. Page views in the docs, error stacks from your laptop, command
invocations, sometimes file paths or environment variables. Usually
"anonymous". Almost always opt-out, not opt-in. Sometimes shipped via a
dependency you didn't pick.

codegraph collects none of it. Not at install. Not at index time. Not
when the viewer is open. Not when the GitHub Action runs. The binary
in your `node_modules` does not contain a single call to a telemetry
SDK, an analytics endpoint, or a "check for update" service.

This page is the long-form version of `PRIVACY.md`. The short version
lives at the root of the repo and is the contract; this page is the
explanation.

## The argument for no telemetry, even the "harmless" kind

We considered the standard pitch — anonymous usage counters, error
reporting, an opt-in beta channel — and rejected each one for reasons
specific to codegraph.

**Your source is the input.** codegraph reads the most sensitive thing
on your machine: the code your employer pays you to write. Even
metadata about that code (file paths, function names, framework
versions, error stack traces from inside our parser) leaks
architectural detail. A "minimal" error report from our parser would
include the file path, the symbol name we choked on, and a snippet of
the surrounding tokens. That is not minimal — that is the structure of
the codebase, sampled.

**Reviewers ship the artifact.** A graph diff from codegraph ends up
attached to a PR. Engineers paste it into Slack and review meetings.
That artifact has to be one any company can ship through any review
without asking "wait, where did this number get sent?". A telemetry
beacon — even a counted one — turns a static-analysis output into a
data-flow concern.

**Determinism is the product.** The graph is a pure function of the
source. Telemetry adds a side effect. Side effects in a tool that is
selling determinism are a contradiction we can't square.

**Air-gapped users matter.** A meaningful share of the people we want
as users — finance, healthcare, defense, regulated startups — operate
in environments where any unexpected outbound connection is an
incident. Building telemetry in and adding an "enterprise off switch"
is the wrong shape: the off switch becomes the configuration these
users have to verify on every release, in every CI run, on every dev
machine. "There is nothing to switch off" is a stronger commitment.

**A useful opt-in metric is a hard product to build.** Truly anonymous
counters that survive a privacy review are rare. The path of least
resistance is "send what you can and let legal sort it out", which is
how every tool ends up logging more than its README admits. We would
rather not start.

## What we are giving up

This is a real tradeoff and we want to be honest about it.

- We do not know how many people use codegraph beyond GitHub stars and
  npm download counts (which the registry collects on its own; we do
  not enrich them).
- We do not know which adapters are popular. We rely on issue
  threads, Discord traffic, and explicit feedback to prioritize.
- We cannot detect a regression "in the wild" before someone files an
  issue. There is no Sentry dashboard lighting up red — there is just
  the issue tracker.
- We cannot run product experiments. There is no "30% of users see
  the new layout, did it convert better?". We ship a thing, watch the
  PR and Discord, and decide.

We accept these costs.

## What "no telemetry" enforces in practice

Saying it isn't enough. Three mechanisms keep the promise honest:

1. **A network-call audit script.** `scripts/audit-network-calls.ts`
   greps the source for every common HTTP call shape (`fetch`,
   `axios`, `got`, `https.request`, `node-fetch`, `undici`,
   `XMLHttpRequest`). Any match must be preceded by a per-line
   comment of the form `// codegraph:network-ok <reason>`. Anything
   else fails the build. This runs on every PR.
2. **A dependency allowlist.** A lint rule rejects any dependency in
   the analytics / telemetry ecosystem (`@sentry/*`, `posthog-*`,
   `@datadog/*`, `mixpanel`, `amplitude`, etc.). Adding one requires
   editing the allowlist, which requires a maintainer review and a
   PRIVACY.md update in the same PR.
3. **An exhaustive PRIVACY.md.** Every legitimate reason the binary
   may make a network call is enumerated in `PRIVACY.md`. The audit
   script's whitelist comments are required to cite a reason that
   matches an entry there.

A maintainer cannot quietly add telemetry: doing so requires touching
a public document, the audit script, the allowlist, and getting a
review. The friction is the point.

## The boundary cases, listed

Here is every case where the binary or the project may make a network
call, and the rule that governs it.

| Component | When | Why we allow it |
| --- | --- | --- |
| `packages/core` | Never | Core is pure analysis. No allowlist entry exists. |
| `packages/cli` | Never at runtime | The CLI is hermetic. No allowlist entry exists. |
| `packages/viewer` | Same-origin fetch of the IR JSON | The viewer must read the file the CLI is serving. No third-party calls. |
| `packages/action` | GitHub API for PR comment + check status | The Action is the one place a network call is part of the user-visible job. Documented in `PRIVACY.md`. |
| Integration tests | Cloning fixture repos | Only when running our test suite, never end-user code. Pinned to commit SHAs. |
| Install time | Tree-sitter grammar prebuilt binaries | Standard npm install behavior, transitive dependency, runs once per machine. |

## What we tell enterprise reviewers

If you are the person on the security team approving codegraph for
your organization, the short version is:

- The MIT license travels with the source. You can vendor it.
- The binary makes no outbound calls at runtime; this is enforced by
  CI.
- The Action makes one or two GitHub API calls per PR using your own
  `GITHUB_TOKEN`, on your own runner.
- There is no codegraph-operated service to audit. There is no
  account, no API key, no licence server.
- Adapters are npm dependencies. Treat them with normal supply-chain
  scrutiny.
- The full posture is in `SECURITY.md`. The full data story is in
  `PRIVACY.md`. The audit script is in `scripts/audit-network-calls.ts`.

If your review needs more — a SOC 2 letter, a penetration test
report, a custom DPA — we are a small project; we can probably help,
and the place to start is `security@codegraph.dev`.

## What changes if we ever change our minds

If a future version of codegraph ever introduces telemetry, even
opt-in, the change will:

1. Land as a major version bump.
2. Update `PRIVACY.md` with the exact data shape, retention, and
   transport.
3. Update `SECURITY.md` if the change touches the supply chain.
4. Be announced in the release notes and on the docs site as a
   breaking change in posture, not a feature.
5. Default to off, and require an explicit opt-in flag the user sets
   themselves.

We do not plan to do this. We are writing the procedure down so that
if a future maintainer is tempted, the path is publicly committal
enough that it is harder than just shipping a quieter alternative.
