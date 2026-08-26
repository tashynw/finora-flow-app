"""Invoice, receipt sign-off and signed-link endpoints.

The three principles the estimate endpoints follow hold here — a refusal explains
the whole remaining task, the server decides what the caller may do, and a route is
described in full including whose turn it is. Two more apply only to invoices.

*A control firing is not the same as a form being incomplete.* An invoice missing a
cost centre is somebody's ordinary work in progress. An invoice that duplicates one
already recorded, or exceeds the estimate that approved it, is a control that has
fired and a person needs to look at it. Both arrive as `problems`, and `blockers`
names the second kind separately so the register can sort by it and the detail
screen can lead with it.

*Nothing in a signed link authorises anything.* `POST /links/resolve` takes a token
from an email, tells the caller which record it points at, and stops. The caller is
already signed in — the endpoint requires it — and the sign-off they go on to
perform is authorised against that session exactly as it would be from the register.
The link saves them finding the record; it does not vouch for them.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from finora.api.deps import (
    ApprovalServiceDep,
    CorrelationDep,
    CurrentUserDep,
    InvoiceServicesDep,
    RequirePermission,
    SessionDep,
)
from finora.api.security import Principal
from finora.api.views import (
    NamedRefOut,
    PlannedStepOut,
    RouteOut,
    TransitionOut,
    awaiting_labels,
    awaiting_me,
    ref_out,
    route_out,
    transition_out,
)
from finora.application.approvals import ApprovalService
from finora.application.invoices import (
    RECORD_TYPE,
    DocumentNotUsableError,
    InvoiceDraft,
    InvoiceError,
    InvoiceService,
    NotEditableError,
    NotReadyError,
    WrongSignerError,
    may_view,
)
from finora.application.purchase_orders import commitment
from finora.application.signed_links import (
    REFUSAL_MESSAGE,
    LinkRefusal,
    ResolvedLink,
)
from finora.domain.approvals import (
    LEVEL_LABELS,
    ApprovalError,
    ApprovalOutcome,
    RouteNotAvailableError,
)
from finora.domain.invoices import (
    BLOCKING_PROBLEMS,
    EDITABLE_STATES,
    PROBLEM_EXPLANATIONS,
    PROBLEM_FIELDS,
    InvoiceProblem,
)
from finora.domain.money import CurrencyError, Money
from finora.domain.purchase_orders import is_receiving, state_label
from finora.domain.reminders import ReminderPurpose
from finora.domain.roles import ApprovalLevel, AuthorizationError, Permission, Role
from finora.domain.workflow import STATE_LABELS, TERMINAL_STATES, WorkflowState
from finora.infrastructure.db.models import (
    ApprovalRequest,
    Document,
    Estimate,
    Invoice,
    PurchaseOrder,
    ReminderSchedule,
    User,
)

router = APIRouter(prefix="/invoices", tags=["invoices"])


# ------------------------------------------------------------------- schemas


class InvoiceProblemOut(BaseModel):
    problem: InvoiceProblem
    field: str
    explanation: str
    #: Whether this is a control firing rather than a form left unfinished. Drives
    #: how prominently the screen shows it, and what it says about who should act.
    is_blocking: bool


class LinkedEstimateOut(BaseModel):
    """The approved spend this invoice draws on, as a screen needs to show it."""

    id: uuid.UUID
    reference: str
    state: WorkflowState
    state_label: str
    vendor_name: str
    approved_total_minor_units: int | None
    currency: str | None
    approved_total_formatted: str | None
    #: What is left of the approval after this invoice. Negative when the invoice
    #: exceeds it, which is the number a reviewer wants rather than the two they
    #: would otherwise subtract themselves.
    remaining_minor_units: int | None
    remaining_formatted: str | None


class LinkedPurchaseOrderOut(BaseModel):
    id: uuid.UUID
    number: str
    #: Whether the order is still taking invoices. Sent rather than inferred from
    #: the state, because "open" and "closed" are both the approved state and the
    #: browser must not have to know that.
    is_open: bool
    state_label: str
    vendor_name: str
    total_minor_units: int
    currency: str
    total_formatted: str
    #: Billed by other live invoices, so a reviewer can see this invoice's claim in
    #: the context of the order rather than on its own.
    billed_by_others_minor_units: int
    billed_by_others_formatted: str
    remaining_minor_units: int
    remaining_formatted: str


class SignOffOut(BaseModel):
    """Where receipt confirmation stands, for the panel that shows it."""

    #: Who has to confirm receipt. Sent as an id as well as a label because the
    #: editor has to put the current assignment back into its selector, and a
    #: display name cannot be matched to a person reliably enough to do that.
    requester_id: uuid.UUID | None
    requester_label: str | None
    requester_email: str | None
    requested_at: datetime | None
    signed_off_at: datetime | None
    signed_off_by_label: str | None
    note: str | None
    #: How many times the assigned person has been chased, and when next. Shown
    #: because "we have asked four times" is the fact that justifies escalating,
    #: and hiding it makes the escalation look arbitrary.
    reminders_sent: int
    next_reminder_at: datetime | None
    escalation_level: int
    #: Whether this caller is the one who must confirm receipt.
    is_mine_to_sign: bool


class InvoiceActionsOut(BaseModel):
    """What this caller may do to this invoice, decided by the server."""

    may_edit: bool
    may_request_sign_off: bool
    may_sign_off: bool
    may_decline: bool
    may_recall: bool
    may_cancel: bool
    may_decide: bool


class InvoiceSummary(BaseModel):
    id: uuid.UUID
    reference: str
    state: WorkflowState
    state_label: str

    vendor_name: str
    description: str
    invoice_number: str | None
    invoice_date: date | None
    due_date: date | None
    total_minor_units: int | None
    currency: str | None
    total_formatted: str | None

    requester_label: str | None
    department: str | None
    created_at: datetime
    submitted_at: datetime | None
    signed_off_at: datetime | None
    decided_at: datetime | None

    route_summary: str | None
    awaiting_labels: list[str]
    awaiting_me: bool
    #: Whether this row is waiting on this caller to confirm receipt. The register's
    #: other "is this mine" question, and the more urgent of the two.
    awaiting_my_sign_off: bool

    problem_count: int
    #: How many of those problems are controls that have fired. What the register
    #: sorts and filters by, because these are the rows nobody else will chase.
    blocker_count: int
    #: Days until payment is due, negative once overdue. Null when no due date is
    #: recorded. Computed here so every row on a page is measured from one instant.
    days_until_due: int | None
    #: Working hours the assigned person has been sitting on a sign-off request.
    #: Null unless the invoice is waiting on one.
    reminders_sent: int | None


class InvoiceDetail(InvoiceSummary):
    vendor_id: uuid.UUID | None
    cost_centre: NamedRefOut | None
    gl_account: NamedRefOut | None
    document_id: uuid.UUID | None
    created_by_label: str

    estimate: LinkedEstimateOut | None
    purchase_order: LinkedPurchaseOrderOut | None
    #: Who the linked estimate says asked for this, when nobody has been assigned
    #: yet. A suggestion for the form, never an assignment.
    suggested_requester_id: uuid.UUID | None

    problems: list[InvoiceProblemOut]
    sign_off: SignOffOut
    route: RouteOut | None
    route_history: list[RouteOut]
    transitions: list[TransitionOut]
    planned_route: list[PlannedStepOut] | None
    planned_route_problem: str | None
    actions: InvoiceActionsOut


class InvoicePage(BaseModel):
    items: list[InvoiceSummary]
    total: int
    limit: int
    offset: int


class InvoiceCreateRequest(BaseModel):
    #: An accepted invoice reading to record this from. Omitted for an invoice that
    #: did not arrive by mail.
    document_id: uuid.UUID | None = None


class InvoiceDraftRequest(BaseModel):
    """The complete editable state of a draft invoice, as with an estimate."""

    vendor_name: str = Field(max_length=300)
    description: str = Field(max_length=500)
    vendor_id: uuid.UUID | None = None
    invoice_number: str | None = Field(default=None, max_length=120)
    invoice_date: date | None = None
    due_date: date | None = None
    total_minor_units: int | None = Field(default=None, ge=1)
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    estimate_id: uuid.UUID | None = None
    purchase_order_id: uuid.UUID | None = None
    cost_centre_id: uuid.UUID | None = None
    gl_account_id: uuid.UUID | None = None
    #: Who will confirm the goods or services arrived.
    requester_id: uuid.UUID | None = None


class InvoiceReasonRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=1000)


class SignOffRequest(BaseModel):
    #: Optional. Confirming receipt needs no explanation; declining does, and that
    #: is a different endpoint with a mandatory reason.
    note: str | None = Field(default=None, max_length=2000)


class InvoiceDecisionRequest(BaseModel):
    step_order: int = Field(ge=1)
    level: ApprovalLevel
    outcome: ApprovalOutcome
    comment: str | None = Field(default=None, max_length=2000)


# ------------------------------------------------------------------- mapping


def _money(minor_units: int | None, currency: str | None) -> Money | None:
    if minor_units is None or not currency:
        return None
    try:
        return Money(minor_units, currency)
    except CurrencyError:
        return None


def _problem_out(problem: InvoiceProblem) -> InvoiceProblemOut:
    return InvoiceProblemOut(
        problem=problem,
        field=PROBLEM_FIELDS[problem],
        explanation=PROBLEM_EXPLANATIONS[problem],
        is_blocking=problem in BLOCKING_PROBLEMS,
    )


def _linked_estimate_out(
    session: Session, invoice: Invoice, *, total: Money | None
) -> LinkedEstimateOut | None:
    if invoice.estimate_id is None:
        return None
    estimate = session.get(Estimate, invoice.estimate_id)
    if estimate is None:
        return None

    approved = _money(estimate.total_minor_units, estimate.currency)
    remaining: Money | None = None
    if approved is not None and total is not None and approved.currency == total.currency:
        remaining = Money(approved.minor_units - total.minor_units, approved.currency)

    return LinkedEstimateOut(
        id=estimate.id,
        reference=estimate.reference,
        state=estimate.state,
        state_label=STATE_LABELS[estimate.state],
        vendor_name=estimate.vendor_name,
        approved_total_minor_units=estimate.total_minor_units,
        currency=estimate.currency,
        approved_total_formatted=approved.format() if approved else None,
        remaining_minor_units=remaining.minor_units if remaining else None,
        remaining_formatted=remaining.format() if remaining else None,
    )


def _linked_order_out(
    session: Session, invoice: Invoice, *, invoices: InvoiceService
) -> LinkedPurchaseOrderOut | None:
    if invoice.purchase_order_id is None:
        return None
    order = session.get(PurchaseOrder, invoice.purchase_order_id)
    if order is None:
        return None

    committed = commitment(order)
    if committed is None:
        # An order with no supplier or no figure, which only a draft can be, and a
        # draft is never offered for linking. Reported as no linkage rather than
        # as a half-order the panel would have to render around.
        return None

    total = committed.total
    billed = invoices.billed_against(order, currency=total.currency, excluding=invoice.id)
    remaining = Money(total.minor_units - billed.minor_units, total.currency)

    return LinkedPurchaseOrderOut(
        id=order.id,
        number=order.number,
        is_open=is_receiving(order.state, order.closed_at),
        state_label=state_label(order.state, closed_at=order.closed_at),
        vendor_name=committed.vendor_name,
        total_minor_units=total.minor_units,
        currency=total.currency,
        total_formatted=total.format(),
        billed_by_others_minor_units=billed.minor_units,
        billed_by_others_formatted=billed.format(),
        remaining_minor_units=remaining.minor_units,
        remaining_formatted=remaining.format(),
    )


def _schedule(session: Session, invoice: Invoice) -> ReminderSchedule | None:
    """The live sign-off chase for this invoice, if one is running."""
    return session.execute(
        select(ReminderSchedule).where(
            ReminderSchedule.record_type == RECORD_TYPE,
            ReminderSchedule.record_id == invoice.id,
            ReminderSchedule.purpose == ReminderPurpose.sign_off,
            ReminderSchedule.stopped_at.is_(None),
        )
    ).scalar_one_or_none()


def _sign_off_out(
    invoice: Invoice,
    *,
    session: Session,
    user: User,
    schedule: ReminderSchedule | None,
) -> SignOffOut:
    requester = invoice.requester
    signer = session.get(User, invoice.signed_off_by_id) if invoice.signed_off_by_id else None
    return SignOffOut(
        requester_id=invoice.requester_id,
        requester_label=requester.display_name if requester else None,
        # Shown so finance can see the request went somewhere plausible before
        # they start chasing a silence that was an address problem all along.
        requester_email=requester.email if requester else None,
        requested_at=invoice.submitted_at,
        signed_off_at=invoice.signed_off_at,
        signed_off_by_label=signer.display_name if signer else None,
        note=invoice.sign_off_note,
        reminders_sent=schedule.sent_count if schedule else 0,
        next_reminder_at=schedule.next_due_at if schedule else None,
        escalation_level=schedule.escalation_level if schedule else 0,
        is_mine_to_sign=(
            invoice.state is WorkflowState.pending_sign_off and invoice.requester_id == user.id
        ),
    )


def _summary(
    invoice: Invoice,
    *,
    session: Session,
    approvals: ApprovalService,
    invoices: InvoiceService,
    user: User,
    open_request: ApprovalRequest | None,
    today: date,
) -> InvoiceSummary:
    amount = _money(invoice.total_minor_units, invoice.currency)
    # Evaluated on every row rather than only on drafts, unlike estimates. A
    # duplicate or an overrun is worth showing on an invoice that has already gone
    # somewhere, because that is precisely the invoice nobody is looking at.
    found = invoices.outstanding(invoice, today=today)
    schedule = (
        _schedule(session, invoice) if invoice.state is WorkflowState.pending_sign_off else None
    )

    return InvoiceSummary(
        id=invoice.id,
        reference=invoice.reference,
        state=invoice.state,
        state_label=STATE_LABELS[invoice.state],
        vendor_name=invoice.vendor_name,
        description=invoice.description,
        invoice_number=invoice.invoice_number,
        invoice_date=invoice.invoice_date,
        due_date=invoice.due_date,
        total_minor_units=invoice.total_minor_units,
        currency=invoice.currency,
        total_formatted=amount.format() if amount else None,
        requester_label=invoice.requester.display_name if invoice.requester else None,
        department=invoice.department,
        created_at=invoice.created_at,
        submitted_at=invoice.submitted_at,
        signed_off_at=invoice.signed_off_at,
        decided_at=invoice.decided_at,
        route_summary=approvals.summary(open_request) if open_request else None,
        awaiting_labels=awaiting_labels(open_request, approvals),
        awaiting_me=awaiting_me(open_request, approvals=approvals, user=user),
        awaiting_my_sign_off=(
            invoice.state is WorkflowState.pending_sign_off and invoice.requester_id == user.id
        ),
        problem_count=len(found),
        blocker_count=sum(1 for problem in found if problem in BLOCKING_PROBLEMS),
        days_until_due=((invoice.due_date - today).days if invoice.due_date else None),
        reminders_sent=schedule.sent_count if schedule else None,
    )


def _actions(
    invoice: Invoice,
    *,
    principal: Principal,
    user: User,
    approvals: ApprovalService,
    invoices: InvoiceService,
    open_request: ApprovalRequest | None,
    today: date,
) -> InvoiceActionsOut:
    """What this caller may do, by the same rules the write endpoints apply."""
    editable = invoice.state in EDITABLE_STATES
    awaiting_sign_off = invoice.state is WorkflowState.pending_sign_off
    mine_to_sign = awaiting_sign_off and invoice.requester_id == user.id

    # Whoever recorded or submitted the invoice cannot also confirm its receipt.
    # The same rule the service enforces, restated so the button is absent rather
    # than present and refused.
    already = invoices.actions_taken(invoice, user=user)
    conflicted = bool(already & {Permission.invoice_submit, Permission.invoice_edit})

    may_edit = editable and principal.has(Permission.invoice_edit)
    return InvoiceActionsOut(
        may_edit=may_edit,
        may_request_sign_off=(
            may_edit
            and principal.has(Permission.invoice_submit)
            and invoice.requester_id is not None
            and not invoices.outstanding(invoice, today=today)
        ),
        may_sign_off=(
            mine_to_sign and principal.has(Permission.invoice_sign_off) and not conflicted
        ),
        may_decline=(
            mine_to_sign and principal.has(Permission.invoice_sign_off) and not conflicted
        ),
        may_recall=awaiting_sign_off and principal.has(Permission.invoice_edit),
        may_cancel=(
            invoice.state not in TERMINAL_STATES and principal.has(Permission.invoice_edit)
        ),
        may_decide=(
            awaiting_me(open_request, approvals=approvals, user=user)
            and principal.has(Permission.approval_decide)
        ),
    )


def _planned(
    invoice: Invoice, *, approvals: ApprovalService, user: User
) -> tuple[list[PlannedStepOut] | None, str | None]:
    """The route this invoice would take once receipt is confirmed."""
    amount = _money(invoice.total_minor_units, invoice.currency)
    if amount is None:
        return None, None
    try:
        preview = approvals.preview(
            record_type=RECORD_TYPE,
            amount=amount,
            department=invoice.department or user.department,
        )
    except RouteNotAvailableError as error:
        return None, str(error)
    return [
        PlannedStepOut(step_order=order, level=level, level_label=LEVEL_LABELS[level])
        for order, level in preview
    ], None


def _detail(
    invoice: Invoice,
    *,
    session: Session,
    principal: Principal,
    user: User,
    approvals: ApprovalService,
    invoices: InvoiceService,
) -> InvoiceDetail:
    today = datetime.now(UTC).date()
    open_request = approvals.open_request(record_type=RECORD_TYPE, record_id=invoice.id)
    routes = approvals.history(record_type=RECORD_TYPE, record_id=invoice.id)

    # A route only exists once receipt has been confirmed, so anything still at or
    # before sign-off is on none, and the planned route is what its requester and
    # finance need to see instead.
    before_approval = invoice.state in EDITABLE_STATES or (
        invoice.state is WorkflowState.pending_sign_off
    )
    current = None if before_approval else (routes[-1] if routes else None)
    planned, planned_problem = (
        _planned(invoice, approvals=approvals, user=user) if before_approval else (None, None)
    )
    amount = _money(invoice.total_minor_units, invoice.currency)

    return InvoiceDetail(
        **_summary(
            invoice,
            session=session,
            approvals=approvals,
            invoices=invoices,
            user=user,
            open_request=open_request,
            today=today,
        ).model_dump(),
        vendor_id=invoice.vendor_id,
        cost_centre=ref_out(invoice.cost_centre),
        gl_account=ref_out(invoice.gl_account),
        document_id=invoice.document_id,
        created_by_label=invoice.created_by.display_name,
        estimate=_linked_estimate_out(session, invoice, total=amount),
        purchase_order=_linked_order_out(session, invoice, invoices=invoices),
        suggested_requester_id=(
            invoices.suggest_requester(invoice) if invoice.requester_id is None else None
        ),
        problems=[_problem_out(problem) for problem in invoices.outstanding(invoice, today=today)],
        sign_off=_sign_off_out(
            invoice, session=session, user=user, schedule=_schedule(session, invoice)
        ),
        route=(
            route_out(current, approvals=approvals, session=session, user=user) if current else None
        ),
        route_history=[
            route_out(row, approvals=approvals, session=session, user=user)
            for row in routes
            if current is None or row.id != current.id
        ],
        transitions=[
            transition_out(
                from_state=row.from_state,
                to_state=row.to_state,
                actor_label=row.actor_label,
                reason=row.reason,
                occurred_at=row.occurred_at,
            )
            for row in invoices.transitions(invoice)
        ],
        planned_route=planned,
        planned_route_problem=planned_problem,
        actions=_actions(
            invoice,
            principal=principal,
            user=user,
            approvals=approvals,
            invoices=invoices,
            open_request=open_request,
            today=today,
        ),
    )


def _load(session: Session, invoice_id: uuid.UUID, *, user: User) -> Invoice:
    """The invoice, or a 404 whether it is absent or none of this caller's business."""
    row = session.get(Invoice, invoice_id)
    if row is None or row.archived_at is not None or not may_view(row, user=user):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="That invoice could not be found.",
        )
    return row


