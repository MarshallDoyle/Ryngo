"""FastAPI entrypoint — wires the routers and applies auth selectively.

Routes:
    GET  /healthz          — public, no auth
    POST /charges          — public (deliberately unauthenticated for demo)
    POST /refunds          — auth required
    GET  /customers/{id}   — auth required
    POST /customers        — auth required
    POST /webhooks/stripe  — public, dynamic-dispatch into _handlers_dispatch
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from fastapi import Depends, FastAPI, Request

from api._handlers_dispatch import dispatch
from api.db import close_db
from api.middleware.auth import require_auth
from api.routes import charges, customers, refunds


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await close_db()


app = FastAPI(title="payments-api", lifespan=lifespan)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/webhooks/stripe")
async def webhook(req: Request) -> dict[str, bool]:
    event = await req.json()
    await dispatch(event)
    return {"received": True}


# Charges: NO auth dependency. Some routes are protected, some are not —
# codegraph should render this asymmetry on the route nodes.
app.include_router(charges.router)

# Refunds and customers: auth required.
app.include_router(refunds.router, dependencies=[Depends(require_auth)])
app.include_router(customers.router, dependencies=[Depends(require_auth)])
