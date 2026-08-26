"""Accrual period management: opening, generating, reviewing, locking and exporting.

An accrual is a claim that something is owed at period end even though it has
not been paid. The service works in three phases:

1. *Open* the period with a date range.
2. *Generate* candidates from unpaid invoices dated on or before period end;
   a person then edits amounts and reasons, and finalizes each line.
3. *Lock* the period — a different person — and *export* the set for posting.

Two rules never change:

*Editing and locking are different people.* `accrual:edit` and
`accrual:lock_period` are a segregation-of-duties pair on the period, recorded
via `RecordActionRow` the same way credit-card coding and closing are.

*AI never finalizes or locks.* Those paths take a named person and a reason.

*Invoice state transitions are skipped.* Generating candidates creates the
accrual entries without altering invoice workflow state; the rules that would
govern those transitions are still open, so the safe choice is to leave each
invoice where it already is.
"""

from __future__ import annotations

import csv
import hashlib
import io
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Literal
from uuid import UUID, uuid4

import structlog
from sqlalchemy import Sequence as SqlSequence
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from finora.domain.accruals import (
    CANDIDATE_SOURCE_STATES,
    EXPORT_COLUMNS,
    PROBLEM_EXPLANATIONS,
    PROBLEM_FIELDS,
    CandidateProblem,
    CandidateStanding,
    CandidateView,
    EditDraft,
    FieldProblem,
    InvoiceCandidateSource,
    PeriodStanding,
    PeriodView,
    edit_problems,
    export_problems,
    finalize_problems,
    is_candidate_source,
    lock_problems,
    open_candidate_count,
    open_period_problems,
    period_standing,
    standing_after_edit,
)
from finora.domain.audit import ActorType, AuditAction
from finora.domain.money import Money
from finora.domain.roles import Permission, assert_can_act
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import (
    AccrualCandidate,
    AccrualExport,
    AccrualPeriod,
    Invoice,
    RecordActionRow,
    User,
)

logger = structlog.get_logger(__name__)

RECORD_TYPE = "accrual_period"

_PERIOD_REFERENCE = SqlSequence("accrual_period_reference_seq")
_CANDIDATE_REFERENCE = SqlSequence("accrual_candidate_reference_seq")


class AccrualError(Exception):
    """Base for refusals the API turns into 4xx responses."""


class NotFoundError(AccrualError):
    pass


class ConflictError(AccrualError):
    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


class ValidationError(AccrualError):
    def __init__(self, problems: tuple[FieldProblem, ...]):
        self.problems = problems
        super().__init__("; ".join(item.message for item in problems))


@dataclass(frozen=True, slots=True)
class ExportResult:
    export: AccrualExport
    data: bytes


