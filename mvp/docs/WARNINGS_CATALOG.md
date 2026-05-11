# Compiler-warnings catalog

A reference list of every code issue Ryngo could flag, organized by
category. Each entry is tagged with **what it would take to detect it
in our IR today**. The point of this file is to make warning expansion
a menu-pick instead of an open-ended question.

## Today (shipped)

`mvp/lib/warnings.js` ships seven warnings. All are body-text regex
against the function source. No type info, no cross-file analysis, no
AST. Per-function `data.warnings: [{ kind, severity, message }]`
attached during analyze.

| kind | severity | signal |
|---|---|---|
| `triple-nested-loop` | high | three or more `for`/`while`/comprehension loops nested |
| `nested-loop` | medium | two loops nested |
| `io-in-loop` | high | network / DB call inside a `for` / `while` body |
| `recursion` | low | function body calls itself, no memo cue |
| `long-function` | low | > 120 LOC |
| `many-params` | low | > 6 params |
| `deep-nesting` | low | brace / indent depth ≥ 5 |

---

## Detection-cost legend

Every entry below is tagged with the cheapest path to ship it:

- **🟢 ship-today** — detectable with our existing IR (regex on
  `def.body`, node ids, edges). No new infra. ~30 LOC each.
- **🟡 needs-parser** — needs richer AST than our regex extractors
  produce. Solved when tree-sitter swap lands (Phase 5.1).
- **🟠 needs-types** — needs type info on every binding / call site.
  Solved when Phase 5.2 ships (typed-param extraction).
- **🔴 needs-effects** — needs the cross-function effect-propagation
  system (Phase 5.7). E.g. "does this function transitively reach a
  db-write?"
- **⚫ out-of-scope** — would need a runtime, a CVE feed, a real
  SAST engine, or a type checker. Park.

---

## A. Performance & algorithmic complexity

### A.1  Loop / iteration

| kind | sev | signal | cost |
|---|---|---|---|
| `triple-nested-loop` | high | 3 nested loops | shipped |
| `nested-loop` | medium | 2 nested loops | shipped |
| `quad-plus-nested-loop` | high | 4+ nested loops | 🟢 |
| `repeated-length-access` | low | `arr.length` / `len(x)` evaluated each iter when the source list isn't mutated | 🟡 |
| `string-concat-in-loop` | medium | `s += "..."` or `s = s + "..."` inside a loop body (build via `array.join` / `''.join`) | 🟢 |
| `regex-compile-in-loop` | medium | `new RegExp(...)` / `re.compile(...)` inside loop body | 🟢 |
| `function-defined-in-loop` | medium | arrow or `function` declared inside loop body | 🟡 |
| `sort-in-loop` | high | `arr.sort()` / `sorted(list)` inside loop body | 🟢 |
| `array-from-in-loop` | low | `Array.from` / `Array(n).fill` repeatedly allocating | 🟢 |
| `redundant-conversion` | low | `Number(Number(x))` / `str(str(x))` / similar identity casts | 🟢 |
| `inefficient-spread-in-loop` | medium | `[...arr, x]` / `{...obj, k: v}` accumulator (use push/Object.assign) | 🟢 |

### A.2  Data structures

| kind | sev | signal | cost |
|---|---|---|---|
| `linear-search-in-array` | medium | repeated `arr.indexOf` / `arr.includes` / `if x in list` where the array is large + immutable (use Set) | 🟡 |
| `array-as-set` | low | `arr.push` + `arr.includes` pattern (set membership over array) | 🟡 |
| `array-as-queue` | low | `arr.shift()` in a hot loop (O(n) per dequeue; use a deque) | 🟢 |
| `unbounded-growth` | medium | array / dict that's pushed/appended in a long-lived function but never trimmed | 🔴 |
| `memo-without-bound` | medium | dict / Map used as memo never has a delete / clear | 🔴 |

### A.3  I/O & network

| kind | sev | signal | cost |
|---|---|---|---|
| `io-in-loop` | high | network / DB call inside a loop | shipped |
| `n-plus-one-query` | high | DB read inside a loop where the loop var becomes a query param — specialized I/O-in-loop with route → adapter signal | 🔴 |
| `sync-io-in-async` | high | `fs.readFileSync`/`fs.writeFileSync` in an `async` function | 🟢 |
| `sequential-await` | medium | two or more `await`s in a row that don't depend on each other (could be `Promise.all`) | 🟡 |
| `await-in-loop` | medium | `await` inside a `for` / `while` body with no inter-iteration data dep (could batch) | 🟡 |
| `fetch-without-timeout` | medium | `fetch(...)` / `requests.get(...)` without an explicit timeout | 🟢 |
| `unhandled-promise-rejection` | high | `Promise.then(...)` chain with no `.catch` / `await` not inside `try` | 🟡 |
| `forgotten-await` | high | call to an `async` function whose return is used as if synchronous | 🟠 |
| `missing-stream-close` | medium | `fs.openSync` / `open(...)` without a `finally` / `with` block | 🟡 |

