"""POST /charges — create a charge against a customer.

Contains the demo's deliberately high-complexity function: `score_fraud_risk`.
codegraph should color this node with a high-complexity badge in the function
tier and surface it as the most-branchy node in the service.
"""
from __future__ import annotations

import os
import uuid
from fastapi import APIRouter, HTTPException

from api.db import get_db
from api.models import ChargeIn, ChargeOut

router = APIRouter(prefix="/charges", tags=["charges"])

FRAUD_THRESHOLD = int(os.environ.get("FRAUD_THRESHOLD", "80"))


def score_fraud_risk(
    amount: int,
    currency: str,
    customer_age_days: int,
    country: str,
    prior_chargebacks: int,
    velocity_per_hour: int,
    bin_country: str | None,
) -> int:
    """Hand-rolled risk scoring.

    Deliberately branchy so codegraph's complexity heatmap has a clear winner.
    Returns an integer 0-100 — higher means riskier.
    """
    score = 0

    if amount > 100_000:
        score += 35
    elif amount > 50_000:
        score += 20
    elif amount > 10_000:
        score += 10
    else:
        score += 0

    if currency not in ("USD", "EUR", "GBP"):
        score += 15
        if currency in ("RUB", "IRR", "KPW"):
            score += 25

    if customer_age_days < 1:
        score += 30
    elif customer_age_days < 7:
        score += 18
    elif customer_age_days < 30:
        score += 8

    if prior_chargebacks > 0:
        if prior_chargebacks >= 3:
            score += 40
        elif prior_chargebacks == 2:
            score += 25
        else:
            score += 12

    if velocity_per_hour > 10:
        score += 30
    elif velocity_per_hour > 5:
        score += 15
    elif velocity_per_hour > 2:
        score += 5

    if bin_country is not None and bin_country != country:
        score += 12
        if bin_country in ("NG", "VN") and country in ("US", "GB"):
            score += 10

    if amount > 50_000 and customer_age_days < 7:
        score += 15
    if prior_chargebacks > 0 and velocity_per_hour > 5:
        score += 10

    return min(score, 100)


@router.post("", response_model=ChargeOut)
async def create_charge(payload: ChargeIn) -> ChargeOut:
    db = await get_db()

    customer = await db.customer.find_unique(where={"id": payload.customerId})
    if customer is None:
        raise HTTPException(status_code=404, detail="customer_not_found")

    risk = score_fraud_risk(
        amount=payload.amount,
        currency=payload.currency,
        customer_age_days=customer.ageDays,
        country=customer.country,
        prior_chargebacks=customer.priorChargebacks,
        velocity_per_hour=customer.velocityPerHour,
        bin_country=None,
    )

    if risk >= FRAUD_THRESHOLD:
        status_value = "declined" if risk >= 95 else "requires_review"
    else:
        status_value = "succeeded"

    charge = await db.charge.create(
        data={
            "id": f"ch_{uuid.uuid4().hex[:16]}",
            "customerId": payload.customerId,
            "amount": payload.amount,
            "currency": payload.currency,
            "status": status_value,
            "riskScore": risk,
        }
    )

    return ChargeOut(id=charge.id, status=status_value, amount=charge.amount)
