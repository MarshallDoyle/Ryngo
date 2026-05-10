#!/usr/bin/env node
//
// compute-refs.js
//
// Resolve the (base, head) SHA pair the codegraph action should diff against,
// reading the event payload at $GITHUB_EVENT_PATH. Writes the result as
// `name=value` lines to $GITHUB_OUTPUT (or stdout when run outside a runner)
// in the GitHub Actions output format:
//
//   base-sha=<sha>
//   head-sha=<sha>
//   head-repo=<owner/repo>          # for actions/checkout `repository:`
//   pr-number=<n|empty>             # empty on merge_group / workflow_dispatch
//   skip=<true|false>               # true on draft PRs unless overridden
//   skip-reason=<short string>      # populated when skip=true
//
// Why a Node script instead of inline shell?
//   - The pull_request payload's `head.sha` is the *real* PR head, but the
//     runner's $GITHUB_SHA is a synthetic merge commit. Mixing the two has
//     bitten us before. Reading from the JSON payload directly keeps every
//     event type honest and unit-testable.
//   - Force-push handling: GitHub re-fires `synchronize` with a fresh
//     payload whose `head.sha` is the new tip. As long as we always read
//     from the payload (never `git rev-parse HEAD`), force-pushes Just Work.
//   - Merge-commit avoidance: same reason — `GITHUB_SHA` on pull_request is
//     `refs/pull/<n>/merge`, which is the merge of head into base. Diffing
//     base→merge would understate the PR by definition (the merge commit is
//     base + head). We diff base.sha→head.sha.
//
// CLI:
//   node compute-refs.js                      # reads env, writes outputs
//   node compute-refs.js --event-path <path>  # override (for tests)
//   node compute-refs.js --print              # pretty-print to stdout, no GITHUB_OUTPUT write
//
// Exit codes: 0 success, 1 unsupported event, 2 malformed payload.

'use strict';

const fs = require('fs');

const SUPPORTED_EVENTS = new Set([
  'pull_request',
  'pull_request_target',
  'merge_group',
  'workflow_dispatch',
]);

function parseArgs(argv) {
  const args = { eventPath: null, print: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--event-path') {
      args.eventPath = argv[++i];
    } else if (a === '--print') {
      args.print = true;
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: compute-refs.js [--event-path <path>] [--print]\n'
      );
      process.exit(0);
    } else {
      process.stderr.write(`compute-refs: unknown argument "${a}"\n`);
      process.exit(2);
    }
  }
  return args;
}

function readEvent(eventPath) {
  if (!eventPath) {
    throw new Error(
      'GITHUB_EVENT_PATH is not set; pass --event-path for local testing'
    );
  }
  let raw;
  try {
    raw = fs.readFileSync(eventPath, 'utf8');
  } catch (e) {
    const err = new Error(`cannot read event payload at ${eventPath}: ${e.message}`);
    err.code = 'EVENT_READ';
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    const err = new Error(`event payload is not valid JSON: ${e.message}`);
    err.code = 'EVENT_PARSE';
    throw err;
  }
}

function isSha(s) {
  return typeof s === 'string' && /^[0-9a-f]{7,40}$/i.test(s);
}

