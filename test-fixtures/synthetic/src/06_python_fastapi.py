"""Exercises: FastAPI route + Pydantic schema + Depends.

The adapter must produce:
  - http-route edge from `read_widget` to literal "/widgets/{widget_id}"
  - call edge from `read_widget` to `get_db` via the Depends wrapper
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel


class Widget(BaseModel):
    id: int
    name: str


def get_db() -> object:
    return object()


router = APIRouter()


@router.get("/widgets/{widget_id}")
def read_widget(widget_id: int, db: object = Depends(get_db)) -> Widget:
    return Widget(id=widget_id, name="example")
