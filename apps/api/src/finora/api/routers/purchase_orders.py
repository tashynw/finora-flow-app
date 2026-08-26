"""Purchase order endpoints.

An order has two facts a screen needs that no other record does.

*Its state and its label are not the same thing.* Internally an order runs on the
shared workflow states, so its history and its approval route work exactly like an
estimate's. To the people using it there are only two words that matter: an order
is Open, meaning invoices may still be billed to it, or Closed, meaning they may
not. Both are returned. Filtering and sorting use the state; the label is what
gets rendered.

*What is left on it is the number people act on.* An order's total is what was
committed; its remaining balance is what a new invoice can still draw. Every
response that names a total names the remaining balance beside it, because an
order at its ceiling looks identical to one with room on it until you subtract.
"""

from __future__ import annotations

import uuid
from datetime import datetime
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
    PurchaseOrderServiceDep,
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
from finora.application.purchase_orders import (
    NotEditableError,
    NotReadyError,
    PurchaseOrderDraft,
    PurchaseOrderError,
    PurchaseOrderService,
    billed_to,
)
from finora.domain.approvals import (
    LEVEL_LABELS,
    ApprovalError,
    ApprovalOutcome,
    RouteNotAvailableError,
)
from finora.domain.money import CurrencyError, Money
from finora.domain.purchase_orders import (
    BLOCKING_PROBLEMS,
    EDITABLE_STATES,
    PROBLEM_EXPLANATIONS,
    PROBLEM_FIELDS,
    PurchaseOrderProblem,
    is_receiving,
    state_label,
)
from finora.domain.roles import (
    ApprovalLevel,
    AuthorizationError,
    Permission,
    SegregationOfDutiesError,
    permissions_for,
)
from finora.domain.workflow import TransitionError, WorkflowState
from finora.infrastructure.db.models import (
    CostCentre,
    Estimate,
    GlAccount,
    PurchaseOrder,
    User,
    Vendor,
)

router = APIRouter(prefix="/purchase-orders", tags=["purchase orders"])

_VIEW = Depends(RequirePermission(Permission.purchase_order_view))
_MANAGE = Depends(RequirePermission(Permission.purchase_order_manage))

RECORD_TYPE = "purchase_order"


# ------------------------------------------------------------------------- models


class PurchaseOrderProblemOut(BaseModel):
    problem: PurchaseOrderProblem
    field: str
    explanation: str
    #: Whether this is a control that has fired rather than a form half-filled.
    is_blocking: bool


class PurchaseOrderSummary(BaseModel):
    id: uuid.UUID
    number: str
    state: WorkflowState
    state_label: str
    is_open: bool
    vendor_name: str | None
    description: str
    total_minor_units: int | None
    currency: str | None
    total_formatted: str | None
    billed_formatted: str | None
    remaining_minor_units: int | None
    remaining_formatted: str | None
    department: str | None
    raised_by_label: str
    created_at: datetime
    #: Levels the route is currently waiting on, so a register can say who is
    #: holding an order up without a second request per row.
    awaiting: list[str]
    is_awaiting_me: bool
    blocker_count: int


class PurchaseOrderPage(BaseModel):
    rows: list[PurchaseOrderSummary]
    total: int
    page: int
    page_size: int


class PurchaseOrderDetail(BaseModel):
    id: uuid.UUID
    number: str
    state: WorkflowState
    state_label: str
    is_open: bool
    version: int

    vendor: NamedRefOut | None
    description: str
    total_minor_units: int | None
    currency: str | None
    total_formatted: str | None
    cost_centre: NamedRefOut | None
    gl_account: NamedRefOut | None
    department: str | None

    estimate_id: uuid.UUID | None
    estimate_reference: str | None

    billed_minor_units: int | None
    billed_formatted: str | None
    remaining_minor_units: int | None
    remaining_formatted: str | None

    raised_by_label: str
    submitted_at: datetime | None
    opened_at: datetime | None
    closed_at: datetime | None
    closed_by_label: str | None
    closed_reason: str | None

    problems: list[PurchaseOrderProblemOut]
    blockers: list[PurchaseOrderProblemOut]
    #: What this order would need, if it were submitted as it stands. Empty when
    #: an approved estimate already covers it, which is not the same as no route
    #: being available — `route_unavailable` says which.
    planned_route: list[PlannedStepOut]
    route_unavailable: str | None
    needs_approval: bool

    route: RouteOut | None
    transitions: list[TransitionOut]
    #: Server-decided controls. A button the caller may not press is absent
    #: rather than present and refused.
    can_edit: bool
    can_submit: bool
    can_withdraw: bool
    can_amend: bool
    can_close: bool
    can_cancel: bool
    can_decide: bool


