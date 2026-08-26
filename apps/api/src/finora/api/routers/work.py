"""Unified work queue endpoints.

One answer to "what needs me", spanning approvals, receipt confirmations,
document reviews, vendor conclusions and the inbox. Ordered by how long each
item has waited. Badge counts feed the navigation without a second round trip
per section.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from finora.api.deps import CurrentUserDep, RequirePermission, WorkServiceDep
from finora.domain.roles import Permission
from finora.domain.work import WorkItem, WorkKind

router = APIRouter(prefix="/work", tags=["work"])


class WorkItemOut(BaseModel):
    kind: WorkKind
    kind_label: str
    record_id: uuid.UUID
    record_path: str
    reference: str
    title: str
    subtitle: str
    waiting_since: datetime
    waiting_hours: int
    amount_formatted: str | None = None
    detail: str | None = None


class WorkQueueOut(BaseModel):
    items: list[WorkItemOut]
    total: int
    counts_by_kind: dict[str, int]


class WorkBadgesOut(BaseModel):
    """Counts keyed exactly as the web navigation badge slots expect."""

    myWork: int
    awaitingMyApproval: int
    documentsNeedingReview: int
    intakeUnprocessed: int
    vendorNeedingReview: int
    operationalAlerts: int


def _item(row: WorkItem) -> WorkItemOut:
    return WorkItemOut(
        kind=row.kind,
        kind_label=row.kind_label,
        record_id=row.record_id,
        record_path=row.record_path,
        reference=row.reference,
        title=row.title,
        subtitle=row.subtitle,
        waiting_since=row.waiting_since,
        waiting_hours=row.waiting_hours,
        amount_formatted=row.amount_formatted,
        detail=row.detail,
    )


@router.get("/queue", response_model=WorkQueueOut)
def read_queue(
    service: WorkServiceDep,
    user: CurrentUserDep,
    _: Annotated[object, Depends(RequirePermission(Permission.report_view))] = None,
    kind: Annotated[
        list[WorkKind] | None, Query(description="Limit to these kinds of work")
    ] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> WorkQueueOut:
    """Everything waiting on this caller, oldest first."""
    kinds = frozenset(kind) if kind else None
    items, total, counts = service.queue(user=user, kinds=kinds, limit=limit, offset=offset)
    return WorkQueueOut(
        items=[_item(row) for row in items],
        total=total,
        counts_by_kind=counts,
    )


@router.get("/badges", response_model=WorkBadgesOut)
def read_badges(
    service: WorkServiceDep,
    user: CurrentUserDep,
    _: Annotated[object, Depends(RequirePermission(Permission.report_view))] = None,
) -> WorkBadgesOut:
    """Navigation badge counts for this caller."""
    badges = service.badges(user=user)
    mapped = badges.as_map()
    return WorkBadgesOut(
        myWork=mapped["myWork"],
        awaitingMyApproval=mapped["awaitingMyApproval"],
        documentsNeedingReview=mapped["documentsNeedingReview"],
        intakeUnprocessed=mapped["intakeUnprocessed"],
        vendorNeedingReview=mapped["vendorNeedingReview"],
        operationalAlerts=mapped["operationalAlerts"],
    )


@router.get("/dashboard", response_model=WorkQueueOut)
def read_dashboard(
    service: WorkServiceDep,
    user: CurrentUserDep,
    _: Annotated[object, Depends(RequirePermission(Permission.report_view))] = None,
    limit: Annotated[int, Query(ge=1, le=20)] = 5,
) -> WorkQueueOut:
    """The handful of next actions the home page shows."""
    # Exclude inbox noise from the home page: ready mail belongs on Inbox.
    items, total, counts = service.queue(
        user=user,
        kinds=frozenset(
            {
                WorkKind.approval,
                WorkKind.sign_off,
                WorkKind.document_review,
                WorkKind.vendor_review,
            }
        ),
        limit=limit,
        offset=0,
    )
    return WorkQueueOut(
        items=[_item(row) for row in items],
        total=total,
        counts_by_kind=counts,
    )
