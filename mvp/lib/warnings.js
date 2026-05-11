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
 *   nested-loop              medium  2-deep nested for/while
 *   triple-nested-loop       high    3+ deep — almost always avoidable
 *   io-in-loop               high    fetch / requests / axios / prisma in a loop
 *   recursion                low     function calls itself, no memo cue
 *   long-function            low     > 60 source lines
 *   many-params              low     > 6 parameters
 *   deep-nesting             low     > 5 indent levels (Python) / brace depth (TS)
 *
 *   --- Phase 10.next (this commit) ---
 *
 *   Security (7):
 *   eval-or-function-ctor    high    eval / new Function / Python exec
 *   weak-crypto              medium  MD5 / SHA-1
 *   jwt-no-verify            high    jwt.decode without jwt.verify
 *   cors-allow-all           high    Access-Control-Allow-Origin: *
 *   requests-verify-false    high    Python verify=False / JS rejectUnauthorized:false
 *   hardcoded-password       high    string literal assigned to password/api_key/etc
 *   cookie-no-httponly       medium  res.cookie(...) without HttpOnly
 *
 *   Performance (5):
 *   sort-in-loop             high    .sort()/sorted() inside loop body
 *   string-concat-in-loop    medium  s += "..." inside loop body
 *   sync-io-in-async         high    async fn with fs.readFileSync etc.
 *   fetch-without-timeout    medium  fetch / requests.X without timeout
 *   regex-compile-in-loop    medium  new RegExp / re.compile inside loop body
 *
 *   Correctness (4):
 *   loose-equality           low     JS == / != (use === / !==)
 *   empty-catch              medium  catch (...) {} / except: pass
 *   swallowed-error          medium  catch block that only console.log's the error
 *   ts-ignore                medium  @ts-ignore / @ts-nocheck / @ts-expect-error / as any
 *
 *   Async (2):
 *   async-without-await      low     async keyword with no await
 *   settimeout-not-cleared   low     setTimeout/setInterval return not bound
 *
 *   IR-level passes (in lib/dead-code.js, run post-resolver):
 *   dead-function            medium  def with no inbound calls + not exported
 *   circular-import          high    cycle in imports-file subgraph
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

  // -- Phase 10.next: 18 additional detectors ---------------------------
  // Each takes the function body and pushes onto `warnings`. Detectors
  // are intentionally cheap regex + token scans — same precision /
  // false-positive profile as the original seven. The point is signal,
  // not correctness proof.
  const firstLine = lines[0] || "";

  detectSecurity(inside, firstLine, warnings, lang);
  detectPerformanceExtra(inside, firstLine, warnings, lang);
  detectCorrectness(inside, warnings, lang);
  detectAsyncExtra(inside, firstLine, warnings, lang);

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

// ---------------------------------------------------------------------------
// Phase 10.next — security detectors (7)
// ---------------------------------------------------------------------------

function detectSecurity(inside, firstLine, warnings, lang) {
  if (hasEvalOrFunctionCtor(inside, lang)) {
    warnings.push({
      kind: "eval-or-function-ctor",
      severity: "high",
      message:
        lang === "py"
          ? "eval() / exec() on dynamic input is a code-injection vector"
          : "eval() / new Function() on dynamic input is a code-injection vector",
    });
  }
  if (hasWeakCrypto(inside, lang)) {
    warnings.push({
      kind: "weak-crypto",
      severity: "medium",
      message: "MD5 / SHA-1 are broken — use SHA-256 or better",
    });
  }
  if (lang !== "py" && hasJwtDecodeWithoutVerify(inside)) {
    warnings.push({
      kind: "jwt-no-verify",
      severity: "high",
      message: "jwt.decode without jwt.verify accepts forged tokens",
    });
  }
  if (hasCorsAllowAll(inside)) {
    warnings.push({
      kind: "cors-allow-all",
      severity: "high",
      message: "Access-Control-Allow-Origin: * with credentials is unsafe",
    });
  }
  if (hasInsecureTls(inside, lang)) {
    warnings.push({
      kind: "requests-verify-false",
      severity: "high",
      message: "TLS verification disabled — accepts any cert",
    });
  }
  if (hasHardcodedPassword(inside)) {
    warnings.push({
      kind: "hardcoded-password",
      severity: "high",
      message: "Credential literal in source — move to env / secrets store",
    });
  }
  if (hasCookieNoHttpOnly(inside)) {
    warnings.push({
      kind: "cookie-no-httponly",
      severity: "medium",
      message: "cookie set without HttpOnly — readable by JS, XSS-stealable",
    });
  }
}