class PurchaseOrderDraftRequest(BaseModel):
    vendor_id: uuid.UUID | None = None
    description: str = Field(default="", max_length=500)
    total_minor_units: int | None = Field(default=None, ge=0)
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    cost_centre_id: uuid.UUID | None = None
    gl_account_id: uuid.UUID | None = None
    estimate_id: uuid.UUID | None = None


class PurchaseOrderReasonRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


class PurchaseOrderAmendRequest(BaseModel):
    total_minor_units: int = Field(ge=1)
    reason: str = Field(min_length=1, max_length=500)


class PurchaseOrderDecisionRequest(BaseModel):
    step_order: int = Field(ge=1)
    level: ApprovalLevel
    outcome: ApprovalOutcome
    comment: str | None = Field(default=None, max_length=2000)


class PurchaseOrderReferenceData(BaseModel):
    vendors: list[NamedRefOut]
    cost_centres: list[NamedRefOut]
    gl_accounts: list[NamedRefOut]
    approved_estimates: list[NamedRefOut]


# -------------------------------------------------------------------- conversions


def _problem_out(problem: PurchaseOrderProblem) -> PurchaseOrderProblemOut:
    return PurchaseOrderProblemOut(
        problem=problem,
        field=PROBLEM_FIELDS[problem],
        explanation=PROBLEM_EXPLANATIONS[problem],
        is_blocking=problem in BLOCKING_PROBLEMS,
    )


def _money(minor_units: int | None, currency: str | None) -> Money | None:
    if minor_units is None or not currency:
        return None
    try:
        return Money(minor_units, currency)
    except CurrencyError:
        return None


def _remaining(
    session: Session, order: PurchaseOrder
) -> tuple[Money | None, Money | None, Money | None]:
    """The order's total, what has been billed to it, and what is left.

    All three or none: an order with no currency has no arithmetic to report, and
    returning a zero would read as an order with nothing billed rather than an
    order that cannot be billed against yet.
    """
    total = _money(order.total_minor_units, order.currency)
    if total is None:
        return None, None, None
    billed = billed_to(session, order, currency=total.currency)
    return total, billed, total - billed


def _order_row(
    order: PurchaseOrder,
    *,
    session: Session,
    orders: PurchaseOrderService,
    approvals: ApprovalServiceDep,
    user: User,
) -> PurchaseOrderSummary:
    total, billed, remaining = _remaining(session, order)
    request = approvals.open_request(record_type=RECORD_TYPE, record_id=order.id)

    return PurchaseOrderSummary(
        id=order.id,
        number=order.number,
        state=order.state,
        state_label=state_label(order.state, closed_at=order.closed_at),
        is_open=is_receiving(order.state, order.closed_at),
        vendor_name=order.vendor.name if order.vendor is not None else None,
        description=order.description or "",
        total_minor_units=total.minor_units if total else None,
        currency=total.currency if total else None,
        total_formatted=total.format() if total else None,
        billed_formatted=billed.format() if billed else None,
        remaining_minor_units=remaining.minor_units if remaining else None,
        remaining_formatted=remaining.format() if remaining else None,
        department=order.department,
        raised_by_label=order.raised_by.display_name if order.raised_by is not None else "",
        created_at=order.created_at,
        awaiting=awaiting_labels(request, approvals),
        is_awaiting_me=awaiting_me(request, approvals=approvals, user=user),
        blocker_count=len([p for p in orders.outstanding(order) if p in BLOCKING_PROBLEMS]),
    )


