"""Bearer-token auth dependency.

Applied via FastAPI's `dependencies=[Depends(require_auth)]` on the
refunds and customers routers in `api/main.py`. The charges router
deliberately omits this dependency, which codegraph should surface as
"some routes are protected, some are not."
"""
from __future__ import annotations

import os
from fastapi import Header, HTTPException, status

EXPECTED_TOKEN = os.environ.get("PAYMENTS_API_TOKEN", "local-dev-token")


def require_auth(authorization: str | None = Header(default=None)) -> None:
    if authorization is None or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing bearer token",
        )
    token = authorization.removeprefix("Bearer ").strip()
    if token != EXPECTED_TOKEN:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid token",
        )