### A.4  Memory & resources

| kind | sev | signal | cost |
|---|---|---|---|
| `large-object-in-closure` | low | function declared inside another function's body that captures a 50+ KB literal | 🟡 |
| `leaked-event-listener` | high | `addEventListener` / `setInterval` with no matching remove / clear in the same scope | 🟡 |
| `global-cache-no-eviction` | medium | module-level `Map` / `dict` written from a request handler with no eviction policy | 🔴 |

---

## B. Async & concurrency

| kind | sev | signal | cost |
|---|---|---|---|
| `forgotten-await` | high | `async` fn returning Promise treated as value | 🟠 |
| `unhandled-rejection` | high | Promise without `.catch`, await without `try` | 🟡 |
| `promise-then-after-await` | low | mixing `.then()` chains with `await` in the same function | 🟢 |
| `async-without-await` | low | `async` keyword on a function whose body has no `await` (returns a Promise pointlessly) | 🟢 |
| `sync-callback-in-async` | medium | passing an `async` fn to an API that expects synchronous callback (Array.map, sort, …) | 🟠 |
| `race-on-shared-state` | medium | two `async` writes to the same module-level variable without lock / atomicity | 🔴 |
| `settimeout-not-cleared` | low | `setTimeout` / `setInterval` whose return is never bound to a variable | 🟢 |
| `worker-no-terminate` | medium | `new Worker(…)` / `child_process.spawn` with no `.terminate()` / `.kill()` on the exit path | 🟡 |
| `async-iter-with-await-in-loop` | low | `for await (const x of iter)` where the inner work could parallelize | 🟡 |
| `lock-not-released` | high | mutex / semaphore acquired without matching release on every exit path | 🟡 |

---

## C. Security (pattern-based, NOT a SAST)

We will not pretend to be Snyk or Semgrep. These are high-precision
patterns that catch obvious mistakes; anything deeper requires a real
security scanner.

| kind | sev | signal | cost |
|---|---|---|---|
| `hardcoded-secret` | high | string literal matching API-key / JWT / private-key shape | 🟢 |
| `hardcoded-password` | high | string assigned to a variable named `password` / `passwd` / `pwd` | 🟢 |
| `eval-or-function-ctor` | high | `eval(...)` / `new Function(...)` / `exec(user_input)` | 🟢 |
| `child-process-with-string` | high | `exec`/`spawn` whose first arg is a template / concat with user input | 🟡 |
| `sql-string-concat` | high | DB-write/read edge whose handler builds a query via `+`/template literal with non-literal | 🟡 |
| `innerhtml-with-input` | high | `el.innerHTML = …` where the right-hand-side traces back to a request parameter | 🔴 |
| `weak-crypto` | medium | `crypto.createHash('md5')` / `('sha1')` / `Math.random()` for tokens | 🟢 |
| `jwt-no-verify` | high | `jwt.decode` instead of `jwt.verify` | 🟢 |
| `cors-allow-all` | high | `Access-Control-Allow-Origin: *` in code | 🟢 |
| `cookie-no-httponly` | medium | `res.cookie(...)` / `Set-Cookie` without `HttpOnly` / `Secure` / `SameSite` | 🟢 |
| `path-traversal` | high | `fs.readFile(...)` whose arg traces back to a request parameter (no normalization) | 🔴 |
| `open-redirect` | high | `res.redirect(...)` whose arg traces back to a request parameter | 🔴 |
| `ssrf-fetch` | high | `fetch(...)` / `axios.get(...)` whose URL traces back to a request parameter | 🔴 |
| `env-logged` | medium | `console.log(process.env)` or similar | 🟢 |
| `pickle-untrusted` | high | Python `pickle.loads` on non-literal input | 🟢 |
| `yaml-unsafe-load` | high | `yaml.load(...)` without `Loader=yaml.SafeLoader` | 🟢 |
| `requests-verify-false` | high | `requests.get(..., verify=False)` / `rejectUnauthorized: false` | 🟢 |
| `dangerous-permission` | medium | `chmod 0o777` or equivalent | 🟢 |
| `cve-in-deps` | high | dependency in `package.json` / `requirements.txt` matches a known CVE | ⚫ (needs CVE feed) |