def _planned(
    order: PurchaseOrder, *, orders: PurchaseOrderService, approvals: ApprovalServiceDep
) -> tuple[list[PlannedStepOut], str | None, bool]:
    """The route this order would take, or why it could not have one.

    Three outcomes rather than two. No steps and no reason means an approved
    estimate already covers the spend, which is a route of length zero on
    purpose. No steps and a reason means nothing is configured for the amount,
    which stops submission. Conflating them would tell a requester their order
    needs no approval at the moment it cannot be submitted at all.
    """
    total = _money(order.total_minor_units, order.currency)
    if total is None:
        return [], None, True

    if not orders.needs_approval(order):
        return [], None, False

    try:
        steps = approvals.preview(
            record_type=RECORD_TYPE, amount=total, department=order.department
        )
    except RouteNotAvailableError as error:
        return [], str(error), True

    return (
        [
            PlannedStepOut(step_order=order_no, level=level, level_label=LEVEL_LABELS[level])
            for order_no, level in steps
        ],
        None,
        True,
    )


def _order_out(
    order: PurchaseOrder,
    *,
    session: Session,
    orders: PurchaseOrderService,
    approvals: ApprovalServiceDep,
    user: User,
) -> PurchaseOrderDetail:
    found = orders.outstanding(order)
    total, billed, remaining = _remaining(session, order)
    request = approvals.open_request(record_type=RECORD_TYPE, record_id=order.id)
    planned, unavailable, needs_approval = _planned(order, orders=orders, approvals=approvals)

    live = is_receiving(order.state, order.closed_at)
    editable = order.state in EDITABLE_STATES
    may_manage = Permission.purchase_order_manage in permissions_for(user.roles)
    already = orders.actions_taken(order, user=user)
    # An order nobody has billed against can be withdrawn from existence;
    # once it is live it can only be finished. `cancel` enforces this too and
    # explains why, but a button that will certainly be refused should not be
    # on the screen.
    nothing_billed = billed is None or billed.minor_units == 0
    estimate = session.get(Estimate, order.estimate_id) if order.estimate_id else None
    closed_by = session.get(User, order.closed_by_id) if order.closed_by_id else None

    return PurchaseOrderDetail(
        id=order.id,
        number=order.number,
        state=order.state,
        state_label=state_label(order.state, closed_at=order.closed_at),
        is_open=live,
        version=order.version,
        vendor=ref_out(order.vendor),
        description=order.description or "",
        total_minor_units=total.minor_units if total else None,
        currency=total.currency if total else None,
        total_formatted=total.format() if total else None,
        cost_centre=ref_out(order.cost_centre),
        gl_account=ref_out(order.gl_account),
        department=order.department,
        estimate_id=order.estimate_id,
        estimate_reference=estimate.reference if estimate is not None else None,
        billed_minor_units=billed.minor_units if billed else None,
        billed_formatted=billed.format() if billed else None,
        remaining_minor_units=remaining.minor_units if remaining else None,
        remaining_formatted=remaining.format() if remaining else None,
        raised_by_label=order.raised_by.display_name if order.raised_by is not None else "",
        submitted_at=order.submitted_at,
        opened_at=order.opened_at,
        closed_at=order.closed_at,
        closed_by_label=closed_by.display_name if closed_by is not None else None,
        closed_reason=order.closed_reason,
        problems=[_problem_out(problem) for problem in found],
        blockers=[_problem_out(problem) for problem in found if problem in BLOCKING_PROBLEMS],
        planned_route=planned,
        route_unavailable=unavailable,
        needs_approval=needs_approval,
        route=route_out(request, approvals=approvals, session=session, user=user)
        if request is not None
        else None,
        transitions=[
            transition_out(
                from_state=row.from_state,
                to_state=row.to_state,
                actor_label=row.actor_label,
                reason=row.reason,
                occurred_at=row.occurred_at,
            )
            for row in orders.transitions(order)
        ],
        can_edit=editable and may_manage,
        can_submit=editable and may_manage and not found,
        can_withdraw=order.state is WorkflowState.pending_approval and may_manage,
        can_amend=live and may_manage,
        can_close=live and may_manage,
        can_cancel=may_manage
        and nothing_billed
        and order.state not in {WorkflowState.cancelled, WorkflowState.rejected},
        can_decide=(
            request is not None
            and awaiting_me(request, approvals=approvals, user=user)
            and Permission.approval_decide not in already
        ),
    )


