"""Global search across registers the caller may view."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Query
from pydantic import BaseModel

from finora.api.deps import CurrentUserDep, SearchServiceDep
from finora.domain.search import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    SearchHit,
    SearchRecordType,
)

router = APIRouter(prefix="/search", tags=["search"])


class SearchHitOut(BaseModel):
    record_type: SearchRecordType
    type_label: str
    record_id: uuid.UUID
    record_path: str
    reference: str
    title: str
    subtitle: str
    state: str | None = None
    amount_formatted: str | None = None


class SearchResponse(BaseModel):
    query: str
    items: list[SearchHitOut]
    total: int


def _hit(row: SearchHit) -> SearchHitOut:
    return SearchHitOut(
        record_type=row.record_type,
        type_label=row.type_label,
        record_id=row.record_id,
        record_path=row.record_path,
        reference=row.reference,
        title=row.title,
        subtitle=row.subtitle,
        state=row.state,
        amount_formatted=row.amount_formatted,
    )


@router.get("", response_model=SearchResponse)
def search(
    service: SearchServiceDep,
    user: CurrentUserDep,
    q: Annotated[str, Query(min_length=1, max_length=200)],
    record_type: Annotated[
        list[SearchRecordType] | None,
        Query(description="Limit to these record kinds"),
    ] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
) -> SearchResponse:
    """Find records by reference, vendor, description or filename."""
    types = frozenset(record_type) if record_type else None
    items = service.search(user=user, query=q, types=types, limit=limit)
    return SearchResponse(query=q.strip(), items=[_hit(row) for row in items], total=len(items))