# --------------------------------------------------------------------- reads


@router.get("", response_model=InvoicePage)
def list_invoices(
    session: SessionDep,
    approvals: ApprovalServiceDep,
    services: InvoiceServicesDep,
    user: CurrentUserDep,
    _: Annotated[Principal, Depends(RequirePermission(Permission.invoice_view))],
    state: Annotated[list[WorkflowState] | None, Query()] = None,
    mine: Annotated[bool, Query(description="Only invoices assigned to this caller")] = False,
    awaiting_me: Annotated[bool, Query(description="Only invoices awaiting this caller")] = False,
    awaiting_my_sign_off: Annotated[
        bool, Query(description="Only invoices awaiting this caller's receipt confirmation")
    ] = False,
    overdue: Annotated[bool, Query(description="Only invoices past their payment due date")] = (
        False
    ),
    search: Annotated[str | None, Query(max_length=200)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> InvoicePage:
    """The invoice register, newest first."""
    invoices = services.invoices
    today = datetime.now(UTC).date()

    conditions: list[ColumnElement[bool]] = [Invoice.archived_at.is_(None)]
    if state:
        conditions.append(Invoice.state.in_(state))
    if mine or not _sees_everything(user):
        # An ordinary requester sees the invoices they must confirm and the ones
        # they recorded, and nothing else. A supplier's pricing is not general
        # reading inside the organisation.
        conditions.append(or_(Invoice.requester_id == user.id, Invoice.created_by_id == user.id))
    if awaiting_my_sign_off:
        conditions.append(Invoice.requester_id == user.id)
        conditions.append(Invoice.state == WorkflowState.pending_sign_off)
    if overdue:
        conditions.append(Invoice.due_date.is_not(None))
        conditions.append(Invoice.due_date < today)
        conditions.append(Invoice.state.not_in(TERMINAL_STATES))
    if search:
        pattern = f"%{search.strip().lower()}%"
        conditions.append(
            or_(
                func.lower(Invoice.reference).like(pattern),
                func.lower(Invoice.vendor_name).like(pattern),
                func.lower(Invoice.description).like(pattern),
                func.lower(func.coalesce(Invoice.invoice_number, "")).like(pattern),
            )
        )

    if awaiting_me:
        waiting = approvals.awaiting(user=user, record_type=RECORD_TYPE)
        ids = [request.record_id for request in waiting]
        if not ids:
            return InvoicePage(items=[], total=0, limit=limit, offset=offset)
        conditions.append(Invoice.id.in_(ids))

    total = session.execute(
        select(func.count()).select_from(Invoice).where(*conditions)
    ).scalar_one()
    rows = (
        session.execute(
            select(Invoice)
            .where(*conditions)
            .order_by(Invoice.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
        .scalars()
        .all()
    )

    return InvoicePage(
        items=[
            _summary(
                row,
                session=session,
                approvals=approvals,
                invoices=invoices,
                user=user,
                open_request=approvals.open_request(record_type=RECORD_TYPE, record_id=row.id),
                today=today,
            )
            for row in rows
        ],
        total=total,
        limit=limit,
        offset=offset,
    )


def _sees_everything(user: User) -> bool:
    """Whether this user's remit covers invoices they are not named on."""
    return bool(
        user.roles
        & {Role.approver, Role.finance, Role.auditor, Role.administrator, Role.payment_coordinator}
    )


@router.get("/{invoice_id}", response_model=InvoiceDetail)
def get_invoice(
    invoice_id: uuid.UUID,
    session: SessionDep,
    approvals: ApprovalServiceDep,
    services: InvoiceServicesDep,
    user: CurrentUserDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.invoice_view))],
) -> InvoiceDetail:
    """One invoice, its linkage, its sign-off position, and what this caller may do."""
    row = _load(session, invoice_id, user=user)
    return _detail(
        row,
        session=session,
        principal=principal,
        user=user,
        approvals=approvals,
        invoices=services.invoices,
    )


# -------------------------------------------------------------------- writes


@router.post("", response_model=InvoiceDetail, status_code=status.HTTP_201_CREATED)
def create_invoice(
    payload: InvoiceCreateRequest,
    session: SessionDep,
    approvals: ApprovalServiceDep,
    services: InvoiceServicesDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.invoice_create))],
) -> InvoiceDetail:
    """Record an invoice, from an accepted reading or from nothing."""
    invoices = services.invoices
    if payload.document_id is None:
        row = invoices.create_blank(creator=user, correlation_id=correlation_id)
    else:
        document = session.get(Document, payload.document_id)
        if document is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="That document could not be found.",
            )
        try:
            row = invoices.create_from_document(
                document, creator=user, correlation_id=correlation_id
            )
        except DocumentNotUsableError as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    session.commit()
    session.refresh(row)
    return _detail(
        row,
        session=session,
        principal=principal,
        user=user,
        approvals=approvals,
        invoices=invoices,
    )