def _load(session: Session, order_id: uuid.UUID) -> PurchaseOrder:
    order = session.get(PurchaseOrder, order_id)
    if order is None or order.archived_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such purchase order.")
    return order


def _refused(error: PurchaseOrderError) -> HTTPException:
    if isinstance(error, NotReadyError):
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=error.as_detail()
        )
    if isinstance(error, NotEditableError):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error))
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error))


# ---------------------------------------------------------------------- endpoints


@router.get("/reference-data", response_model=PurchaseOrderReferenceData, dependencies=[_VIEW])
def reference_data(session: SessionDep) -> PurchaseOrderReferenceData:
    """Everything the order form needs to offer, resolved to names."""
    vendors = (
        session.execute(
            select(Vendor)
            .where(Vendor.is_active, Vendor.archived_at.is_(None))
            .order_by(Vendor.name)
        )
        .scalars()
        .all()
    )
    centres = (
        session.execute(
            select(CostCentre)
            .where(CostCentre.is_active, CostCentre.archived_at.is_(None))
            .order_by(CostCentre.code)
        )
        .scalars()
        .all()
    )
    accounts = (
        session.execute(
            select(GlAccount)
            .where(GlAccount.is_active, GlAccount.archived_at.is_(None))
            .order_by(GlAccount.code)
        )
        .scalars()
        .all()
    )
    estimates = (
        session.execute(
            select(Estimate)
            .where(Estimate.state == WorkflowState.approved, Estimate.archived_at.is_(None))
            .order_by(Estimate.reference)
        )
        .scalars()
        .all()
    )

    return PurchaseOrderReferenceData(
        vendors=[NamedRefOut(id=row.id, code=row.code, name=row.name) for row in vendors],
        cost_centres=[NamedRefOut(id=row.id, code=row.code, name=row.name) for row in centres],
        gl_accounts=[NamedRefOut(id=row.id, code=row.code, name=row.name) for row in accounts],
        approved_estimates=[
            NamedRefOut(
                id=row.id,
                code=row.reference,
                name=f"{row.reference} — {row.vendor_name or 'Supplier not named'}",
            )
            for row in estimates
        ],
    )


