"""Polyglot edge: Python side. The literal "/widgets/{widget_id}" must match
the URL-string used by web.ts so the adapter can infer a cross-language
http-route -> network edge.
"""

from fastapi import APIRouter

router = APIRouter()


@router.get("/widgets/{widget_id}")
def get_widget(widget_id: int) -> dict[str, int]:
    return {"id": widget_id}