---

## D. Correctness & likely bugs

| kind | sev | signal | cost |
|---|---|---|---|
| `loose-equality` | low | JS `==` / `!=` instead of `===` / `!==` | 🟢 |
| `floating-point-equality` | medium | `a === b` where both are typed `number` and at least one is a non-integer literal | 🟠 |
| `assignment-in-condition` | medium | `if (x = y)` (single `=` in a conditional) | 🟢 |
| `unreachable-code` | medium | statements after `return` / `throw` / `process.exit()` in the same block | 🟡 |
| `empty-catch` | medium | `catch (e) {}` with no body | 🟢 |
| `swallowed-error` | medium | `catch (e) { console.log(e) }` — logged but not propagated | 🟢 |
| `mutation-of-param` | low | reassigning a function parameter | 🟡 |
| `mutation-of-import` | high | `import * as x from …; x.y = …` | 🟡 |
| `shadowed-variable` | low | local declares a name that shadows an outer binding | 🟡 |
| `unused-variable` | low | declared but never read in the function body | 🟡 |
| `unused-import` | low | imported binding never referenced | 🟡 |
| `unused-export` | low | exported binding with no inbound edges in the IR | 🟢 |
| `dead-function` | medium | function with zero inbound `calls` edges and no `export` | 🟢 |
| `unreachable-branch` | medium | branch whose condition is a literal | 🟡 |
| `switch-without-default` | low | `switch` with no `default:` case | 🟡 |
| `inconsistent-return` | medium | function with paths that return values + paths that fall through | 🟠 |
| `mutable-default-arg` | medium | Python `def f(x=[])` or JS `function f(x = []) { x.push(...) }` | 🟡 |
| `null-without-check` | medium | `?.` / `if (x)` followed by `x.foo` access — narrowing inconsistent | 🟠 |
| `array-method-without-return` | low | `arr.map(x => { if (...) … })` with no return | 🟡 |
| `non-deterministic-test` | medium | function named like a test that uses `Math.random` / `Date.now` / `new Date()` without injection | 🟢 |

---

## E. Maintainability & code smell

| kind | sev | signal | cost |
|---|---|---|---|
| `long-function` | low | > 120 LOC | shipped |
| `many-params` | low | > 6 params | shipped |
| `deep-nesting` | low | brace / indent depth ≥ 5 | shipped |
| `god-function` | medium | > 300 LOC | 🟢 |
| `god-class` | medium | class with > 30 methods OR > 800 LOC | 🟢 |
| `god-file` | medium | file with > 1500 LOC | 🟢 |
| `cyclomatic-complexity-high` | medium | function with > 15 branching points | 🟡 |
| `duplicate-code-block` | low | two functions in the same file with bodies > 90 % similar | 🟡 |
| `magic-number` | low | numeric literal > 1 inside a function body that's not 0, 1, -1, 2, 100 | 🟡 |
| `commented-out-code` | low | comment block containing valid code syntax | 🟡 |
| `todo-without-owner` | low | `TODO`/`FIXME`/`XXX` comment without a `(name)` or date | 🟢 |
| `stale-todo` | low | `TODO` comment with date > 180 days old | 🟢 |
| `circular-import` | high | cycle in the `imports-file` edge subgraph | 🟢 |
| `too-many-imports` | low | file with > 30 imports | 🟢 |
| `inconsistent-export-style` | low | file mixes `export default` + named exports of same kind | 🟡 |

---

## F. API / interface design

| kind | sev | signal | cost |
|---|---|---|---|
| `boolean-trap` | low | function with two or more boolean params next to each other (consider options object) | 🟡 |
| `positional-overload` | low | function with > 4 positional params, no defaults | 🟢 |
| `inconsistent-return-types` | medium | typed return is a union with > 3 disjoint branches | 🟠 |
| `optional-trap` | low | function returns `T | undefined` AND every caller `!`-asserts the result | 🟠 |
| `public-no-doc` | low | exported function with no docstring / JSDoc | 🟡 |
| `breaks-semver` | high | exported function whose signature changed in a non-additive way between two refs (compare diff) | 🟠 |
| `param-name-mismatch` | low | function param names don't match the JSDoc / docstring | 🟡 |
| `implicit-any` | low | TS function with un-typed param | 🟠 |
| `ts-ignore` | medium | `@ts-ignore` / `@ts-nocheck` / `as any` in source | 🟢 |
| `noqa-without-reason` | low | `# noqa` / `// eslint-disable-next-line` with no code-after-the-comment | 🟢 |

