"""Audit trail read and verification endpoints.

The trail is append-only elsewhere; these routes only read it and check that the
hash chain still holds. Writing happens on the business paths that cause events.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from finora.api.deps import AuditDep, RequirePermission
from finora.domain.audit import ActorType, AuditAction
from finora.domain.roles import Permission
from finora.infrastructure.db.models import AuditEntryRow

router = APIRouter(prefix="/audit", tags=["audit"])

_VIEW = Depends(RequirePermission(Permission.audit_view))


class AuditEntryOut(BaseModel):
    sequence: int
    entry_hash: str
    previous_hash: str
    occurred_at: datetime
    action: AuditAction
    actor_type: ActorType
    actor_label: str
    actor_id: uuid.UUID | None
    subject_type: str
    subject_id: uuid.UUID | None
    correlation_id: uuid.UUID | None
    detail: dict[str, Any]


class AuditEntryPage(BaseModel):
    items: list[AuditEntryOut]
    total: int
    limit: int
    offset: int


class VerifyRequest(BaseModel):
    start_sequence: int = Field(default=1, ge=1)
    limit: int | None = Field(default=None, ge=1, le=10_000)


class VerifyResponse(BaseModel):
    """Whether a contiguous slice of the chain still holds together."""

    ok: bool
    checked_count: int
    first_bad_sequence: int | None
    message: str
    reason: str | None = None


def _entry(row: AuditEntryRow) -> AuditEntryOut:
    return AuditEntryOut(
        sequence=row.sequence,
        entry_hash=row.entry_hash,
        previous_hash=row.previous_hash,
        occurred_at=row.occurred_at,
        action=row.action,
        actor_type=row.actor_type,
        actor_label=row.actor_label,
        actor_id=row.actor_id,
        subject_type=row.subject_type,
        subject_id=row.subject_id,
        correlation_id=row.correlation_id,
        detail=row.detail,
    )


@router.get("/entries", response_model=AuditEntryPage, dependencies=[_VIEW])
def list_entries(
    audit: AuditDep,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
    action: Annotated[AuditAction | None, Query()] = None,
    subject_type: Annotated[str | None, Query(max_length=80)] = None,
    subject_id: Annotated[uuid.UUID | None, Query()] = None,
    actor_id: Annotated[uuid.UUID | None, Query()] = None,
) -> AuditEntryPage:
    """Paginated trail, oldest first, with optional filters."""
    items = audit.page(
        offset=offset,
        limit=limit,
        action=action,
        subject_type=subject_type,
        subject_id=subject_id,
        actor_id=actor_id,
    )
    total = audit.count(
        action=action,
        subject_type=subject_type,
        subject_id=subject_id,
        actor_id=actor_id,
    )
    return AuditEntryPage(
        items=[_entry(row) for row in items],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/entries/{sequence}", response_model=AuditEntryOut, dependencies=[_VIEW])
def read_entry(sequence: int, audit: AuditDep) -> AuditEntryOut:
    """One entry by its place in the chain."""
    row = audit.get(sequence)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="That audit entry could not be found.",
        )
    return _entry(row)


@router.post("/verify", response_model=VerifyResponse, dependencies=[_VIEW])
def verify_chain(body: VerifyRequest, audit: AuditDep) -> VerifyResponse:
    """Check that a contiguous range of the chain still holds.

    Offered as a range because a mature trail is too large to hash in one
    request; an auditor checks segments and the segments join because each
    carries its predecessor's hash.
    """
    result = audit.verify(start_sequence=body.start_sequence, limit=body.limit)
    return VerifyResponse(
        ok=result.is_intact,
        checked_count=result.entries_checked,
        first_bad_sequence=result.first_broken_sequence,
        message=result.summary,
        reason=result.reason,
    )
