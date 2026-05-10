"""Webhook event dispatch table.

This is the codegraph-required *unresolved-dispatch* demo: incoming Stripe-style
webhook events are dispatched through a string-keyed `_HANDLERS` lookup. Static
analysis cannot statically resolve `_HANDLERS[name]()` to a single callee, so
codegraph should render the edge from `dispatch` as kind `"calls?"` (dynamic /
indirect) fanning out to all four handlers below.
"""
from __future__ import annotations

from typing import Awaitable, Callable

from api.db import get_db


HandlerFn = Callable[[dict], Awaitable[None]]


async def handle_charge_succeeded(event: dict) -> None:
    db = await get_db()
    await db.charge.update(
        where={"id": event["data"]["id"]},
        data={"status": "succeeded"},
    )


async def handle_charge_refunded(event: dict) -> None:
    db = await get_db()
    await db.charge.update(
        where={"id": event["data"]["id"]},
        data={"status": "refunded"},
    )


async def handle_customer_created(event: dict) -> None:
    db = await get_db()
    await db.customer.update(
        where={"id": event["data"]["id"]},
        data={"verified": True},
    )


async def handle_unknown(event: dict) -> None:
    return None


_HANDLERS: dict[str, HandlerFn] = {
    "charge.succeeded": handle_charge_succeeded,
    "charge.refunded": handle_charge_refunded,
    "customer.created": handle_customer_created,
}


async def dispatch(event: dict) -> None:
    name = event.get("type", "")
    handler = _HANDLERS.get(name, handle_unknown)
    await handler(event)
