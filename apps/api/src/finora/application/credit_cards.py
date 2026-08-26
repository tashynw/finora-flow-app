"""Importing a statement, coding its lines, and closing the period.

A statement is a list of charges that already happened. The work here is making
each line accountable — GL, cost centre, usually a receipt — and then freezing
the period so the coding cannot drift after month-end.

Three rules that shape every method:

*Coding and closing are different people on the same period.* Recording a code
writes `credit_card:code` against the period; closing checks that this actor has
not already coded on it. Segregation of duties lives on the period, not the
line, because the forbidden pair is "explained the charges" and "declared the
explaining finished".

*A suggestion never closes.* Assistive proposals are stored beside the applied
values and never read by `close_period`. The close path takes a reason and a
period whose every line is already coded by a person.

*The same file cannot be imported twice.* The SHA-256 of the uploaded bytes is
unique per card, so a double-click at month-end does not double the charges.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import UTC, date, datetime
from uuid import UUID, uuid4

import structlog
from sqlalchemy import Sequence as SqlSequence
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from finora.domain.audit import ActorType, AuditAction
from finora.domain.credit_cards import (
    CODING_PROBLEM_EXPLANATIONS,
    CardTransactionView,
    CodingDraft,
    CodingProblem,
    FieldProblem,
    ParseProblem,
    PeriodStanding,
    PeriodView,
    ReceiptStatus,
    SuggestionDisposition,
    close_problems,
    coding_problems,
    coding_standing,
    may_change,
    parse_statement_csv,
    period_standing,
    receipt_status,
    uncoded_count,
    validate_card_last_four,
)
from finora.domain.money import Money
from finora.domain.roles import Permission, assert_can_act
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import (
    CostCentre,
    CreditCardAccount,
    CreditCardPeriod,
    CreditCardTransaction,
    Document,
    GlAccount,
    RecordActionRow,
    User,
)

logger = structlog.get_logger(__name__)

RECORD_TYPE = "credit_card_period"
CARD_RECORD_TYPE = "credit_card_account"

_PERIOD_REFERENCE = SqlSequence("credit_card_period_reference_seq")


class CreditCardError(Exception):
    """Base for refusals the API turns into 4xx responses."""


class NotFoundError(CreditCardError):
    pass


class ConflictError(CreditCardError):
    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


class ValidationError(CreditCardError):
    def __init__(self, problems: tuple[FieldProblem, ...]):
        self.problems = problems
        super().__init__("; ".join(item.message for item in problems))


@dataclass(frozen=True, slots=True)
class ImportResult:
    period: CreditCardPeriod
    transaction_count: int
    total: Money


class CreditCardService:
    def __init__(self, session: Session, audit: AuditRepository):
        self._session = session
        self._audit = audit

    # ------------------------------------------------------------------ cards

    def create_card(
        self,
        *,
        label: str,
        last_four: str,
        cardholder_name: str,
        currency: str,
        actor: User,
        correlation_id: UUID,
    ) -> CreditCardAccount:
        assert_can_act(roles=actor.roles, permission=Permission.credit_card_code)

        cleaned_four = validate_card_last_four(last_four)
        if cleaned_four is None:
            raise ValidationError(
                (
                    FieldProblem(
                        code=ParseProblem.empty,
                        field="last_four",
                        message="Enter the last four digits of the card, nothing else.",
                    ),
                )
            )

        cleaned_label = label.strip()
        cleaned_holder = cardholder_name.strip()
        if not cleaned_label or not cleaned_holder:
            raise ValidationError(
                (
                    FieldProblem(
                        code=ParseProblem.blank_merchant,
                        field="label" if not cleaned_label else "cardholder_name",
                        message="A card needs a label and a cardholder name.",
                    ),
                )
            )

        try:
            Money.zero(currency)
        except Exception as error:
            raise ValidationError(
                (
                    FieldProblem(
                        code=ParseProblem.unsupported_currency,
                        field="currency",
                        message=str(error),
                    ),
                )
            ) from error

        card = CreditCardAccount(
            id=uuid4(),
            label=cleaned_label,
            last_four=cleaned_four,
            cardholder_name=cleaned_holder,
            currency=currency.upper(),
            is_active=True,
            version=1,
        )
        self._session.add(card)
        self._session.flush()

        self._audit.append(
            action=AuditAction.record_created,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=CARD_RECORD_TYPE,
            subject_id=card.id,
            correlation_id=correlation_id,
            detail={
                "label": card.label,
                "last_four": card.last_four,
                "cardholder": card.cardholder_name,
                "currency": card.currency,
            },
        )
        return card

    def list_cards(self, *, active_only: bool = True) -> list[CreditCardAccount]:
        query = select(CreditCardAccount).where(CreditCardAccount.archived_at.is_(None))
        if active_only:
            query = query.where(CreditCardAccount.is_active.is_(True))
        return list(
            self._session.execute(
                query.order_by(CreditCardAccount.cardholder_name, CreditCardAccount.last_four)
            ).scalars()
        )

    def get_card(self, card_id: UUID) -> CreditCardAccount:
        card = self._session.get(CreditCardAccount, card_id)
        if card is None or card.archived_at is not None:
            raise NotFoundError("That card was not found.")
        return card

    # --------------------------------------------------------------- periods

    def list_periods(
        self,
        *,
        card_id: UUID | None = None,
        standing: PeriodStanding | None = None,
        limit: int = 50,
    ) -> list[CreditCardPeriod]:
        query = select(CreditCardPeriod).options(
            selectinload(CreditCardPeriod.card),
            selectinload(CreditCardPeriod.transactions),
        )
        if card_id is not None:
            query = query.where(CreditCardPeriod.card_id == card_id)
        if standing is PeriodStanding.open:
            query = query.where(CreditCardPeriod.closed_at.is_(None))
        elif standing is PeriodStanding.closed:
            query = query.where(CreditCardPeriod.closed_at.is_not(None))
        return list(
            self._session.execute(
                query.order_by(CreditCardPeriod.statement_date.desc()).limit(limit)
            ).scalars()
        )

    def get_period(self, period_id: UUID) -> CreditCardPeriod:
        period = self._session.execute(
            select(CreditCardPeriod)
            .where(CreditCardPeriod.id == period_id)
            .options(
                selectinload(CreditCardPeriod.card),
                selectinload(CreditCardPeriod.transactions).selectinload(
                    CreditCardTransaction.gl_account
                ),
                selectinload(CreditCardPeriod.transactions).selectinload(
                    CreditCardTransaction.cost_centre
                ),
                selectinload(CreditCardPeriod.transactions).selectinload(
                    CreditCardTransaction.receipt_document
                ),
            )
        ).scalar_one_or_none()
        if period is None:
            raise NotFoundError("That statement period was not found.")
        return period

    def import_statement(
        self,
        card: CreditCardAccount,
        *,
        csv_text: str,
        filename: str,
        period_start: date,
        period_end: date,
        statement_date: date,
        actor: User,
        correlation_id: UUID,
    ) -> ImportResult:
        assert_can_act(roles=actor.roles, permission=Permission.credit_card_code)

        if period_end < period_start:
            raise ValidationError(
                (
                    FieldProblem(
                        code=ParseProblem.bad_date,
                        field="period_end",
                        message="The period end cannot be before its start.",
                    ),
                )
            )

        parsed = parse_statement_csv(csv_text, currency=card.currency)
        if not parsed.ok or parsed.statement is None:
            raise ValidationError(parsed.problems)

        digest = hashlib.sha256(csv_text.encode("utf-8")).hexdigest()
        existing = self._session.execute(
            select(CreditCardPeriod.id).where(
                CreditCardPeriod.card_id == card.id,
                CreditCardPeriod.source_sha256 == digest,
            )
        ).scalar_one_or_none()
        if existing is not None:
            raise ConflictError("This statement file has already been imported for this card.")

        reference = self._next_reference()
        period = CreditCardPeriod(
            id=uuid4(),
            reference=reference,
            card_id=card.id,
            period_start=period_start,
            period_end=period_end,
            statement_date=statement_date,
            currency=card.currency,
            source_sha256=digest,
            source_filename=filename.strip() or "statement.csv",
            imported_by_id=actor.id,
            imported_at=datetime.now(UTC),
            version=1,
        )
        self._session.add(period)
        self._session.flush()

        for row in parsed.statement.transactions:
            self._session.add(
                CreditCardTransaction(
                    id=uuid4(),
                    period_id=period.id,
                    source_row=row.source_row,
                    posted_on=row.posted_on,
                    merchant=row.merchant,
                    cardholder=row.cardholder,
                    description=row.description,
                    external_reference=row.reference,
                    amount_minor_units=row.amount.minor_units,
                    currency=row.amount.currency,
                    category=row.category,
                    receipt_waived=False,
                    version=1,
                )
            )
        self._session.flush()

        self._audit.append(
            action=AuditAction.credit_card_statement_imported,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=period.id,
            correlation_id=correlation_id,
            detail={
                "reference": period.reference,
                "card_id": str(card.id),
                "filename": period.source_filename,
                "sha256": digest,
                "transactions": len(parsed.statement.transactions),
                "total": parsed.statement.total.format(),
                "period_start": period_start.isoformat(),
                "period_end": period_end.isoformat(),
            },
        )
        logger.info(
            "credit_card.statement_imported",
            period_id=str(period.id),
            reference=period.reference,
            transactions=len(parsed.statement.transactions),
        )
        return ImportResult(
            period=self.get_period(period.id),
            transaction_count=len(parsed.statement.transactions),
            total=parsed.statement.total,
        )

    # --------------------------------------------------------------- coding

    def code_transaction(
        self,
        transaction: CreditCardTransaction,
        *,
        gl_account_id: UUID | None,
        cost_centre_id: UUID | None,
        category: str | None,
        exception_reason: str | None,
        actor: User,
        correlation_id: UUID,
        expected_version: int | None = None,
    ) -> CreditCardTransaction:
        period = self.get_period(transaction.period_id)
        assert_can_act(
            roles=actor.roles,
            permission=Permission.credit_card_code,
            already_exercised_on_record=self.actions_taken(period, user=actor),
        )
        if not may_change(closed_at=period.closed_at):
            raise ValidationError(
                coding_problems(
                    CodingDraft(
                        gl_account_id=None,
                        cost_centre_id=None,
                        category=None,
                        exception_reason=None,
                    ),
                    closed_at=period.closed_at,
                )
            )

        if expected_version is not None and transaction.version != expected_version:
            raise ConflictError("Somebody else changed this transaction. Refresh and try again.")

        draft = CodingDraft(
            gl_account_id=gl_account_id,
            cost_centre_id=cost_centre_id,
            category=category,
            exception_reason=exception_reason,
        )
        found = coding_problems(draft, closed_at=period.closed_at)
        if found:
            raise ValidationError(found)

        exception = (exception_reason or "").strip() or None
        if exception:
            transaction.gl_account_id = None
            transaction.cost_centre_id = None
            transaction.exception_reason = exception
        else:
            assert gl_account_id is not None and cost_centre_id is not None
            self._require_gl(gl_account_id)
            self._require_cost_centre(cost_centre_id)
            transaction.gl_account_id = gl_account_id
            transaction.cost_centre_id = cost_centre_id
            transaction.exception_reason = None

        cleaned_category = (category or "").strip() or None
        transaction.category = cleaned_category
        transaction.coded_at = datetime.now(UTC)
        transaction.coded_by_id = actor.id
        transaction.version += 1

        self._record_action(period, user=actor, permission=Permission.credit_card_code)
        self._session.flush()

        self._audit.append(
            action=AuditAction.credit_card_transaction_coded,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=period.id,
            correlation_id=correlation_id,
            detail={
                "transaction_id": str(transaction.id),
                "merchant": transaction.merchant,
                "standing": coding_standing(
                    gl_account_id=transaction.gl_account_id,
                    cost_centre_id=transaction.cost_centre_id,
                    exception_reason=transaction.exception_reason,
                ).value,
                "gl_account_id": (
                    str(transaction.gl_account_id) if transaction.gl_account_id else None
                ),
                "cost_centre_id": (
                    str(transaction.cost_centre_id) if transaction.cost_centre_id else None
                ),
                "exception": transaction.exception_reason,
            },
        )
        return transaction

    def match_receipt(
        self,
        transaction: CreditCardTransaction,
        *,
        document_id: UUID | None,
        waived: bool,
        waiver_reason: str | None,
        confidence: float | None,
        actor: User,
        correlation_id: UUID,
    ) -> CreditCardTransaction:
        period = self.get_period(transaction.period_id)
        assert_can_act(
            roles=actor.roles,
            permission=Permission.credit_card_code,
            already_exercised_on_record=self.actions_taken(period, user=actor),
        )
        if not may_change(closed_at=period.closed_at):
            raise ValidationError(
                (
                    FieldProblem(
                        code=CodingProblem.period_closed,
                        field="period",
                        message=CODING_PROBLEM_EXPLANATIONS[CodingProblem.period_closed],
                    ),
                )
            )

        if document_id is not None and waived:
            raise ValidationError(
                (
                    FieldProblem(
                        code=CodingProblem.both_code_and_exception,
                        field="receipt",
                        message="Match a receipt or waive one, not both.",
                    ),
                )
            )

        if waived:
            reason = (waiver_reason or "").strip()
            if len(reason) < 3:
                raise ValidationError(
                    (
                        FieldProblem(
                            code=CodingProblem.exception_required,
                            field="receipt_waiver_reason",
                            message="Waiving a receipt needs a short reason.",
                        ),
                    )
                )
            transaction.receipt_document_id = None
            transaction.receipt_waived = True
            transaction.receipt_waiver_reason = reason
            transaction.receipt_match_confidence = None
        elif document_id is not None:
            document = self._session.get(Document, document_id)
            if document is None:
                raise NotFoundError("That receipt document was not found.")
            transaction.receipt_document_id = document_id
            transaction.receipt_waived = False
            transaction.receipt_waiver_reason = None
            transaction.receipt_match_confidence = confidence
        else:
            transaction.receipt_document_id = None
            transaction.receipt_waived = False
            transaction.receipt_waiver_reason = None
            transaction.receipt_match_confidence = None

        transaction.matched_at = datetime.now(UTC)
        transaction.matched_by_id = actor.id
        transaction.version += 1

        self._record_action(period, user=actor, permission=Permission.credit_card_code)
        self._session.flush()

        self._audit.append(
            action=AuditAction.credit_card_receipt_matched,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=period.id,
            correlation_id=correlation_id,
            detail={
                "transaction_id": str(transaction.id),
                "status": receipt_status(
                    document_id=transaction.receipt_document_id,
                    waived=transaction.receipt_waived,
                ).value,
                "document_id": (
                    str(transaction.receipt_document_id)
                    if transaction.receipt_document_id
                    else None
                ),
                "waived": transaction.receipt_waived,
            },
        )
        return transaction

    def record_suggestion(
        self,
        transaction: CreditCardTransaction,
        *,
        gl_account_id: UUID | None,
        cost_centre_id: UUID | None,
        receipt_document_id: UUID | None,
        evidence: dict[str, object],
        actor: User,
        correlation_id: UUID,
    ) -> CreditCardTransaction:
        """Store an assistive proposal. Never applies it and never closes anything."""

        period = self.get_period(transaction.period_id)
        assert_can_act(roles=actor.roles, permission=Permission.credit_card_code)
        if not may_change(closed_at=period.closed_at):
            raise ValidationError(
                (
                    FieldProblem(
                        code=CodingProblem.period_closed,
                        field="period",
                        message=CODING_PROBLEM_EXPLANATIONS[CodingProblem.period_closed],
                    ),
                )
            )

        transaction.suggested_gl_account_id = gl_account_id
        transaction.suggested_cost_centre_id = cost_centre_id
        transaction.suggested_receipt_document_id = receipt_document_id
        transaction.suggestion_evidence = evidence
        transaction.suggestion_disposition = SuggestionDisposition.pending
        transaction.version += 1
        self._session.flush()

        self._audit.append(
            action=AuditAction.ai_suggestion_produced,
            actor_type=ActorType.ai,
            actor_id=None,
            actor_label="assistive reader",
            subject_type=RECORD_TYPE,
            subject_id=period.id,
            correlation_id=correlation_id,
            detail={
                "transaction_id": str(transaction.id),
                "suggested_gl_account_id": str(gl_account_id) if gl_account_id else None,
                "suggested_cost_centre_id": (str(cost_centre_id) if cost_centre_id else None),
                "evidence_keys": sorted(evidence.keys()),
            },
        )
        return transaction

    def dispose_suggestion(
        self,
        transaction: CreditCardTransaction,
        *,
        disposition: SuggestionDisposition,
        actor: User,
        correlation_id: UUID,
    ) -> CreditCardTransaction:
        """Accept, edit or reject a pending proposal.

        Accept applies the suggested GL and cost centre when both are present.
        It never closes the period and never matches a receipt on its own — a
        receipt still needs an explicit match call, because matching a document
        is a stronger claim than agreeing with a code.
        """
        period = self.get_period(transaction.period_id)
        assert_can_act(
            roles=actor.roles,
            permission=Permission.credit_card_code,
            already_exercised_on_record=self.actions_taken(period, user=actor),
        )
        if transaction.suggestion_disposition is not SuggestionDisposition.pending:
            raise ConflictError("There is no pending suggestion on this transaction.")

        if disposition is SuggestionDisposition.accepted:
            if (
                transaction.suggested_gl_account_id is not None
                and transaction.suggested_cost_centre_id is not None
            ):
                self.code_transaction(
                    transaction,
                    gl_account_id=transaction.suggested_gl_account_id,
                    cost_centre_id=transaction.suggested_cost_centre_id,
                    category=transaction.category,
                    exception_reason=None,
                    actor=actor,
                    correlation_id=correlation_id,
                )
            transaction.suggestion_disposition = SuggestionDisposition.accepted
            action = AuditAction.ai_suggestion_accepted
        elif disposition is SuggestionDisposition.rejected:
            transaction.suggestion_disposition = SuggestionDisposition.rejected
            action = AuditAction.ai_suggestion_rejected
        elif disposition is SuggestionDisposition.edited:
            transaction.suggestion_disposition = SuggestionDisposition.edited
            action = AuditAction.ai_suggestion_accepted
        else:
            raise ValidationError(
                (
                    FieldProblem(
                        code=CodingProblem.exception_required,
                        field="disposition",
                        message="Choose accept, edit or reject.",
                    ),
                )
            )

        transaction.version += 1
        self._session.flush()
        self._audit.append(
            action=action,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=period.id,
            correlation_id=correlation_id,
            detail={
                "transaction_id": str(transaction.id),
                "disposition": disposition.value,
            },
        )
        return transaction

    # ----------------------------------------------------------------- close

    def close_period(
        self,
        period: CreditCardPeriod,
        *,
        reason: str,
        actor: User,
        correlation_id: UUID,
    ) -> CreditCardPeriod:
        assert_can_act(
            roles=actor.roles,
            permission=Permission.credit_card_close_period,
            already_exercised_on_record=self.actions_taken(period, user=actor),
        )

        view = self._period_view(period)
        found = close_problems(view, reason=reason)
        if found:
            raise ValidationError(found)

        period.closed_at = datetime.now(UTC)
        period.closed_by_id = actor.id
        period.close_reason = reason.strip()
        period.version += 1

        self._record_action(period, user=actor, permission=Permission.credit_card_close_period)
        self._session.flush()

        self._audit.append(
            action=AuditAction.credit_card_period_closed,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=period.id,
            correlation_id=correlation_id,
            detail={
                "reference": period.reference,
                "reason": period.close_reason,
                "transactions": len(period.transactions),
                "uncoded_remaining": 0,
            },
        )
        logger.info(
            "credit_card.period_closed",
            period_id=str(period.id),
            reference=period.reference,
        )
        return period

    def actions_taken(self, period: CreditCardPeriod, *, user: User) -> frozenset[Permission]:
        return frozenset(
            self._session.execute(
                select(RecordActionRow.permission).where(
                    RecordActionRow.record_type == RECORD_TYPE,
                    RecordActionRow.record_id == period.id,
                    RecordActionRow.user_id == user.id,
                )
            ).scalars()
        )

    def period_summary(self, period: CreditCardPeriod) -> dict[str, object]:
        view = self._period_view(period)
        return {
            "standing": period_standing(closed_at=period.closed_at).value,
            "transaction_count": len(period.transactions),
            "uncoded_count": uncoded_count(view.transactions),
            "missing_receipt_count": sum(
                1
                for row in period.transactions
                if receipt_status(document_id=row.receipt_document_id, waived=row.receipt_waived)
                is ReceiptStatus.missing
            ),
        }

    # ------------------------------------------------------------- internals

    def _period_view(self, period: CreditCardPeriod) -> PeriodView:
        return PeriodView(
            closed_at=period.closed_at,
            transactions=tuple(
                CardTransactionView(
                    amount=Money(row.amount_minor_units, row.currency),
                    gl_account_id=row.gl_account_id,
                    cost_centre_id=row.cost_centre_id,
                    exception_reason=row.exception_reason,
                    receipt_document_id=row.receipt_document_id,
                    receipt_waived=row.receipt_waived,
                )
                for row in period.transactions
            ),
        )

    def _next_reference(self) -> str:
        value = self._session.execute(_PERIOD_REFERENCE.next_value()).scalar_one()
        return f"CCS-{int(value):06d}"

    def _require_gl(self, gl_account_id: UUID) -> GlAccount:
        account = self._session.get(GlAccount, gl_account_id)
        if account is None or account.archived_at is not None or not account.is_active:
            raise NotFoundError("That GL account was not found or is not active.")
        return account

    def _require_cost_centre(self, cost_centre_id: UUID) -> CostCentre:
        centre = self._session.get(CostCentre, cost_centre_id)
        if centre is None or centre.archived_at is not None or not centre.is_active:
            raise NotFoundError("That cost centre was not found or is not active.")
        return centre

    def _record_action(
        self,
        period: CreditCardPeriod,
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


def transaction_coding_label(transaction: CreditCardTransaction) -> str:
    standing = coding_standing(
        gl_account_id=transaction.gl_account_id,
        cost_centre_id=transaction.cost_centre_id,
        exception_reason=transaction.exception_reason,
    )
    from finora.domain.credit_cards import CODING_STANDING_LABELS

    return CODING_STANDING_LABELS[standing]


def transaction_receipt_label(transaction: CreditCardTransaction) -> str:
    status = receipt_status(
        document_id=transaction.receipt_document_id,
        waived=transaction.receipt_waived,
    )
    from finora.domain.credit_cards import RECEIPT_STATUS_LABELS

    return RECEIPT_STATUS_LABELS[status]