@router.put("/{invoice_id}", response_model=InvoiceDetail)
def update_invoice(
    invoice_id: uuid.UUID,
    payload: InvoiceDraftRequest,
    session: SessionDep,
    approvals: ApprovalServiceDep,
    services: InvoiceServicesDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.invoice_edit))],
) -> InvoiceDetail:
    """Replace a draft invoice's details.

    Not restricted to whoever recorded it, unlike an estimate. An estimate is
    somebody's own request and rewriting it puts words in their mouth; an invoice is
    a document a supplier sent, and correcting how it was read is ordinary finance
    work whoever first recorded it.
    """
    row = _load(session, invoice_id, user=user)
    invoices = services.invoices

    try:
        invoices.update(
            row,
            InvoiceDraft(**payload.model_dump()),
            actor=user,
            correlation_id=correlation_id,
        )
    except NotEditableError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except InvoiceError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
        ) from error

    session.commit()
    session.refresh(row)
    return _detail(
        row,
        session=session,
        principal=principal,
        user=user,
        approvals=approvals,
        invoices=invoices,
    )


@router.post("/{invoice_id}/request-sign-off", response_model=InvoiceDetail)
def request_sign_off(
    invoice_id: uuid.UUID,
    session: SessionDep,
    approvals: ApprovalServiceDep,
    services: InvoiceServicesDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.invoice_submit))],
) -> InvoiceDetail:
    """Ask the named requester to confirm the goods or services arrived.

    The link that goes in the email is deliberately absent from this response.
    Returning it would put a single-use credential in a browser's network log and
    in whatever else observes API traffic, for no gain: the person who asked for
    the confirmation is not the person who needs the link.
    """
    row = _load(session, invoice_id, user=user)
    invoices = services.invoices

    try:
        invoices.request_sign_off(row, actor=user, correlation_id=correlation_id)
    except NotReadyError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"message": str(error), "problems": error.as_details},
        ) from error
    except NotEditableError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except InvoiceError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
        ) from error

    session.commit()
    session.refresh(row)
    return _detail(
        row,
        session=session,
        principal=principal,
        user=user,
        approvals=approvals,
        invoices=invoices,
    )


