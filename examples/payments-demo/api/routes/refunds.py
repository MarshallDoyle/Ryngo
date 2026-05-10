"""POST /refunds — refund a previously-succeeded charge."""
from __future__ import annotations

import uuid
from fastapi import APIRouter, HTTPException

from api.db import get_db
from api.models import RefundIn, RefundOut

router = APIRouter(prefix="/refunds", tags=["refunds"])


@router.post("", response_model=RefundOut)
async def create_refund(payload: RefundIn) -> RefundOut:
    db = await get_db()

    charge = await db.charge.find_unique(where={"id": payload.chargeId})
    if charge is None:
        raise HTTPException(status_code=404, detail="charge_not_found")
    if charge.status != "succeeded":
        raise HTTPException(status_code=409, detail="charge_not_refundable")

    refund = await db.refund.create(
        data={
            "id": f"re_{uuid.uuid4().hex[:16]}",
            "chargeId": payload.chargeId,
            "reason": payload.reason,
        }
    )

    await db.charge.update(
        where={"id": payload.chargeId},
        data={"status": "refunded"},
    )

    return RefundOut(id=refund.id, chargeId=refund.chargeId, status="refunded")
