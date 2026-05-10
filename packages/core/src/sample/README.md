# Sample IR generator

`generator.ts` produces deterministic, plausibly-realistic IR JSON for a
fictional 3-tier web application. It is used by:

- the **viewer** during development (no real adapter run required),
- demo / marketing **screenshots**,
- snapshot **test fixtures**,
- viewer **performance** testing at large scale.

The generator is dependency-free: no Node built-ins, no third-party imports.
It can run in a browser, a worker, or `node`.

## Topology

Every output is a single 3-tier app:

| Service | Tier      | Modules | Notes                                |
| ------- | --------- | ------- | ------------------------------------ |
| `web`   | frontend  | 12      | pages, components, api-client, ...   |
| `api`   | backend   | 15      | routes, services, repositories, ...  |
| `worker`| worker    | 5       | main, consumers, tasks, retry, metrics |
| `db`    | database  | 8 tables (as `type` nodes)             |

Cross-service edges:

- `web/api-client` &rarr; `api/routes` (HTTP, marked `effect: "network"`, `sink: true`)
- `api/repositories` &rarr; `db/<table>` (`reads` / `writes`, marked `effect: "db_*"`)
- `api/queue` &rarr; `worker/consumers` (queue dispatch, `effect: "queue"`)
- `worker/tasks` &rarr; `db/<table>` (`writes`, marked `sink: true`)

Plus:

- a sprinkle of unresolved / dynamic-dispatch edges (~8% of `calls`)
- a few `unknown`-typed edges (~5% of `calls`)
- a handful of dead-code functions (`attributes.dead = true`)
- "hot" modules (`routes`, `services`, `pages`, `components`) carry a higher
  `attributes.churn` metric and substantially more functions

## Sizes

Selected with `--size`:

| Size   | Approx. nodes | Use case               |
| ------ | ------------- | ---------------------- |
| small  | ~50–80        | screenshots, fixtures  |
| medium | ~500          | typical real app       |
| large  | ~5,000        | viewer perf testing    |

Real output lands within ~10% of the stated target.

## Determinism

Every run is fully deterministic in `(size, seed)`. The same seed produces
byte-identical JSON across machines and Node versions — the generator uses a
Mulberry32 PRNG seeded from the `seed` flag. No `Date.now()`, no `Math.random()`,
no system entropy; the embedded `meta.commit` is itself derived from the seed.

## Usage

### Programmatic

```ts
import { generateSampleIR } from '@codegraph/core/sample/generator';
import { writeFileSync } from 'node:fs';

const ir = generateSampleIR({ size: 'medium', seed: 42 });
writeFileSync('sample.json', JSON.stringify(ir, null, 2));
```

### CLI (via root `pnpm sample`)

Once wired into the workspace:

```sh
pnpm sample                  # default: small, seed 1
pnpm sample medium           # ~500-node IR
pnpm sample large            # ~5000-node IR
pnpm sample medium --seed 7  # different but deterministic medium
```

The pre-generated `sample-small.json` is committed under
`packages/viewer/public/sample-small.json` so the dev viewer has something to
show on first load. The medium and large sizes are intentionally **not**
committed — generate them on demand.

## Output shape (matches `@codegraph/core/ir`)

The generator emits an `IRDocument` with `schemaVersion` at the root and the
canonical `{metadata, nodes, edges}` graph nested under `ir`. Node IDs are
32-char lowercase hex digests of the canonical signature string (cyrb128 in
the generator; production indexers use BLAKE3-128 — the contract is the
length and lowercase hex shape, not the specific hash function).

```jsonc
{
  "schemaVersion": "0.1.0",
  "ir": {
    "metadata": {
      "repo": "codegraph/sample-app",
      "commit": "<deterministic 40-char hex>",
      "generatedAt": "2026-05-08T00:00:00.000Z",
      "generators": [
        { "name": "@codegraph/core sample", "version": "0.1.0",
          "size": "small", "seed": 1, "nodeCount": 56, "edgeCount": 90 }
      ]
    },
    "nodes": [
      { "id": "<32-hex>", "tier": "service", "name": "web",
        "path": "apps/web", "lang": "ts", "manifest": "apps/web/package.json",
        "signature": "service|codegraph/sample-app|apps/web" },
      { "id": "<32-hex>", "tier": "module", "name": "api-client",
        "parentId": "<service-id>",
        "path": "apps/web/src/api-client/index.ts", "lang": "ts",
        "signature": "module|<service-id>|apps/web/src/api-client/index.ts" },
      { "id": "<32-hex>", "tier": "function", "name": "getUser",
        "parentId": "<module-id>", "kind": "async",
        "pure": false, "exported": true,
        "params": [{ "name": "user",
                     "type": { "lang": "ts", "display": "User",
                               "source": "annotated" } }],
        "returnType": { "lang": "ts", "display": "Promise<User>",
                        "source": "annotated" },
        "asyncness": "async",
        "signature": "function|<module-id>|getUser|1|User" }
    ],
    "edges": [
      { "sourceId": "<api-client-fn>", "targetId": "<routes-fn>",
        "category": "network", "method": "GET", "kind": "http" },
      { "sourceId": "<repo-fn>", "targetId": "<table>",
        "category": "db-write", "store": "postgres",
        "entity": "users", "op": "insert" }
    ]
  }
}
```

Notes:

- Hierarchy is encoded only via `parentId`. There is no `contains` edge.
- Dynamic-dispatch calls carry `callKind: "dynamic"` on the `call` edge.
- "Dead" functions get a `tags: ["dead"]` entry; the viewer can dim them.
- Effects are surfaced through `pure: false` plus appropriate edge categories
  (`network`, `db-read`, `db-write`); "hot" functions in this fixture are
  always `pure: false`.