function hasEvalOrFunctionCtor(text, lang) {
  if (lang === "py") return /\beval\s*\(|\bexec\s*\(/.test(text);
  return /\beval\s*\(|\bnew\s+Function\s*\(/.test(text);
}

function hasWeakCrypto(text, lang) {
  if (lang === "py") return /\bhashlib\.(?:md5|sha1)\s*\(/.test(text);
  return /createHash\s*\(\s*['"](?:md5|sha1)['"]\s*\)/i.test(text);
}

function hasJwtDecodeWithoutVerify(text) {
  return /\bjwt\.decode\s*\(/.test(text) && !/\bjwt\.verify\s*\(/.test(text);
}

function hasCorsAllowAll(text) {
  if (/['"]Access-Control-Allow-Origin['"][^,]*,\s*['"]\*['"]/.test(text)) return true;
  if (/\borigin\s*:\s*['"]\*['"]/.test(text)) return true;
  return false;
}

function hasInsecureTls(text, lang) {
  if (lang === "py") return /\bverify\s*=\s*False\b/.test(text);
  return /\brejectUnauthorized\s*:\s*false\b/.test(text);
}

function hasHardcodedPassword(text) {
  // Looks for: const password = "abcd" / password: "abcd" / passwd='secret'
  // Excludes: empty strings, single-char values, env-var refs, ${} format strings.
  const re = /\b(?:password|passwd|pwd|api_key|apikey|secret|client_secret|access_token|private_key)\s*[:=]\s*['"]([^'"$\\{`<>]{8,})['"]/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const literal = m[1];
    if (literal.includes("env.") || literal.includes("process.")) continue;
    if (/^(?:your[\s-]?password|change[\s-]?me|todo|example|placeholder|xxx+|test|password)$/i.test(literal)) continue;
    return true;
  }
  return false;
}

function hasCookieNoHttpOnly(text) {
  // res.cookie('name', val, { ...opts }) — flag when the options arg
  // omits httpOnly. Best-effort: we only see the call site as text.
  const calls = text.match(/\bres\.cookie\s*\([^)]*\)/g);
  if (!calls) return false;
  return calls.some(
    (c) => /\{[^{}]+\}/.test(c) && !/http[Oo]nly/.test(c),
  );
}

// ---------------------------------------------------------------------------
// Phase 10.next — performance detectors (5)
// ---------------------------------------------------------------------------

function detectPerformanceExtra(inside, firstLine, warnings, lang) {
  if (loopBodyContains(inside, lang, /\.sort\s*\(|\bsorted\s*\(/)) {
    warnings.push({
      kind: "sort-in-loop",
      severity: "high",
      message: "sort() inside a loop — O(n² log n); sort once outside",
    });
  }
  if (loopBodyContains(inside, lang, /\b\w+\s*\+=\s*['"]|\b\w+\s*=\s*\w+\s*\+\s*['"]/)) {
    warnings.push({
      kind: "string-concat-in-loop",
      severity: "medium",
      message: "string += in loop — accumulate into array, join() at end",
    });
  }
  if (hasSyncIoInAsync(firstLine, inside, lang)) {
    warnings.push({
      kind: "sync-io-in-async",
      severity: "high",
      message:
        lang === "py"
          ? "blocking I/O in async def — use aiofiles / asyncio.to_thread"
          : "fs.*Sync in async function — use the async variant",
    });
  }
  if (hasFetchWithoutTimeout(inside, lang)) {
    warnings.push({
      kind: "fetch-without-timeout",
      severity: "medium",
      message:
        lang === "py"
          ? "requests.X without timeout= — hangs forever on slow servers"
          : "fetch() without timeout/AbortSignal — hangs forever",
    });
  }
  if (loopBodyContains(inside, lang, /\bnew\s+RegExp\s*\(|\bre\.compile\s*\(/)) {
    warnings.push({
      kind: "regex-compile-in-loop",
      severity: "medium",
      message: "regex compiled in loop — hoist the regex outside",
    });
  }
}

function hasSyncIoInAsync(firstLine, body, lang) {
  if (lang === "py") {
    if (!/^\s*async\s+def\b/.test(firstLine)) return false;
    // Conservative — only flag explicit blocking helpers.
    return /\btime\.sleep\s*\(|\brequests\.\w+\s*\(/.test(body);
  }
  if (!/\basync\b/.test(firstLine)) return false;
  return /\bfs\.(?:readFileSync|writeFileSync|existsSync|statSync|mkdirSync|rmSync|unlinkSync|readdirSync)\s*\(/.test(
    body,
  );
}

function hasFetchWithoutTimeout(text, lang) {
  if (lang === "py") {
    // requests.get(url) — no timeout=. Only flag calls with at least
    // one argument; bare `requests.get` references aren't calls.
    const re = /\brequests\.(?:get|post|put|patch|delete|head)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!/\btimeout\s*=/.test(m[1])) return true;
    }
    return false;
  }
  const re = /\bfetch\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const args = m[1];
    if (/\btimeout\b|\bsignal\s*:|AbortSignal/.test(args)) continue;
    if (!args.trim()) continue; // bare `fetch()` — probably a re-export
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Phase 10.next — correctness detectors (4)
// ---------------------------------------------------------------------------

function detectCorrectness(inside, warnings, lang) {
  if (lang !== "py" && hasLooseEquality(inside)) {
    warnings.push({
      kind: "loose-equality",
      severity: "low",
      message: "== / != coerces types — use === / !== unless deliberate",
    });
  }
  if (hasEmptyCatch(inside, lang)) {
    warnings.push({
      kind: "empty-catch",
      severity: "medium",
      message: "empty catch — at minimum, log the error",
    });
  }
  if (hasSwallowedError(inside, lang)) {
    warnings.push({
      kind: "swallowed-error",
      severity: "medium",
      message: "catch only logs and continues — caller never sees the failure",
    });
  }
  if (lang !== "py" && hasTsIgnoreOrAsAny(inside)) {
    warnings.push({
      kind: "ts-ignore",
      severity: "medium",
      message: "@ts-ignore / as any — type-check escape hatch",
    });
  }
}

function hasLooseEquality(text) {
  // Strip string literals + comments first so we don't false-positive on
  // `"foo == bar"` strings or commented examples.
  const stripped = text
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
  return /[^=!<>]==[^=]|[^!]!=[^=]/.test(stripped);
}

function hasEmptyCatch(text, lang) {
  if (lang === "py") return /^[\t ]*except[^:]*:[\t ]*pass[\t ]*(?:#[^\n]*)?$/m.test(text);
  return /catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(text);
}

function hasSwallowedError(text, lang) {
  if (lang === "py") {
    // except [Foo] [as e]: <single log line> + dedent/end
    return /^[\t ]*except[^:]*:\s*\n[\t ]+(?:print|logging\.\w+|logger\.\w+|sys\.stderr\.write)\s*\([^)]*\)\s*(?:#[^\n]*)?$/m.test(
      text,
    );
  }
  return /catch\s*\([^)]*\)\s*\{\s*console\.\w+\s*\([^)]*\)\s*;?\s*\}/.test(text);
}

function hasTsIgnoreOrAsAny(text) {
  return /@ts-ignore\b|@ts-nocheck\b|@ts-expect-error\b|\bas\s+any\b/.test(text);
}

// ---------------------------------------------------------------------------
// Phase 10.next — async detectors (2)
// ---------------------------------------------------------------------------

function detectAsyncExtra(inside, firstLine, warnings, lang) {
  if (hasAsyncWithoutAwait(firstLine, inside, lang)) {
    warnings.push({
      kind: "async-without-await",
      severity: "low",
      message:
        "async with no await — returns a Promise pointlessly; drop async or add await",
    });
  }
  if (lang !== "py" && hasUnboundedTimer(inside)) {
    warnings.push({
      kind: "settimeout-not-cleared",
      severity: "low",
      message:
        "setTimeout / setInterval return not stored — can't clearTimeout on unmount",
    });
  }
}

function hasAsyncWithoutAwait(firstLine, body, lang) {
  if (lang === "py") {
    if (!/^\s*async\s+def\b/.test(firstLine)) return false;
    return !/\bawait\b/.test(body);
  }
  if (!/\basync\b/.test(firstLine)) return false;
  return !/\bawait\b/.test(body);
}

function hasUnboundedTimer(text) {
  const lines = text.split("\n");
  for (const line of lines) {
    if (!/\bset(?:Timeout|Interval)\s*\(/.test(line)) continue;
    // If the call is on the right of an `=` / `:` / `return`, it's stored / handed off.
    if (/[=:]\s*set(?:Timeout|Interval)\s*\(/.test(line)) continue;
    if (/\breturn\s+set(?:Timeout|Interval)\s*\(/.test(line)) continue;
    if (/\.\s*set(?:Timeout|Interval)\s*\(/.test(line)) continue; // method call, e.g. window.setTimeout
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// loop-body helper — used by sort-in-loop, string-concat-in-loop,
// regex-compile-in-loop, and any future "X happens inside any loop"
// check. Honest about precision: matches anything inside the loop's
// immediate brace/indent block — not just the first iteration scope.
// ---------------------------------------------------------------------------

function loopBodyContains(text, lang, pattern) {
  if (lang === "py") return pyLoopBodyContains(text, pattern);
  return tsLoopBodyContains(text, pattern);
}

function pyLoopBodyContains(text, pattern) {
  const lines = text.split("\n");
  let baseIndent = -1;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.match(/^[ \t]*/)[0].replace(/\t/g, "    ").length;
    if (PY_LOOP_LINE_RE.test(line)) {
      baseIndent = indent;
      continue;
    }
    if (baseIndent >= 0) {
      if (indent > baseIndent) {
        if (pattern.test(line)) return true;
      } else {
        baseIndent = -1;
      }
    }
  }
  return false;
}

function tsLoopBodyContains(text, pattern) {
  let i = 0;
  while (i < text.length) {
    const m = text.slice(i).match(/\b(for|while)\s*\(/);
    if (!m) return false;
    let k = i + m.index + m[0].length;
    let parens = 1;
    while (k < text.length && parens > 0) {
      if (text[k] === "(") parens++;
      else if (text[k] === ")") parens--;
      k++;
    }
    while (k < text.length && /\s/.test(text[k])) k++;
    if (text[k] !== "{") {
      // single-statement loop body
      const eol = text.indexOf("\n", k);
      const rest = text.slice(k, eol > -1 ? eol : text.length);
      if (pattern.test(rest)) return true;
      i = eol > -1 ? eol + 1 : text.length;
      continue;
    }
    const bodyStart = k + 1;
    let depth = 1;
    k = bodyStart;
    while (k < text.length && depth > 0) {
      if (text[k] === "{") depth++;
      else if (text[k] === "}") depth--;
      k++;
    }
    const bodyText = text.slice(bodyStart, k - 1);
    if (pattern.test(bodyText)) return true;
    i = k;
  }
  return false;
}