class AccrualService:
    def __init__(self, session: Session, audit: AuditRepository):
        self._session = session
        self._audit = audit

    # --------------------------------------------------------------- periods

    def open_period(
        self,
        *,
        actor: User,
        period_start: date,
        period_end: date,
        label: str,
        correlation_id: UUID,
    ) -> AccrualPeriod:
        assert_can_act(roles=actor.roles, permission=Permission.accrual_edit)

        found = open_period_problems(period_start=period_start, period_end=period_end)
        if found:
            raise ValidationError(found)

        reference = self._next_period_reference()
        period = AccrualPeriod(
            id=uuid4(),
            reference=reference,
            period_start=period_start,
            period_end=period_end,
            label=label.strip(),
            opened_by_id=actor.id,
            opened_at=datetime.now(UTC),
            version=1,
        )
        self._session.add(period)
        self._session.flush()

        self._audit.append(
            action=AuditAction.accrual_period_opened,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=period.id,
            correlation_id=correlation_id,
            detail={
                "reference": period.reference,
                "period_start": period_start.isoformat(),
                "period_end": period_end.isoformat(),
                "label": period.label,
            },
        )
        logger.info(
            "accrual.period_opened",
            period_id=str(period.id),
            reference=period.reference,
        )
        return period

    def list_periods(
        self,
        *,
        standing: PeriodStanding | None = None,
        limit: int = 50,
    ) -> list[AccrualPeriod]:
        query = select(AccrualPeriod).options(
            selectinload(AccrualPeriod.candidates),
        )
        if standing is PeriodStanding.open:
            query = query.where(AccrualPeriod.locked_at.is_(None))
        elif standing is PeriodStanding.locked:
            query = query.where(AccrualPeriod.locked_at.is_not(None))
        return list(
            self._session.execute(
                query.order_by(AccrualPeriod.period_end.desc()).limit(limit)
            ).scalars()
        )

    def get_period(self, period_id: UUID) -> AccrualPeriod:
        period = self._session.execute(
            select(AccrualPeriod)
            .where(AccrualPeriod.id == period_id)
            .options(
                selectinload(AccrualPeriod.candidates).selectinload(AccrualCandidate.gl_account),
                selectinload(AccrualPeriod.candidates).selectinload(AccrualCandidate.cost_centre),
                selectinload(AccrualPeriod.candidates).selectinload(AccrualCandidate.invoice),
                selectinload(AccrualPeriod.exports),
            )
        ).scalar_one_or_none()
        if period is None:
            raise NotFoundError("That accrual period was not found.")
        return period

    # ----------------------------------------------------------- candidates

    def generate_candidates(
        self,
        *,
        actor: User,
        period_id: UUID,
        correlation_id: UUID,
    ) -> tuple[AccrualPeriod, int]:
        """Scan invoices and create candidates for those not yet on this period.

        State transitions for invoices are skipped. The platform records the
        obligation as a candidate without altering the invoice's own workflow;
        the rules governing those transitions are still open, so the safe
        choice is to leave the invoice where it is.
        """
        period = self.get_period(period_id)
        assert_can_act(
            roles=actor.roles,
            permission=Permission.accrual_edit,
            already_exercised_on_record=self.actions_taken(period, user=actor),
        )

        if period.locked_at is not None:
            raise ValidationError(
                (
                    FieldProblem(
                        code=CandidateProblem.period_locked,
                        field=PROBLEM_FIELDS[CandidateProblem.period_locked],
                        message=PROBLEM_EXPLANATIONS[CandidateProblem.period_locked],
                    ),
                )
            )

        # Invoice IDs already on this period, to avoid duplicates.
        existing_invoice_ids: set[UUID] = {
            c.invoice_id for c in period.candidates if c.invoice_id is not None
        }

        invoices = list(
            self._session.execute(
                select(Invoice).where(Invoice.state.in_(CANDIDATE_SOURCE_STATES))
            ).scalars()
        )

        created = 0
        for inv in invoices:
            if inv.id in existing_invoice_ids:
                continue
            source = InvoiceCandidateSource(
                id=inv.id,
                state=inv.state,
                invoice_date=inv.invoice_date,
                currency=inv.currency,
                total_minor_units=inv.total_minor_units,
                vendor_name=inv.vendor_name,
                invoice_number=inv.invoice_number,
                description=inv.description,
                gl_account_id=inv.gl_account_id,
                cost_centre_id=inv.cost_centre_id,
                department=inv.department,
            )
            if not is_candidate_source(source, period_end=period.period_end):
                continue

            reference = self._next_candidate_reference()
            candidate = AccrualCandidate(
                id=uuid4(),
                period_id=period.id,
                reference=reference,
                invoice_id=inv.id,
                standing=CandidateStanding.proposed,
                currency=inv.currency,
                amount_minor_units=inv.total_minor_units,
                original_amount_minor_units=inv.total_minor_units,
                vendor_name=inv.vendor_name,
                invoice_number=inv.invoice_number,
                invoice_reference=inv.reference,
                description=inv.description,
                department=inv.department,
                gl_account_id=inv.gl_account_id,
                cost_centre_id=inv.cost_centre_id,
                version=1,
            )
            self._session.add(candidate)
            created += 1

        self._record_action(period, user=actor, permission=Permission.accrual_edit)
        self._session.flush()

        self._audit.append(
            action=AuditAction.accrual_candidates_generated,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=period.id,
            correlation_id=correlation_id,
            detail={
                "reference": period.reference,
                "created": created,
                "period_end": period.period_end.isoformat(),
            },
        )
        logger.info(
            "accrual.candidates_generated",
            period_id=str(period.id),
            reference=period.reference,
            created=created,
        )

        # Expire so the reload picks up freshly inserted rows.
        self._session.expire(period)
        return self.get_period(period_id), created

    def edit_candidate(
        self,
        *,
        actor: User,
        candidate_id: UUID,
        amount_minor: int | None,
        currency: str,
        exclude: bool,
        reason: str,
        note: str | None,
        description: str | None,
        expected_version: int | None,
        correlation_id: UUID,
    ) -> AccrualCandidate:
        candidate = self._require_candidate(candidate_id)
        period = self.get_period(candidate.period_id)
        assert_can_act(
            roles=actor.roles,
            permission=Permission.accrual_edit,
            already_exercised_on_record=self.actions_taken(period, user=actor),
        )

        if expected_version is not None and candidate.version != expected_version:
            raise ConflictError("Somebody else changed this candidate. Refresh and try again.")

        amount = Money(amount_minor, currency) if amount_minor is not None else None
        draft = EditDraft(
            amount=amount,
            standing=CandidateStanding.excluded if exclude else CandidateStanding.adjusted,
            reason=reason,
            note=note,
            description=description,
        )
        found = edit_problems(draft, locked_at=period.locked_at, current=candidate.standing)
        if found:
            raise ValidationError(found)

        original = candidate.amount_minor_units
        amount_changed = amount_minor is not None and amount_minor != original

        if amount_minor is not None:
            candidate.amount_minor_units = amount_minor
            candidate.currency = currency

        if description is not None:
            cleaned_desc = description.strip()
            if cleaned_desc:
                candidate.description = cleaned_desc

        candidate.standing = standing_after_edit(exclude=exclude, amount_changed=amount_changed)
        candidate.edit_reason = reason.strip()
        if note is not None:
            candidate.note = note.strip() or None
        candidate.version += 1

        self._record_action(period, user=actor, permission=Permission.accrual_edit)
        self._session.flush()

        self._audit.append(
            action=AuditAction.accrual_candidate_edited,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=period.id,
            correlation_id=correlation_id,
            detail={
                "candidate_id": str(candidate.id),
                "reference": candidate.reference,
                "standing": candidate.standing.value,
                "amount_minor_units": candidate.amount_minor_units,
                "currency": candidate.currency,
                "reason": candidate.edit_reason,
            },
        )
        return candidate

    def finalize_candidate(
        self,
        *,
        actor: User,
        candidate_id: UUID,
        expected_version: int | None,
        correlation_id: UUID,
    ) -> AccrualCandidate:
        candidate = self._require_candidate(candidate_id)
        period = self.get_period(candidate.period_id)
        assert_can_act(roles=actor.roles, permission=Permission.accrual_finalize)

        if expected_version is not None and candidate.version != expected_version:
            raise ConflictError("Somebody else changed this candidate. Refresh and try again.")

        found = finalize_problems(locked_at=period.locked_at, standing=candidate.standing)
        if found:
            raise ValidationError(found)

        candidate.standing = CandidateStanding.finalized
        candidate.finalized_at = datetime.now(UTC)
        candidate.finalized_by_id = actor.id
        candidate.version += 1
        self._session.flush()

        self._audit.append(
            action=AuditAction.accrual_candidate_finalized,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=period.id,
            correlation_id=correlation_id,
            detail={
                "candidate_id": str(candidate.id),
                "reference": candidate.reference,
                "amount_minor_units": candidate.amount_minor_units,
                "currency": candidate.currency,
            },
        )
        return candidate

    # ----------------------------------------------------------------- lock

    def lock_period(
        self,
        *,
        actor: User,
        period_id: UUID,
        reason: str,
        expected_version: int | None,
        correlation_id: UUID,
    ) -> AccrualPeriod:
        period = self.get_period(period_id)
        assert_can_act(
            roles=actor.roles,
            permission=Permission.accrual_lock_period,
            already_exercised_on_record=self.actions_taken(period, user=actor),
        )

        if expected_version is not None and period.version != expected_version:
            raise ConflictError("Somebody else changed this period. Refresh and try again.")

        view = self._period_view(period)
        found = lock_problems(view, reason=reason)
        if found:
            raise ValidationError(found)

        period.locked_at = datetime.now(UTC)
        period.locked_by_id = actor.id
        period.lock_reason = reason.strip()
        period.version += 1

        self._record_action(period, user=actor, permission=Permission.accrual_lock_period)
        self._session.flush()

        self._audit.append(
            action=AuditAction.period_locked,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=period.id,
            correlation_id=correlation_id,
            detail={
                "reference": period.reference,
                "reason": period.lock_reason,
                "candidates": len(period.candidates),
            },
        )
        logger.info(
            "accrual.period_locked",
            period_id=str(period.id),
            reference=period.reference,
        )
        return period

    # --------------------------------------------------------------- export

    def export_period(
        self,
        *,
        actor: User,
        period_id: UUID,
        format: Literal["csv", "xlsx"],
        official: bool,
        correlation_id: UUID,
    ) -> ExportResult:
        """Build a CSV or xlsx export and record it.

        Official exports are only available once the period is locked.
        Draft exports can be generated at any time.
        xlsx is supported via openpyxl (already a project dependency).
        """
        assert_can_act(roles=actor.roles, permission=Permission.accrual_export)
        period = self.get_period(period_id)

        found = export_problems(locked_at=period.locked_at, official=official)
        if found:
            raise ValidationError(found)

        # Excluded candidates are omitted from the export; the file is the
        # official record of what was accrued, not a log of what was considered.
        included = [c for c in period.candidates if c.standing is not CandidateStanding.excluded]

        raw = self._build_export(included, format=format, period=period)
        digest = hashlib.sha256(raw).hexdigest()

        max_version = self._session.execute(
            select(func.max(AccrualExport.version)).where(AccrualExport.period_id == period.id)
        ).scalar_one_or_none()
        version = (max_version or 0) + 1

        filename = f"{period.reference}-v{version}.{format}"

        export_row = AccrualExport(
            id=uuid4(),
            period_id=period.id,
            version=version,
            format=format,
            official=official,
            filename=filename,
            sha256=digest,
            byte_size=len(raw),
            row_count=len(included),
            generated_by_id=actor.id,
            generated_at=datetime.now(UTC),
        )
        self._session.add(export_row)
        self._session.flush()

        self._audit.append(
            action=AuditAction.export_generated,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=period.id,
            correlation_id=correlation_id,
            detail={
                "reference": period.reference,
                "version": version,
                "format": format,
                "official": official,
                "rows": len(included),
                "sha256": digest,
            },
        )
        logger.info(
            "accrual.export_generated",
            period_id=str(period.id),
            reference=period.reference,
            version=version,
            format=format,
        )
        return ExportResult(export=export_row, data=raw)

    # ---------------------------------------------------------------- summary

    def actions_taken(self, period: AccrualPeriod, *, user: User) -> frozenset[Permission]:
        """Permissions this user has already exercised on this period."""
        return frozenset(
            self._session.execute(
                select(RecordActionRow.permission).where(
                    RecordActionRow.record_type == RECORD_TYPE,
                    RecordActionRow.record_id == period.id,
                    RecordActionRow.user_id == user.id,
                )
            ).scalars()
        )

    def period_summary(self, period: AccrualPeriod) -> dict[str, object]:
        view = self._period_view(period)
        return {
            "standing": period_standing(locked_at=period.locked_at).value,
            "candidate_count": len(period.candidates),
            "open_candidate_count": open_candidate_count(view.candidates),
        }

    # -------------------------------------------------------------- internals

    def _period_view(self, period: AccrualPeriod) -> PeriodView:
        return PeriodView(
            locked_at=period.locked_at,
            candidates=tuple(
                CandidateView(
                    standing=row.standing,
                    amount=Money(row.amount_minor_units, row.currency),
                    edit_reason=row.edit_reason,
                )
                for row in period.candidates
            ),
        )

    def _require_candidate(self, candidate_id: UUID) -> AccrualCandidate:
        candidate = self._session.get(AccrualCandidate, candidate_id)
        if candidate is None:
            raise NotFoundError("That accrual candidate was not found.")
        return candidate

    def _next_period_reference(self) -> str:
        value = self._session.execute(_PERIOD_REFERENCE.next_value()).scalar_one()
        return f"ACC-{int(value):04d}"

    def _next_candidate_reference(self) -> str:
        value = self._session.execute(_CANDIDATE_REFERENCE.next_value()).scalar_one()
        return f"ACL-{int(value):04d}"

    def _record_action(
        self,
        period: AccrualPeriod,
        *,
        user: User,
        permission: Permission,
    ) -> None:
        existing = self._session.execute(
            select(RecordActionRow).where(
                RecordActionRow.record_type == RECORD_TYPE,
                RecordActionRow.record_id == period.id,
                RecordActionRow.user_id == user.id,
                RecordActionRow.permission == permission,
            )
        ).scalar_one_or_none()
        if existing is not None:
            return
        self._session.add(
            RecordActionRow(
                id=uuid4(),
                record_type=RECORD_TYPE,
                record_id=period.id,
                user_id=user.id,
                permission=permission,
            )
        )

    def _build_export(
        self,
        candidates: list[AccrualCandidate],
        *,
        format: Literal["csv", "xlsx"],
        period: AccrualPeriod,
    ) -> bytes:
        rows = [self._candidate_row(c) for c in candidates]
        if format == "csv":
            return self._build_csv(rows)
        return self._build_xlsx(rows, period=period)

    def _candidate_row(self, c: AccrualCandidate) -> dict[str, str]:
        # Amount formatted as a decimal string, since both CSV and xlsx want it
        # as text; the posting system applies its own numeric rules on import.
        amount_str = f"{c.amount_minor_units / 100:.2f}"
        return {
            "reference": c.reference,
            "standing": c.standing.value,
            "invoice_reference": c.invoice_reference or "",
            "invoice_number": c.invoice_number or "",
            "vendor": c.vendor_name,
            "description": c.description,
            "currency": c.currency,
            "amount": amount_str,
            "department": c.department or "",
            "gl_code": c.gl_account.code if c.gl_account else "",
            "cost_centre_code": c.cost_centre.code if c.cost_centre else "",
            "edit_reason": c.edit_reason or "",
            "note": c.note or "",
        }

    def _build_csv(self, rows: list[dict[str, str]]) -> bytes:
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=list(EXPORT_COLUMNS), lineterminator="\r\n")
        writer.writeheader()
        writer.writerows(rows)
        return buf.getvalue().encode("utf-8")

    def _build_xlsx(self, rows: list[dict[str, str]], *, period: AccrualPeriod) -> bytes:
        import openpyxl
        from openpyxl.styles import Font

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = period.reference

        headers = list(EXPORT_COLUMNS)
        ws.append(headers)
        for cell in ws[1]:
            cell.font = Font(bold=True)

        for row in rows:
            ws.append([row[col] for col in headers])

        buf = io.BytesIO()
        wb.save(buf)
        return buf.getvalue()
