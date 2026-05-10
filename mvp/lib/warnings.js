/**
 * Heuristic CS-style warnings per function body.
 *
 * Pure function. Runs alongside the existing extractCalls / extractDefs
 * passes — gets the function's body text + param list and returns an
 * array of `{ kind, severity, message }` warnings for the IR to expose
 * on `node.data.warnings`. The viewer paints a small ⚠ badge on any
 * node with warnings.
 *
 * What this is and isn't:
 *   - It's a fast regex + indent-tracking heuristic. Catches "smells"
 *     like nested loops over the same collection, sequential network
 *     I/O in a loop, recursion without memoization. Not a static
 *     analyzer; will have false positives.
 *   - It is NOT a replacement for runtime profiling, big-O proofs, or a
 *     real linter. The point is "you should look at this," not "this
 *     is incorrect."
 *
 * Catalog (severity):
 *   nested-loop          medium   2-deep nested for/while
 *   triple-nested-loop   high     3+ deep — almost always avoidable
 *   io-in-loop           high     fetch / requests / axios / prisma in a loop
 *   recursion            low      function calls itself, no memo cue
 *   long-function        low      > 60 source lines
 *   many-params          low      > 6 parameters
 *   deep-nesting         low      > 5 indent levels (Python) / brace depth (TS)
 */

