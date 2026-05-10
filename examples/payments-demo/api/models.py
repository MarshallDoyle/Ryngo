"""Pydantic request / response shapes for the payments API."""
from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field


class ChargeIn(BaseModel):
    amount: int = Field(gt=0, description="Amount in minor units")
    currency: str = Field(min_length=3, max_length=3)
    customerId: str


class ChargeOut(BaseModel):
    id: str
    status: Literal["succeeded", "requires_review", "declined"]
    amount: int


class RefundIn(BaseModel):
    chargeId: str
    reason: str


class RefundOut(BaseModel):
    id: str
    chargeId: str
    status: Literal["refunded"]


class CustomerIn(BaseModel):
    email: str


class CustomerOut(BaseModel):
    id: str
    email: str
    createdAt: str
