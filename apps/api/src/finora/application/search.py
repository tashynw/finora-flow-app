"""Federated search across the registers a caller is allowed to see.

Each type reuses the same columns its own list endpoint already searches, so a
hit here is never something the dedicated register would hide. Visibility for
estimates and invoices follows the same remit rules as those registers.
"""

from __future__ import annotations

from sqlalchemy import ColumnElement, func, or_, select
from sqlalchemy.orm import Session

from finora.domain.money import Money
from finora.domain.roles import Role, has_permission
from finora.domain.search import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    MIN_QUERY_LENGTH,
    PER_TYPE_CAP,
    SEARCH_TYPE_LABELS,
    SEARCH_TYPE_PERMISSIONS,
    SearchHit,
    SearchRecordType,
)
from finora.infrastructure.db.models import (
    Document,
    Estimate,
    Invoice,
    PaymentPackage,
    PurchaseOrder,
    User,
    VendorCheckIn,
)


class SearchService:
    def __init__(self, session: Session) -> None:
        self._session = session

    def search(
        self,
        *,
        user: User,
        query: str,
        types: frozenset[SearchRecordType] | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> list[SearchHit]:
        cleaned = query.strip()
        if len(cleaned) < MIN_QUERY_LENGTH:
            return []

        capped = max(1, min(limit, MAX_LIMIT))
        pattern = f"%{cleaned}%"
        pattern_lower = f"%{cleaned.lower()}%"

        wanted = types or frozenset(SearchRecordType)
        hits: list[SearchHit] = []

        for record_type in SearchRecordType:
            if record_type not in wanted:
                continue
            permission = SEARCH_TYPE_PERMISSIONS[record_type]
            if not has_permission(user.roles, permission):
                continue
            remaining = capped - len(hits)
            if remaining <= 0:
                break
            per_type = min(PER_TYPE_CAP, remaining)
            hits.extend(
                self._search_type(
                    record_type,
                    user=user,
                    pattern=pattern,
                    pattern_lower=pattern_lower,
                    limit=per_type,
                )
            )
        return hits[:capped]

    def _search_type(
        self,
        record_type: SearchRecordType,
        *,
        user: User,
        pattern: str,
        pattern_lower: str,
        limit: int,
    ) -> list[SearchHit]:
        if record_type is SearchRecordType.estimate:
            return self._estimates(user, pattern_lower, limit)
        if record_type is SearchRecordType.invoice:
            return self._invoices(user, pattern_lower, limit)
        if record_type is SearchRecordType.purchase_order:
            return self._purchase_orders(pattern, limit)
        if record_type is SearchRecordType.payment_package:
            return self._payment_packages(pattern, limit)
        if record_type is SearchRecordType.document:
            return self._documents(pattern, limit)
        return self._vendor_check_ins(pattern, limit)

    def _estimates(self, user: User, pattern_lower: str, limit: int) -> list[SearchHit]:
        conditions: list[ColumnElement[bool]] = [
            Estimate.archived_at.is_(None),
            or_(
                func.lower(Estimate.reference).like(pattern_lower),
                func.lower(Estimate.vendor_name).like(pattern_lower),
                func.lower(Estimate.description).like(pattern_lower),
                func.lower(func.coalesce(Estimate.estimate_number, "")).like(pattern_lower),
            ),
        ]
        if not _sees_estimates(user):
            conditions.append(Estimate.requester_id == user.id)

        rows = (
            self._session.execute(
                select(Estimate)
                .where(*conditions)
                .order_by(Estimate.created_at.desc())
                .limit(limit)
            )
            .scalars()
            .all()
        )
        return [
            SearchHit(
                record_type=SearchRecordType.estimate,
                type_label=SEARCH_TYPE_LABELS[SearchRecordType.estimate],
                record_id=row.id,
                record_path=f"/estimates/{row.id}",
                reference=row.reference,
                title=row.vendor_name or row.reference,
                subtitle=row.description or row.state.value,
                state=row.state.value,
                amount_formatted=_money(row.total_minor_units, row.currency),
            )
            for row in rows
        ]

    def _invoices(self, user: User, pattern_lower: str, limit: int) -> list[SearchHit]:
        conditions: list[ColumnElement[bool]] = [
            Invoice.archived_at.is_(None),
            or_(
                func.lower(Invoice.reference).like(pattern_lower),
                func.lower(Invoice.vendor_name).like(pattern_lower),
                func.lower(Invoice.description).like(pattern_lower),
                func.lower(func.coalesce(Invoice.invoice_number, "")).like(pattern_lower),
            ),
        ]
        if not _sees_invoices(user):
            conditions.append(
                or_(Invoice.requester_id == user.id, Invoice.created_by_id == user.id)
            )

        rows = (
            self._session.execute(
                select(Invoice).where(*conditions).order_by(Invoice.created_at.desc()).limit(limit)
            )
            .scalars()
            .all()
        )
        return [
            SearchHit(
                record_type=SearchRecordType.invoice,
                type_label=SEARCH_TYPE_LABELS[SearchRecordType.invoice],
                record_id=row.id,
                record_path=f"/invoices/{row.id}",
                reference=row.reference,
                title=row.vendor_name or row.reference,
                subtitle=row.description or row.state.value,
                state=row.state.value,
                amount_formatted=_money(row.total_minor_units, row.currency),
            )
            for row in rows
        ]

    def _purchase_orders(self, pattern: str, limit: int) -> list[SearchHit]:
        rows = (
            self._session.execute(
                select(PurchaseOrder)
                .where(
                    PurchaseOrder.archived_at.is_(None),
                    or_(
                        PurchaseOrder.number.ilike(pattern),
                        PurchaseOrder.description.ilike(pattern),
                    ),
                )
                .order_by(PurchaseOrder.created_at.desc())
                .limit(limit)
            )
            .scalars()
            .all()
        )
        return [
            SearchHit(
                record_type=SearchRecordType.purchase_order,
                type_label=SEARCH_TYPE_LABELS[SearchRecordType.purchase_order],
                record_id=row.id,
                record_path=f"/purchase-orders/{row.id}",
                reference=row.number,
                title=row.number,
                subtitle=row.description or row.state.value,
                state=row.state.value,
                amount_formatted=_money(row.total_minor_units, row.currency),
            )
            for row in rows
        ]

    def _payment_packages(self, pattern: str, limit: int) -> list[SearchHit]:
        rows = (
            self._session.execute(
                select(PaymentPackage)
                .where(
                    or_(
                        PaymentPackage.reference.ilike(pattern),
                        PaymentPackage.description.ilike(pattern),
                        PaymentPackage.submission_reference.ilike(pattern),
                    )
                )
                .order_by(PaymentPackage.created_at.desc())
                .limit(limit)
            )
            .scalars()
            .all()
        )
        return [
            SearchHit(
                record_type=SearchRecordType.payment_package,
                type_label=SEARCH_TYPE_LABELS[SearchRecordType.payment_package],
                record_id=row.id,
                record_path=f"/payments/{row.id}",
                reference=row.reference,
                title=row.reference,
                subtitle=row.description or _package_standing(row),
                state=_package_standing(row),
            )
            for row in rows
        ]

    def _documents(self, pattern: str, limit: int) -> list[SearchHit]:
        rows = (
            self._session.execute(
                select(Document)
                .where(Document.filename.ilike(pattern))
                .order_by(Document.created_at.desc())
                .limit(limit)
            )
            .scalars()
            .all()
        )
        return [
            SearchHit(
                record_type=SearchRecordType.document,
                type_label=SEARCH_TYPE_LABELS[SearchRecordType.document],
                record_id=row.id,
                record_path=f"/documents/{row.id}",
                reference=row.filename,
                title=row.filename,
                subtitle=row.kind.value,
                state=row.kind.value,
            )
            for row in rows
        ]

    def _vendor_check_ins(self, pattern: str, limit: int) -> list[SearchHit]:
        rows = (
            self._session.execute(
                select(VendorCheckIn)
                .where(
                    or_(
                        VendorCheckIn.reference.ilike(pattern),
                        VendorCheckIn.vendor_name.ilike(pattern),
                    )
                )
                .order_by(VendorCheckIn.created_at.desc())
                .limit(limit)
            )
            .scalars()
            .all()
        )
        return [
            SearchHit(
                record_type=SearchRecordType.vendor_check_in,
                type_label=SEARCH_TYPE_LABELS[SearchRecordType.vendor_check_in],
                record_id=row.id,
                record_path=f"/vendor-confirmations/{row.id}",
                reference=row.reference,
                title=row.vendor_name or row.reference,
                subtitle=_check_in_standing(row),
                state=_check_in_standing(row),
            )
            for row in rows
        ]


def _sees_estimates(user: User) -> bool:
    return bool(
        user.roles
        & {
            Role.approver,
            Role.finance,
            Role.auditor,
            Role.administrator,
            Role.payment_coordinator,
        }
    )


def _sees_invoices(user: User) -> bool:
    return bool(
        user.roles
        & {
            Role.approver,
            Role.finance,
            Role.auditor,
            Role.administrator,
            Role.payment_coordinator,
        }
    )


def _money(minor: int | None, currency: str | None) -> str | None:
    if minor is None or not currency:
        return None
    return Money(minor, currency).format()


def _package_standing(row: PaymentPackage) -> str:
    if row.submitted_at is not None:
        return "submitted"
    if row.cancelled_at is not None:
        return "cancelled"
    return "open"


def _check_in_standing(row: VendorCheckIn) -> str:
    if row.reviewed_at is not None:
        return "reviewed"
    if row.answered_at is not None:
        return "answered"
    if row.sent_at is not None:
        return "waiting"
    return "not_asked"
