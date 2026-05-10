# payments-demo

A tiny, MIT-licensed payments app used as the reference fixture for the codegraph launch video and README hero GIF. It is deliberately small — about 25 source files and ~50 functions — so the function-tier graph fits on a single canvas without panning.

The demo is **not** wired up to run. It is a static-analysis fixture: codegraph reads the source and lifts it into a graph IR. There is no install step, no migrations to apply, no servers to start.

## Stack

- **Next.js (App Router, TypeScript)** at the repo root: renders a checkout form and a refund form, exposes `/api/*` Route Handlers that proxy through a typed client to the FastAPI backend. Auth middleware (`middleware.ts`) is applied to `/api/refund/*` and `/api/customer/*` but **not** to `/api/charge/*`.
- **FastAPI (Python)** under `api/`: three resource modules — charges, refunds, customers — plus a webhook endpoint that uses a string-keyed dispatch table.
- **Prisma + Postgres** under `prisma/`: a shared schema with `Customer`, `Charge`, `Refund` models. Both sides reference the same models (TS via `@prisma/client`, Python via `prisma-client-py`).

## What this fixture demonstrates to codegraph

Each item below is a feature codegraph is meant to surface. Indexing this repo and opening the viewer should make every one of them visible.

| # | Feature                              | Where to look in the source                                                                  |
| - | ------------------------------------ | -------------------------------------------------------------------------------------------- |
| 1 | Cross-service edge (Next.js → API)   | `app/api/charge/route.ts` → `lib/api-client.ts#postCharge` → `fetch` → `api/routes/charges.py#create_charge` |
| 2 | Database read + write (Prisma)       | `api/routes/charges.py` and `refunds.py` use `db.charge.create` / `db.charge.find_unique` / `db.charge.update` |
| 3 | Environment variable                 | `api/db.py` (`DATABASE_URL`), `api/routes/charges.py` (`FRAUD_THRESHOLD`), `lib/api-client.ts` (`PAYMENTS_API_TOKEN`) |
| 4 | Dead code (unused exported helper)   | `lib/format.ts#formatCardLast4` — exported but no inbound edge in the repo                   |
| 5 | Dynamic / unresolved dispatch        | `api/_handlers_dispatch.py#dispatch` — `_HANDLERS[name]()` lookup table; the edge from `dispatch` fans out to four handlers as kind `calls?` |
| 6 | High-complexity function             | `api/routes/charges.py#score_fraud_risk` — nested branches on amount, currency, age, chargebacks, velocity, country mismatch |
| 7 | Auth applied selectively (Next.js)   | `middleware.ts` matcher covers `/api/refund/*` and `/api/customer/*`, omits `/api/charge/*`  |
| 8 | Auth applied selectively (FastAPI)   | `api/main.py` — `Depends(require_auth)` on the refunds and customers routers, not on charges, healthz, or webhooks |

The `.codegraph.yml` at the repo root declares three boundaries — `web`, `payments-api`, `data` — so the service-tier view shows them as separate rounded rectangles with typed edges between them.

## Layout

```
payments-demo/
├── README.md                          (this file)
├── LICENSE                            (MIT)
├── .codegraph.yml                     (boundaries + adapters + effect roots)
├── .env.example                       (env vars referenced by both sides)
├── package.json                       (Next.js workspace root)
├── next.config.ts
├── tsconfig.json
├── middleware.ts                      (auth on /api/refund/*, /api/customer/*)
├── app/
│   ├── layout.tsx
│   ├── page.tsx
│   ├── charge/page.tsx                (client component — form + fetch /api/charge)
│   ├── refund/page.tsx                (client component — form + fetch /api/refund)
│   └── api/
│       ├── charge/route.ts            (POST /api/charge — no auth)
│       ├── refund/route.ts            (POST /api/refund — auth via middleware)
│       └── customer/[id]/route.ts     (GET  /api/customer/:id — auth via middleware)
├── lib/
│   ├── api-client.ts                  (typed fetch client — the cross-service edge origin)
│   └── format.ts                      (formatAmount used; formatCardLast4 is dead code)
├── api/
│   ├── pyproject.toml
│   ├── __init__.py
│   ├── main.py                        (FastAPI app + selective auth wiring)
│   ├── db.py                          (Prisma client wrapper, reads DATABASE_URL)
│   ├── models.py                      (Pydantic request/response shapes)
│   ├── _handlers_dispatch.py          (handlers[name]() — dynamic dispatch demo)
│   ├── middleware/
│   │   └── auth.py                    (require_auth dependency)
│   └── routes/
│       ├── charges.py                 (POST /charges + score_fraud_risk high-complexity)
│       ├── refunds.py                 (POST /refunds)
│       └── customers.py               (GET/POST /customers)
└── prisma/
    ├── schema.prisma                  (Customer, Charge, Refund)
    └── migrations/
        └── init.sql                   (SQL form of the schema)
```

## Use in the launch video

The 60-second demo (`marketing/demo-script.md`) and the 8-second README hero GIF (`marketing/hero-gif-storyboard.md`) both film against this repo:

- The service-tier shot at 5–8s shows the three boundary rectangles (`web`, `payments-api`, `data`) and the cross-service edge between them.
- The drilldown at 8–14s zooms into `payments-api` and lands on `score_fraud_risk` — the function colored with a high-complexity badge.
- The typed-edge inspector at 14–25s pops on the `app/api/charge/route.ts → fetch → /charges` edge, showing the inferred argument shape `{ amount, currency, customerId }`.
- The dead-code surfacing (`formatCardLast4`) and the dynamic-dispatch fan-out (`dispatch → _HANDLERS[name]()`) are auxiliary beats available for the deep-dive cut.

## License

MIT. See `LICENSE`. Free to fork, vendor, or rip apart for your own demos.
