"""Prisma client wrapper.

We use prisma-client-py against the schema in `../prisma/schema.prisma`.
codegraph's Prisma adapter should match `db.charge.create / find / update`
against the `Charge` model in the schema and emit db-write / db-read edges.
"""
from __future__ import annotations

import os
from prisma import Prisma

DATABASE_URL = os.environ.get("DATABASE_URL", "")

_client: Prisma | None = None


async def get_db() -> Prisma:
    global _client
    if _client is None:
        _client = Prisma()
        await _client.connect()
    return _client


async def close_db() -> None:
    global _client
    if _client is not None:
        await _client.disconnect()
        _client = None