@router.post("/{invoice_id}/sign-off", response_model=InvoiceDetail)
def sign_off(
    invoice_id: uuid.UUID,
    payload: SignOffRequest,
    session: SessionDep,
    approvals: ApprovalServiceDep,
    services: InvoiceServicesDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.invoice_sign_off))],
) -> InvoiceDetail:
    """Confirm the goods or services were received, opening the approval route."""
    row = _load(session, invoice_id, user=user)
    invoices = services.invoices

    try:
        invoices.sign_off(row, actor=user, note=payload.note, correlation_id=correlation_id)
    except WrongSignerError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except NotReadyError as error:
        # A problem found now rather than when sign-off was requested: a duplicate
        # recorded in the meantime, or a linked estimate since cancelled.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"message": str(error), "problems": error.as_details},
        ) from error
    except NotEditableError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except RouteNotAvailableError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except AuthorizationError as error:
        # Covers segregation of duties: whoever recorded or submitted this invoice
        # cannot also be the one who says the goods arrived.
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except InvoiceError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
        ) from error

    session.commit()
    session.refresh(row)
    return _detail(
        row,
        session=session,
        principal=principal,
        user=user,
        approvals=approvals,
        invoices=invoices,
    )


@router.post("/{invoice_id}/decline", response_model=InvoiceDetail)
def decline_sign_off(
    invoice_id: uuid.UUID,
    payload: InvoiceReasonRequest,
    session: SessionDep,
    approvals: ApprovalServiceDep,
    services: InvoiceServicesDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.invoice_sign_off))],
) -> InvoiceDetail:
    """Report that what was billed did not arrive, or not as billed."""
    row = _load(session, invoice_id, user=user)
    invoices = services.invoices

    try:
        invoices.decline_sign_off(
            row, actor=user, reason=payload.reason, correlation_id=correlation_id
        )
    except WrongSignerError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except NotEditableError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except InvoiceError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
        ) from error

    session.commit()
    session.refresh(row)
    return _detail(
        row,
        session=session,
        principal=principal,
        user=user,
        approvals=approvals,
        invoices=invoices,
    )