@router.get("", response_model=PurchaseOrderPage, dependencies=[_VIEW])
def list_orders(
    session: SessionDep,
    orders: PurchaseOrderServiceDep,
    approvals: ApprovalServiceDep,
    user: CurrentUserDep,
    state: Annotated[list[WorkflowState] | None, Query()] = None,
    open_only: Annotated[bool, Query()] = False,
    vendor_id: Annotated[uuid.UUID | None, Query()] = None,
    search: Annotated[str | None, Query(max_length=200)] = None,
    awaiting_me_only: Annotated[bool, Query()] = False,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 25,
) -> PurchaseOrderPage:
    """The order register.

    `open_only` is separate from `state` on purpose: "open" is not a state, it is
    an approved order that has not been closed, and a caller filtering for live
    commitments should not have to know that.
    """
    conditions: list[ColumnElement[bool]] = [PurchaseOrder.archived_at.is_(None)]
    if state:
        conditions.append(PurchaseOrder.state.in_(state))
    if open_only:
        conditions.append(PurchaseOrder.state == WorkflowState.approved)
        conditions.append(PurchaseOrder.closed_at.is_(None))
    if vendor_id is not None:
        conditions.append(PurchaseOrder.vendor_id == vendor_id)
    if search:
        pattern = f"%{search.strip()}%"
        conditions.append(
            or_(PurchaseOrder.number.ilike(pattern), PurchaseOrder.description.ilike(pattern))
        )

    total = session.execute(
        select(func.count()).select_from(PurchaseOrder).where(*conditions)
    ).scalar_one()

    rows = (
        session.execute(
            select(PurchaseOrder)
            .where(*conditions)
            .order_by(PurchaseOrder.created_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        .scalars()
        .all()
    )

    out = [
        _order_row(row, session=session, orders=orders, approvals=approvals, user=user)
        for row in rows
    ]
    if awaiting_me_only:
        # Filtered after loading rather than in SQL, because "waiting on me"
        # depends on delegation and on the requester never deciding their own
        # order, neither of which is a column.
        out = [row for row in out if row.is_awaiting_me]

    return PurchaseOrderPage(rows=out, total=total, page=page, page_size=page_size)


@router.post(
    "",
    response_model=PurchaseOrderDetail,
    status_code=status.HTTP_201_CREATED,
    dependencies=[_MANAGE],
)
def create_order(
    session: SessionDep,
    orders: PurchaseOrderServiceDep,
    approvals: ApprovalServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> PurchaseOrderDetail:
    """Start a blank order and give it its number.

    The number is issued now rather than at submission so that whoever is raising
    it can quote it to the supplier while the details are still being agreed.
    """
    order = orders.create_blank(raiser=user, correlation_id=correlation_id)
    session.commit()
    session.refresh(order)
    return _order_out(order, session=session, orders=orders, approvals=approvals, user=user)


@router.get("/{order_id}", response_model=PurchaseOrderDetail, dependencies=[_VIEW])
def read_order(
    order_id: uuid.UUID,
    session: SessionDep,
    orders: PurchaseOrderServiceDep,
    approvals: ApprovalServiceDep,
    user: CurrentUserDep,
) -> PurchaseOrderDetail:
    order = _load(session, order_id)
    return _order_out(order, session=session, orders=orders, approvals=approvals, user=user)


@router.put("/{order_id}", response_model=PurchaseOrderDetail, dependencies=[_MANAGE])
def update_order(
    order_id: uuid.UUID,
    body: PurchaseOrderDraftRequest,
    session: SessionDep,
    orders: PurchaseOrderServiceDep,
    approvals: ApprovalServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> PurchaseOrderDetail:
    order = _load(session, order_id)
    try:
        orders.update(
            order,
            PurchaseOrderDraft(
                vendor_id=body.vendor_id,
                description=body.description,
                total_minor_units=body.total_minor_units,
                currency=body.currency,
                cost_centre_id=body.cost_centre_id,
                gl_account_id=body.gl_account_id,
                estimate_id=body.estimate_id,
            ),
            actor=user,
            correlation_id=correlation_id,
        )
    except PurchaseOrderError as error:
        raise _refused(error) from error

    session.commit()
    session.refresh(order)
    return _order_out(order, session=session, orders=orders, approvals=approvals, user=user)


@router.post("/{order_id}/submit", response_model=PurchaseOrderDetail, dependencies=[_MANAGE])
def submit_order(
    order_id: uuid.UUID,
    session: SessionDep,
    orders: PurchaseOrderServiceDep,
    approvals: ApprovalServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> PurchaseOrderDetail:
    """Commit the order, through approval when it needs any."""
    order = _load(session, order_id)
    try:
        orders.submit(order, actor=user, correlation_id=correlation_id)
    except RouteNotAvailableError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except PurchaseOrderError as error:
        raise _refused(error) from error
    except TransitionError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    session.commit()
    session.refresh(order)
    return _order_out(order, session=session, orders=orders, approvals=approvals, user=user)


@router.post("/{order_id}/withdraw", response_model=PurchaseOrderDetail, dependencies=[_MANAGE])
def withdraw_order(
    order_id: uuid.UUID,
    body: PurchaseOrderReasonRequest,
    session: SessionDep,
    orders: PurchaseOrderServiceDep,
    approvals: ApprovalServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> PurchaseOrderDetail:
    order = _load(session, order_id)
    try:
        orders.withdraw(order, actor=user, reason=body.reason, correlation_id=correlation_id)
    except PurchaseOrderError as error:
        raise _refused(error) from error
    except TransitionError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    session.commit()
    session.refresh(order)
    return _order_out(order, session=session, orders=orders, approvals=approvals, user=user)


@router.post("/{order_id}/amend", response_model=PurchaseOrderDetail, dependencies=[_MANAGE])
def amend_order(
    order_id: uuid.UUID,
    body: PurchaseOrderAmendRequest,
    session: SessionDep,
    orders: PurchaseOrderServiceDep,
    approvals: ApprovalServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> PurchaseOrderDetail:
    """Change what a live order commits.

    An increase sends it back for approval. That is the point of the endpoint
    rather than a side effect of it: the signature on the order was given for the
    old figure and does not cover the new one.
    """
    order = _load(session, order_id)
    try:
        orders.amend(
            order,
            total_minor_units=body.total_minor_units,
            actor=user,
            reason=body.reason,
            correlation_id=correlation_id,
        )
    except RouteNotAvailableError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except PurchaseOrderError as error:
        raise _refused(error) from error
    except TransitionError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    session.commit()
    session.refresh(order)
    return _order_out(order, session=session, orders=orders, approvals=approvals, user=user)


@router.post("/{order_id}/close", response_model=PurchaseOrderDetail, dependencies=[_MANAGE])
def close_order(
    order_id: uuid.UUID,
    body: PurchaseOrderReasonRequest,
    session: SessionDep,
    orders: PurchaseOrderServiceDep,
    approvals: ApprovalServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> PurchaseOrderDetail:
    """Stop an order taking further invoices, without denying the ones it took."""
    order = _load(session, order_id)
    try:
        orders.close(order, actor=user, reason=body.reason, correlation_id=correlation_id)
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except PurchaseOrderError as error:
        raise _refused(error) from error

    session.commit()
    session.refresh(order)
    return _order_out(order, session=session, orders=orders, approvals=approvals, user=user)


@router.post("/{order_id}/cancel", response_model=PurchaseOrderDetail, dependencies=[_MANAGE])
def cancel_order(
    order_id: uuid.UUID,
    body: PurchaseOrderReasonRequest,
    session: SessionDep,
    orders: PurchaseOrderServiceDep,
    approvals: ApprovalServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> PurchaseOrderDetail:
    """Withdraw an order that should never have been raised.

    Refused once anything has been billed against it, with the suggestion to
    close it instead. Cancelling asserts the commitment never existed, and an
    invoice against it is evidence to the contrary.
    """
    order = _load(session, order_id)
    try:
        orders.cancel(order, actor=user, reason=body.reason, correlation_id=correlation_id)
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except PurchaseOrderError as error:
        raise _refused(error) from error
    except TransitionError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    session.commit()
    session.refresh(order)
    return _order_out(order, session=session, orders=orders, approvals=approvals, user=user)


@router.post("/{order_id}/decisions", response_model=PurchaseOrderDetail)
def decide_order(
    order_id: uuid.UUID,
    body: PurchaseOrderDecisionRequest,
    session: SessionDep,
    orders: PurchaseOrderServiceDep,
    approvals: ApprovalServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
    _principal: Annotated[Principal, Depends(RequirePermission(Permission.approval_decide))],
) -> PurchaseOrderDetail:
    """Record an approval decision on an order.

    The step and level are named by the caller rather than inferred from who they
    are, for the same reason as on an estimate: somebody eligible at two levels
    of one route must say which they are deciding, because the two signatures
    mean different things.
    """
    order = _load(session, order_id)

    try:
        orders.record_decision(
            order,
            step_order=body.step_order,
            level=body.level,
            outcome=body.outcome,
            actor=user,
            comment=body.comment,
            correlation_id=correlation_id,
        )
    except SegregationOfDutiesError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except ApprovalError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
        ) from error
    except PurchaseOrderError as error:
        raise _refused(error) from error
    except TransitionError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    session.commit()
    session.refresh(order)
    return _order_out(order, session=session, orders=orders, approvals=approvals, user=user)