// Accept truthy strings from env or workflow inputs. GitHub stringifies all
// inputs so 'true' / 'false' is what we actually receive.
function isTruthy(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

// Resolve refs for one event. Returns
//   { baseSha, headSha, headRepo, prNumber, skip, skipReason }
// Throws on any malformed payload — callers map to exit code 2.
function resolveRefs(eventName, payload, env) {
  const out = {
    baseSha: '',
    headSha: '',
    headRepo: '',
    prNumber: '',
    skip: false,
    skipReason: '',
  };

  if (!SUPPORTED_EVENTS.has(eventName)) {
    const err = new Error(
      `unsupported event "${eventName}"; supported: ${[...SUPPORTED_EVENTS].join(', ')}`
    );
    err.code = 'UNSUPPORTED_EVENT';
    throw err;
  }

  if (eventName === 'merge_group') {
    const mg = payload.merge_group;
    if (!mg || !isSha(mg.base_sha) || !isSha(mg.head_sha)) {
      const err = new Error('merge_group payload missing base_sha/head_sha');
      err.code = 'BAD_PAYLOAD';
      throw err;
    }
    out.baseSha = mg.base_sha;
    out.headSha = mg.head_sha;
    // merge_group runs in the base repo, never a fork.
    out.headRepo = (payload.repository && payload.repository.full_name) || '';
    return out;
  }

  if (eventName === 'workflow_dispatch') {
    // workflow_dispatch isn't tied to a PR, so refs come from inputs or env.
    // Convention (documented in action README §workflow_dispatch usage):
    //   inputs.base_sha / inputs.head_sha — explicit override (preferred), OR
    //   env CODEGRAPH_BASE_SHA / CODEGRAPH_HEAD_SHA — same thing without
    //     plumbing a workflow input.
    // If neither is set, fall back to (default branch HEAD, GITHUB_SHA). The
    // caller is on their own to make sure GITHUB_SHA is what they want.
    const inputs = (payload.inputs && typeof payload.inputs === 'object') ? payload.inputs : {};
    const baseSha = inputs.base_sha || env.CODEGRAPH_BASE_SHA || '';
    const headSha = inputs.head_sha || env.CODEGRAPH_HEAD_SHA || env.GITHUB_SHA || '';

    if (!isSha(headSha)) {
      const err = new Error(
        'workflow_dispatch: no head SHA available (set inputs.head_sha or CODEGRAPH_HEAD_SHA)'
      );
      err.code = 'BAD_PAYLOAD';
      throw err;
    }
    if (!isSha(baseSha)) {
      const err = new Error(
        'workflow_dispatch: no base SHA available (set inputs.base_sha or CODEGRAPH_BASE_SHA)'
      );
      err.code = 'BAD_PAYLOAD';
      throw err;
    }
    out.baseSha = baseSha;
    out.headSha = headSha;
    out.headRepo = (payload.repository && payload.repository.full_name) || '';
    return out;
  }

  // pull_request and pull_request_target share the same shape.
  const pr = payload.pull_request;
  if (!pr || !pr.base || !pr.head) {
    const err = new Error(
      `${eventName} payload missing pull_request.{base,head}`
    );
    err.code = 'BAD_PAYLOAD';
    throw err;
  }
  if (!isSha(pr.base.sha) || !isSha(pr.head.sha)) {
    const err = new Error(
      `${eventName} payload has non-SHA values for base.sha/head.sha`
    );
    err.code = 'BAD_PAYLOAD';
    throw err;
  }
  out.baseSha = pr.base.sha;
  out.headSha = pr.head.sha;
  // For pull_request from a fork, head.repo.full_name is `fork-owner/repo`.
  // For pull_request from a same-repo branch, it's the same repo. Either way,
  // actions/checkout needs this string verbatim.
  out.headRepo = (pr.head.repo && pr.head.repo.full_name)
    || (payload.repository && payload.repository.full_name)
    || '';
  out.prNumber = String(pr.number || payload.number || '');

  if (pr.draft && !isTruthy(env.CODEGRAPH_RUN_ON_DRAFT)) {
    out.skip = true;
    out.skipReason = 'draft PR (set CODEGRAPH_RUN_ON_DRAFT=true to override)';
  }

  return out;
}

function emitOutputs(result, options) {
  // Lines must use the modern `name=value` syntax. Multi-line values would
  // need the heredoc form, but every value here is a single token.
  const lines = [
    `base-sha=${result.baseSha}`,
    `head-sha=${result.headSha}`,
    `head-repo=${result.headRepo}`,
    `pr-number=${result.prNumber}`,
    `skip=${result.skip ? 'true' : 'false'}`,
    `skip-reason=${result.skipReason}`,
  ];
  const text = lines.join('\n') + '\n';

  if (options.print || !process.env.GITHUB_OUTPUT) {
    process.stdout.write(text);
    return;
  }
  fs.appendFileSync(process.env.GITHUB_OUTPUT, text);
}

function main() {
  const args = parseArgs(process.argv);
  const eventPath = args.eventPath || process.env.GITHUB_EVENT_PATH || null;
  const eventName = process.env.GITHUB_EVENT_NAME || '';

  if (!eventName) {
    process.stderr.write('compute-refs: GITHUB_EVENT_NAME is not set\n');
    process.exit(1);
  }

  let payload;
  try {
    payload = readEvent(eventPath);
  } catch (e) {
    process.stderr.write(`compute-refs: ${e.message}\n`);
    process.exit(2);
  }

  let result;
  try {
    result = resolveRefs(eventName, payload, process.env);
  } catch (e) {
    process.stderr.write(`compute-refs: ${e.message}\n`);
    process.exit(e.code === 'UNSUPPORTED_EVENT' ? 1 : 2);
  }

  emitOutputs(result, args);
}

if (require.main === module) {
  main();
}

module.exports = { resolveRefs, isSha, isTruthy, SUPPORTED_EVENTS };
