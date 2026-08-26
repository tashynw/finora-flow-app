"""Raising, approving, amending and closing a commitment to a supplier.

Structurally the same as the estimate service, and different in three places that
follow from an order being a commitment rather than a request.

*An order can be born already approved.* Not every order needs a decision. One
drawing entirely on an approved estimate — same supplier, same currency, no more
money — asks for authority somebody has already given, and sending it round again
is a second signature on one decision. `submit` therefore either opens a route or
opens the order, and says on the record which of the two happened and why.

*An approved figure can change, and changing it upwards un-approves it.* An
approval is given for an amount. Raising the amount afterwards would carry a
signature nobody gave, so an increase sends the order back for approval and it
stops accepting invoices while that is decided. A reduction does not, except that
it cannot go below what suppliers have already billed: invoices that were correct
when they arrived must not be put in breach of an order changed after the fact.

*Closing is not cancelling, and the difference is whether anything happened.* An
order that has been billed against cannot be cancelled, because cancelling says
it should never have existed and there are invoices proving otherwise. It is
closed instead, which says it is finished. Cancelling stays available for an
order nobody acted on.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

import structlog
from sqlalchemy import Sequence as SqlSequence
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from finora.application.approvals import ApprovalService
from finora.domain.approvals import ApprovalOutcome, RouteState
from finora.domain.audit import ActorType, AuditAction
from finora.domain.money import CurrencyError, Money
from finora.domain.purchase_orders import (
    EDITABLE_STATES,
    PROBLEM_EXPLANATIONS,
    PROBLEM_FIELDS,
    LinkedEstimate,
    OrderDetails,
    PurchaseOrderProblem,
    is_receiving,
    needs_its_own_approval,
    problems,
    state_label,
)
from finora.domain.roles import ApprovalLevel, Permission, assert_can_act
from finora.domain.workflow import TransitionSource, WorkflowState, transition
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import (
    CostCentre,
    Estimate,
    GlAccount,
    Invoice,
    PurchaseOrder,
    RecordActionRow,
    StateTransitionRow,
    User,
    Vendor,
)

logger = structlog.get_logger(__name__)

#: How a purchase order names itself to the approval engine, the transition table
#: and the audit trail.
RECORD_TYPE = "purchase_order"

#: The order number comes from here rather than from a person. A supplier quotes
#: it back on their invoice and it is how that invoice is matched to this
#: commitment, so two orders sharing one number would make the match ambiguous.
#: Taking it out of the user's hands removes the only way that happens.
NUMBER_SEQUENCE = SqlSequence("purchase_order_number_seq")


class PurchaseOrderError(Exception):
    """Base class for a refused action on an order."""


class NotEditableError(PurchaseOrderError):
    def __init__(self, state: WorkflowState) -> None:
        self.state = state
        super().__init__(
            "This order is with approvers and cannot be edited. Withdraw it first "
            "if a detail is wrong."
            if state is WorkflowState.pending_approval
            else "This order can no longer be edited."
        )


class NotReadyError(PurchaseOrderError):
    """The order is incomplete or contradicts something it draws on."""

    def __init__(self, found: tuple[PurchaseOrderProblem, ...]) -> None:
        self.problems = found
        super().__init__("This order is not ready to be committed.")

    def as_detail(self) -> dict[str, object]:
        """The refusal in the shape the API returns problems everywhere else."""
        return {
            "message": str(self),
            "problems": [
                {
                    "problem": problem.value,
                    "field": PROBLEM_FIELDS[problem],
                    "explanation": PROBLEM_EXPLANATIONS[problem],
                }
                for problem in self.problems
            ],
        }


@dataclass(frozen=True, slots=True)
class Commitment:
    """The figures an invoice is measured against.

    Absent for a draft, which has no supplier or no amount yet. Having one type
    that either exists or does not saves every reader of an order from checking
    three nullable columns and guessing what it means when one of them is empty.
    """

    vendor_id: UUID
    vendor_name: str
    total: Money


def commitment(order: PurchaseOrder) -> Commitment | None:
    """What this order commits, or None if it does not commit anything yet."""
    if order.vendor_id is None or order.total_minor_units is None or not order.currency:
        return None
    try:
        total = Money(order.total_minor_units, order.currency)
    except CurrencyError:
        # A currency the platform cannot scale. Unreachable through the API, which
        # refuses one at entry, and treated as no commitment rather than guessed
        # at, because an amount whose decimal places nothing knows must not be
        # compared with anything.
        return None
    return Commitment(
        vendor_id=order.vendor_id,
        vendor_name=order.vendor.name if order.vendor is not None else "",
        total=total,
    )


def billed_to(
    session: Session,
    order: PurchaseOrder,
    *,
    currency: str,
    excluding: UUID | None = None,
) -> Money:
    """What live invoices have billed to an order, in the currency asked for.

    Cancelled and rejected invoices are excluded, because an order's capacity is
    not consumed by a demand that was refused. Invoices in another currency are
    excluded too: they are a linkage fault reported against the invoice, not a
    figure to add into a total denominated in something else.

    `excluding` leaves one invoice out, so re-checking a saved invoice does not
    count it against itself and report an overrun that does not exist.
    """
    conditions = [
        Invoice.purchase_order_id == order.id,
        Invoice.state.not_in([WorkflowState.cancelled, WorkflowState.rejected]),
        Invoice.archived_at.is_(None),
        Invoice.currency == currency,
    ]
    if excluding is not None:
        conditions.append(Invoice.id != excluding)

    total = session.execute(
        select(func.coalesce(func.sum(Invoice.total_minor_units), 0)).where(*conditions)
    ).scalar_one()
    return Money(int(total or 0), currency)


@dataclass(frozen=True, slots=True)
class PurchaseOrderDraft:
    """The editable face of an order."""

    vendor_id: UUID | None
    description: str
    total_minor_units: int | None
    currency: str | None
    cost_centre_id: UUID | None
    gl_account_id: UUID | None
    estimate_id: UUID | None


@dataclass(frozen=True, slots=True)
class _ActingUser:
    """Adapts a user row to what the approval service asks for."""

    user: User

    @property
    def user_id(self) -> UUID:
        return self.user.id

    @property
    def display_name(self) -> str:
        return self.user.display_name


class PurchaseOrderService:
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

    def create_blank(self, *, raiser: User, correlation_id: UUID) -> PurchaseOrder:
        order = PurchaseOrder(
            number=self._next_number(),
            state=WorkflowState.draft,
            raised_by_id=raiser.id,
        )
        self._session.add(order)
        self._session.flush()

        self._audit.append(
            action=AuditAction.record_created,
            actor_type=ActorType.user,
            actor_id=raiser.id,
            actor_label=raiser.display_name,
            subject_type=RECORD_TYPE,
            subject_id=order.id,
            correlation_id=correlation_id,
            detail={"number": order.number},
        )
        return order

    # ------------------------------------------------------------------ editing

    def update(
        self,
        order: PurchaseOrder,
        draft: PurchaseOrderDraft,
        *,
        actor: User,
        correlation_id: UUID,
    ) -> PurchaseOrder:
        """Replace a draft's details, recording only what actually moved."""
        if order.state not in EDITABLE_STATES:
            raise NotEditableError(order.state)

        self._assert_references_exist(draft)
        amount = self._draft_amount(draft)

        applied: dict[str, dict[str, str | None]] = {}

        def apply(field: str, value: object | None) -> None:
            before = getattr(order, field)
            if before == value:
                return
            setattr(order, field, value)
            applied[field] = {"from": _recorded(before), "to": _recorded(value)}

        apply("vendor_id", draft.vendor_id)
        apply("description", draft.description.strip()[:500])
        apply("total_minor_units", amount.minor_units if amount else None)
        apply("currency", amount.currency if amount else None)
        apply("cost_centre_id", draft.cost_centre_id)
        apply("gl_account_id", draft.gl_account_id)
        apply("estimate_id", draft.estimate_id)

        if not applied:
            return order

        self._session.flush()
        self._audit.append(
            action=AuditAction.record_updated,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=order.id,
            correlation_id=correlation_id,
            detail={"number": order.number, "changed": applied},
        )
        return order

    def outstanding(self, order: PurchaseOrder) -> tuple[PurchaseOrderProblem, ...]:
        """Everything stopping this order from being committed."""
        return problems(self._details(order))

    def needs_approval(self, order: PurchaseOrder) -> bool:
        """Whether submitting this order would ask anybody to decide.

        False means an approved estimate already covers it and it would open on
        submission. That is a route of length zero on purpose, and a screen has
        to be able to say so rather than showing an empty approval panel that
        reads as a route nobody has configured.
        """
        return needs_its_own_approval(self._details(order))

    # --------------------------------------------------------------- committing

    def submit(
        self,
        order: PurchaseOrder,
        *,
        actor: User,
        correlation_id: UUID,
    ) -> PurchaseOrder:
        """Commit the order, through approval if it needs any.

        Completeness first, then the question of whether anybody has to agree. An
        order covered by an approved estimate opens on the spot and records which
        approval it stands on; anything else goes round.
        """
        assert_can_act(roles=actor.roles, permission=Permission.purchase_order_manage)

        if order.state not in EDITABLE_STATES:
            raise NotEditableError(order.state)

        details = self._details(order)
        found = problems(details)
        if found:
            raise NotReadyError(found)

        amount = self._amount(order)
        now = datetime.now(UTC)

        order.submitted_at = now
        order.submitted_by_id = actor.id
        order.department = actor.department
        self._session.flush()

        if not needs_its_own_approval(details):
            self._open_without_approval(order, actor=actor, correlation_id=correlation_id)
            return order

        # Opened before the transition, so an order nobody is configured to
        # approve stays editable with an explanation rather than becoming a
        # pending commitment that cannot move.
        self._approvals.open_route(
            record_type=RECORD_TYPE,
            record_id=order.id,
            amount=amount,
            department=order.department,
            requester_id=order.raised_by_id,
            actor=_ActingUser(actor),
            correlation_id=correlation_id,
        )
        self._move(
            order,
            target=WorkflowState.pending_approval,
            actor=actor,
            reason=None,
            correlation_id=correlation_id,
        )
        self._record_action(order, user=actor, permission=Permission.purchase_order_manage)

        logger.info(
            "purchase_order.submitted",
            purchase_order_id=str(order.id),
            number=order.number,
            amount=amount.format(),
        )
        return order

    def _open_without_approval(
        self,
        order: PurchaseOrder,
        *,
        actor: User,
        correlation_id: UUID,
    ) -> None:
        """Open an order whose spend an approved estimate already covers."""
        estimate = self._session.get(Estimate, order.estimate_id) if order.estimate_id else None
        standing_on = estimate.reference if estimate is not None else "an approved estimate"
        reason = (
            f"Committed against {standing_on}, which is approved for this supplier "
            "at this amount or more. No further approval was required."
        )

        order.opened_at = datetime.now(UTC)

        # Through pending approval rather than straight to approved, even though
        # nobody is being asked. Draft to approved is not a transition any record
        # in the platform may make, and widening that table for this one case
        # would remove the guard everywhere. Two entries also read correctly in
        # the history: submitted, then opened because nothing further was needed.
        self._move(
            order,
            target=WorkflowState.pending_approval,
            actor=actor,
            reason=None,
            correlation_id=correlation_id,
        )
        self._move(
            order,
            target=WorkflowState.approved,
            actor=actor,
            reason=reason,
            correlation_id=correlation_id,
        )
        logger.info(
            "purchase_order.opened_on_estimate",
            purchase_order_id=str(order.id),
            number=order.number,
            estimate=standing_on,
        )

    def withdraw(
        self,
        order: PurchaseOrder,
        *,
        actor: User,
        reason: str,
        correlation_id: UUID,
    ) -> PurchaseOrder:
        """Pull an order back from approvers so it can be corrected."""
        if order.state is not WorkflowState.pending_approval:
            raise NotEditableError(order.state)
        if not reason.strip():
            raise PurchaseOrderError("Give a reason for withdrawing this from approval.")

        self._close_open_route(
            order, actor=actor, reason=reason.strip(), correlation_id=correlation_id
        )
        self._move(
            order,
            target=WorkflowState.draft,
            actor=actor,
            reason=reason.strip(),
            correlation_id=correlation_id,
        )
        order.submitted_at = None
        order.submitted_by_id = None
        self._session.flush()
        return order

    def record_decision(
        self,
        order: PurchaseOrder,
        *,
        step_order: int,
        level: ApprovalLevel,
        outcome: ApprovalOutcome,
        actor: User,
        comment: str | None,
        correlation_id: UUID,
    ) -> PurchaseOrder:
        """Apply an approval decision and open or refuse the order if the route closed."""
        assert_can_act(
            roles=actor.roles,
            permission=Permission.approval_decide,
            already_exercised_on_record=self.actions_taken(order, user=actor),
        )

        request = self._approvals.open_request(record_type=RECORD_TYPE, record_id=order.id)
        if request is None:
            raise PurchaseOrderError(
                "This order has no approval route open, so there is nothing to decide."
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
        self._record_action(order, user=actor, permission=Permission.approval_decide)

        if state is RouteState.approved:
            order.opened_at = datetime.now(UTC)
            self._move(
                order,
                target=WorkflowState.approved,
                actor=actor,
                reason=comment,
                correlation_id=correlation_id,
            )
        elif state is RouteState.rejected:
            self._move(
                order,
                target=WorkflowState.rejected,
                actor=actor,
                # A rejection carries a comment, enforced by the approvals domain
                # before this point, so this is never the empty reason the
                # workflow machine refuses.
                reason=comment,
                correlation_id=correlation_id,
            )
        return order

    # ----------------------------------------------------------------- amending

    def amend(
        self,
        order: PurchaseOrder,
        *,
        total_minor_units: int,
        actor: User,
        reason: str,
        correlation_id: UUID,
    ) -> PurchaseOrder:
        """Change what a live order commits.

        An increase is a commitment nobody has agreed to, so the order goes back
        for approval and stops taking invoices until it comes out. A reduction
        needs no new authority — less money was already covered by the approval
        for more — but cannot go below what suppliers have already billed.
        """
        assert_can_act(roles=actor.roles, permission=Permission.purchase_order_manage)

        if not is_receiving(order.state, order.closed_at):
            raise PurchaseOrderError("Only a live order can be amended.")
        if not reason.strip():
            raise PurchaseOrderError("Give a reason for changing what this order commits.")

        was = self._amount(order)
        now_at = Money(total_minor_units, was.currency)
        if now_at == was:
            raise PurchaseOrderError("That is the amount the order already commits.")

        billed = self.billed_against(order)
        if billed is not None and now_at < billed:
            raise NotReadyError((PurchaseOrderProblem.below_what_is_billed,))

        order.total_minor_units = now_at.minor_units
        self._session.flush()

        self._audit.append(
            action=AuditAction.record_updated,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=order.id,
            correlation_id=correlation_id,
            detail={
                "number": order.number,
                "changed": {"total": {"from": was.format(), "to": now_at.format()}},
                "reason": reason.strip(),
            },
        )

        if now_at < was:
            return order

        self._approvals.open_route(
            record_type=RECORD_TYPE,
            record_id=order.id,
            amount=now_at,
            department=order.department,
            requester_id=order.raised_by_id,
            actor=_ActingUser(actor),
            correlation_id=correlation_id,
        )
        order.opened_at = None
        self._move(
            order,
            target=WorkflowState.pending_approval,
            actor=actor,
            reason=f"Increased from {was.format()} to {now_at.format()}: {reason.strip()}",
            correlation_id=correlation_id,
        )
        return order

    # ------------------------------------------------------------------ closing

    def close(
        self,
        order: PurchaseOrder,
        *,
        actor: User,
        reason: str,
        correlation_id: UUID,
    ) -> PurchaseOrder:
        """Stop an order taking further invoices.

        Not a state change. The order stays approved, because it was; what changes
        is that nobody expects any more against it. Recorded with who and why,
        since an order that ran out and an order somebody shut early look the same
        afterwards and are not the same thing.
        """
        assert_can_act(roles=actor.roles, permission=Permission.purchase_order_manage)

        if not is_receiving(order.state, order.closed_at):
            raise PurchaseOrderError("Only a live order can be closed.")
        if not reason.strip():
            raise PurchaseOrderError("Give a reason for closing this order.")

        billed = self.billed_against(order)

        order.closed_at = datetime.now(UTC)
        order.closed_by_id = actor.id
        order.closed_reason = reason.strip()
        self._session.flush()

        self._audit.append(
            action=AuditAction.state_changed,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=order.id,
            correlation_id=correlation_id,
            detail={
                "number": order.number,
                "from": "open",
                "to": "closed",
                "reason": order.closed_reason,
                "billed": billed.format() if billed is not None else None,
            },
        )
        return order

    def cancel(
        self,
        order: PurchaseOrder,
        *,
        actor: User,
        reason: str,
        correlation_id: UUID,
    ) -> PurchaseOrder:
        """Withdraw an order that should not have been raised.

        Refused once anything has been billed against it. Cancelling says the
        commitment should never have existed, and an invoice against it is
        evidence to the contrary; closing is the honest ending in that case.
        """
        assert_can_act(roles=actor.roles, permission=Permission.purchase_order_manage)

        if not reason.strip():
            raise PurchaseOrderError("Give a reason for cancelling this order.")

        billed = self.billed_against(order)
        if billed is not None and billed.minor_units > 0:
            raise PurchaseOrderError(
                f"{billed.format()} has already been invoiced against this order, so it "
                "cannot be cancelled. Close it instead, which stops further invoices "
                "without denying the ones already received."
            )

        self._close_open_route(
            order,
            actor=actor,
            reason=f"Order cancelled: {reason.strip()}",
            correlation_id=correlation_id,
        )
        self._move(
            order,
            target=WorkflowState.cancelled,
            actor=actor,
            reason=reason.strip(),
            correlation_id=correlation_id,
        )
        return order

    # -------------------------------------------------------------------- reads

    def billed_against(self, order: PurchaseOrder) -> Money | None:
        """Everything live invoices have billed to this order.

        `None` for an order that has not yet named a currency, which only a draft
        can be: there is no denomination to answer in, and nothing can have been
        billed against a commitment not yet made.
        """
        if not order.currency:
            return None
        return billed_to(self._session, order, currency=order.currency)

    def transitions(self, order: PurchaseOrder) -> list[StateTransitionRow]:
        """This order's state history, oldest first."""
        return list(
            self._session.execute(
                select(StateTransitionRow)
                .where(
                    StateTransitionRow.record_type == RECORD_TYPE,
                    StateTransitionRow.record_id == order.id,
                )
                .order_by(StateTransitionRow.occurred_at, StateTransitionRow.id)
            )
            .scalars()
            .all()
        )

    def actions_taken(self, order: PurchaseOrder, *, user: User) -> frozenset[Permission]:
        """What this user has already done to this order.

        Read by the API so a control barred by segregation of duties is absent
        rather than present and refused on press.
        """
        return frozenset(
            self._session.execute(
                select(RecordActionRow.permission).where(
                    RecordActionRow.record_type == RECORD_TYPE,
                    RecordActionRow.record_id == order.id,
                    RecordActionRow.user_id == user.id,
                )
            ).scalars()
        )

    # ---------------------------------------------------------------- internals

    def _details(self, order: PurchaseOrder) -> OrderDetails:
        return OrderDetails(
            vendor_id=order.vendor_id,
            description=order.description or "",
            total=self._amount_or_none(order),
            cost_centre_id=order.cost_centre_id,
            billed=self.billed_against(order),
            estimate=self._linked_estimate(order),
        )

    def _linked_estimate(self, order: PurchaseOrder) -> LinkedEstimate | None:
        if order.estimate_id is None:
            return None
        estimate = self._session.get(Estimate, order.estimate_id)
        if estimate is None:
            return None

        approved: Money | None = None
        if estimate.total_minor_units is not None and estimate.currency:
            try:
                approved = Money(estimate.total_minor_units, estimate.currency)
            except CurrencyError:
                approved = None

        return LinkedEstimate(
            state_is_approved=estimate.state is WorkflowState.approved,
            vendor_id=estimate.vendor_id,
            approved_total=approved,
        )

    def _close_open_route(
        self,
        order: PurchaseOrder,
        *,
        actor: User,
        reason: str,
        correlation_id: UUID,
    ) -> None:
        request = self._approvals.open_request(record_type=RECORD_TYPE, record_id=order.id)
        if request is not None:
            self._approvals.withdraw(
                request=request,
                actor=_ActingUser(actor),
                reason=reason,
                correlation_id=correlation_id,
            )

    def _assert_references_exist(self, draft: PurchaseOrderDraft) -> None:
        """Refuse a reference to something that is not there, by name.

        A foreign key would refuse it too, at commit, as an integrity error with
        nothing a user could act on.
        """
        if draft.vendor_id is not None:
            vendor = self._session.get(Vendor, draft.vendor_id)
            if vendor is None or vendor.archived_at is not None or not vendor.is_active:
                raise PurchaseOrderError("That vendor does not exist, or is no longer in use.")
        if draft.cost_centre_id is not None:
            centre = self._session.get(CostCentre, draft.cost_centre_id)
            if centre is None or centre.archived_at is not None or not centre.is_active:
                raise PurchaseOrderError("That cost centre does not exist, or is no longer in use.")
        if draft.gl_account_id is not None:
            account = self._session.get(GlAccount, draft.gl_account_id)
            if account is None or account.archived_at is not None or not account.is_active:
                raise PurchaseOrderError("That GL account does not exist, or is no longer in use.")
        if draft.estimate_id is not None and self._session.get(Estimate, draft.estimate_id) is None:
            raise PurchaseOrderError("That estimate does not exist.")

    @staticmethod
    def _draft_amount(draft: PurchaseOrderDraft) -> Money | None:
        if draft.total_minor_units is None:
            return None
        currency = (draft.currency or "").strip().upper()
        if not currency:
            raise PurchaseOrderError("Choose the currency this amount is in.")
        try:
            return Money(draft.total_minor_units, currency)
        except CurrencyError as error:
            raise PurchaseOrderError(str(error)) from error

    @staticmethod
    def _amount_or_none(order: PurchaseOrder) -> Money | None:
        if order.total_minor_units is None or not order.currency:
            return None
        try:
            return Money(order.total_minor_units, order.currency)
        except CurrencyError:
            return None

    def _amount(self, order: PurchaseOrder) -> Money:
        amount = self._amount_or_none(order)
        if amount is None:
            raise NotReadyError((PurchaseOrderProblem.amount_missing,))
        return amount

    def _record_action(self, order: PurchaseOrder, *, user: User, permission: Permission) -> None:
        already = self._session.execute(
            select(RecordActionRow).where(
                RecordActionRow.record_type == RECORD_TYPE,
                RecordActionRow.record_id == order.id,
                RecordActionRow.user_id == user.id,
                RecordActionRow.permission == permission,
            )
        ).scalar_one_or_none()
        if already is not None:
            return
        self._session.add(
            RecordActionRow(
                record_type=RECORD_TYPE,
                record_id=order.id,
                user_id=user.id,
                permission=permission,
            )
        )
        self._session.flush()

    def _move(
        self,
        order: PurchaseOrder,
        *,
        target: WorkflowState,
        actor: User,
        reason: str | None,
        correlation_id: UUID,
    ) -> None:
        """Validate a state change through the machine and persist it."""
        change = transition(
            record_id=order.id,
            current=order.state,
            target=target,
            source=TransitionSource.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            expected_version=order.version,
            actual_version=order.version,
            reason=reason,
            correlation_id=correlation_id,
        )
        order.state = target
        self._session.add(
            StateTransitionRow(
                record_type=RECORD_TYPE,
                record_id=order.id,
                from_state=change.from_state,
                to_state=change.to_state,
                source=change.source,
                actor_id=change.actor_id,
                actor_label=change.actor_label,
                reason=change.reason,
                correlation_id=change.correlation_id,
                occurred_at=change.occurred_at,
                context={"number": order.number},
            )
        )
        self._session.flush()

        self._audit.append(
            action=AuditAction.state_changed,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=order.id,
            correlation_id=correlation_id,
            detail={
                "number": order.number,
                "from": state_label(change.from_state),
                "to": state_label(change.to_state),
                "reason": change.reason,
                "total": (amount.format() if (amount := self._amount_or_none(order)) else None),
            },
        )

    def _next_number(self) -> str:
        value = self._session.execute(NUMBER_SEQUENCE.next_value()).scalar_one()
        return f"PO-{value:06d}"


def _recorded(value: object | None) -> str | None:
    """One edited value as the audit trail stores it.

    Text rather than the value's own type, for the same reason the estimate
    service does it: a date, an identifier and an amount share one column, and a
    reader wants to see what changed rather than reconstruct types. Empty against
    absent is the distinction that has to survive, so only `None` becomes null.
    """
    if value is None:
        return None
    return str(value)
