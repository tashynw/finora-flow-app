"""Recording an invoice, confirming the goods arrived, and sending it for approval.

The same one-function-does-the-whole-job discipline as `application.estimates`, for
the same reason: details and route must change together or approvers decide on
figures that have moved. Invoices add a step in front of approval, and that step is
the reason this module exists separately.

**Sign-off is not a formality.** Between an invoice arriving and an approver seeing
it, somebody has to say the goods or services actually turned up. Nothing in the
platform can determine that. Extraction can read what a supplier billed; the
approval matrix can confirm somebody senior enough agreed to the spend; neither
knows whether the boxes were delivered. Only the person who asked for them does. So
`request_sign_off` puts the invoice in front of that person, chases them on a clock,
and refuses to move to approval without them.

Three things happen together when sign-off is requested, and the ordering is
deliberate: a link is issued, a message is queued, and a reminder cycle is started,
all inside the transaction that moved the state. If the state change rolls back, so
does the request to act on it. If the mail server is down, the message waits in the
outbox and the invoice is still correctly in `pending_sign_off`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
from uuid import UUID

import structlog
from sqlalchemy import Sequence as SqlSequence
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from finora.application.approvals import ApprovalService
from finora.application.outbox import enqueue
from finora.application.purchase_orders import billed_to, commitment
from finora.application.reminders import ReminderService
from finora.application.signed_links import IssuedLink, SignedLinkService
from finora.domain.approvals import ApprovalOutcome, RouteState
from finora.domain.audit import ActorType, AuditAction
from finora.domain.extraction import DocumentKind, ExtractionStatus, FieldName
from finora.domain.invoices import (
    EDITABLE_STATES,
    PROBLEM_EXPLANATIONS,
    PROBLEM_FIELDS,
    InvoiceDetails,
    InvoiceProblem,
    LinkedEstimate,
    LinkedPurchaseOrder,
    PurchaseOrderPolicy,
    TolerancePolicy,
    problems,
)
from finora.domain.money import CurrencyError, Money
from finora.domain.notifications import MessageKind
from finora.domain.purchase_orders import is_receiving
from finora.domain.reminders import ReminderPurpose
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
    Invoice,
    PurchaseOrder,
    RecordActionRow,
    StateTransitionRow,
    User,
    Vendor,
)

logger = structlog.get_logger(__name__)

#: The record type invoices are known by in the shared approval, transition, audit
#: and reminder tables.
RECORD_TYPE = "invoice"

REFERENCE_SEQUENCE = SqlSequence("invoice_reference_seq")

#: States from which an invoice is still waiting on receipt confirmation. Used to
#: answer the reminder scheduler's "is this still worth chasing" question.
_AWAITING_SIGN_OFF = frozenset({WorkflowState.pending_sign_off})


class InvoiceError(Exception):
    """Base class for a refused invoice action."""


class NotEditableError(InvoiceError):
    def __init__(self, state: WorkflowState) -> None:
        self.state = state
        if state is WorkflowState.pending_sign_off:
            detail = (
                "This invoice is with the requester for receipt confirmation and "
                "cannot be edited. Recall it first if a detail is wrong."
            )
        elif state is WorkflowState.pending_approval:
            detail = (
                "This invoice is with approvers and cannot be edited. Withdraw it "
                "first if a detail is wrong; the approvals given so far will be "
                "recorded and it will need approving again."
            )
        else:
            detail = "This invoice can no longer be edited."
        super().__init__(detail)


class NotReadyError(InvoiceError):
    """Validation rules are unmet. Carries every problem, not the first."""

    def __init__(self, found: tuple[InvoiceProblem, ...]) -> None:
        self.problems = found
        super().__init__("This invoice is not ready to go forward.")

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


class DocumentNotUsableError(InvoiceError):
    """The document cannot become an invoice, and why."""


class WrongSignerError(InvoiceError):
    """Somebody other than the named requester tried to confirm receipt.

    A distinct error because the answer is not "you lack a permission" but "this
    is not yours to confirm", and the two send a user to different places.
    """

    def __init__(self) -> None:
        super().__init__(
            "Only the person this invoice is assigned to may confirm that the goods "
            "or services were received. If that assignment is wrong, finance can "
            "change it."
        )


@dataclass(slots=True)
class InvoiceDraft:
    """The complete editable state of a draft invoice.

    Everything at once rather than a set of changes, so `None` unambiguously means
    "this invoice has no such value", exactly as with `EstimateDraft`.
    """

    vendor_name: str
    description: str
    vendor_id: UUID | None = None
    invoice_number: str | None = None
    invoice_date: date | None = None
    due_date: date | None = None
    total_minor_units: int | None = None
    currency: str | None = None
    estimate_id: UUID | None = None
    purchase_order_id: UUID | None = None
    cost_centre_id: UUID | None = None
    gl_account_id: UUID | None = None
    requester_id: UUID | None = None


class InvoiceService:
    def __init__(
        self,
        *,
        session: Session,
        approvals: ApprovalService,
        audit: AuditRepository,
        links: SignedLinkService,
        reminders: ReminderService,
        purchase_orders: PurchaseOrderPolicy | None = None,
        tolerance: TolerancePolicy | None = None,
        mail_domain: str = "finora.invalid",
    ) -> None:
        self._session = session
        self._approvals = approvals
        self._audit = audit
        self._links = links
        self._reminders = reminders
        self._purchase_orders = purchase_orders or PurchaseOrderPolicy()
        self._tolerance = tolerance or TolerancePolicy()
        self._mail_domain = mail_domain

    # ------------------------------------------------------------------ recording

    def create_from_document(
        self,
        document: Document,
        *,
        creator: User,
        correlation_id: UUID,
    ) -> Invoice:
        """Record an invoice from an accepted reading.

        Only from an accepted one, and only from one accepted *as an invoice*. A
        reading still in review has values nobody has confirmed, and this is the
        record a payment is eventually made against.
        """
        extraction = next((item for item in document.extractions if item.is_current), None)
        if extraction is None or extraction.status is not ExtractionStatus.accepted:
            raise DocumentNotUsableError(
                "The values read from this document have not been accepted yet. "
                "Check them in the review workspace and accept them first."
            )
        if extraction.kind is not DocumentKind.invoice:
            raise DocumentNotUsableError(
                f"This document was accepted as a {extraction.kind.value.replace('_', ' ')}, "
                "not an invoice. Change its type in the review workspace if that is wrong."
            )

        existing = self._session.execute(
            select(Invoice).where(Invoice.document_id == document.id)
        ).scalar_one_or_none()
        if existing is not None:
            raise DocumentNotUsableError(
                f"This document has already been recorded as invoice {existing.reference}."
            )

        values = {row.name: row for row in extraction.fields}

        def text_of(name: FieldName) -> str:
            row = values.get(name)
            return row.text if row is not None else ""

        total_row = values.get(FieldName.total)
        date_row = values.get(FieldName.document_date)
        due_row = values.get(FieldName.due_date)
        vendor_name = text_of(FieldName.vendor_name)

        invoice = Invoice(
            reference=self._next_reference(),
            state=WorkflowState.draft,
            created_by_id=creator.id,
            document_id=document.id,
            vendor_id=self._match_vendor(vendor_name),
            vendor_name=vendor_name[:300],
            invoice_number=(text_of(FieldName.document_number)[:120] or None),
            invoice_date=date_row.value_date if date_row is not None else None,
            due_date=due_row.value_date if due_row is not None else None,
            total_minor_units=total_row.amount_minor_units if total_row is not None else None,
            currency=(total_row.currency if total_row is not None else None)
            or (text_of(FieldName.currency).upper()[:3] or None),
            # Left for a person, as with an estimate. A description assembled from
            # a filename is not a description of what was supplied, and the person
            # confirming receipt is the one who has to recognise it.
            description="",
        )
        self._session.add(invoice)
        self._session.flush()

        self._audit.append(
            action=AuditAction.record_created,
            actor_type=ActorType.user,
            actor_id=creator.id,
            actor_label=creator.display_name,
            subject_type=RECORD_TYPE,
            subject_id=invoice.id,
            correlation_id=correlation_id,
            detail={
                "reference": invoice.reference,
                "from_document": str(document.id),
                "document_sha256": document.sha256,
                "extraction_attempt": extraction.attempt,
                "vendor_name": invoice.vendor_name,
                "invoice_number": invoice.invoice_number,
                "total": self._format_total(invoice),
            },
        )
        logger.info(
            "invoice.created",
            invoice_id=str(invoice.id),
            reference=invoice.reference,
            from_document=str(document.id),
        )
        return invoice

    def create_blank(self, *, creator: User, correlation_id: UUID) -> Invoice:
        """Record an empty draft, for an invoice that did not arrive by mail."""
        invoice = Invoice(
            reference=self._next_reference(),
            state=WorkflowState.draft,
            created_by_id=creator.id,
        )
        self._session.add(invoice)
        self._session.flush()

        self._audit.append(
            action=AuditAction.record_created,
            actor_type=ActorType.user,
            actor_id=creator.id,
            actor_label=creator.display_name,
            subject_type=RECORD_TYPE,
            subject_id=invoice.id,
            correlation_id=correlation_id,
            detail={"reference": invoice.reference, "from_document": None},
        )
        return invoice

    # -------------------------------------------------------------------- editing

    def update(
        self,
        invoice: Invoice,
        draft: InvoiceDraft,
        *,
        actor: User,
        correlation_id: UUID,
    ) -> Invoice:
        """Replace a draft's details, recording what moved."""
        if invoice.state not in EDITABLE_STATES:
            raise NotEditableError(invoice.state)

        self._assert_references_exist(draft)
        amount = self._draft_amount(draft)

        applied: dict[str, dict[str, str | None]] = {}

        def apply(field: str, value: object | None) -> None:
            before = getattr(invoice, field)
            if before == value:
                return
            setattr(invoice, field, value)
            applied[field] = {"from": _recorded(before), "to": _recorded(value)}

        apply("vendor_id", draft.vendor_id)
        apply("vendor_name", draft.vendor_name.strip()[:300])
        apply("invoice_number", _trimmed(draft.invoice_number, 120))
        apply("invoice_date", draft.invoice_date)
        apply("due_date", draft.due_date)
        apply("description", draft.description.strip()[:500])
        apply("estimate_id", draft.estimate_id)
        apply("purchase_order_id", draft.purchase_order_id)
        apply("cost_centre_id", draft.cost_centre_id)
        apply("gl_account_id", draft.gl_account_id)
        apply("requester_id", draft.requester_id)
        apply("total_minor_units", amount.minor_units if amount else None)
        apply("currency", amount.currency if amount else _trimmed(draft.currency, 3))

        if not applied:
            return invoice

        self._session.flush()
        self._audit.append(
            action=AuditAction.record_updated,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=invoice.id,
            correlation_id=correlation_id,
            detail={"reference": invoice.reference, "changed": applied},
        )
        return invoice

    def outstanding(
        self, invoice: Invoice, *, today: date | None = None
    ) -> tuple[InvoiceProblem, ...]:
        """Everything stopping this invoice from going forward."""
        return problems(
            self._details(invoice),
            today=today or datetime.now(UTC).date(),
            purchase_orders=self._purchase_orders,
            tolerance=self._tolerance,
        )

    def suggest_requester(self, invoice: Invoice) -> UUID | None:
        """Who should confirm receipt, when the linked estimate says.

        A suggestion rather than an assignment. The estimate's requester asked for
        the goods and is the obvious person, but finance may know they have left or
        that somebody else took delivery, so the screen offers it and a person
        confirms.
        """
        if invoice.estimate_id is None:
            return None
        estimate = self._session.get(Estimate, invoice.estimate_id)
        return estimate.requester_id if estimate is not None else None

    # ------------------------------------------------------------------- sign-off

    def request_sign_off(
        self,
        invoice: Invoice,
        *,
        actor: User,
        correlation_id: UUID,
    ) -> IssuedLink:
        """Send a complete invoice to its requester to confirm receipt.

        Validation, then the state, then the link, the message and the chasing
        clock — all in this transaction. A rolled-back state change takes its
        request to act with it.
        """
        assert_can_act(roles=actor.roles, permission=Permission.invoice_submit)

        if invoice.state not in EDITABLE_STATES:
            raise NotEditableError(invoice.state)

        found = self.outstanding(invoice)
        if found:
            raise NotReadyError(found)

        requester = self._require_requester(invoice)
        now = datetime.now(UTC)

        invoice.submitted_at = now
        invoice.submitted_by_id = actor.id
        invoice.department = requester.department

        # Leaving draft brings this invoice inside the double-payment index, and
        # this is the one moment the check above can be beaten: two invoices for
        # the same vendor number, each recorded before the other existed, submitted
        # at once. The savepoint turns that race into the same refusal a person
        # would have seen a moment earlier rather than an unexplained failure.
        try:
            with self._session.begin_nested():
                self._session.flush()
                self._move(
                    invoice,
                    target=WorkflowState.pending_sign_off,
                    actor=actor,
                    reason=None,
                    correlation_id=correlation_id,
                )
        except IntegrityError as error:
            if _is_duplicate_violation(error):
                raise NotReadyError((InvoiceProblem.duplicate_invoice_number,)) from error
            raise
        self._record_action(invoice, user=actor, permission=Permission.invoice_submit)

        link = self._links.issue(
            record_type=RECORD_TYPE,
            record_id=invoice.id,
            purpose=ReminderPurpose.sign_off,
            issued_to=requester,
            correlation_id=correlation_id,
        )
        self._queue_sign_off_message(
            invoice,
            requester=requester,
            link=link,
            kind=MessageKind.sign_off_request,
            correlation_id=correlation_id,
        )
        self._reminders.start(
            record_type=RECORD_TYPE,
            record_id=invoice.id,
            purpose=ReminderPurpose.sign_off,
            recipient=requester,
            correlation_id=correlation_id,
            since=now,
        )

        self._audit.append(
            action=AuditAction.sign_off_requested,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=invoice.id,
            correlation_id=correlation_id,
            detail={
                "reference": invoice.reference,
                "requester": str(requester.id),
                "link_expires_at": link.expires_at.isoformat(),
            },
        )
        logger.info(
            "invoice.sign_off_requested",
            invoice_id=str(invoice.id),
            reference=invoice.reference,
            requester_id=str(requester.id),
        )
        return link

    def sign_off(
        self,
        invoice: Invoice,
        *,
        actor: User,
        note: str | None,
        correlation_id: UUID,
    ) -> Invoice:
        """Record that the goods or services were received, and open the route.

        The chasing stops here, in the same transaction, rather than when the
        scheduler next notices. Between the two there is a window, and a reminder
        sent inside it chases somebody about work they have just done.
        """
        assert_can_act(
            roles=actor.roles,
            permission=Permission.invoice_sign_off,
            already_exercised_on_record=self._actions_taken(invoice, user=actor),
        )

        if invoice.state is not WorkflowState.pending_sign_off:
            raise NotEditableError(invoice.state)
        if invoice.requester_id != actor.id:
            raise WrongSignerError()

        # Re-checked at the moment of sign-off, not merely when it was requested.
        # A duplicate may have been recorded, or the linked estimate cancelled,
        # while this invoice sat in somebody's inbox.
        found = self.outstanding(invoice)
        if found:
            raise NotReadyError(found)

        now = datetime.now(UTC)
        invoice.signed_off_at = now
        invoice.signed_off_by_id = actor.id
        invoice.sign_off_note = (note or "").strip() or None
        self._session.flush()

        amount = self._amount(invoice)
        self._approvals.open_route(
            record_type=RECORD_TYPE,
            record_id=invoice.id,
            amount=amount,
            department=invoice.department,
            requester_id=actor.id,
            actor=_ActingUser(actor),
            correlation_id=correlation_id,
        )

        self._move(
            invoice,
            target=WorkflowState.pending_approval,
            actor=actor,
            reason=None,
            correlation_id=correlation_id,
        )
        self._record_action(invoice, user=actor, permission=Permission.invoice_sign_off)
        self._close_sign_off_chase(invoice, reason="Receipt was confirmed.")

        self._audit.append(
            action=AuditAction.signed_off,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=invoice.id,
            correlation_id=correlation_id,
            detail={
                "reference": invoice.reference,
                "note": invoice.sign_off_note,
                "total": amount.format(),
            },
        )
        logger.info("invoice.signed_off", invoice_id=str(invoice.id), reference=invoice.reference)
        return invoice

    def decline_sign_off(
        self,
        invoice: Invoice,
        *,
        actor: User,
        reason: str,
        correlation_id: UUID,
    ) -> Invoice:
        """Record that what was billed did not arrive, or not as billed.

        Moves the invoice to `exception` rather than back to draft. A refusal is a
        finding about a supplier, not a formatting problem with the record, and
        `exception` is the state a person is expected to come and look at.
        """
        assert_can_act(
            roles=actor.roles,
            permission=Permission.invoice_sign_off,
            already_exercised_on_record=self._actions_taken(invoice, user=actor),
        )

        if invoice.state is not WorkflowState.pending_sign_off:
            raise NotEditableError(invoice.state)
        if invoice.requester_id != actor.id:
            raise WrongSignerError()
        if not reason.strip():
            raise InvoiceError(
                "Say what was wrong with the delivery. This is what finance acts on."
            )

        self._move(
            invoice,
            target=WorkflowState.exception,
            actor=actor,
            reason=reason,
            correlation_id=correlation_id,
        )
        self._record_action(invoice, user=actor, permission=Permission.invoice_sign_off)
        self._close_sign_off_chase(invoice, reason="Receipt was declined.")

        self._audit.append(
            action=AuditAction.sign_off_declined,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=invoice.id,
            correlation_id=correlation_id,
            detail={"reference": invoice.reference, "reason": reason.strip()},
        )
        logger.info(
            "invoice.sign_off_declined",
            invoice_id=str(invoice.id),
            reference=invoice.reference,
        )
        return invoice

    def recall(
        self,
        invoice: Invoice,
        *,
        actor: User,
        reason: str,
        correlation_id: UUID,
    ) -> Invoice:
        """Take an invoice back from sign-off, to correct it.

        Finance's counterpart to a requester declining. The chasing stops and the
        link is revoked, so the requester who was mid-way through opening it does
        not confirm receipt of a figure that is about to change.
        """
        assert_can_act(roles=actor.roles, permission=Permission.invoice_edit)

        if invoice.state is not WorkflowState.pending_sign_off:
            raise NotEditableError(invoice.state)
        if not reason.strip():
            raise InvoiceError("Say why this is being recalled.")

        self._move(
            invoice,
            target=WorkflowState.draft,
            actor=actor,
            reason=reason,
            correlation_id=correlation_id,
        )
        invoice.submitted_at = None
        invoice.submitted_by_id = None
        self._session.flush()
        self._close_sign_off_chase(invoice, reason="The invoice was recalled for correction.")
        return invoice

    # ------------------------------------------------------------------- approval

    def record_decision(
        self,
        invoice: Invoice,
        *,
        step_order: int,
        level: ApprovalLevel,
        outcome: ApprovalOutcome,
        actor: User,
        comment: str | None,
        correlation_id: UUID,
    ) -> Invoice:
        """Apply an approval decision and move the invoice if the route closed.

        Only the route's own conclusion moves the invoice. A single approval on a
        multi-step route changes nothing here, which is what keeps a record from
        looking approved because the first of four people agreed.

        The segregation-of-duties check runs against what this user has already
        done to this specific invoice, so whoever confirmed receipt or submitted it
        is refused here even if they hold every approver role in the organisation.
        """
        assert_can_act(
            roles=actor.roles,
            permission=Permission.approval_decide,
            already_exercised_on_record=self._actions_taken(invoice, user=actor),
        )

        request = self._approvals.open_request(record_type=RECORD_TYPE, record_id=invoice.id)
        if request is None:
            raise InvoiceError(
                "This invoice has no approval route open, so there is nothing to decide."
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
        self._record_action(invoice, user=actor, permission=Permission.approval_decide)

        if state is RouteState.approved:
            invoice.decided_at = datetime.now(UTC)
            self._move(
                invoice,
                target=WorkflowState.approved,
                actor=actor,
                reason=comment,
                correlation_id=correlation_id,
            )
        elif state is RouteState.rejected:
            invoice.decided_at = datetime.now(UTC)
            self._move(
                invoice,
                target=WorkflowState.rejected,
                actor=actor,
                # Rejection requires a comment, checked by the approvals domain
                # before this point, so this is never the empty reason the
                # workflow machine would refuse.
                reason=comment,
                correlation_id=correlation_id,
            )
        return invoice

    def cancel(
        self,
        invoice: Invoice,
        *,
        actor: User,
        reason: str,
        correlation_id: UUID,
    ) -> Invoice:
        """Abandon an invoice, closing any open route and stopping any chasing."""
        assert_can_act(roles=actor.roles, permission=Permission.invoice_edit)
        if not reason.strip():
            raise InvoiceError("Say why this invoice is being cancelled.")

        request = self._approvals.open_request(record_type=RECORD_TYPE, record_id=invoice.id)
        if request is not None:
            self._approvals.withdraw(
                request=request,
                actor=_ActingUser(actor),
                reason=f"Invoice cancelled: {reason.strip()}",
                correlation_id=correlation_id,
            )

        self._move(
            invoice,
            target=WorkflowState.cancelled,
            actor=actor,
            reason=reason.strip(),
            correlation_id=correlation_id,
        )
        self._close_sign_off_chase(invoice, reason="The invoice was cancelled.")
        return invoice

    # -------------------------------------------------------------------- reading

    def transitions(self, invoice: Invoice) -> list[StateTransitionRow]:
        """This invoice's state history, oldest first."""
        return list(
            self._session.execute(
                select(StateTransitionRow)
                .where(
                    StateTransitionRow.record_type == RECORD_TYPE,
                    StateTransitionRow.record_id == invoice.id,
                )
                .order_by(StateTransitionRow.occurred_at, StateTransitionRow.id)
            )
            .scalars()
            .all()
        )

    def is_still_awaiting_sign_off(self, invoice: Invoice) -> bool:
        """Whether chasing this invoice still serves a purpose."""
        return invoice.state in _AWAITING_SIGN_OFF

    def billed_against(self, order: PurchaseOrder, *, currency: str, excluding: UUID) -> Money:
        """What other live invoices have already billed to a purchase order.

        Exposed because a reviewer deciding whether to link an invoice to an order
        needs to see the order's remaining capacity, not only whether this invoice
        happens to fit.
        """
        return billed_to(self._session, order, currency=currency, excluding=excluding)

    def actions_taken(self, invoice: Invoice, *, user: User) -> frozenset[Permission]:
        """What this user has already done to this invoice.

        Read by the API so a button barred by segregation of duties is absent
        rather than present and refused on press.
        """
        return self._actions_taken(invoice, user=user)

    # ------------------------------------------------------------------- internals

    def _details(self, invoice: Invoice) -> InvoiceDetails:
        """Assemble everything the rules judge, including the linked records."""
        return InvoiceDetails(
            vendor_name=invoice.vendor_name or "",
            description=invoice.description or "",
            invoice_number=invoice.invoice_number,
            invoice_date=invoice.invoice_date,
            total=self._amount_or_none(invoice),
            cost_centre_id=invoice.cost_centre_id,
            requester_id=invoice.requester_id,
            vendor_id=invoice.vendor_id,
            due_date=invoice.due_date,
            estimate=self._linked_estimate(invoice),
            purchase_order=self._linked_order(invoice),
            is_duplicate=self._has_live_duplicate(invoice),
        )

    def _linked_estimate(self, invoice: Invoice) -> LinkedEstimate | None:
        if invoice.estimate_id is None:
            return None
        estimate = self._session.get(Estimate, invoice.estimate_id)
        if estimate is None:
            return None

        approved: Money | None = None
        if estimate.total_minor_units is not None and estimate.currency:
            try:
                approved = Money(estimate.total_minor_units, estimate.currency)
            except CurrencyError:
                approved = None

        return LinkedEstimate(
            estimate_id=estimate.id,
            state=estimate.state,
            vendor_id=estimate.vendor_id,
            vendor_name=estimate.vendor_name or "",
            approved_total=approved,
        )

    def _linked_order(self, invoice: Invoice) -> LinkedPurchaseOrder | None:
        if invoice.purchase_order_id is None:
            return None
        order = self._session.get(PurchaseOrder, invoice.purchase_order_id)
        if order is None:
            return None

        committed = commitment(order)
        if committed is None:
            # No supplier or no figure, which only a draft can be, and a draft is
            # never offered for linking. Treated as no order rather than as one
            # with nothing to measure against, which would report an overrun on a
            # comparison with nothing.
            return None

        return LinkedPurchaseOrder(
            purchase_order_id=order.id,
            is_open=is_receiving(order.state, order.closed_at) and order.archived_at is None,
            vendor_id=committed.vendor_id,
            total=committed.total,
            billed_by_others=billed_to(
                self._session,
                order,
                currency=committed.total.currency,
                excluding=invoice.id,
            ),
        )

    def _has_live_duplicate(self, invoice: Invoice) -> bool:
        """Whether another live invoice already carries this vendor and number.

        Matched on the vendor identifier rather than the name, because two spellings
        of one supplier must not be a way past the control, and a name with no
        identifier behind it is refused separately by `vendor_not_on_master`.
        """
        if invoice.vendor_id is None or not (invoice.invoice_number or "").strip():
            return False
        found = self._session.execute(
            select(Invoice.id).where(
                Invoice.vendor_id == invoice.vendor_id,
                func.lower(Invoice.invoice_number) == (invoice.invoice_number or "").casefold(),
                Invoice.id != invoice.id,
                Invoice.state.not_in([WorkflowState.cancelled, WorkflowState.rejected]),
                Invoice.archived_at.is_(None),
            )
        ).first()
        return found is not None

    def _require_requester(self, invoice: Invoice) -> User:
        if invoice.requester_id is None:
            raise InvoiceError(
                "Name the person who will confirm the goods or services were "
                "received. Without one this invoice has nobody to sign it off."
            )
        requester = self._session.get(User, invoice.requester_id)
        if requester is None or not requester.is_active:
            raise InvoiceError(
                "The person assigned to confirm receipt no longer has an active "
                "account. Assign somebody else."
            )
        return requester

    def _queue_sign_off_message(
        self,
        invoice: Invoice,
        *,
        requester: User,
        link: IssuedLink,
        kind: MessageKind,
        correlation_id: UUID,
        cc_addresses: list[str] | None = None,
        reminder_number: int = 0,
    ) -> None:
        """Put a sign-off request or reminder into the outbox.

        The body carries the figures and a link, and no attachment. The document
        itself stays behind authentication: a supplier's invoice is commercially
        sensitive and email is the one channel nobody controls the copies of.
        """
        amount = self._format_total(invoice) or "an amount not yet recorded"
        chase = (
            ""
            if reminder_number == 0
            else f"\nThis is reminder {reminder_number}. The invoice is still waiting on you.\n"
        )
        subject = (
            f"{'Reminder: ' if reminder_number else ''}Confirm receipt — "
            f"{invoice.reference} — {invoice.vendor_name}"
        )
        body = (
            f"Hello {requester.display_name},\n"
            f"\n"
            f"{invoice.vendor_name} has invoiced for {amount} and it is recorded as "
            f"{invoice.reference}.\n"
            f"\n"
            f"  What was supplied: {invoice.description or 'not described'}\n"
            f"  Their invoice number: {invoice.invoice_number or 'not recorded'}\n"
            f"  Invoice date: {invoice.invoice_date or 'not recorded'}\n"
            f"{chase}"
            f"\n"
            f"Before this can go for approval, you need to confirm that the goods or "
            f"services actually arrived, and that this is what was billed. If they did "
            f"not, say so on the same screen and finance will take it up with the "
            f"supplier.\n"
            f"\n"
            f"  {link.url}\n"
            f"\n"
            f"You will be asked to sign in. The link expires on "
            f"{link.expires_at:%d %B %Y}.\n"
        )

        enqueue(
            self._session,
            kind=kind,
            idempotency_key=f"{RECORD_TYPE}:{invoice.id}:sign_off:{reminder_number}",
            record_type=RECORD_TYPE,
            record_id=invoice.id,
            to_address=requester.email,
            to_name=requester.display_name,
            subject=subject[:400],
            body_text=body,
            cc_addresses=cc_addresses,
            correlation_id=correlation_id,
            domain=self._mail_domain,
        )

    def queue_sign_off_reminder(
        self,
        invoice: Invoice,
        *,
        requester: User,
        cc_addresses: list[str],
        reminder_number: int,
        escalated: bool,
        correlation_id: UUID,
    ) -> IssuedLink:
        """Chase a sign-off, with a fresh link.

        A new link each time, which revokes the previous one. Otherwise every
        reminder would widen the window a live link exists in rather than moving
        it, and an eight-reminder cycle would leave eight working links in a
        mailbox.
        """
        link = self._links.issue(
            record_type=RECORD_TYPE,
            record_id=invoice.id,
            purpose=ReminderPurpose.sign_off,
            issued_to=requester,
            correlation_id=correlation_id,
        )
        self._queue_sign_off_message(
            invoice,
            requester=requester,
            link=link,
            kind=(MessageKind.sign_off_escalation if escalated else MessageKind.sign_off_reminder),
            correlation_id=correlation_id,
            cc_addresses=cc_addresses,
            reminder_number=reminder_number,
        )
        return link

    def _close_sign_off_chase(self, invoice: Invoice, *, reason: str) -> None:
        """Stop chasing and withdraw the links, together.

        Both, always. A stopped cycle with a live link leaves a route to a sign-off
        screen for a record that no longer wants one; a revoked link with a running
        cycle emails somebody a link that will not work.
        """
        self._reminders.stop(
            record_type=RECORD_TYPE,
            record_id=invoice.id,
            purpose=ReminderPurpose.sign_off,
            reason=reason,
        )
        self._links.revoke_for_record(
            record_type=RECORD_TYPE,
            record_id=invoice.id,
            purpose=ReminderPurpose.sign_off,
        )

    @staticmethod
    def _draft_amount(draft: InvoiceDraft) -> Money | None:
        if draft.total_minor_units is None:
            return None
        currency = (draft.currency or "").strip().upper()
        if not currency:
            raise InvoiceError("Choose the currency this amount is in.")
        try:
            return Money(draft.total_minor_units, currency)
        except CurrencyError as error:
            raise InvoiceError(str(error)) from error

    @staticmethod
    def _amount_or_none(invoice: Invoice) -> Money | None:
        if invoice.total_minor_units is None or not invoice.currency:
            return None
        try:
            return Money(invoice.total_minor_units, invoice.currency)
        except CurrencyError:
            return None

    def _amount(self, invoice: Invoice) -> Money:
        amount = self._amount_or_none(invoice)
        if amount is None:
            raise NotReadyError((InvoiceProblem.amount_missing,))
        return amount

    def _format_total(self, invoice: Invoice) -> str | None:
        amount = self._amount_or_none(invoice)
        return amount.format() if amount else None

    def _move(
        self,
        invoice: Invoice,
        *,
        target: WorkflowState,
        actor: User,
        reason: str | None,
        correlation_id: UUID,
    ) -> None:
        change = transition(
            record_id=invoice.id,
            current=invoice.state,
            target=target,
            source=TransitionSource.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            expected_version=invoice.version,
            actual_version=invoice.version,
            reason=reason,
            correlation_id=correlation_id,
        )
        invoice.state = target
        self._session.add(
            StateTransitionRow(
                record_type=RECORD_TYPE,
                record_id=invoice.id,
                from_state=change.from_state,
                to_state=change.to_state,
                source=change.source,
                actor_id=change.actor_id,
                actor_label=change.actor_label,
                reason=change.reason,
                correlation_id=change.correlation_id,
                occurred_at=change.occurred_at,
                context={"reference": invoice.reference},
            )
        )
        self._session.flush()

        self._audit.append(
            action=AuditAction.state_changed,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=invoice.id,
            correlation_id=correlation_id,
            detail={
                "reference": invoice.reference,
                "from": str(change.from_state),
                "to": str(change.to_state),
                "reason": change.reason,
                "total": self._format_total(invoice),
            },
        )

    def _record_action(self, invoice: Invoice, *, user: User, permission: Permission) -> None:
        already = self._session.execute(
            select(RecordActionRow).where(
                RecordActionRow.record_type == RECORD_TYPE,
                RecordActionRow.record_id == invoice.id,
                RecordActionRow.user_id == user.id,
                RecordActionRow.permission == permission,
            )
        ).scalar_one_or_none()
        if already is not None:
            return
        self._session.add(
            RecordActionRow(
                record_type=RECORD_TYPE,
                record_id=invoice.id,
                user_id=user.id,
                permission=permission,
            )
        )
        self._session.flush()

    def _actions_taken(self, invoice: Invoice, *, user: User) -> frozenset[Permission]:
        return frozenset(
            self._session.execute(
                select(RecordActionRow.permission).where(
                    RecordActionRow.record_type == RECORD_TYPE,
                    RecordActionRow.record_id == invoice.id,
                    RecordActionRow.user_id == user.id,
                )
            )
            .scalars()
            .all()
        )

    def _assert_references_exist(self, draft: InvoiceDraft) -> None:
        """Refuse a reference to something that is not there, naming what it was."""
        if draft.vendor_id is not None:
            vendor = self._session.get(Vendor, draft.vendor_id)
            if vendor is None or vendor.archived_at is not None or not vendor.is_active:
                raise InvoiceError("That vendor does not exist, or is no longer in use.")
        if draft.cost_centre_id is not None:
            centre = self._session.get(CostCentre, draft.cost_centre_id)
            if centre is None or centre.archived_at is not None or not centre.is_active:
                raise InvoiceError("That cost centre does not exist, or is no longer in use.")
        if draft.gl_account_id is not None:
            account = self._session.get(GlAccount, draft.gl_account_id)
            if account is None or account.archived_at is not None or not account.is_active:
                raise InvoiceError("That GL account does not exist, or is no longer in use.")
        if draft.estimate_id is not None:
            estimate = self._session.get(Estimate, draft.estimate_id)
            if estimate is None or estimate.archived_at is not None:
                raise InvoiceError("That estimate does not exist.")
        if draft.purchase_order_id is not None:
            order = self._session.get(PurchaseOrder, draft.purchase_order_id)
            if order is None or order.archived_at is not None:
                raise InvoiceError("That purchase order does not exist.")
        if draft.requester_id is not None:
            requester = self._session.get(User, draft.requester_id)
            if requester is None or not requester.is_active:
                raise InvoiceError("That person does not have an active account.")

    def _match_vendor(self, name: str) -> UUID | None:
        """Link to the vendor master when the name is an exact match.

        Exact only, as with estimates. A fuzzy match would attach a payment record
        to the wrong company for the sake of saving a click.
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
        return f"INV-{value:06d}"


#: The index whose violation means "somebody else got there first".
_DUPLICATE_INDEX = "uq_invoices_live_vendor_number"


def _is_duplicate_violation(error: IntegrityError) -> bool:
    """Whether this integrity error is the double-payment control firing.

    Matched on the index name rather than on the exception type alone, so an
    unrelated constraint failure is re-raised as the defect it is instead of being
    reported to a person as a duplicate invoice.
    """
    return _DUPLICATE_INDEX in str(error.orig)


def _trimmed(value: str | None, limit: int) -> str | None:
    cleaned = (value or "").strip()[:limit]
    return cleaned or None


def _recorded(value: object | None) -> str | None:
    """One edited value as the audit trail stores it, as in `application.estimates`."""
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


def may_view(invoice: Invoice, *, user: User) -> bool:
    """Whether this user may see this invoice.

    The named requester sees theirs, whoever recorded it sees it, and anyone
    holding a role with a wider remit sees all of them. This is the record-level
    half of authorisation; the permission itself is checked separately.
    """
    if invoice.requester_id == user.id or invoice.created_by_id == user.id:
        return True
    return bool(
        user.roles
        & {Role.approver, Role.finance, Role.auditor, Role.administrator, Role.payment_coordinator}
    )
