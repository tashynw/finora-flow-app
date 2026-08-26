"""Assemble the caller's unified work queue from the live record stores.

Each kind of work already has a register or queue. This service does not invent
a parallel workflow; it reads those sources under the same permissions the
dedicated screens use, then orders everything by how long it has waited.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from finora.application.approvals import ApprovalService
from finora.domain.approvals import LEVEL_LABELS, StepState
from finora.domain.extraction import ExtractionStatus
from finora.domain.intake import IntakeStatus
from finora.domain.money import Money
from finora.domain.roles import Permission, has_permission, permissions_for
from finora.domain.work import WORK_KIND_LABELS, WorkBadges, WorkItem, WorkKind
from finora.domain.workflow import WorkflowState
from finora.infrastructure.db.models import (
    Document,
    Estimate,
    InboundMessage,
    Invoice,
    PurchaseOrder,
    User,
    VendorCheckIn,
)

_APPROVAL_PATHS: dict[str, str] = {
    "estimate": "/estimates",
    "invoice": "/invoices",
    "purchase_order": "/purchase-orders",
}


_DEFAULT_QUEUE_KINDS = frozenset(
    {
        WorkKind.approval,
        WorkKind.sign_off,
        WorkKind.document_review,
        WorkKind.vendor_review,
    }
)


class WorkService:
    def __init__(self, session: Session, *, approvals: ApprovalService) -> None:
        self._session = session
        self._approvals = approvals

    def queue(
        self,
        *,
        user: User,
        kinds: frozenset[WorkKind] | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[WorkItem], int, dict[str, int]]:
        """Everything waiting on this caller, oldest first.

        `kinds` filters the assembled list. When omitted, inbox messages are left
        off — they have their own screen — and only actionable work is returned.
        Counts are always across every kind the caller may see, so a filter can
        say how much it is hiding.
        """
        now = datetime.now(UTC)
        items = self._collect(user=user, now=now)
        counts: dict[str, int] = {}
        for item in items:
            counts[item.kind.value] = counts.get(item.kind.value, 0) + 1

        wanted = kinds if kinds is not None else _DEFAULT_QUEUE_KINDS
        items = [item for item in items if item.kind in wanted]

        total = len(items)
        return items[offset : offset + limit], total, counts

    def badges(self, *, user: User) -> WorkBadges:
        now = datetime.now(UTC)
        items = self._collect(user=user, now=now)
        by_kind = {kind: 0 for kind in WorkKind}
        for item in items:
            by_kind[item.kind] += 1

        my_work = (
            by_kind[WorkKind.approval]
            + by_kind[WorkKind.sign_off]
            + by_kind[WorkKind.document_review]
            + by_kind[WorkKind.vendor_review]
        )
        return WorkBadges(
            my_work=my_work,
            awaiting_my_approval=by_kind[WorkKind.approval],
            documents_needing_review=by_kind[WorkKind.document_review],
            intake_unprocessed=by_kind[WorkKind.intake],
            vendor_needing_review=by_kind[WorkKind.vendor_review],
            operational_alerts=0,
        )

    def dashboard(self, *, user: User, limit: int = 5) -> list[WorkItem]:
        items, _, _ = self.queue(user=user, limit=limit, offset=0)
        return items

    # ---------------------------------------------------------------- collect

    def _collect(self, *, user: User, now: datetime) -> list[WorkItem]:
        held = permissions_for(user.roles)
        items: list[WorkItem] = []

        if Permission.approval_view in held:
            items.extend(self._approvals_for(user=user, now=now))
        if Permission.invoice_sign_off in held:
            items.extend(self._sign_offs_for(user=user, now=now))
        if Permission.extraction_view in held:
            items.extend(self._documents_for(now=now))
        if Permission.vendor_confirmation_review in held:
            items.extend(self._vendor_reviews_for(now=now))
        if Permission.intake_view in held:
            items.extend(self._intake_for(now=now))

        items.sort(key=lambda row: row.waiting_since)
        return items

    def _approvals_for(self, *, user: User, now: datetime) -> list[WorkItem]:
        waiting = self._approvals.awaiting(user=user)
        if not waiting:
            return []

        records = self._approval_records(waiting)
        items: list[WorkItem] = []
        for request in waiting:
            record = records.get(request.record_id)
            path_root = _APPROVAL_PATHS.get(request.record_type, f"/{request.record_type}")
            mine = [
                LEVEL_LABELS[step.level]
                for step in self._approvals.progress(request)
                if step.state is StepState.ready
                and self._approvals.standing(
                    request=request, level=step.level, user=user
                ).may_decide
            ]
            amount = Money(request.amount_minor_units, request.currency).format()
            items.append(
                WorkItem(
                    kind=WorkKind.approval,
                    kind_label=WORK_KIND_LABELS[WorkKind.approval],
                    record_id=request.record_id,
                    record_path=f"{path_root}/{request.record_id}",
                    reference=record[0] if record else "",
                    title=record[1] if record else "Needs a decision",
                    subtitle=(
                        f"{' · '.join(mine)} · {record[2]}"
                        if record and mine
                        else (record[2] if record else "")
                    ),
                    waiting_since=request.opened_at,
                    waiting_hours=max(0, int((now - request.opened_at).total_seconds() // 3600)),
                    amount_formatted=amount,
                    detail=request.record_type.replace("_", " ").title(),
                )
            )
        return items

    def _approval_records(self, requests: list[Any]) -> dict[UUID, tuple[str, str, str]]:
        by_type: dict[str, list[UUID]] = {}
        for request in requests:
            by_type.setdefault(request.record_type, []).append(request.record_id)

        found: dict[UUID, tuple[str, str, str]] = {}
        if ids := by_type.get("estimate"):
            for estimate in self._session.execute(
                select(Estimate).where(Estimate.id.in_(ids))
            ).scalars():
                found[estimate.id] = (
                    estimate.reference,
                    estimate.vendor_name or "No supplier named",
                    estimate.description or "No description",
                )
        if ids := by_type.get("invoice"):
            for invoice in self._session.execute(
                select(Invoice).where(Invoice.id.in_(ids))
            ).scalars():
                found[invoice.id] = (
                    invoice.reference,
                    invoice.vendor_name or "No supplier named",
                    invoice.description or "No description",
                )
        if ids := by_type.get("purchase_order"):
            for order in self._session.execute(
                select(PurchaseOrder).where(PurchaseOrder.id.in_(ids))
            ).scalars():
                found[order.id] = (
                    order.number,
                    order.vendor.name if order.vendor else "No supplier named",
                    order.description or "No description",
                )
        return found

    def _sign_offs_for(self, *, user: User, now: datetime) -> list[WorkItem]:
        rows = list(
            self._session.execute(
                select(Invoice)
                .where(
                    Invoice.state == WorkflowState.pending_sign_off,
                    Invoice.requester_id == user.id,
                    Invoice.archived_at.is_(None),
                )
                .order_by(Invoice.updated_at)
            ).scalars()
        )
        items: list[WorkItem] = []
        for row in rows:
            since = row.updated_at
            amount = (
                Money(row.total_minor_units, row.currency).format()
                if row.total_minor_units is not None and row.currency
                else None
            )
            items.append(
                WorkItem(
                    kind=WorkKind.sign_off,
                    kind_label=WORK_KIND_LABELS[WorkKind.sign_off],
                    record_id=row.id,
                    record_path=f"/invoices/{row.id}",
                    reference=row.reference,
                    title=row.vendor_name or "Confirm receipt",
                    subtitle=row.description or "Goods or services to confirm",
                    waiting_since=since,
                    waiting_hours=max(0, int((now - since).total_seconds() // 3600)),
                    amount_formatted=amount,
                )
            )
        return items

    def _documents_for(self, *, now: datetime) -> list[WorkItem]:
        rows = list(
            self._session.execute(
                select(Document)
                .where(Document.status == ExtractionStatus.needs_review)
                .order_by(Document.created_at)
            ).scalars()
        )
        return [
            WorkItem(
                kind=WorkKind.document_review,
                kind_label=WORK_KIND_LABELS[WorkKind.document_review],
                record_id=row.id,
                record_path=f"/documents/{row.id}",
                reference=row.filename or row.id.hex[:8].upper(),
                title=row.filename or "Document needs review",
                subtitle="A reading is waiting for a person to check it",
                waiting_since=row.created_at,
                waiting_hours=max(0, int((now - row.created_at).total_seconds() // 3600)),
            )
            for row in rows
        ]

    def _vendor_reviews_for(self, *, now: datetime) -> list[WorkItem]:
        rows = list(
            self._session.execute(
                select(VendorCheckIn)
                .where(
                    VendorCheckIn.answered_at.is_not(None),
                    VendorCheckIn.reviewed_at.is_(None),
                )
                .order_by(VendorCheckIn.answered_at)
            ).scalars()
        )
        return [
            WorkItem(
                kind=WorkKind.vendor_review,
                kind_label=WORK_KIND_LABELS[WorkKind.vendor_review],
                record_id=row.id,
                record_path=f"/vendor-confirmations/{row.id}",
                reference=row.reference,
                title=row.vendor_name,
                subtitle="The supplier answered — conclude Paid or Outstanding",
                waiting_since=row.answered_at or row.created_at,
                waiting_hours=max(
                    0,
                    int((now - (row.answered_at or row.created_at)).total_seconds() // 3600),
                ),
            )
            for row in rows
        ]

    def _intake_for(self, *, now: datetime) -> list[WorkItem]:
        # Ready messages are scanned and waiting for a person to open them.
        # Counting them on My work would drown the queue for finance; they stay
        # on the Inbox badge and appear only when the caller filters to intake.
        rows = list(
            self._session.execute(
                select(InboundMessage)
                .where(InboundMessage.status == IntakeStatus.ready)
                .order_by(InboundMessage.received_at)
                .limit(100)
            ).scalars()
        )
        return [
            WorkItem(
                kind=WorkKind.intake,
                kind_label=WORK_KIND_LABELS[WorkKind.intake],
                record_id=row.id,
                record_path=f"/intake/{row.id}",
                reference=row.subject or "(no subject)",
                title=row.subject or "Message ready for triage",
                subtitle=row.from_address or "Unknown sender",
                waiting_since=row.received_at,
                waiting_hours=max(0, int((now - row.received_at).total_seconds() // 3600)),
            )
            for row in rows
        ]


def may_see_work(user: User) -> bool:
    """Whether this person has any permission that feeds the work queue."""
    return has_permission(
        user.roles,
        Permission.report_view,
    )