@router.post("/{invoice_id}/recall", response_model=InvoiceDetail)
def recall_invoice(
    invoice_id: uuid.UUID,
    payload: InvoiceReasonRequest,
    session: SessionDep,
    approvals: ApprovalServiceDep,
    services: InvoiceServicesDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.invoice_edit))],
) -> InvoiceDetail:
    """Take an invoice back from sign-off so a detail can be corrected."""
    row = _load(session, invoice_id, user=user)
    invoices = services.invoices

    try:
        invoices.recall(row, actor=user, reason=payload.reason, correlation_id=correlation_id)
    except NotEditableError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except InvoiceError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
        ) from error

    session.commit()
    session.refresh(row)
    return _detail(
        row,
        session=session,
        principal=principal,
        user=user,
        approvals=approvals,
        invoices=invoices,
    )


@router.post("/{invoice_id}/cancel", response_model=InvoiceDetail)
def cancel_invoice(
    invoice_id: uuid.UUID,
    payload: InvoiceReasonRequest,
    session: SessionDep,
    approvals: ApprovalServiceDep,
    services: InvoiceServicesDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.invoice_edit))],
) -> InvoiceDetail:
    """Abandon an invoice, closing any route and stopping any chasing."""
    row = _load(session, invoice_id, user=user)
    invoices = services.invoices

    try:
        invoices.cancel(row, actor=user, reason=payload.reason, correlation_id=correlation_id)
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except InvoiceError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
        ) from error

    session.commit()
    session.refresh(row)
    return _detail(
        row,
        session=session,
        principal=principal,
        user=user,
        approvals=approvals,
        invoices=invoices,
    )


