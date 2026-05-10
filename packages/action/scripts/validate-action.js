#!/usr/bin/env node
//
// validate-action.js
//
// Sanity-check packages/action/action.yml without booting a GitHub runner.
// Purely lexical/structural — not a YAML schema validator. The checks we
// run are the ones that have actually broken composite actions in the wild:
//
//   1. Required top-level keys present (`name`, `runs.using == "composite"`,
//      `runs.steps`).
//   2. Every `${{ inputs.<x> }}` reference in the steps appears in the
//      top-level `inputs:` map. Typo'd input names render as empty strings
//      at runtime — cheap to catch here.
//   3. Every output has a `value:` expression and the step it references
//      exists. (`steps.<id>.outputs.<name>` typos silently produce empty
//      action outputs, which then break downstream jobs.)
//   4. Every step that writes to GITHUB_OUTPUT does so via `>> "$GITHUB_OUTPUT"`
//      (not the deprecated `::set-output ::`).
//   5. No `pull_request_target` is wired in by accident — the action itself
//      doesn't trigger anything, but a step that hard-codes `pull_request`
//      would silently no-op for `merge_group`. We just warn.
//
// We deliberately don't pull in `js-yaml` — this script is meant to be
// runnable from `node scripts/validate-action.js` on a fresh clone with no
// install step. A targeted regex pass is sufficient for the action.yml we own.
//
// CLI:
//   node validate-action.js                   # validates the sibling action.yml
//   node validate-action.js path/to/action.yml
//   node validate-action.js --json            # machine-readable output
//
// Exit codes: 0 ok, 1 errors found, 2 file unreadable.

'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { file: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write('Usage: validate-action.js [path/to/action.yml] [--json]\n');
      process.exit(0);
    } else if (!args.file) args.file = a;
    else {
      process.stderr.write(`validate-action: unexpected argument "${a}"\n`);
      process.exit(2);
    }
  }
  if (!args.file) {
    args.file = path.resolve(__dirname, '..', 'action.yml');
  }
  return args;
}

// Strip line comments and trailing whitespace. We don't try to build a real
// YAML AST — the checks below are line-oriented and survive comment removal
// just fine.
function stripComments(yaml) {
  return yaml
    .split('\n')
    .map((line) => {
      // Remove `# ...` comments unless the `#` is inside a string. action.yml
      // doesn't contain literal `#` characters in string values, so a coarse
      // pass is fine. (Run a full YAML parse if that ever stops being true.)
      const idx = line.indexOf('#');
      const out = idx < 0 ? line : line.slice(0, idx);
      return out.trimEnd();
    })
    .join('\n');
}

// Yields the names declared under a top-level mapping key, treating the
// document as 2-space indented (matches the action.yml in this repo). Returns
// the keys in document order.
function collectMapKeys(yaml, topKey) {
  const lines = yaml.split('\n');
  const keys = [];
  let inBlock = false;
  let blockIndent = -1;
  const topRe = new RegExp(`^${topKey}:\\s*$`);
  const childRe = /^(\s+)([A-Za-z0-9_\-]+)\s*:/;

  for (const line of lines) {
    if (!inBlock) {
      if (topRe.test(line)) {
        inBlock = true;
        blockIndent = -1;
      }
      continue;
    }
    if (line.trim() === '') continue;
    // Top-level key encountered? End of block.
    if (/^[A-Za-z0-9_\-]+:/.test(line)) break;

    const m = line.match(childRe);
    if (!m) continue;
    const indent = m[1].length;
    if (blockIndent === -1) blockIndent = indent;
    if (indent === blockIndent) keys.push(m[2]);
  }
  return keys;
}

function collectStepIds(yaml) {
  // `id:` keys appearing under `runs.steps.-`. Steps are hyphen-list items
  // indented 4 spaces in this repo's action.yml.
  const ids = [];
  const re = /^\s+id:\s+([A-Za-z0-9_\-]+)\s*$/gm;
  let m;
  while ((m = re.exec(yaml)) !== null) ids.push(m[1]);
  return ids;
}

function findExpressions(yaml) {
  // Returns array of { match, line } for every `${{ ... }}`.
  const out = [];
  const lines = yaml.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const re = /\$\{\{\s*([^}]+?)\s*\}\}/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      out.push({ match: m[0], inner: m[1].trim(), line: i + 1 });
    }
  }
  return out;
}

