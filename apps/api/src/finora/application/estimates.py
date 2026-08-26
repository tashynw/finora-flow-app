"""Raising an estimate, sending it for approval, and what happens to the answer.

The shape of this module follows one decision: an estimate's details and its
approval route are only ever changed together, in one transaction, by one
function. Every alternative leaks. If a requester can edit an amount while a
route is open, approvers are deciding on a figure that is no longer there. If a
route can close without moving the estimate's state, the record sits approved
with nobody told. So `submit`, `withdraw` and `record_decision` each do the whole
job, and the API layer has no way to do half of it.

Values arriving from an accepted document reading are copied, not referenced. The
reading stays as the evidence for where they came from, and the estimate carries
its own figures, because an estimate approved in March must still say what was
approved if the document is re-read in June.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
from uuid import UUID

import structlog
from sqlalchemy import Sequence as SqlSequence
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from finora.application.approvals import ApprovalService
from finora.domain.approvals import ApprovalOutcome, RouteState
from finora.domain.audit import ActorType, AuditAction
from finora.domain.estimates import (
    EDITABLE_STATES,
    PROBLEM_EXPLANATIONS,
    PROBLEM_FIELDS,
    EstimateDetails,
    EstimateProblem,
    problems,
)
from finora.domain.extraction import DocumentKind, ExtractionStatus, FieldName
from finora.domain.money import CurrencyError, Money
from finora.domain.roles import ApprovalLevel, Permission, Role, assert_can_act
from finora.domain.workflow import (
    TransitionSource,
    WorkflowState,
    transition,
)
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import (
    CostCentre,
    Document,
    Estimate,
    GlAccount,
    RecordActionRow,
    StateTransitionRow,
    User,
    Vendor,
)

logger = structlog.get_logger(__name__)

#: The record type these estimates are known by in the shared approval,
#: transition and audit tables.
RECORD_TYPE = "estimate"

#: Database sequence behind the human-readable reference. A sequence rather than
#: a count of existing rows, because two requesters submitting at the same instant
#: would both count the same number and one of them would lose the insert.
REFERENCE_SEQUENCE = SqlSequence("estimate_reference_seq")


class EstimateError(Exception):
    """Base class for a refused estimate action."""


class NotEditableError(EstimateError):
    def __init__(self, state: WorkflowState) -> None:
        self.state = state
        super().__init__(
            "This estimate is with approvers and cannot be edited. Withdraw it "
            "first if a detail is wrong; the approvals given so far will be recorded "
            "and it will need approving again."
            if state is WorkflowState.pending_approval
            else "This estimate can no longer be edited."
        )


class NotReadyError(EstimateError):
    """Completeness rules are unmet. Carries every gap, not the first."""

    def __init__(self, found: tuple[EstimateProblem, ...]) -> None:
        self.problems = found
        super().__init__("This estimate is not ready to be sent for approval.")

    @property
    def as_details(self) -> list[dict[str, str]]:
        return [
            {
                "problem": str(problem),
                "field": PROBLEM_FIELDS[problem],
                "explanation": PROBLEM_EXPLANATIONS[problem],
            }
            for problem in self.problems
        ]


class DocumentNotUsableError(EstimateError):
    """The document cannot become an estimate, and why."""


@dataclass(slots=True)
class EstimateDraft:
    """The complete editable state of a draft estimate.

    Everything at once rather than a set of changes, so `None` unambiguously
    means "this estimate has no such value". A partial update would need a
    separate sentinel to distinguish "leave the cost centre alone" from "remove
    the cost centre", and every reader of the type would have to remember which
    was which.
    """

    vendor_name: str
    description: str
    justification: str
    vendor_id: UUID | None = None
    estimate_number: str | None = None
    estimate_date: date | None = None
    needed_by: date | None = None
    total_minor_units: int | None = None
    currency: str | None = None
    cost_centre_id: UUID | None = None
    gl_account_id: UUID | None = None


class EstimateService:
    def __init__(
        self,
        *,
        session: Session,
        approvals: ApprovalService,
        audit: AuditRepository,
    ) -> None:
        self._session = session
        self._approvals = approvals
        self._audit = audit

    # ------------------------------------------------------------------ raising

    def create_from_document(
        self,
        document: Document,
        *,
        requester: User,
        correlation_id: UUID,
    ) -> Estimate:
        """Raise a draft estimate from an accepted reading.

        Only from an accepted one. A reading still in review has values nobody has
        confirmed, and an estimate is a request to spend money: the point of the
        review workspace is that this is where its output becomes usable.
        """
        extraction = next((item for item in document.extractions if item.is_current), None)
        if extraction is None or extraction.status is not ExtractionStatus.accepted:
            raise DocumentNotUsableError(
                "The values read from this document have not been accepted yet. "
                "Check them in the review workspace and accept them first."
            )
        if extraction.kind is not DocumentKind.estimate:
            raise DocumentNotUsableError(
                f"This document was accepted as a {extraction.kind.value.replace('_', ' ')}, "
                "not an estimate. Change its type in the review workspace if that is wrong."
            )

        existing = self._session.execute(
            select(Estimate).where(Estimate.document_id == document.id)
        ).scalar_one_or_none()
        if existing is not None:
            raise DocumentNotUsableError(
                f"This document has already been raised as estimate {existing.reference}."
            )

        values = {row.name: row for row in extraction.fields}

        def text_of(name: FieldName) -> str:
            row = values.get(name)
            return row.text if row is not None else ""

        total_row = values.get(FieldName.total)
        currency = text_of(FieldName.currency).upper()[:3] or None
        date_row = values.get(FieldName.document_date)

        estimate = Estimate(
            reference=self._next_reference(),
            state=WorkflowState.draft,
            requester_id=requester.id,
            document_id=document.id,
            vendor_id=self._match_vendor(text_of(FieldName.vendor_name)),
            vendor_name=text_of(FieldName.vendor_name)[:300],
            estimate_number=(text_of(FieldName.document_number)[:120] or None),
            estimate_date=date_row.value_date if date_row is not None else None,
            total_minor_units=total_row.amount_minor_units if total_row is not None else None,
            currency=(total_row.currency if total_row is not None else None) or currency,
            # Left for the requester. A description assembled from a filename is
            # not a description of what is being bought, and pre-filling one
            # invites it through unread.
            description="",
            justification="",
        )
        self._session.add(estimate)
        self._session.flush()

        self._audit.append(
            action=AuditAction.record_created,
            actor_type=ActorType.user,
            actor_id=requester.id,
            actor_label=requester.display_name,
            subject_type=RECORD_TYPE,
            subject_id=estimate.id,
            correlation_id=correlation_id,
            detail={
                "reference": estimate.reference,
                "from_document": str(document.id),
                "document_sha256": document.sha256,
                "extraction_attempt": extraction.attempt,
                "vendor_name": estimate.vendor_name,
                "total": self._format_total(estimate),
            },
        )
        logger.info(
            "estimate.created",
            estimate_id=str(estimate.id),
            reference=estimate.reference,
            from_document=str(document.id),
        )
        return estimate

    def create_blank(self, *, requester: User, correlation_id: UUID) -> Estimate:
        """Raise an empty draft, for a quotation that did not arrive by mail."""
        estimate = Estimate(
            reference=self._next_reference(),
            state=WorkflowState.draft,
            requester_id=requester.id,
        )
        self._session.add(estimate)
        self._session.flush()

        self._audit.append(
            action=AuditAction.record_created,
            actor_type=ActorType.user,
            actor_id=requester.id,
            actor_label=requester.display_name,
            subject_type=RECORD_TYPE,
            subject_id=estimate.id,
            correlation_id=correlation_id,
            detail={"reference": estimate.reference, "from_document": None},
        )
        return estimate

    # ------------------------------------------------------------------ editing

    def update(
        self,
        estimate: Estimate,
        draft: EstimateDraft,
        *,
        actor: User,
        correlation_id: UUID,
    ) -> Estimate:
        """Replace a draft's details, recording what moved.

        The audit entry lists only the fields that actually changed. Recording the
        whole submitted form on every keystroke-driven save would bury the one
        edit that mattered, and "the amount went from 40,000 to 60,000 the day
        before it was approved" is the entry somebody will come looking for.
        """
        if estimate.state not in EDITABLE_STATES:
            raise NotEditableError(estimate.state)

        self._assert_references_exist(draft)
        amount = self._draft_amount(draft)

        applied: dict[str, dict[str, str | None]] = {}

        def apply(field: str, value: object | None) -> None:
            before = getattr(estimate, field)
            if before == value:
                return
            setattr(estimate, field, value)
            applied[field] = {"from": _recorded(before), "to": _recorded(value)}

        apply("vendor_id", draft.vendor_id)
        apply("vendor_name", draft.vendor_name.strip()[:300])
        apply("estimate_number", _trimmed(draft.estimate_number, 120))
        apply("estimate_date", draft.estimate_date)
        apply("needed_by", draft.needed_by)
        apply("description", draft.description.strip()[:500])
        apply("justification", draft.justification.strip())
        apply("cost_centre_id", draft.cost_centre_id)
        apply("gl_account_id", draft.gl_account_id)
        apply("total_minor_units", amount.minor_units if amount else None)
        apply("currency", amount.currency if amount else _trimmed(draft.currency, 3))

        if not applied:
            return estimate

        self._session.flush()
        self._audit.append(
            action=AuditAction.record_updated,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=estimate.id,
            correlation_id=correlation_id,
            detail={"reference": estimate.reference, "changed": applied},
        )
        return estimate

    def outstanding(
        self, estimate: Estimate, *, today: date | None = None
    ) -> tuple[EstimateProblem, ...]:
        """Everything stopping this estimate from being submitted."""
        return problems(self._details(estimate), today=today or datetime.now(UTC).date())

    @staticmethod
    def _draft_amount(draft: EstimateDraft) -> Money | None:
        """The draft's total as money, refusing a currency nothing can scale.

        Built through `Money` rather than stored as the two columns directly, so
        an unrecognised ISO code is refused at the point of entry instead of
        becoming a number whose decimal places nothing knows.
        """
        if draft.total_minor_units is None:
            return None
        currency = (draft.currency or "").strip().upper()
        if not currency:
            raise EstimateError("Choose the currency this amount is in.")
        try:
            return Money(draft.total_minor_units, currency)
        except CurrencyError as error:
            raise EstimateError(str(error)) from error

    # --------------------------------------------------------------- submission

    def submit(
        self,
        estimate: Estimate,
        *,
        actor: User,
        correlation_id: UUID,
    ) -> Estimate:
        """Send a complete draft for approval.

        Completeness, then the route, then the state, in that order. The route is
        planned before anything is written, so an estimate whose amount nobody is
        configured to approve stays a draft with an explanation rather than
        becoming a pending request that cannot move.
        """
        assert_can_act(roles=actor.roles, permission=Permission.estimate_submit)

        if estimate.state is not WorkflowState.draft:
            raise NotEditableError(estimate.state)

        found = self.outstanding(estimate)
        if found:
            raise NotReadyError(found)

        department = actor.department
        amount = self._amount(estimate)
        now = datetime.now(UTC)

        estimate.submitted_at = now
        estimate.submitted_by_id = actor.id
        estimate.department = department
        self._session.flush()

        # Opened before the transition, so a route that cannot be planned leaves
        # the estimate in draft rather than pending with nobody to act on it.
        self._approvals.open_route(
            record_type=RECORD_TYPE,
            record_id=estimate.id,
            amount=amount,
            department=department,
            requester_id=estimate.requester_id,
            actor=_ActingUser(actor),
            correlation_id=correlation_id,
        )

        self._move(
            estimate,
            target=WorkflowState.pending_approval,
            actor=actor,
            reason=None,
            correlation_id=correlation_id,
        )
        # Recorded so that segregation of duties has something to consult. Holding
        # both the requester and approver roles is legitimate; using both on this
        # estimate is not, and this row is how the second attempt is refused.
        self._record_action(estimate, user=actor, permission=Permission.estimate_submit)

        logger.info(
            "estimate.submitted",
            estimate_id=str(estimate.id),
            reference=estimate.reference,
            amount=amount.format(),
        )
        return estimate

    def withdraw(
        self,
        estimate: Estimate,
        *,
        actor: User,
        reason: str,
        correlation_id: UUID,
    ) -> Estimate:
        """Pull an estimate back from approvers so it can be corrected."""
        if estimate.state is not WorkflowState.pending_approval:
            raise NotEditableError(estimate.state)
        if not reason.strip():
            raise EstimateError("Give a reason for withdrawing this from approval.")

        request = self._approvals.open_request(record_type=RECORD_TYPE, record_id=estimate.id)
        if request is not None:
            self._approvals.withdraw(
                request=request,
                actor=_ActingUser(actor),
                reason=reason.strip(),
                correlation_id=correlation_id,
            )

        # State first, then the submission stamp. The database requires anything
        # past draft to name who submitted it, so clearing the stamp while the row
        # still says `pending_approval` is refused by the check constraint.
        self._move(
            estimate,
            target=WorkflowState.draft,
            actor=actor,
            reason=reason.strip(),
            correlation_id=correlation_id,
        )
        estimate.submitted_at = None
        estimate.submitted_by_id = None
        self._session.flush()
        return estimate

    def cancel(
        self,
        estimate: Estimate,
        *,
        actor: User,
        reason: str,
        correlation_id: UUID,
    ) -> Estimate:
        """Abandon an estimate for good, closing any open route."""
        if not reason.strip():
            raise EstimateError("Give a reason for cancelling this estimate.")

        request = self._approvals.open_request(record_type=RECORD_TYPE, record_id=estimate.id)
        if request is not None:
            self._approvals.withdraw(
                request=request,
                actor=_ActingUser(actor),
                reason=f"Estimate cancelled: {reason.strip()}",
                correlation_id=correlation_id,
            )

        self._move(
            estimate,
            target=WorkflowState.cancelled,
            actor=actor,
            reason=reason.strip(),
            correlation_id=correlation_id,
        )
        return estimate

    # ----------------------------------------------------------------- deciding

    def record_decision(
        self,
        estimate: Estimate,
        *,
        step_order: int,
        level: ApprovalLevel,
        outcome: ApprovalOutcome,
        actor: User,
        comment: str | None,
        correlation_id: UUID,
    ) -> Estimate:
        """Apply an approval decision and move the estimate if the route closed.

        The segregation-of-duties check runs against what this user has already
        done to this specific estimate, so somebody who submitted it is refused
        here even if they hold every approver role in the organisation.
        """
        assert_can_act(
            roles=actor.roles,
            permission=Permission.approval_decide,
            already_exercised_on_record=self._actions_taken(estimate, user=actor),
        )

        request = self._approvals.open_request(record_type=RECORD_TYPE, record_id=estimate.id)
        if request is None:
            raise EstimateError(
                "This estimate has no approval route open, so there is nothing to decide."
            )

        state = self._approvals.record_decision(
            request=request,
            step_order=step_order,
            level=level,
            outcome=outcome,
            user=actor,
            comment=comment,
            correlation_id=correlation_id,
        )
        self._record_action(estimate, user=actor, permission=Permission.approval_decide)

        if state is RouteState.approved:
            estimate.decided_at = datetime.now(UTC)
            self._move(
                estimate,
                target=WorkflowState.approved,
                actor=actor,
                reason=comment,
                correlation_id=correlation_id,
            )
        elif state is RouteState.rejected:
            estimate.decided_at = datetime.now(UTC)
            self._move(
                estimate,
                target=WorkflowState.rejected,
                actor=actor,
                # Rejection requires a comment, checked by the approvals domain
                # before this point, so this is never the empty reason the
                # workflow machine would refuse.
                reason=comment,
                correlation_id=correlation_id,
            )
        return estimate

    # ---------------------------------------------------------------- internals

    def transitions(self, estimate: Estimate) -> list[StateTransitionRow]:
        """This estimate's state history, oldest first."""
        return list(
            self._session.execute(
                select(StateTransitionRow)
                .where(
                    StateTransitionRow.record_type == RECORD_TYPE,
                    StateTransitionRow.record_id == estimate.id,
                )
                .order_by(StateTransitionRow.occurred_at, StateTransitionRow.id)
            )
            .scalars()
            .all()
        )

    def _details(self, estimate: Estimate) -> EstimateDetails:
        return EstimateDetails(
            vendor_name=estimate.vendor_name or "",
            description=estimate.description or "",
            total=self._amount_or_none(estimate),
            estimate_date=estimate.estimate_date,
            cost_centre_id=estimate.cost_centre_id,
            justification=estimate.justification or "",
            needed_by=estimate.needed_by,
        )

    @staticmethod
    def _amount_or_none(estimate: Estimate) -> Money | None:
        if estimate.total_minor_units is None or not estimate.currency:
            return None
        try:
            return Money(estimate.total_minor_units, estimate.currency)
        except CurrencyError:
            return None

    def _amount(self, estimate: Estimate) -> Money:
        amount = self._amount_or_none(estimate)
        if amount is None:
            raise NotReadyError((EstimateProblem.amount_missing,))
        return amount

    def _format_total(self, estimate: Estimate) -> str | None:
        amount = self._amount_or_none(estimate)
        return amount.format() if amount else None

    def _move(
        self,
        estimate: Estimate,
        *,
        target: WorkflowState,
        actor: User,
        reason: str | None,
        correlation_id: UUID,
    ) -> None:
        """Validate a state change through the machine and persist it."""
        change = transition(
            record_id=estimate.id,
            current=estimate.state,
            target=target,
            source=TransitionSource.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            expected_version=estimate.version,
            actual_version=estimate.version,
            reason=reason,
            correlation_id=correlation_id,
        )
        estimate.state = target
        self._session.add(
            StateTransitionRow(
                record_type=RECORD_TYPE,
                record_id=estimate.id,
                from_state=change.from_state,
                to_state=change.to_state,
                source=change.source,
                actor_id=change.actor_id,
                actor_label=change.actor_label,
                reason=change.reason,
                correlation_id=change.correlation_id,
                occurred_at=change.occurred_at,
                context={"reference": estimate.reference},
            )
        )
        self._session.flush()

        self._audit.append(
            action=AuditAction.state_changed,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=estimate.id,
            correlation_id=correlation_id,
            detail={
                "reference": estimate.reference,
                "from": str(change.from_state),
                "to": str(change.to_state),
                "reason": change.reason,
                "total": self._format_total(estimate),
            },
        )

    def _record_action(self, estimate: Estimate, *, user: User, permission: Permission) -> None:
        already = self._session.execute(
            select(RecordActionRow).where(
                RecordActionRow.record_type == RECORD_TYPE,
                RecordActionRow.record_id == estimate.id,
                RecordActionRow.user_id == user.id,
                RecordActionRow.permission == permission,
            )
        ).scalar_one_or_none()
        if already is not None:
            return
        self._session.add(
            RecordActionRow(
                record_type=RECORD_TYPE,
                record_id=estimate.id,
                user_id=user.id,
                permission=permission,
            )
        )
        self._session.flush()

    def _actions_taken(self, estimate: Estimate, *, user: User) -> frozenset[Permission]:
        return frozenset(
            self._session.execute(
                select(RecordActionRow.permission).where(
                    RecordActionRow.record_type == RECORD_TYPE,
                    RecordActionRow.record_id == estimate.id,
                    RecordActionRow.user_id == user.id,
                )
            )
            .scalars()
            .all()
        )

    def _assert_references_exist(self, draft: EstimateDraft) -> None:
        """Refuse a reference to a vendor, cost centre or account that is not there.

        A foreign key would refuse it too, at commit, as an integrity error with
        nothing a user could act on. Checked here so the refusal names the thing
        that was not found.
        """
        if draft.vendor_id is not None:
            vendor = self._session.get(Vendor, draft.vendor_id)
            if vendor is None or vendor.archived_at is not None or not vendor.is_active:
                raise EstimateError("That vendor does not exist, or is no longer in use.")
        if draft.cost_centre_id is not None:
            centre = self._session.get(CostCentre, draft.cost_centre_id)
            if centre is None or centre.archived_at is not None or not centre.is_active:
                raise EstimateError("That cost centre does not exist, or is no longer in use.")
        if draft.gl_account_id is not None:
            account = self._session.get(GlAccount, draft.gl_account_id)
            if account is None or account.archived_at is not None or not account.is_active:
                raise EstimateError("That GL account does not exist, or is no longer in use.")

    def _match_vendor(self, name: str) -> UUID | None:
        """Link to the vendor master when the name is an exact match.

        Exact only, deliberately. A fuzzy match would attach a payment record to
        the wrong company for the sake of saving a click, and the requester is
        being shown this screen anyway.
        """
        cleaned = name.strip()
        if not cleaned:
            return None
        return (
            self._session.execute(
                select(Vendor.id).where(
                    func.lower(Vendor.name) == cleaned.casefold(),
                    Vendor.is_active,
                    Vendor.archived_at.is_(None),
                )
            )
            .scalars()
            .first()
        )

    def _next_reference(self) -> str:
        value = self._session.execute(REFERENCE_SEQUENCE.next_value()).scalar_one()
        return f"EST-{value:06d}"


