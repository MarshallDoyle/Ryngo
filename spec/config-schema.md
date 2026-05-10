# `.codegraph.yml` Configuration Schema

Status: draft v1
Applies to: `schemaVersion: 1`
File location: repository root, named exactly `.codegraph.yml` (or `.codegraph.yaml`).

---

## 1. Goals & rationale

codegraph is a deterministic, no-LLM static-analysis tool that compiles a codebase
into a typed graph IR (versioned JSON), renders it in React Flow, and diffs it in a
GitHub Action. The config file must:

1. **Be optional.** Running codegraph with no config in a typical repo must produce
   a useful graph. Config exists to refine, not enable.
2. **Be ergonomic.** The common case (declare a frontend/backend split, ignore
   `vendor/`) should fit in ~10 lines.
3. **Be explicit when it matters.** Boundary semantics, custom groupings, and
   adapter behavior are load-bearing for the rendered graph and the diff in CI;
   these get full, documented surface area.
4. **Be versioned.** `schemaVersion` is mandatory at the top so the CLI can refuse
   forward-incompatible files cleanly.
5. **Be deterministic.** No values that depend on machine clocks, env vars at parse
   time, or network state. Anything path-shaped is interpreted relative to the
   config file.

### Design decisions

- **Globs use the `picomatch`/`gitignore` dialect.** `**` matches across
  directories, `*` does not cross `/`, leading `!` negates. This matches what
  developers already type in `.gitignore` and `tsconfig.json`.
- **Boundaries are a map, not a list.** `boundaries.frontend: [...]` reads better
  than `boundaries: [{ name: frontend, patterns: [...] }]` and discourages
  duplicate names. `frontend`, `backend`, `infra` have no privileged meaning;
  they are reserved as suggested defaults but any string key works.
- **Each file belongs to at most one boundary.** When multiple boundary patterns
  match a file, the longest-pattern wins; ties resolve by declaration order in
  the YAML (top wins). Unmatched files go to the implicit `_unassigned`
  boundary, which renders but does not gate the diff.
- **Adapters are opt-out, not opt-in.** Auto-detection runs first; `adapters` only
  exists to disable a detected adapter, force-enable one auto-detect missed, or
  pass adapter-specific options.
- **Grouping is declarative, not imperative.** Users describe *what* to group
  (`pattern`, `boundary`, `tagged`) and *how* it should appear (`collapsed`,
  `label`). The renderer decides geometry.
- **Entry-point hints augment, never replace, auto-detection.** Removing an
  auto-detected entry point requires `entryPoints.exclude`; this keeps the common
  case (add an extra script that codegraph missed) trivial.
- **Output paths default into `.codegraph/`.** A single hidden directory at repo
  root holds the IR, the published viewer bundle, and any caches, so a single
  `.gitignore` line suffices.

### Out of scope for v1

- Multi-repo / monorepo cross-linking (planned for v2 via a `imports:` field).
- Per-branch overrides (planned via `~/.codegraph/overrides.yml`).
- Secret interpolation. Configs are committed; nothing in here should ever be
  secret.

---

## 2. Top-level fields

