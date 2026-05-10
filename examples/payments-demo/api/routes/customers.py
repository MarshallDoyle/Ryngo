"""GET /customers/{id} and POST /customers — customer CRUD subset."""
from __future__ import annotations

import uuid
from fastapi import APIRouter, HTTPException

from api.db import get_db
from api.models import CustomerIn, CustomerOut

router = APIRouter(prefix="/customers", tags=["customers"])


@router.get("/{customer_id}", response_model=CustomerOut)
async def get_customer(customer_id: str) -> CustomerOut:
    db = await get_db()
    customer = await db.customer.find_unique(where={"id": customer_id})
    if customer is None:
        raise HTTPException(status_code=404, detail="customer_not_found")
    return CustomerOut(
        id=customer.id,
        email=customer.email,
        createdAt=customer.createdAt.isoformat(),
    )


@router.post("", response_model=CustomerOut)
async def create_customer(payload: CustomerIn) -> CustomerOut:
    db = await get_db()
    customer = await db.customer.create(
        data={
            "id": f"cus_{uuid.uuid4().hex[:16]}",
            "email": payload.email,
        }
    )
    return CustomerOut(
        id=customer.id,
        email=customer.email,
        createdAt=customer.createdAt.isoformat(),
    )