---

## G. Framework-specific (React + Express + FastAPI + Django + Rails)

These need adapter context — the framework adapter has to fire first
so the warning has the right scope to attach to.

| kind | sev | signal | framework | cost |
|---|---|---|---|---|
| `react-missing-key` | medium | `arr.map(x => <Foo .../>)` with no `key` prop | React | 🟡 |
| `react-effect-missing-deps` | high | `useEffect(() => { x })` referencing `x` that isn't in the deps array | React | 🟠 |
| `react-set-state-in-render` | high | `useState` setter called outside a callback / effect | React | 🟡 |
| `react-inline-object-prop` | low | JSX prop assigned `={{...}}` literal that recreates each render | React | 🟡 |
| `react-direct-dom` | high | `document.getElementById` / `ref.current.style.…` inside a render body | React | 🟢 |
| `express-route-no-error-handler` | medium | `app.use((req, res, next) => …)` chain without a 4-arg error middleware | Express | 🔴 |
| `express-route-handler-no-async-catch` | medium | route handler is `async` but `next(err)` never called on throw | Express | 🟠 |
| `fastapi-deps-without-typing` | low | `Depends(...)` param with no type annotation | FastAPI | 🟠 |
| `fastapi-sync-handler-with-io` | high | non-`async def` handler containing network / DB I/O | FastAPI | 🟢 |
| `django-orm-in-template` | medium | `{% for x in queryset %}{{ x.foo.bar }}` — likely N+1 | Django | 🔴 |
| `rails-strong-params-missing` | medium | controller action with `params` access not gated by `require(:model).permit(...)` | Rails | 🟡 |
| `prisma-find-many-no-where` | low | `prisma.X.findMany()` with no filter — full-table scan | Prisma | 🟢 |
| `sqlalchemy-select-no-limit` | low | `session.query(X).all()` with no `.limit()` | SQLAlchemy | 🟢 |

---

## H. Test quality

| kind | sev | signal | cost |
|---|---|---|---|
| `test-no-assertion` | medium | function in a `*test*` file that has no `expect`/`assert`/`assertX` call | 🟢 |
| `test-uses-real-clock` | medium | test fn uses `Date.now()` / `new Date()` without mocking | 🟢 |
| `test-uses-random` | medium | test fn uses `Math.random` / `random.X` without seeding | 🟢 |
| `test-order-dependent` | medium | test reads or writes a module-level variable | 🟡 |
| `test-skipped` | low | `.skip` / `it.only` / `xit` / `@pytest.mark.skip` left in source | 🟢 |
| `untested-public-export` | low | exported function with zero inbound calls from any `*test*` file | 🟢 |
| `weak-mock-coverage` | low | function with > 5 external calls, none of which are mocked in the matching test | 🟠 |
| `flaky-marker` | low | `// flaky` / `// retry` comment + `retry`/`retries(N)` in test config | 🟢 |

---

## I. Build / deps / config / repo hygiene

| kind | sev | signal | cost |
|---|---|---|---|
| `unpinned-dependency` | medium | `package.json` / `requirements.txt` entry with `*` or no version | 🟢 |
| `dev-dep-in-prod-import` | high | import from a package listed under `devDependencies` from a non-test file | 🟢 |
| `outdated-major-dep` | low | a dep is > 1 major version behind | 🟢 |
| `dep-with-known-cve` | high | dep version matches an OSV / GHSA advisory | ⚫ (CVE feed) |
| `large-package-imported-for-one-fn` | low | importing all of `lodash` for one helper (tree-shaking miss) | 🟢 |
| `circular-import` | high | file-import cycle | 🟢 |
| `missing-license` | low | repo has no `LICENSE` file | 🟢 |
| `missing-readme` | low | repo has no `README*` file | 🟢 |
| `secrets-in-history` | high | git log search reveals a previously-committed secret (we currently throw source away — out of scope) | ⚫ |
| `gitignore-missing-env` | medium | `.env` files exist but not in `.gitignore` | 🟢 |
| `package-lock-out-of-sync` | medium | `package.json` mtime > `package-lock.json` mtime | 🟢 |

---

## J. Documentation