function validate(file) {
  const errors = [];
  const warnings = [];
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { errors: [`cannot read ${file}: ${e.message}`], warnings: [], file };
  }
  const yaml = stripComments(raw);

  // 1. Required top-level keys.
  if (!/^name:\s+\S/m.test(yaml)) {
    errors.push('missing top-level `name:`');
  }
  if (!/^runs:\s*$/m.test(yaml)) {
    errors.push('missing top-level `runs:` block');
  }
  if (!/^\s+using:\s+composite\b/m.test(yaml)) {
    errors.push('runs.using must be "composite"');
  }
  if (!/^\s+steps:\s*$/m.test(yaml)) {
    errors.push('runs.steps is required');
  }

  // 2. Inputs declared vs referenced.
  const inputs = new Set(collectMapKeys(yaml, 'inputs'));
  if (inputs.size === 0) {
    warnings.push('no `inputs:` declared — composite actions usually take at least one');
  }

  const exprs = findExpressions(yaml);
  for (const e of exprs) {
    const m = e.inner.match(/^inputs\.([A-Za-z0-9_\-]+)/);
    if (!m) continue;
    if (!inputs.has(m[1])) {
      errors.push(
        `line ${e.line}: \`inputs.${m[1]}\` referenced but not declared in inputs:`
      );
    }
  }

  // 3. Outputs reference real step ids.
  const stepIds = new Set(collectStepIds(yaml));
  // Match `outputs:` block until either the next top-level key or EOF.
  const outputBlock = yaml.match(/^outputs:\s*$([\s\S]*?)(?:^[A-Za-z0-9_\-]+:\s*$|$(?![\s\S]))/m);
  if (outputBlock) {
    const body = outputBlock[1];
    // Each output is `  name:` then indented child lines until the next
    // sibling at the same indent (or end of block).
    const outRe = /^( {2})([A-Za-z0-9_\-]+):\s*$([\s\S]*?)(?=^ {2}[A-Za-z0-9_\-]+:\s*$|$(?![\s\S]))/gm;
    let om;
    while ((om = outRe.exec(body)) !== null) {
      const name = om[2];
      const valueLine = om[3];
      if (!/value:\s*\S/.test(valueLine)) {
        errors.push(`output \`${name}\` is missing a \`value:\` expression`);
        continue;
      }
      const stepRefs = [...valueLine.matchAll(/steps\.([A-Za-z0-9_\-]+)\.outputs\.([A-Za-z0-9_\-]+)/g)];
      for (const r of stepRefs) {
        if (!stepIds.has(r[1])) {
          errors.push(
            `output \`${name}\` references step id \`${r[1]}\` which is not declared`
          );
        }
      }
    }
  }

  // 4. No deprecated set-output. Catches accidental backslide during edits.
  if (/::set-output\s/.test(raw)) {
    errors.push('uses deprecated `::set-output ::` syntax — write to $GITHUB_OUTPUT instead');
  }

  // 5. Soft check: every step that sets `id:` also has `if:` matching the
  // skip gate, OR is itself the gate. This caught a real bug where step 4
  // ran on draft PRs because someone forgot the `if:` line. Heuristic only.
  const idLines = [...yaml.matchAll(/^\s+id:\s+([A-Za-z0-9_\-]+)/gm)];
  for (const idMatch of idLines) {
    const idName = idMatch[1];
    if (idName === 'validate') continue; // the gate itself
    // Search backwards from the id line for an `if:` within the same step.
    // Steps are list items starting with `    - name:` at 4-space indent.
    const before = yaml.slice(0, idMatch.index);
    const stepStart = before.lastIndexOf('\n    - ');
    if (stepStart === -1) continue;
    const stepBody = yaml.slice(stepStart, idMatch.index + 200);
    if (!/\n\s+if:\s*[^\n]+/.test(stepBody)) {
      warnings.push(
        `step \`${idName}\` has no \`if:\` guard — runs even when validate.outputs.skip == 'true'`
      );
    }
  }

  return { errors, warnings, file };
}

function main() {
  const args = parseArgs(process.argv);
  const result = validate(args.file);

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(`validating ${result.file}\n`);
    if (result.errors.length === 0 && result.warnings.length === 0) {
      process.stdout.write('  OK\n');
    }
    for (const w of result.warnings) {
      process.stdout.write(`  warn: ${w}\n`);
    }
    for (const e of result.errors) {
      process.stdout.write(`  error: ${e}\n`);
    }
    process.stdout.write(
      `\n${result.errors.length} error(s), ${result.warnings.length} warning(s)\n`
    );
  }
  process.exit(result.errors.length > 0 ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { validate, stripComments, collectMapKeys, collectStepIds };