def _trimmed(value: str | None, limit: int) -> str | None:
    """A stripped, truncated value, or None when there is nothing left of it."""
    cleaned = (value or "").strip()[:limit]
    return cleaned or None


def _recorded(value: object | None) -> str | None:
    """One edited value as the audit trail stores it.

    Text rather than the value's own JSON type, because a date, an identifier and
    an amount all have to sit in the same column and a reader of the trail wants
    to see what changed, not to reconstruct which Python type each side was. The
    distinction that has to survive is empty against absent, so an empty string
    stays an empty string and only `None` becomes null.
    """
    if value is None:
        return None
    return str(value)


@dataclass(frozen=True, slots=True)
class _ActingUser:
    """Adapts a `User` row to the `Actor` protocol the approvals service takes."""

    user: User

    @property
    def user_id(self) -> UUID:
        return self.user.id

    @property
    def display_name(self) -> str:
        return self.user.display_name


def may_view(estimate: Estimate, *, user: User) -> bool:
    """Whether this user may see this estimate.

    A requester sees their own. Anyone holding a role with a wider remit sees all
    of them, because an approver has to see a request to decide it and finance has
    to see the whole pipeline. This is the record-level half of authorisation; the
    permission itself is checked separately.
    """
    if estimate.requester_id == user.id:
        return True
    return bool(
        user.roles
        & {Role.approver, Role.finance, Role.auditor, Role.administrator, Role.payment_coordinator}
    )