| kind | sev | signal | cost |
|---|---|---|---|
| `public-no-jsdoc` | low | exported function/class with no leading `/**` block (JS/TS) or `"""` (Python) | 🟢 |
| `stale-comment` | low | comment with a date or version reference > 1 year old in source | 🟢 |
| `param-doc-mismatch` | low | JSDoc/docstring lists `@param x` but param is named `y` | 🟡 |
| `unexplained-magic-constant` | low | exported constant with no adjacent comment | 🟢 |
| `readme-missing-install` | low | `README.md` exists but has no `Install` / `Getting started` section | 🟢 |

---

## K. Accessibility (frontend)

Worth catching even if the user isn't doing FE; adapter would fire on
JSX / Vue / Svelte templates.

| kind | sev | signal | cost |
|---|---|---|---|
| `img-no-alt` | medium | `<img>` JSX/HTML without `alt=` (use empty `alt=""` for decoration) | 🟡 |
| `button-no-label` | medium | `<button>` with no text and no `aria-label` | 🟡 |
| `click-on-div` | medium | `<div onClick=…>` without `role="button"` and `tabIndex` | 🟡 |
| `form-no-label` | medium | `<input>` without a matching `<label htmlFor=…>` | 🟡 |
| `color-only-signal` | low | text whose `style.color` is the only differentiator (red error text) — too vague to detect reliably; skip until we have richer JSX context | ⚫ |

---

## L. Stylistic (low-value; only worth shipping if grouped)

These are usually a linter's job. Worth catching only as a *cluster
signal* — "this file has 40 of these, refactor incoming" — not
per-occurrence.

- `inconsistent-quotes` — single / double mix in one file
- `inconsistent-semicolons` — JS files with both styles
- `trailing-whitespace` — bytes-only check
- `tab-space-mix` — indent type inconsistency
- `naming-convention-violation` — camelCase / snake_case violation per file convention
- `crlf-mix` — line endings inconsistent

All 🟢. Mostly skip.

---

## Shipping plan — next 20 to add

Picking by (a) high signal-to-noise, (b) low implementation cost, (c)
no false-positive blowback on the corpus benchmark. Each is a small
addition to `mvp/lib/warnings.js`.

| # | kind | sev | from |
|---|---|---|---|
| 1 | `string-concat-in-loop` | medium | A.1 |
| 2 | `regex-compile-in-loop` | medium | A.1 |
| 3 | `sort-in-loop` | high | A.1 |
| 4 | `sync-io-in-async` | high | A.3 |
| 5 | `fetch-without-timeout` | medium | A.3 |
| 6 | `async-without-await` | low | B |
| 7 | `settimeout-not-cleared` | low | B |
| 8 | `eval-or-function-ctor` | high | C |
| 9 | `weak-crypto` | medium | C |
| 10 | `jwt-no-verify` | high | C |
| 11 | `cors-allow-all` | high | C |
| 12 | `cookie-no-httponly` | medium | C |
| 13 | `requests-verify-false` | high | C |
| 14 | `hardcoded-password` | high | C |
| 15 | `loose-equality` | low | D |
| 16 | `empty-catch` | medium | D |
| 17 | `swallowed-error` | medium | D |
| 18 | `unused-export` | low | D |
| 19 | `dead-function` | medium | D |
| 20 | `ts-ignore` | medium | F |

Twenty doable, ~30 LOC each → ~600 LOC into `warnings.js`. The seven
that exist today get us to 27 total. After that, the parser-blocked
and types-blocked entries (`forgotten-await`, `inconsistent-return`,
`react-effect-missing-deps`, …) unlock as Phase 5.1 / 5.2 land.

---

## What we explicitly will NOT try to catch

- **Full type checking.** Use TypeScript / mypy / Sorbet. Ryngo is
  not a type checker.
- **Real SAST.** No taint tracking from sources to sinks at the level
  Semgrep / CodeQL do. Our security warnings are high-precision
  patterns, not flow analysis.
- **CVE matching.** No third-party advisory feed. Snyk / Dependabot
  / `osv-scanner` already do this and we have nothing to add.
- **Linter-only stylistic noise.** ESLint / Prettier / Black already
  do this; we don't need to fight them.
- **Runtime behavior.** No fuzzing, no execution, no symbolic
  evaluation. Ryngo never runs your code.

---

## Why this catalog exists

`warnings.js` will grow. Adding a new warning ad-hoc when you spot
the pattern is fine for one or two — past five, the categories blur
and you ship overlapping kinds. This file is the menu: pick from a
listed kind, check the cost flag, decide whether to ship now or wait
for a parser upgrade.

When a new warning lands, move its row from the catalog to the
"Today (shipped)" table at the top.

When a parser/adapter upgrade unblocks a 🟡 / 🟠 / 🔴 entry, drop
its flag.
