# @codegraph/adapter-env

Detects environment-variable reads in TypeScript and Python source, parses
`.env*` files at the repo root and common subdirs into a registry of
declared keys, and emits IR fragments that downstream codegraph tooling
(viewer, dead-code analysis, security-insights) can consume to draw
"function reads env var X" relationships across the graph.

> Status: v0.1.0. Conforms to `@codegraph/adapter-sdk` apiVersion 1.

## What it produces

For every recognized read, the adapter emits one expression-tier IR node
plus (when there is an enclosing function) one `env-read` edge:

```
function handleSignup        ───env-read──>  expression { leaf: env, name: "DATABASE_URL" }
                                                tags: ["env:source=process.env", "env:declared"]
```

For dotenv loader sites (`import 'dotenv/config'`, `dotenv.config()`,
`from 'dotenv' { config }; config()`) the adapter emits a config-file
leaf instead, tagged `env:dotenv-loaded`:

```
expression { leaf: config-file, path: ".env", format: "env" }
   tags: ["env:source=dotenv", "env:dotenv-loaded"]
```

`.env*` file parsing happens once in the `detect` phase. The adapter does
**not** emit an IR module per `.env` file — that belongs to a generic
config-file adapter when one exists. The parsed registry is used here
purely to mark referenced keys as `env:declared` and to emit
`env/undeclared-reference` diagnostics for keys that are referenced but
never declared.

## Patterns recognized

### TypeScript / JavaScript

| Pattern                                  | Source tag          | Notes                                  |
|------------------------------------------|---------------------|----------------------------------------|
| `process.env.DATABASE_URL`               | `process.env`       |                                        |
| `process.env['DATABASE_URL']`            | `process.env`       | computed key (string literal only)     |
| `process.env.X \|\| 'fallback'`          | `process.env`       | `defaultValue: 'fallback'` captured    |
| `process.env.X ?? 'fallback'`            | `process.env`       | same                                   |
| `const { X, Y } = process.env`           | `process.env`       | one leaf per destructured name         |
| `import.meta.env.VITE_API_URL`           | `import.meta.env`   | Vite / SvelteKit / Nuxt-Vite           |
| `Bun.env.PORT`                           | `Bun.env`           | Bun runtime                            |
| `import 'dotenv/config'`                 | `dotenv` (loader)   | side-effect import → loader leaf       |
| `dotenv.config()`                        | `dotenv` (loader)   | resolved through namespace + named imports |

Deliberately NOT recognized:

- `const env = process.env; env.X` — would require binding-flow analysis.
- `process.env[someVar]` — non-literal key; we emit an `env/dynamic-key`
  diagnostic and skip the read.
- Webpack/Vite `define`-plugin replacements — we treat the *source* as
  truth and ignore build-time substitution (per
  `research/adapters.md` §6 known gotchas).

### Python

| Pattern                                            | Source tag             |
|----------------------------------------------------|------------------------|
| `os.environ['DATABASE_URL']`                       | `os.environ`           |
| `os.environ.get('DATABASE_URL')`                   | `os.environ.get`       |
| `os.environ.get('DATABASE_URL', 'default')`        | `os.environ.get`       |
| `os.getenv('DATABASE_URL')`                        | `os.getenv`            |
| `os.getenv('DATABASE_URL', 'default')`             | `os.getenv`            |
| `getenv('X')` after `from os import getenv`        | `os.getenv`            |
| `environ['X']` after `from os import environ`     | `os.environ`           |
| `class Settings(BaseSettings): database_url: str` | `pydantic-settings`    |

For pydantic-settings, the adapter walks each `BaseSettings` subclass's
class body for `model_config = SettingsConfigDict(env_prefix=...)` (v2)
or `class Config: env_prefix = ...` (v1) and prefixes each annotated
field name with the resolved prefix.

## `.env*` file parsing

The parser is dependency-free and supports:

- `KEY=VALUE` with unquoted, single-quoted, and double-quoted values.
- `\n` `\r` `\t` `\"` `\\` escapes inside double-quoted strings.
- `${OTHER_VAR}` substitution against keys parsed earlier in the same
  file (no cross-file expansion — that would be non-deterministic).
- `export KEY=VALUE` lines.
- `# comment` lines and inline `KEY=VAL # comment` (with whitespace
  before `#` per the standard dotenv grammar).

Filename → environment slot:

| File                  | Environment    |
|-----------------------|----------------|
| `.env`                | `default`      |
| `.env.local`          | `local`        |
| `.env.production`     | `production`   |
| `.env.development`    | `development`  |
| `.env.example`        | `example`      |
| `.env.<anything>`     | `<anything>`   |

## Activation

The adapter's `detect` phase activates the adapter when **either**:

- one or more `.env*` files exist at the repo root, `apps/*`,
  `packages/*`, or `services/*`, **or**
- a manifest declares one of: `dotenv`, `dotenv-flow`, `dotenv-expand`,
  `@dotenvx/dotenvx`, `@t3-oss/env-nextjs`, `@t3-oss/env-core`,
  `envalid`, `python-dotenv`, `pydantic-settings`.

If neither condition holds, the adapter is inactive — no IR is emitted.
Users with non-conventional layouts can force-activate via
`codegraph.config.ts`.

## Diagnostic codes

| Code                          | Severity | When                                                     |
|-------------------------------|----------|----------------------------------------------------------|
| `env/dotenv-too-large`        | warn     | A `.env*` file exceeds 256KB — parsing is skipped.       |
| `env/dynamic-key`             | warn     | Subscript / `getenv` with a non-literal key.             |
| `env/rest-destructure`        | warn     | `const { ...rest } = process.env`.                       |
| `env/undeclared-reference`    | warn     | A name is referenced in source but no `.env*` declares it. |
| `env/no-analyzer`             | info     | `appliesTo` matched but no language analyzer ran.        |
| `env/summary`                 | info     | Once-per-run summary in `finalize`.                      |

`env/undeclared-reference` skips conventional buildtime variables
(`NODE_ENV`, `VITE_*`, `NEXT_PUBLIC_*`, `REACT_APP_*`, `PUBLIC_*`,
`STORYBOOK_*`, `PUBLIC_URL`, `BASE_URL`).

## Determinism

The adapter follows the host's determinism rules (spec
`adapter-interface.md` §6.2):

- No module-level mutable state. The dotenv registry lives in a closure
  variable owned by the factory.
- Per-file findings are sorted by source position before emit, so the
  lexical-occurrence index baked into leaf IDs is invariant under AST
  visitor order.
- No reads of `process.env`, `Date.now`, or `Math.random` from inside
  the adapter (the host stubs them anyway).

## Edge category and leaf flavor

Edge: `env-read` (closed enum at v0.1, `EnvReadEdge` from
`@codegraph/core`). Carries optional `name`.

Leaf: `env` (`LeafEnv { flavor: 'env', name, defaultValue? }`) for
reads; `config-file` (`LeafConfigFile { flavor: 'config-file', path,
format: 'env' }`) for dotenv loader sites.

Adapter-specific facts (source, declared, dotenv-loaded) live on
`tags: string[]` per coordination with the IR-types owners. Tags are
namespaced under `env:` so they coexist cleanly with future adapters
that adopt the same convention.

## See also

- `spec/adapter-interface.md` — the 4-phase adapter contract.
- `spec/ir-schema.md` — IR shape and identity rules.
- `research/adapters.md` §6 — env-adapter design notes.
- `adapters/express`, `adapters/fastapi.ts` — reference adapters.