const TS_LOOP_RE = /\b(for|while)\s*\(/g;
const PY_LOOP_LINE_RE = /^\s*(for|while)\s/;
const IO_PATTERNS = [
  /\bawait\s+fetch\s*\(/,
  /\baxios\.(?:get|post|put|patch|delete|head|options|request)\s*\(/,
  /\brequests\.(?:get|post|put|patch|delete|head|options|request)\s*\(/,
  /\burllib\.request\.urlopen\s*\(/,
  /\bhttpx\.(?:AsyncClient\(\)\.)?(?:get|post|put|patch|delete)\s*\(/,
  /\bprisma\.\w+\.(?:findMany|findFirst|findUnique|create|update|delete|upsert)\s*\(/,
  /\bsession\.(?:execute|query|add|delete|commit)\s*\(/,
  /\b(?:db|database)\.(?:query|select|insert|update|delete)\s*\(/,
];

export function detectWarnings(body, params, name, lang) {
  if (!body || typeof body !== "string") return [];
  const warnings = [];

  // Skip the def header line so recursion + long-fn checks don't
  // count it. The first line is the function signature.
  const lines = body.split("\n");
  const inside = lines.slice(1).join("\n");

  // long-function — heuristic threshold; small functions are often
  // pure transformations, long ones almost always have multiple
  // responsibilities worth surfacing.
  if (lines.length > 60) {
    warnings.push({
      kind: "long-function",
      severity: "low",
      message: `${lines.length} lines — consider splitting`,
    });
  }
  if (params && params.length > 6) {
    warnings.push({
      kind: "many-params",
      severity: "low",
      message: `${params.length} parameters — consider an options object`,
    });
  }

  const nesting =
    lang === "py" ? maxLoopNestingPy(lines) : maxLoopNestingTs(inside);
  if (nesting >= 3) {
    warnings.push({
      kind: "triple-nested-loop",
      severity: "high",
      message: `${nesting}-deep nested loops · ≈ O(n^${nesting})`,
    });
  } else if (nesting === 2) {
    warnings.push({
      kind: "nested-loop",
      severity: "medium",
      message: "2-deep nested loops · potentially O(n²)",
    });
  }

  if (loopContainsIO(inside, lang)) {
    warnings.push({
      kind: "io-in-loop",
      severity: "high",
      message: "I/O call inside a loop · likely sequential fetches / N+1 query",
    });
  }

  if (name && callsItself(inside, name) && !hasMemoCue(inside, lang)) {
    warnings.push({
      kind: "recursion",
      severity: "low",
      message: "recursive · consider memoization for cacheable inputs",
    });
  }

  const depth =
    lang === "py" ? maxIndentLevels(lines) : maxBraceDepth(inside);
  if (depth > 5) {
    warnings.push({
      kind: "deep-nesting",
      severity: "low",
      message: `${depth}-deep ${lang === "py" ? "indent" : "brace"} levels`,
    });
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Nested-loop detection
// ---------------------------------------------------------------------------

function maxLoopNestingTs(text) {
  let max = 0;
  let braceDepth = 0;
  const stack = []; // brace depths at which a loop block opened
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "{") {
      braceDepth++;
    } else if (c === "}") {
      braceDepth--;
      while (stack.length && stack[stack.length - 1] > braceDepth) stack.pop();
    } else if (c === "f" || c === "w") {
      // Match `for (` / `for (`-with-let / `while (`. Only at a
      // word boundary so `forEach` / identifier `forX` don't trip.
      if (i > 0 && /\w/.test(text[i - 1])) {
        i++;
        continue;
      }
      const tail = text.slice(i, i + 8);
      const m = tail.match(/^(for|while)\b/);
      if (m) {
        // Look ahead for the next `{` that opens this loop's body.
        // Track parens depth so the for-header `(`s/`)`s don't count.
        const start = i + m[0].length;
        let depth = 0;
        let braceFound = false;
        for (let k = start; k < text.length && k < start + 200; k++) {
          if (text[k] === "(") depth++;
          else if (text[k] === ")") depth--;
          else if (text[k] === "{" && depth <= 0) {
            braceFound = true;
            stack.push(braceDepth + 1);
            max = Math.max(max, stack.length);
            break;
          } else if (text[k] === ";" && depth <= 0) {
            // Single-statement loop, no brace block. Still a loop —
            // count it as briefly opening at the current depth.
            break;
          }
        }
        if (!braceFound) {
          // Single-line loop: treat it as a no-op nesting bump for the
          // current statement; we don't push to stack since there's no
          // block to track.
        }
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return max;
}

function maxLoopNestingPy(lines) {
  // Python uses indentation. Track a stack of (indent, isLoop) per
  // currently-open scope. A loop is "nested" if there's already a loop
  // scope on the stack.
  const stack = [];
  let max = 0;
  for (const line of lines) {
    const trimmed = line.replace(/\s+$/, "");
    if (!trimmed.trim()) continue;
    const indent = line.match(/^[ \t]*/)[0].replace(/\t/g, "    ").length;
    while (stack.length && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    if (PY_LOOP_LINE_RE.test(line)) {
      stack.push({ indent, isLoop: true });
      const loopCount = stack.filter((s) => s.isLoop).length;
      if (loopCount > max) max = loopCount;
    } else if (/^\s*(if|elif|else|with|try|except|finally|def|class|async\s+def)\b/.test(line)) {
      stack.push({ indent, isLoop: false });
    }
  }
  return max;
}

// ---------------------------------------------------------------------------
// I/O in loop
// ---------------------------------------------------------------------------

function loopContainsIO(text, lang) {
  // Cheap test: is there a loop that contains, somewhere within ~30
  // following lines, an I/O call? Doesn't guarantee the call is in
  // the loop's body, but it's a strong directional signal.
  const lines = text.split("\n");
  let inLoop = 0;
  let loopWindowLeft = 0;
  for (const line of lines) {
    const isLoopStart =
      lang === "py"
        ? PY_LOOP_LINE_RE.test(line)
        : /\b(?:for|while)\s*\(/.test(line);
    if (isLoopStart) {
      inLoop++;
      loopWindowLeft = 30;
    } else if (loopWindowLeft > 0) {
      loopWindowLeft--;
      if (loopWindowLeft === 0) inLoop = Math.max(0, inLoop - 1);
    }
    if (inLoop > 0) {
      for (const re of IO_PATTERNS) {
        if (re.test(line)) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Recursion (without memo)
// ---------------------------------------------------------------------------

function callsItself(body, name) {
  const re = new RegExp(`(?<![\\w.$])${escapeRegex(name)}\\s*\\(`);
  return re.test(body);
}

function hasMemoCue(body, lang) {
  if (lang === "py") {
    return /@(?:functools\.)?(?:lru_cache|cache|cached_property)/.test(body);
  }
  return /\bmemo(?:ize)?\b|\bcache\.(?:get|has)\s*\(/.test(body);
}

// ---------------------------------------------------------------------------
// Depth heuristics
// ---------------------------------------------------------------------------

function maxBraceDepth(text) {
  let depth = 0;
  let max = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      depth++;
      if (depth > max) max = depth;
    } else if (text[i] === "}") {
      depth = Math.max(0, depth - 1);
    }
  }
  return max;
}

function maxIndentLevels(lines) {
  // Convert tabs to 4 spaces, divide by 4 to count "levels". Skip
  // blank lines.
  let max = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.match(/^[ \t]*/)[0].replace(/\t/g, "    ").length;
    const level = Math.floor(indent / 4);
    if (level > max) max = level;
  }
  return max;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