@router.post("/{invoice_id}/decision", response_model=InvoiceDetail)
def decide_invoice(
    invoice_id: uuid.UUID,
    payload: InvoiceDecisionRequest,
    session: SessionDep,
    approvals: ApprovalServiceDep,
    services: InvoiceServicesDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.approval_decide))],
) -> InvoiceDetail:
    """Record one approval decision, moving the invoice if the route closed."""
    row = _load(session, invoice_id, user=user)
    invoices = services.invoices

    try:
        invoices.record_decision(
            row,
            step_order=payload.step_order,
            level=payload.level,
            outcome=payload.outcome,
            actor=user,
            comment=payload.comment,
            correlation_id=correlation_id,
        )
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except ApprovalError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except InvoiceError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    session.commit()
    session.refresh(row)
    return _detail(
        row,
        session=session,
        principal=principal,
        user=user,
        approvals=approvals,
        invoices=invoices,
    )


# ------------------------------------------------------------- signed links


link_router = APIRouter(prefix="/links", tags=["links"])


class ResolveRequest(BaseModel):
    token: str = Field(min_length=1, max_length=200)


class ResolvedOut(BaseModel):
    """Where a link points, and nothing more.

    No permission, no state, no signal that the holder may act. The screen the
    caller lands on fetches the record through the ordinary authenticated endpoint,
    which is where authority is decided.
    """

    record_type: str
    record_id: uuid.UUID
    purpose: ReminderPurpose


