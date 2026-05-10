#!/usr/bin/env node
//
// format-summary.js
//
// Wrap the codegraph diff markdown for $GITHUB_STEP_SUMMARY. The job-summary
// surface has different rules than the PR sticky comment:
//
//   - No `<!-- codegraph -->` marker. Job summaries aren't deduped — each
//     run gets its own. The marker is dead weight here.
//   - No truncation. The 10 KB soft cap from design/pr-comment.md exists to
//     keep PR conversations scannable; the summary is a per-run archive that
//     reviewers consult only when they want depth. Show the whole breakdown.
//   - GitHub renders summaries with a 1 MB cap (per job step). We assert
//     well below that and bail with a friendly note if exceeded.
//   - Add an envelope: `## codegraph diff` heading, ref/SHA breadcrumb,
//     trailer with the runner-side artifact paths so a reviewer downloading
//     the job's artifacts knows what to look at.
//
// CLI:
//   node format-summary.js --diff <path> [--json <path>] \
//     [--base <sha>] [--head <sha>] [--pr <number>] \
//     [--viewer-url <url>] [--out <path>]
//
// Defaults:
//   --diff defaults to $CODEGRAPH_SUMMARY_PATH (set by action.yml step 9).
//   --out  defaults to $GITHUB_STEP_SUMMARY (the runner-provided file).
//
// Exit codes: 0 success, 1 missing diff input, 2 cap exceeded.

'use strict';

const fs = require('fs');
const path = require('path');

// GitHub's per-step summary cap is 1 MiB; we assert at 900 KiB to leave
// headroom for our envelope and the trailing newline GitHub adds.
const STEP_SUMMARY_CAP_BYTES = 900 * 1024;

function parseArgs(argv) {
  const args = {
    diff: null,
    json: null,
    base: '',
    head: '',
    pr: '',
    viewerUrl: '',
    out: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) {
        process.stderr.write(`format-summary: ${a} requires a value\n`);
        process.exit(1);
      }
      return v;
    };
    switch (a) {
      case '--diff': args.diff = next(); break;
      case '--json': args.json = next(); break;
      case '--base': args.base = next(); break;
      case '--head': args.head = next(); break;
      case '--pr': args.pr = next(); break;
      case '--viewer-url': args.viewerUrl = next(); break;
      case '--out': args.out = next(); break;
      case '--help':
      case '-h':
        process.stdout.write(
          'Usage: format-summary.js --diff <path> [--json <path>] ' +
          '[--base <sha>] [--head <sha>] [--pr <n>] [--viewer-url <url>] ' +
          '[--out <path>]\n'
        );
        process.exit(0);
        break;
      default:
        process.stderr.write(`format-summary: unknown argument "${a}"\n`);
        process.exit(1);
    }
  }
  return args;
}

function shortSha(sha) {
  if (typeof sha !== 'string') return '';
  return sha.length >= 7 ? sha.slice(0, 7) : sha;
}

// Build the envelope around the CLI-produced markdown. The CLI emits its own
// section structure (per design/pr-comment.md); we wrap it with breadcrumb
// metadata so the summary stands alone if downloaded as an artifact.
function renderSummary({ diffMd, base, head, pr, viewerUrl, jsonPath }) {
  const lines = [];
  lines.push('## codegraph diff');
  lines.push('');

  const breadcrumbBits = [];
  if (base && head) {
    breadcrumbBits.push(`<code>${shortSha(base)}…${shortSha(head)}</code>`);
  } else if (head) {
    breadcrumbBits.push(`<code>${shortSha(head)}</code>`);
  }
  if (pr) breadcrumbBits.push(`PR #${pr}`);
  if (viewerUrl) breadcrumbBits.push(`<a href="${viewerUrl}">open in viewer</a>`);
  if (breadcrumbBits.length > 0) {
    lines.push(breadcrumbBits.join(' &middot; '));
    lines.push('');
  }

  lines.push(diffMd.trimEnd());
  lines.push('');

  if (jsonPath) {
    lines.push('---');
    lines.push('');
    lines.push(
      `<sub>Machine-readable diff: <code>${jsonPath}</code> ` +
      '(downloadable from this run\'s artifacts).</sub>'
    );
    lines.push('');
  }

  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  const diffPath = args.diff || process.env.CODEGRAPH_SUMMARY_PATH || null;
  const outPath = args.out || process.env.GITHUB_STEP_SUMMARY || null;

  if (!diffPath) {
    process.stderr.write(
      'format-summary: --diff is required (or set CODEGRAPH_SUMMARY_PATH)\n'
    );
    process.exit(1);
  }
  if (!fs.existsSync(diffPath)) {
    process.stderr.write(`format-summary: diff file not found: ${diffPath}\n`);
    process.exit(1);
  }

  const diffMd = fs.readFileSync(diffPath, 'utf8');
  const summary = renderSummary({
    diffMd,
    base: args.base,
    head: args.head,
    pr: args.pr,
    viewerUrl: args.viewerUrl,
    jsonPath: args.json ? path.basename(args.json) : '',
  });

  const bytes = Buffer.byteLength(summary, 'utf8');
  if (bytes > STEP_SUMMARY_CAP_BYTES) {
    // Hard cap: don't try to truncate intelligently here — the CLI knows
    // its own markdown structure better than we do. Leave a marker for
    // the human running the workflow.
    const note = [
      '## codegraph diff',
      '',
      `> Diff summary too large for the job summary surface ` +
      `(${(bytes / 1024).toFixed(0)} KiB > ${(STEP_SUMMARY_CAP_BYTES / 1024)} KiB cap). ` +
      'See the run\'s artifacts for the full markdown / JSON.',
      '',
    ].join('\n');

    if (outPath) {
      fs.appendFileSync(outPath, note);
    } else {
      process.stdout.write(note);
    }
    process.exit(2);
  }

  if (outPath) {
    fs.appendFileSync(outPath, summary);
  } else {
    process.stdout.write(summary);
  }
}

if (require.main === module) {
  main();
}

module.exports = { renderSummary, shortSha, STEP_SUMMARY_CAP_BYTES };