| Field           | Type          | Required | Default                      | Summary                                       |
| --------------- | ------------- | -------- | ---------------------------- | --------------------------------------------- |
| `schemaVersion` | integer       | yes      | —                            | Currently `1`. CLI rejects unknown versions.  |
| `project`       | object        | no       | `{ name: <repo dir name> }`  | Display metadata.                             |
| `root`          | string        | no       | `.`                          | Path to the source root, relative to config.  |
| `boundaries`    | object        | no       | `{}`                         | Named globs that classify each file.          |
| `ignore`        | string[]      | no       | see [§4.3](#43-ignore)       | Globs excluded from analysis entirely.        |
| `adapters`      | object        | no       | `{}`                         | Per-adapter enable/disable + options.         |
| `groups`        | object[]      | no       | `[]`                         | Custom node-grouping rules for the viewer.    |
| `entryPoints`   | object        | no       | `{ include: [], exclude: []}`| Augment auto-detected entry points.           |
| `output`        | object        | no       | see [§4.7](#47-output)       | Where to write IR + viewer artifacts.         |
| `diff`          | object        | no       | see [§4.8](#48-diff)         | Severity policy for the GitHub Action.        |

Unknown top-level fields are a hard error. Unknown nested fields under
`adapters.<name>` are passed through to the adapter (forward-compatible).

---

## 3. Field-by-field reference

### 3.1 `schemaVersion`

```yaml
schemaVersion: 1
```

Integer. Hard-required. Any value other than `1` is rejected by codegraph 0.x.
Bumping is reserved for breaking changes; additive fields keep version `1`.

### 3.2 `project`

```yaml
project:
  name: my-app          # default: basename of repo root
  description: ""       # optional, shown in viewer header
```

Display-only. Never affects analysis.

### 3.3 `root`

```yaml
root: ./src
```

Path to the directory codegraph treats as the analysis root. All globs in
`boundaries`, `ignore`, `groups`, and `entryPoints` are evaluated relative to
`root`. Defaults to `.` (the directory containing `.codegraph.yml`).

### 3.4 `boundaries`

A map from boundary name (string) to a list of glob patterns. Files matching at
least one pattern of a boundary are tagged with that boundary in the IR. Each
file lands in exactly one boundary (see resolution rules below).

```yaml
boundaries:
  frontend:
    - "web/**"
    - "packages/ui/**"
    - "**/*.tsx"
  backend:
    - "api/**"
    - "services/**"
    - "**/*.go"
  infra:
    - "deploy/**"
    - "terraform/**"
    - "**/*.tf"
```

**Reserved names** (suggested defaults, no special semantics): `frontend`,
`backend`, `infra`, `shared`, `tests`, `tools`. Any other identifier matching
`^[a-zA-Z][a-zA-Z0-9_-]*$` is allowed. The implicit boundary `_unassigned`
collects everything else and is the only name starting with `_`.

**Resolution rules** when a file matches patterns in multiple boundaries:

1. Longest matching pattern wins (more specific = stronger signal).
2. On length tie, the boundary declared earlier in the YAML wins.
3. Negated patterns (`!foo/bar`) inside a boundary's list remove a file from
   that boundary; they never move it to another boundary.

These rules are deterministic and locale-independent.

### 3.5 `ignore`

```yaml
ignore:
  - "**/node_modules/**"
  - "**/dist/**"
  - "**/*.generated.*"
  - "vendor/**"
```

Files matching any pattern are not parsed, not added to the IR, and never appear
in the viewer. `ignore` is applied **before** boundaries. The defaults are merged
with the user list (the user cannot un-ignore a default by omitting it; use a
leading `!` to do that):

```yaml
# implicit defaults
- "**/node_modules/**"
- "**/.git/**"
- "**/dist/**"
- "**/build/**"
- "**/.next/**"
- "**/.turbo/**"
- "**/target/**"           # rust
- "**/__pycache__/**"
- "**/*.min.js"
- "**/*.lock"
```

To re-include something a default ignores:

```yaml
ignore:
  - "!dist/types.d.ts"     # un-ignore one generated file we care about
```

### 3.6 `adapters`

```yaml
adapters:
  typescript:
    enabled: true            # default: auto-detected
    tsconfig: "./tsconfig.json"
    followTypeOnly: false
  python:
    enabled: false           # disable even though it was auto-detected
  go:
    buildTags: ["integration"]
  scip:
    indexPath: "./index.scip"  # use a pre-built SCIP index instead of running indexers
```

Each key is an adapter id. Recognized v1 ids (subject to which adapter packages
ship — confirmed only by inspection of `/adapters` at runtime):
`typescript`, `javascript`, `python`, `go`, `rust`, `java`, `ruby`, `scip`.

**Common subkeys** (all optional):

| Key       | Type    | Purpose                                                      |
| --------- | ------- | ------------------------------------------------------------ |
| `enabled` | boolean | Force on/off. If absent, the adapter runs iff it auto-detects |
| `include` | glob[]  | Restrict to a subset of files the adapter would otherwise see |
| `exclude` | glob[]  | Subtract from that subset                                     |

Anything else under `adapters.<name>` is passed verbatim to the adapter. Unknown
options are the adapter's responsibility to validate.

> Assumption: the exact list of adapter packages is not yet finalized in
> `adapters/`. The schema accepts any string id that matches
> `^[a-z][a-z0-9_-]*$`; the CLI emits a warning (not an error) for ids it does
> not recognize, so configs survive adding/removing adapters.

### 3.7 `groups`

Grouping rules tell the renderer to draw N files/symbols as a single
(optionally collapsed) node. Order matters: the first matching rule wins per
file; a file is in at most one group.

```yaml
groups:
  - id: auth
    label: "Authentication"
    pattern: "internal/auth/**"
    collapsed: true
    color: "#7B5BD6"

  - id: db-models
    label: "DB models"
    boundary: backend
    pattern: "**/models/*.go"
    collapsed: false

  - id: feature-flags
    tagged: "@featureFlag"     # group every symbol whose docstring/decorator carries this tag
    label: "Feature flags"
```

Fields:

| Field       | Type    | Required | Notes                                                       |
| ----------- | ------- | -------- | ----------------------------------------------------------- |
| `id`        | string  | yes      | Stable id used in the IR. `^[a-z][a-z0-9_-]*$`.             |
| `label`     | string  | no       | Human label. Defaults to `id`.                              |
| `pattern`   | glob    | no\*     | Path glob. At least one of `pattern`/`boundary`/`tagged` required. |
| `boundary`  | string  | no\*     | Name from `boundaries`; restricts the rule.                 |
| `tagged`    | string  | no\*     | Symbol-level tag (e.g. a `@codegraph:group=foo` annotation). |
| `collapsed` | boolean | no       | Default `false`. Collapsed groups render as one node.       |
| `color`     | string  | no       | CSS color. Default derived from `id` hash.                  |

`pattern`, `boundary`, `tagged` AND together when more than one is set.

### 3.8 `entryPoints`

Auto-detection finds: HTTP route definitions in known frameworks, CLI
`main`/`__main__` blocks, exported package symbols, and binaries declared in
`package.json` / `pyproject.toml` / `Cargo.toml`. `entryPoints` adds or removes
on top of that.

```yaml
entryPoints:
  include:
    - kind: function
      symbol: "scripts/migrate.ts#runMigration"
    - kind: file
      path: "cmd/worker/main.go"
    - kind: route
      symbol: "api/internal/admin#handler"
      label: "Admin webhook"

  exclude:
    - "tests/**"             # never treat anything under tests/ as an entry point
    - kind: route
      symbol: "api/v1/healthz"
```

Each entry under `include` is an object with:

- `kind`: `function` | `file` | `route` | `export` (default `function`)
- `symbol`: dotted/colon path into the IR (mutually exclusive with `path`)
- `path`: file path relative to `root`
- `label`: optional display name

Entries under `exclude` may be either bare globs (treated as `path` matchers) or
the same object form. Excludes apply after includes and after auto-detection.

### 3.9 `output`

```yaml
output:
  ir:
    path: ".codegraph/ir.json"     # written by `codegraph build`
    pretty: false
    splitChunks: false             # if true, write ir/<sha>/<chunk>.json files
  viewer:
    publish:
      kind: "static"               # "static" | "github-pages" | "none"
      dir: ".codegraph/viewer"     # output dir for the static bundle
      baseUrl: "/"                 # for github-pages, e.g. "/myrepo/"
  cache:
    path: ".codegraph/cache"
    enabled: true
```

| Path                    | Default                  | Notes                                  |
| ----------------------- | ------------------------ | -------------------------------------- |
| `output.ir.path`        | `.codegraph/ir.json`     | Relative to repo root.                 |
| `output.ir.pretty`      | `false`                  | `true` for human-readable, larger.     |
| `output.ir.splitChunks` | `false`                  | Future: chunked IR for huge repos.     |
| `output.viewer.publish.kind` | `"static"`          | `"none"` skips viewer build.           |
| `output.viewer.publish.dir`  | `.codegraph/viewer` |                                       |
| `output.viewer.publish.baseUrl` | `"/"`            | Used by the viewer for asset paths.    |
| `output.cache.path`     | `.codegraph/cache`       | Adapter incremental caches.            |
| `output.cache.enabled`  | `true`                   |                                        |

### 3.10 `diff`

Used only by `packages/action`. The diff produces categorized changes (added /
removed / moved / re-typed) per node + per edge; this section maps categories to
severity for PR annotations.

```yaml
diff:
  fail: ["error"]              # severities that fail the Action
  rules:
    nodeRemoved: error
    nodeAdded: info
    edgeRemoved: warning
    edgeAdded: info
    boundaryViolationAdded: error
    entryPointRemoved: warning
  ignore:
    - "tests/**"
```

Severities: `error` | `warning` | `info` | `off`. Defaults are conservative:
removals are `warning`, additions `info`, and any new edge crossing a boundary
in a direction the user hasn't allowed is `error` (boundary violation logic
itself lives in the IR diff engine, not the config).

---

## 4. Resolution & precedence summary

For any path `p` under `root`:

1. If `p` matches `ignore` (incl. defaults, after applying `!` un-ignores), it
   is dropped. End.
2. Adapters that auto-detected `p` (or are `enabled: true`) parse it. Adapters
   with `enabled: false` skip it.
3. The boundary of `p` is computed via the rules in §3.4.
4. Group membership is computed via the first-matching rule in `groups`.
5. Entry-point auto-detection runs; then `entryPoints.include` adds; then
   `entryPoints.exclude` subtracts.
6. The IR is written to `output.ir.path`.

The whole pipeline is pure given (config + filesystem snapshot). No step reads
env vars, system time, or network.

---

## 5. Examples

### 5.1 Zero-config

No `.codegraph.yml` is required. codegraph runs adapters on auto-detect, applies
default `ignore` patterns, builds an IR with one implicit `_unassigned`
boundary, and writes it to `.codegraph/ir.json`.

### 5.2 Minimal — just `schemaVersion`

```yaml
schemaVersion: 1
```

Identical behavior to no file present, but explicit. Recommended for any repo
that runs the CI Action so the version contract is recorded.

### 5.3 Boundaries only — typical web app

```yaml
schemaVersion: 1

boundaries:
  frontend:
    - "web/**"
    - "**/*.tsx"
  backend:
    - "api/**"
    - "services/**"
  shared:
    - "packages/types/**"

ignore:
  - "**/*.generated.ts"
```

This is enough for the diff to flag any new edge from `frontend` into `backend`
that doesn't pass through `shared`.

### 5.4 Full custom — monorepo with infra + custom group + diff policy

```yaml
schemaVersion: 1

project:
  name: acme-platform
  description: "Customer-facing app + internal services"

root: .

boundaries:
  frontend:
    - "apps/web/**"
    - "apps/admin/**"
    - "packages/ui/**"
  backend:
    - "apps/api/**"
    - "services/**/*.go"
    - "services/**/*.py"
  infra:
    - "deploy/**"
    - "terraform/**"
    - ".github/workflows/**"
  shared:
    - "packages/types/**"
    - "packages/proto/**"

ignore:
  - "**/*.gen.go"
  - "**/*.pb.go"
  - "!packages/proto/index.gen.ts"   # re-include this one despite *.gen.* default

adapters:
  typescript:
    tsconfig: "./tsconfig.base.json"
  go:
    buildTags: ["integration"]
  python:
    enabled: false                   # we have a tiny scripts/ dir we don't care about
  scip:
    indexPath: "./build/index.scip"  # pre-built in CI

groups:
  - id: auth
    label: "Auth subsystem"
    pattern: "services/auth/**"
    collapsed: true
    color: "#7B5BD6"
  - id: billing-models
    label: "Billing models"
    boundary: backend
    pattern: "services/billing/internal/models/**"
  - id: feature-flags
    label: "Feature flags"
    tagged: "@featureFlag"

entryPoints:
  include:
    - kind: file
      path: "cmd/worker/main.go"
      label: "Background worker"
    - kind: function
      symbol: "scripts/migrate.ts#runMigrations"
  exclude:
    - "tests/**"
    - "**/__fixtures__/**"

output:
  ir:
    path: "build/codegraph/ir.json"
    pretty: true
  viewer:
    publish:
      kind: "github-pages"
      dir: "build/codegraph/viewer"
      baseUrl: "/acme-platform/"
  cache:
    path: ".codegraph/cache"

diff:
  fail: ["error"]
  rules:
    nodeRemoved: error
    edgeRemoved: warning
    boundaryViolationAdded: error
    entryPointRemoved: warning
  ignore:
    - "tests/**"
    - "**/scratch/**"
```

---

## 6. Validation

The schema in `spec/config.schema.json` (JSON Schema draft 2020-12) is the
source of truth. The CLI validates every load and prints the failing path
(`/boundaries/frontend/2`) with the offending value. Validation is the same
code path used by the LSP-style editor integration that ships with the viewer.

## 7. Migration & versioning

- Additive changes (new optional fields, new adapter ids) keep `schemaVersion: 1`.
- Breaking changes bump to `2`. The CLI ships `codegraph migrate` to rewrite
  v1 → vN files mechanically when possible.
- A config with a higher `schemaVersion` than the CLI knows is a hard error,
  not a warning, to keep CI reproducible.