@link_router.post("/resolve", response_model=ResolvedOut)
def resolve_link(
    payload: ResolveRequest,
    session: SessionDep,
    services: InvoiceServicesDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> ResolvedOut:
    """Exchange a link token for the record it names.

    Requires a session, and that is the whole design: the token identifies a
    destination, the session identifies the person. A holder who is not signed in
    is sent to sign in first and arrives here as themselves.

    Every refusal returns the same 404 and the same sentence, whether the token
    never existed, expired, was spent or belongs to somebody else. Distinguishing
    them would let a holder learn which tokens are real.
    """
    outcome = services.links.resolve(
        payload.token, presented_by=user, correlation_id=correlation_id
    )
    # Committed even when refused. The refusal is an audit entry, and a probe that
    # rolls itself back is a probe nobody can see afterwards.
    session.commit()

    if isinstance(outcome, LinkRefusal):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=REFUSAL_MESSAGE)

    return _resolved_out(outcome)


def _resolved_out(link: ResolvedLink) -> ResolvedOut:
    return ResolvedOut(
        record_type=link.record_type,
        record_id=link.record_id,
        purpose=link.purpose,
    )


# --------------------------------------------------- invoice reference data


class InvoiceReferenceData(BaseModel):
    """The selectors an invoice form needs beyond the shared reference data.

    Vendors, cost centres and accounts come from `/reference`, which the estimate
    form already uses. These three are specific to linking an invoice: approved
    estimates it may draw on, orders it may bill against, and the colleagues who
    could be asked to confirm receipt.
    """

    approved_estimates: list[LinkedEstimateOut]
    open_purchase_orders: list[LinkedPurchaseOrderOut]
    people: list[NamedRefOut]


