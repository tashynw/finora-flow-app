"""One queue for everything waiting on an approver.

An approver does not think in record types. They think "what is waiting on me",
and the answer spans estimates, invoices and purchase orders. Three registers
each with an "awaiting me" filter answers a different question three times and
leaves the person to merge and order the results by eye, which is exactly the
step at which the oldest thing gets missed.

Ordered by how long the route has been open, oldest first. This is a work queue
rather than a register: the thing that has waited longest is the thing somebody
else is waiting on, and there is no reading of "newest first" that serves an
approver.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select

from finora.api.deps import (
    ApprovalServiceDep,
    CurrentUserDep,
    RequirePermission,
    SessionDep,
)
from finora.api.views import awaiting_labels
from finora.domain.approvals import LEVEL_LABELS, StepState
from finora.domain.money import Money
from finora.domain.roles import Permission
from finora.infrastructure.db.models import (
    ApprovalRequest,
    Estimate,
    Invoice,
    PurchaseOrder,
    User,
)

router = APIRouter(prefix="/approvals", tags=["approvals"])

#: What each record type is called on screen, and where its detail page lives.
#: Held here rather than in the browser so a new record type entering the
#: approval system appears in the queue without a second change to make.
RECORD_TYPES: dict[str, tuple[str, str]] = {
    "estimate": ("Estimate", "/estimates"),
    "invoice": ("Invoice", "/invoices"),
    "purchase_order": ("Purchase order", "/purchase-orders"),
}


class ApprovalQueueItemOut(BaseModel):
    """One thing waiting on this approver."""

    request_id: uuid.UUID
    record_type: str
    record_type_label: str
    record_id: uuid.UUID
    #: Where to send them to decide it. Built here because the path belongs to
    #: the record type rather than to the screen showing the row.
    record_path: str
    reference: str
    vendor_name: str
    description: str
    amount_minor_units: int
    currency: str
    amount_formatted: str
    department: str | None
    requester_label: str | None
    #: The levels this caller would be deciding at, so a row that is one of two
    #: parallel approvals says which half of it is theirs.
    my_levels: list[str]
    awaiting_labels: list[str]
    opened_at: datetime
    #: Whole hours the route has been open. Worked out here so every screen
    #: agrees on what "waiting" means and none of them has to guess a clock.
    waiting_hours: int
    #: Above one when the record came back round after being withdrawn or
    #: amended. An approver seeing something for the second time should be told.
    attempt: int


class ApprovalQueueOut(BaseModel):
    items: list[ApprovalQueueItemOut]
    total: int
    #: Counts across the whole queue rather than the page, so a filter can say
    #: how much it is hiding.
    counts_by_type: dict[str, int]


@dataclass(frozen=True, slots=True)
class _Record:
    """The parts of a record every queue row needs, whatever kind it is."""

    reference: str
    vendor_name: str
    description: str


def _records(session: SessionDep, requests: list[ApprovalRequest]) -> dict[uuid.UUID, _Record]:
    """The referenced records, one query per kind rather than one per row."""
    by_type: dict[str, list[uuid.UUID]] = {}
    for request in requests:
        by_type.setdefault(request.record_type, []).append(request.record_id)

    found: dict[uuid.UUID, _Record] = {}

    if ids := by_type.get("estimate"):
        for estimate in session.execute(select(Estimate).where(Estimate.id.in_(ids))).scalars():
            found[estimate.id] = _Record(
                reference=estimate.reference,
                vendor_name=estimate.vendor_name or "",
                description=estimate.description or "",
            )

    if ids := by_type.get("invoice"):
        for invoice in session.execute(select(Invoice).where(Invoice.id.in_(ids))).scalars():
            found[invoice.id] = _Record(
                reference=invoice.reference,
                vendor_name=invoice.vendor_name or "",
                description=invoice.description or "",
            )

    if ids := by_type.get("purchase_order"):
        for order in session.execute(
            select(PurchaseOrder).where(PurchaseOrder.id.in_(ids))
        ).scalars():
            found[order.id] = _Record(
                reference=order.number,
                vendor_name=order.vendor.name if order.vendor else "",
                description=order.description or "",
            )

    return found


def _requesters(session: SessionDep, requests: list[ApprovalRequest]) -> dict[uuid.UUID, str]:
    ids = {request.requester_id for request in requests}
    if not ids:
        return {}
    rows = session.execute(select(User).where(User.id.in_(ids))).scalars()
    return {row.id: row.display_name for row in rows}


@router.get("/queue", response_model=ApprovalQueueOut)
def read_queue(
    session: SessionDep,
    approvals: ApprovalServiceDep,
    user: CurrentUserDep,
    _: Annotated[object, Depends(RequirePermission(Permission.approval_view))] = None,
    record_type: Annotated[
        list[str] | None, Query(description="Limit to these record types")
    ] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ApprovalQueueOut:
    """Everything waiting on this caller, oldest first.

    Eligibility is resolved before pagination rather than after. Whether a route
    is this person's to decide depends on department-scoped assignments and live
    delegations, which the query cannot answer alone, so the honest choices are
    to filter then page, or to page then filter and hand back pages of varying
    and occasionally zero length. An approver's queue is tens of items, and a
    page that is empty for no visible reason is worse than the extra work.
    """
    waiting = approvals.awaiting(user=user)

    counts: dict[str, int] = {}
    for request in waiting:
        counts[request.record_type] = counts.get(request.record_type, 0) + 1

    if record_type:
        wanted = set(record_type)
        waiting = [request for request in waiting if request.record_type in wanted]

    total = len(waiting)
    page = waiting[offset : offset + limit]

    records = _records(session, page)
    requesters = _requesters(session, page)
    now = datetime.now(UTC)

    items: list[ApprovalQueueItemOut] = []
    for request in page:
        record = records.get(request.record_id)
        label, path = RECORD_TYPES.get(
            request.record_type, (request.record_type, f"/{request.record_type}")
        )
        mine = [
            step.level
            for step in approvals.progress(request)
            if step.state is StepState.ready
            and approvals.standing(request=request, level=step.level, user=user).may_decide
        ]
        items.append(
            ApprovalQueueItemOut(
                request_id=request.id,
                record_type=request.record_type,
                record_type_label=label,
                record_id=request.record_id,
                record_path=f"{path}/{request.record_id}",
                reference=record.reference if record else "",
                vendor_name=record.vendor_name if record else "",
                description=record.description if record else "",
                amount_minor_units=request.amount_minor_units,
                currency=request.currency,
                amount_formatted=Money(request.amount_minor_units, request.currency).format(),
                department=request.department,
                requester_label=requesters.get(request.requester_id),
                my_levels=[LEVEL_LABELS[level] for level in mine],
                awaiting_labels=awaiting_labels(request, approvals),
                opened_at=request.opened_at,
                waiting_hours=max(0, int((now - request.opened_at).total_seconds() // 3600)),
                attempt=request.attempt,
            )
        )

    return ApprovalQueueOut(items=items, total=total, counts_by_type=counts)
