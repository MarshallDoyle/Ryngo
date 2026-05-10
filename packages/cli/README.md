# `@codegraph/cli`

The `codegraph` command-line interface. Compiles a codebase to a typed graph IR (versioned JSON), renders that IR in a local React Flow viewer, diffs two IRs, and exports them to Mermaid, D2, or Graphviz.

`codegraph` is **deterministic and LLM-free**. The same input repository produces byte-identical IR JSON across runs and across machines (modulo a deterministic adapter set and a pinned config).

---

## Install

```sh
# Global
npm i -g @codegraph/cli

# One-shot, no install
npx @codegraph/cli --help
```

The package ships a single `codegraph` binary. Node `>= 18.17` is required.

---

## Why commander?

The CLI is built on [`commander`](https://github.com/tj/commander.js). Commander has been stable for a decade, has zero runtime dependencies, ships a small wire size (~60 KB unpacked), and supports both subcommands and sub-subcommands (which `codegraph adapter list|add|remove` requires) with first-class TypeScript types. `oclif` was considered but is heavier than necessary for a single-binary tool, and `yargs` has rougher TS ergonomics for nested commands.

---

## Quick start

```sh
codegraph init                                       # write .codegraph.yml
codegraph index . --out ir.json                      # build IR for cwd
codegraph serve ir.json                              # open the React Flow viewer
codegraph diff main HEAD --format markdown           # diff two git refs in CI
codegraph export mermaid ir.json --out graph.mmd     # render to Mermaid
```

---

## Command reference

### `codegraph index [path]`

Build the typed graph IR for a repository.

| Flag                  | Type      | Default            | Description                                                                              |
| --------------------- | --------- | ------------------ | ---------------------------------------------------------------------------------------- |
| `[path]`              | positional | `.`               | Repository root to index.                                                                |
| `-c, --config <path>` | string    | `$CODEGRAPH_CONFIG`| Path to `.codegraph.yml`.                                                                |
| `-o, --out <file>`    | string    | stdout             | Write IR JSON to `<file>`.                                                               |
| `--cache-dir <dir>`   | string    | `$CODEGRAPH_CACHE` | Cache directory used for incremental indexing.                                           |
| `-a, --adapters <list>` | string  | auto-detect        | Comma-separated adapter ids to run.                                                      |
| `--since <git-rev>`   | string    | —                  | Incremental: only re-parse files changed since `<git-rev>`; merge with cached IR.        |
| `--fail-on <level>`   | enum      | `error`            | Exit non-zero when diagnostics reach `<level>` (`error` \| `warning` \| `info`).         |
| `-v, --verbose`       | bool      | `false`            | Verbose progress on stderr.                                                              |
| `-q, --quiet`         | bool      | `false`            | Suppress non-error stderr.                                                               |
| `--json`              | bool      | `false`            | Wrap output in a JSON envelope (see below).                                              |

**Examples**

```sh
codegraph index .                                    # IR JSON to stdout
codegraph index ./apps/web --out web.ir.json
codegraph index . --since origin/main --cache-dir .codegraph-cache
codegraph index . -a typescript,python --fail-on warning
```

---

### `codegraph diff <baseRef> <headRef>`

Diff two IRs. Each argument is **either** an IR JSON file path **or** a git revision. When a git revision is given, `codegraph` builds an IR for that ref using the same config that the working tree resolves to.

| Flag               | Type     | Default     | Description                                                                  |
| ------------------ | -------- | ----------- | ---------------------------------------------------------------------------- |
| `<baseRef>`        | positional | —         | Base IR file or git revision.                                                |
| `<headRef>`        | positional | —         | Head IR file or git revision.                                                |
| `-f, --format`     | enum     | `summary`   | `json` \| `summary` \| `mermaid` \| `markdown`.                              |
| `-o, --out <file>` | string   | stdout      | Write the diff to `<file>`.                                                  |
| `--exit-on-change` | bool     | `false`     | Exit `4` when the diff is non-empty (CI gate).                               |
| `--scope`          | string   | —           | Restrict the diff to a subgraph (e.g. `pkg:web`, `path:src/server/**`).      |

**Examples**

```sh
codegraph diff main HEAD --format markdown --out diff.md
codegraph diff base.ir.json head.ir.json --format json
codegraph diff main HEAD --exit-on-change         # fails CI if anything changed
```

---

### `codegraph serve [ir]`

Start the local React Flow viewer with the IR mounted. If `[ir]` is omitted, indexes the working directory on the fly.

| Flag           | Type   | Default     | Description                                |
| -------------- | ------ | ----------- | ------------------------------------------ |
| `[ir]`         | positional | —       | Path to an IR JSON file.                   |
| `-p, --port`   | int    | `4115`      | Port to bind.                              |
| `--host`       | string | `127.0.0.1` | Host to bind.                              |
| `--no-open`    | bool   | —           | Do not auto-open the browser.              |
| `--watch`      | bool   | `false`     | Re-index on filesystem changes.            |

```sh
codegraph serve ir.json
codegraph serve --watch                # index cwd, re-run on file changes
codegraph serve ir.json --port 9000 --no-open
```

---

### `codegraph export <format> [ir]`

Render an IR to a textual graph format. If `[ir]` is omitted, reads from stdin.

| Flag                    | Type    | Default | Description                                                |
| ----------------------- | ------- | ------- | ---------------------------------------------------------- |
| `<format>`              | enum    | —       | `mermaid` \| `d2` \| `dot` \| `graphviz`.                  |
| `[ir]`                  | positional | stdin | Path to an IR JSON file.                                 |
| `-o, --out <file>`      | string  | stdout  | Write output to `<file>`.                                  |
| `--include <selector>`  | string\[] | —     | Subgraph selector to include. Repeatable.                  |
| `--exclude <selector>`  | string\[] | —     | Subgraph selector to exclude. Repeatable.                  |
| `--depth <n>`           | int     | —       | Max edge-traversal depth from each seed node.              |
| `--collapse <kind>`     | string\[] | —     | Collapse nodes of `<kind>` into a single node. Repeatable. |

Subgraph selectors share a common DSL with `--scope` on `diff`:

```
pkg:<name>           # one workspace package
path:<glob>          # files matching a glob
node:<id>            # a specific node by id
kind:<kind>          # all nodes of a kind (e.g. kind:export)
tag:<label>          # nodes carrying a config tag
```

```sh
codegraph export mermaid ir.json --include pkg:web --depth 2 --out web.mmd
cat ir.json | codegraph export d2 --collapse module > graph.d2
codegraph export dot ir.json | dot -Tsvg > graph.svg
```

---

### `codegraph init`

Write a starter `.codegraph.yml` to the current directory.

| Flag         | Type   | Default   | Description                                                |
| ------------ | ------ | --------- | ---------------------------------------------------------- |
| `-f, --force`| bool   | `false`   | Overwrite an existing config file.                         |
| `--template` | enum   | `minimal` | `minimal` \| `typescript` \| `python` \| `polyglot`.       |

---

### `codegraph adapter list | add | remove`

Manage language/runtime adapters.

```sh
codegraph adapter list
codegraph adapter add @codegraph/adapter-typescript
codegraph adapter add @codegraph/adapter-python --version ^0.4.0
codegraph adapter remove @codegraph/adapter-python
```

---

## Global flags

These work on every subcommand.

| Flag                  | Type   | Default            | Description                                          |
| --------------------- | ------ | ------------------ | ---------------------------------------------------- |
| `-V, --version`       | —      | —                  | Print the CLI version and exit.                      |
| `-h, --help`          | —      | —                  | Show help for a command.                             |
| `-c, --config <path>` | string | `$CODEGRAPH_CONFIG`| Path to `.codegraph.yml`.                            |
| `-v, --verbose`       | bool   | `false`            | Verbose diagnostics on stderr.                       |
| `-q, --quiet`         | bool   | `false`            | Suppress non-error stderr.                           |
| `--json`              | bool   | `false`            | JSON output on stdout (see contract below).          |
| `--no-color`          | bool   | —                  | Disable ANSI color (also `$NO_COLOR`).               |

`--verbose` and `--quiet` are mutually exclusive; if both are passed, `--verbose` wins.

---

## Exit codes

| Code | Name                  | Meaning                                                                 |
| ---- | --------------------- | ----------------------------------------------------------------------- |
| `0`  | `Success`             | Command completed cleanly.                                              |
| `1`  | `UserError`           | Bad flags, missing arguments, unknown command, missing input file.      |
| `2`  | `IndexerError`        | An adapter or the indexer crashed while building the IR.                |
| `3`  | `IrValidationFailed`  | Output IR failed schema validation or invariant checks.                 |
| `4`  | `DiffChanged`         | `diff --exit-on-change` saw a non-empty diff.                           |
| `5`  | `ConfigError`         | `.codegraph.yml` is missing, unparsable, or references unknown adapter. |
| `6`  | `CacheError`          | Cache directory unreadable / unwritable.                                |
| `7`  | `ServerError`         | `serve` failed to bind, or the server shut down uncleanly.              |
| `99` | `InternalError`       | Unexpected/internal error — please file a bug.                          |

These codes are a public API; the GitHub Action in `packages/action` consumes them directly.

---

## stdout / stderr contract

`codegraph` keeps stdout machine-readable on every command:

* **stdout** — the command's payload. Either:
  * the IR JSON document (`index`),
  * the diff document (`diff`),
  * the rendered text (`export`), or
  * a single JSON envelope when `--json` is set.
* **stderr** — human-readable diagnostics: progress, warnings, errors, `--verbose` traces. Nothing on stderr is structured.

This means `codegraph index . > ir.json` always produces a valid IR file, even with `--verbose`. ANSI color is auto-disabled when stdout/stderr is not a TTY, and forcibly disabled by `--no-color` or `$NO_COLOR=1`.

### `--json` envelope

When `--json` is passed, every command emits a single JSON object on stdout instead of its native payload. The shape is:

```jsonc
{
  "version": "0.1.0",          // CLI version
  "command": "index",          // subcommand path
  "ok": true,                  // false on non-zero exit
  "exitCode": 0,
  "data": { /* command-specific payload, e.g. the IR */ },
  "diagnostics": [             // structured copies of anything that went to stderr
    { "level": "warning", "message": "...", "source": "adapter:typescript" }
  ]
}
```

`--json` plus `--out <file>` writes the envelope to `<file>` and leaves stdout empty, for pipelines that need both a file artefact and a clean stdout.

---

## Environment variables

| Variable             | Default   | Description                                                                                          |
| -------------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| `CODEGRAPH_CONFIG`   | —         | Path to `.codegraph.yml`. Overridden by `--config`.                                                  |
| `CODEGRAPH_CACHE`    | `.codegraph-cache` | Cache directory for incremental indexing. Overridden by `--cache-dir`.                       |
| `NO_COLOR`           | unset     | When set (any non-empty value), disables ANSI color. Same effect as `--no-color`.                    |
| `CODEGRAPH_LOG`      | `info`    | Minimum stderr log level (`debug` \| `info` \| `warn` \| `error`). Combines with `--verbose`/`--quiet`. |

Precedence: explicit flag > environment variable > built-in default.

---

## Examples in CI

Fail a PR when the public graph changes:

```yaml
- run: npx @codegraph/cli index . --out head.ir.json
- run: npx @codegraph/cli diff origin/main head.ir.json --exit-on-change --format markdown --out diff.md
```

Publish a Mermaid diagram of just one package:

```sh
codegraph index . | codegraph export mermaid --include pkg:web --depth 3 > web.mmd
```

---

## License

MIT — see `LICENSE`.