@router.get("/reference/linkable", response_model=InvoiceReferenceData)
def linkable_reference_data(
    session: SessionDep,
    _: Annotated[Principal, Depends(RequirePermission(Permission.invoice_view))],
) -> InvoiceReferenceData:
    """Approved estimates, open orders and active people, for the linkage selectors."""
    estimates = (
        session.execute(
            select(Estimate)
            .where(
                Estimate.state == WorkflowState.approved,
                Estimate.archived_at.is_(None),
            )
            .order_by(Estimate.reference.desc())
            .limit(500)
        )
        .scalars()
        .all()
    )
    orders = (
        session.execute(
            select(PurchaseOrder)
            .where(
                PurchaseOrder.state == WorkflowState.approved,
                PurchaseOrder.closed_at.is_(None),
                PurchaseOrder.archived_at.is_(None),
            )
            .order_by(PurchaseOrder.number.desc())
            .limit(500)
        )
        .scalars()
        .all()
    )
    people = (
        session.execute(
            select(User)
            .where(User.is_active, User.archived_at.is_(None))
            .order_by(User.display_name)
        )
        .scalars()
        .all()
    )

    return InvoiceReferenceData(
        approved_estimates=[
            LinkedEstimateOut(
                id=row.id,
                reference=row.reference,
                state=row.state,
                state_label=STATE_LABELS[row.state],
                vendor_name=row.vendor_name,
                approved_total_minor_units=row.total_minor_units,
                currency=row.currency,
                approved_total_formatted=(
                    amount.format()
                    if (amount := _money(row.total_minor_units, row.currency))
                    else None
                ),
                remaining_minor_units=None,
                remaining_formatted=None,
            )
            for row in estimates
        ],
        open_purchase_orders=[
            LinkedPurchaseOrderOut(
                id=row.id,
                number=row.number,
                is_open=True,
                state_label=state_label(row.state, closed_at=row.closed_at),
                vendor_name=committed.vendor_name,
                total_minor_units=committed.total.minor_units,
                currency=committed.total.currency,
                total_formatted=committed.total.format(),
                billed_by_others_minor_units=0,
                billed_by_others_formatted=Money.zero(committed.total.currency).format(),
                remaining_minor_units=committed.total.minor_units,
                remaining_formatted=committed.total.format(),
            )
            for row in orders
            if (committed := commitment(row)) is not None
        ],
        people=[NamedRefOut(id=row.id, code=row.email, name=row.display_name) for row in people],
    )
