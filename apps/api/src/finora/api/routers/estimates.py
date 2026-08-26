"""Estimate and approval endpoints.

Three things shape every response here, and they are the same three as the
document endpoints, restated for a record that commits money.

*A refusal explains the whole remaining task.* `problems` is returned on every
read of an estimate, so the screen shows a requester everything outstanding at
once. Submitting is not the way to find out what is missing.

*The server decides what the caller may do.* Every read carries an `actions`
block computed from the same checks the write endpoints enforce. A client that
worked out for itself whether a button should be enabled would eventually reach a
different answer from the server, and the answer that matters is the server's.

*A route is described in full, including whose turn it is.* An approver's step
carries whether *this* caller may decide it, resolved against assignments and
delegations, because the alternative is an approver pressing a button to be told
they were never eligible.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
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
    EstimateServiceDep,
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
from finora.application.estimates import (
    RECORD_TYPE,
    DocumentNotUsableError,
    EstimateDraft,
    EstimateError,
    EstimateService,
    NotEditableError,
    NotReadyError,
    may_view,
)
from finora.domain.approvals import (
    LEVEL_LABELS,
    ApprovalError,
    ApprovalOutcome,
    RouteNotAvailableError,
)
from finora.domain.estimates import (
    EDITABLE_STATES,
    PROBLEM_EXPLANATIONS,
    PROBLEM_FIELDS,
    EstimateProblem,
)
from finora.domain.money import CURRENCY_EXPONENTS, CurrencyError, Money
from finora.domain.roles import ApprovalLevel, AuthorizationError, Permission, Role
from finora.domain.workflow import STATE_LABELS, TERMINAL_STATES, WorkflowState
from finora.infrastructure.db.models import (
    ApprovalRequest,
    CostCentre,
    Document,
    Estimate,
    GlAccount,
    User,
    Vendor,
)

router = APIRouter(prefix="/estimates", tags=["estimates"])


# ------------------------------------------------------------------- schemas


class EstimateProblemOut(BaseModel):
    problem: EstimateProblem
    #: The control to send the reviewer to. Named by the server so the field a
    #: rule refers to cannot drift from the field the form focuses.
    field: str
    explanation: str


class EstimateActionsOut(BaseModel):
    """What this caller may do to this estimate, decided by the server.

    Every field is the outcome of the same check the corresponding endpoint
    performs, so a disabled button and a refused request always agree.
    """

    may_edit: bool
    may_submit: bool
    may_withdraw: bool
    may_cancel: bool
    may_decide: bool


class EstimateSummary(BaseModel):
    id: uuid.UUID
    reference: str
    state: WorkflowState
    state_label: str

    vendor_name: str
    description: str
    total_minor_units: int | None
    currency: str | None
    total_formatted: str | None
    estimate_date: date | None
    needed_by: date | None

    requester_label: str
    department: str | None
    created_at: datetime
    submitted_at: datetime | None
    decided_at: datetime | None

    #: Enough of the route to triage a queue without opening each row.
    route_summary: str | None
    awaiting_labels: list[str]
    #: Whether this row is waiting on the caller. What an approver sorts by.
    awaiting_me: bool
    #: How many completeness rules are unmet. Only meaningful for a draft.
    problem_count: int


class EstimateDetail(EstimateSummary):
    vendor_id: uuid.UUID | None
    estimate_number: str | None
    justification: str
    cost_centre: NamedRefOut | None
    gl_account: NamedRefOut | None
    document_id: uuid.UUID | None

    problems: list[EstimateProblemOut]
    #: The route this estimate is on, or the one that decided it. Null for a draft,
    #: which is on none: see `planned_route` for what it would take.
    route: RouteOut | None
    #: Every route before the current one, oldest first. Present because "the Unit
    #: Head approved this and then the amount changed" is the history an auditor
    #: comes looking for.
    route_history: list[RouteOut]
    transitions: list[TransitionOut]
    #: The route this estimate would take if submitted now, for a draft. Null once
    #: it has been submitted, because by then the route it is actually on is the
    #: answer, and null on a draft whose amount no configured band covers.
    planned_route: list[PlannedStepOut] | None
    planned_route_problem: str | None
    actions: EstimateActionsOut


class EstimatePage(BaseModel):
    items: list[EstimateSummary]
    total: int
    limit: int
    offset: int


class EstimateCreateRequest(BaseModel):
    #: An accepted document reading to raise this from. Omitted for a quotation
    #: that did not arrive by mail.
    document_id: uuid.UUID | None = None


class EstimateDraftRequest(BaseModel):
    """The complete editable state of a draft, not a set of changes.

    A PUT rather than a PATCH because `null` then means "this estimate has no
    such value" without a second sentinel, and because the form sends every field
    it owns anyway.
    """

    vendor_name: str = Field(max_length=300)
    description: str = Field(max_length=500)
    justification: str = Field(max_length=4000)
    vendor_id: uuid.UUID | None = None
    estimate_number: str | None = Field(default=None, max_length=120)
    estimate_date: date | None = None
    needed_by: date | None = None
    total_minor_units: int | None = Field(default=None, ge=1)
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    cost_centre_id: uuid.UUID | None = None
    gl_account_id: uuid.UUID | None = None


class EstimateReasonRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=1000)


class EstimateDecisionRequest(BaseModel):
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


def _problem_out(problem: EstimateProblem) -> EstimateProblemOut:
    return EstimateProblemOut(
        problem=problem,
        field=PROBLEM_FIELDS[problem],
        explanation=PROBLEM_EXPLANATIONS[problem],
    )


def _summary(
    estimate: Estimate,
    *,
    approvals: ApprovalService,
    estimates: EstimateService,
    user: User,
    open_request: ApprovalRequest | None,
) -> EstimateSummary:
    amount = _money(estimate.total_minor_units, estimate.currency)
    problems = estimates.outstanding(estimate) if estimate.state in EDITABLE_STATES else ()
    return EstimateSummary(
        id=estimate.id,
        reference=estimate.reference,
        state=estimate.state,
        state_label=STATE_LABELS[estimate.state],
        vendor_name=estimate.vendor_name,
        description=estimate.description,
        total_minor_units=estimate.total_minor_units,
        currency=estimate.currency,
        total_formatted=amount.format() if amount else None,
        estimate_date=estimate.estimate_date,
        needed_by=estimate.needed_by,
        requester_label=estimate.requester.display_name,
        department=estimate.department,
        created_at=estimate.created_at,
        submitted_at=estimate.submitted_at,
        decided_at=estimate.decided_at,
        route_summary=approvals.summary(open_request) if open_request else None,
        awaiting_labels=awaiting_labels(open_request, approvals),
        awaiting_me=awaiting_me(open_request, approvals=approvals, user=user),
        problem_count=len(problems),
    )


def _actions(
    estimate: Estimate,
    *,
    principal: Principal,
    user: User,
    approvals: ApprovalService,
    estimates: EstimateService,
    open_request: ApprovalRequest | None,
) -> EstimateActionsOut:
    """What this caller may do, by the same rules the write endpoints apply."""
    is_requester = estimate.requester_id == user.id
    editable = estimate.state in EDITABLE_STATES
    may_edit = editable and is_requester and principal.has(Permission.estimate_edit)
    return EstimateActionsOut(
        may_edit=may_edit,
        may_submit=(
            may_edit
            and principal.has(Permission.estimate_submit)
            and not estimates.outstanding(estimate)
        ),
        may_withdraw=(
            estimate.state is WorkflowState.pending_approval
            and is_requester
            and principal.has(Permission.estimate_edit)
        ),
        may_cancel=(
            estimate.state not in TERMINAL_STATES
            and is_requester
            and principal.has(Permission.estimate_edit)
        ),
        may_decide=awaiting_me(open_request, approvals=approvals, user=user)
        and principal.has(Permission.approval_decide),
    )


def _planned(
    estimate: Estimate, *, approvals: ApprovalService, user: User
) -> tuple[list[PlannedStepOut] | None, str | None]:
    """The route this estimate would take, or why one cannot be planned.

    Shown before submission so a requester knows who will have to approve, and so
    a matrix gap is visible as a sentence on the draft rather than as a refusal at
    the moment they press submit.
    """
    amount = _money(estimate.total_minor_units, estimate.currency)
    if amount is None:
        return None, None
    try:
        preview = approvals.preview(
            record_type=RECORD_TYPE,
            amount=amount,
            department=estimate.department or user.department,
        )
    except RouteNotAvailableError as error:
        return None, str(error)
    return [
        PlannedStepOut(step_order=order, level=level, level_label=LEVEL_LABELS[level])
        for order, level in preview
    ], None


def _detail(
    estimate: Estimate,
    *,
    session: Session,
    principal: Principal,
    user: User,
    approvals: ApprovalService,
    estimates: EstimateService,
) -> EstimateDetail:
    open_request = approvals.open_request(record_type=RECORD_TYPE, record_id=estimate.id)
    routes = approvals.history(record_type=RECORD_TYPE, record_id=estimate.id)

    # Which route is "the" route depends on whether this estimate is still being
    # written. A draft is on none: any route it has been on was abandoned, and
    # what its requester needs is the one its current amount would take. Anything
    # past draft is either with approvers or was decided by its most recent
    # route, and in both cases that route is the current one. Reporting only an
    # *open* route left an approved estimate claiming it had no route at all,
    # filing the approvals that closed it under "earlier rounds", and offering a
    # planned route beside them as though it still applied.
    editable = estimate.state in EDITABLE_STATES
    current = None if editable else (routes[-1] if routes else None)
    planned, planned_problem = (
        _planned(estimate, approvals=approvals, user=user) if editable else (None, None)
    )

    return EstimateDetail(
        **_summary(
            estimate,
            approvals=approvals,
            estimates=estimates,
            user=user,
            open_request=open_request,
        ).model_dump(),
        vendor_id=estimate.vendor_id,
        estimate_number=estimate.estimate_number,
        justification=estimate.justification,
        cost_centre=ref_out(estimate.cost_centre),
        gl_account=ref_out(estimate.gl_account),
        document_id=estimate.document_id,
        problems=[_problem_out(problem) for problem in estimates.outstanding(estimate)],
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
            for row in estimates.transitions(estimate)
        ],
        planned_route=planned,
        planned_route_problem=planned_problem,
        actions=_actions(
            estimate,
            principal=principal,
            user=user,
            approvals=approvals,
            estimates=estimates,
            open_request=open_request,
        ),
    )


def _load(session: Session, estimate_id: uuid.UUID, *, user: User) -> Estimate:
    """The estimate, or a 404 whether it is absent or none of this caller's business.

    Deliberately the same response for both. A 403 on a record a requester may
    not see would confirm that reference exists, and references are sequential.
    """
    row = session.get(Estimate, estimate_id)
    if row is None or row.archived_at is not None or not may_view(row, user=user):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="That estimate could not be found.",
        )
    return row


# --------------------------------------------------------------------- reads


@router.get("", response_model=EstimatePage)
def list_estimates(
    session: SessionDep,
    approvals: ApprovalServiceDep,
    estimates: EstimateServiceDep,
    user: CurrentUserDep,
    _: Annotated[Principal, Depends(RequirePermission(Permission.estimate_view))],
    state: Annotated[list[WorkflowState] | None, Query()] = None,
    mine: Annotated[bool, Query(description="Only estimates this caller raised")] = False,
    awaiting_me: Annotated[bool, Query(description="Only estimates awaiting this caller")] = False,
    search: Annotated[str | None, Query(max_length=200)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> EstimatePage:
    """The estimate register, newest first.

    Newest first, unlike the document queue. A document queue is work to be done
    and the oldest is next; this is a register of records, and a requester opening
    it has almost always just made the thing they are looking for.
    """
    conditions: list[ColumnElement[bool]] = [Estimate.archived_at.is_(None)]
    if state:
        conditions.append(Estimate.state.in_(state))
    if mine or not _sees_everything(user):
        conditions.append(Estimate.requester_id == user.id)
    if search:
        pattern = f"%{search.strip().lower()}%"
        conditions.append(
            or_(
                func.lower(Estimate.reference).like(pattern),
                func.lower(Estimate.vendor_name).like(pattern),
                func.lower(Estimate.description).like(pattern),
                func.lower(func.coalesce(Estimate.estimate_number, "")).like(pattern),
            )
        )

    if awaiting_me:
        # Resolved through the approvals service rather than in this query,
        # because whether a route is this caller's to decide depends on
        # department-scoped assignments and live delegations.
        waiting = approvals.awaiting(user=user, record_type=RECORD_TYPE)
        ids = [request.record_id for request in waiting]
        if not ids:
            return EstimatePage(items=[], total=0, limit=limit, offset=offset)
        conditions.append(Estimate.id.in_(ids))

    total = session.execute(
        select(func.count()).select_from(Estimate).where(*conditions)
    ).scalar_one()
    rows = (
        session.execute(
            select(Estimate)
            .where(*conditions)
            .order_by(Estimate.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
        .scalars()
        .all()
    )

    return EstimatePage(
        items=[
            _summary(
                row,
                approvals=approvals,
                estimates=estimates,
                user=user,
                open_request=approvals.open_request(record_type=RECORD_TYPE, record_id=row.id),
            )
            for row in rows
        ],
        total=total,
        limit=limit,
        offset=offset,
    )


def _sees_everything(user: User) -> bool:
    """Whether this user's remit covers estimates they did not raise."""
    return bool(
        user.roles
        & {Role.approver, Role.finance, Role.auditor, Role.administrator, Role.payment_coordinator}
    )


@router.get("/{estimate_id}", response_model=EstimateDetail)
def get_estimate(
    estimate_id: uuid.UUID,
    session: SessionDep,
    approvals: ApprovalServiceDep,
    estimates: EstimateServiceDep,
    user: CurrentUserDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.estimate_view))],
) -> EstimateDetail:
    """One estimate, its route, its history, and what this caller may do to it."""
    row = _load(session, estimate_id, user=user)
    return _detail(
        row,
        session=session,
        principal=principal,
        user=user,
        approvals=approvals,
        estimates=estimates,
    )


# -------------------------------------------------------------------- writes


@router.post("", response_model=EstimateDetail, status_code=status.HTTP_201_CREATED)
def create_estimate(
    payload: EstimateCreateRequest,
    session: SessionDep,
    approvals: ApprovalServiceDep,
    estimates: EstimateServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.estimate_create))],
) -> EstimateDetail:
    """Raise a draft estimate, from an accepted reading or from nothing."""
    if payload.document_id is None:
        row = estimates.create_blank(requester=user, correlation_id=correlation_id)
    else:
        document = session.get(Document, payload.document_id)
        if document is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="That document could not be found.",
            )
        try:
            row = estimates.create_from_document(
                document, requester=user, correlation_id=correlation_id
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
        estimates=estimates,
    )


@router.put("/{estimate_id}", response_model=EstimateDetail)
def update_estimate(
    estimate_id: uuid.UUID,
    payload: EstimateDraftRequest,
    session: SessionDep,
    approvals: ApprovalServiceDep,
    estimates: EstimateServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.estimate_edit))],
) -> EstimateDetail:
    """Replace a draft's details."""
    row = _load(session, estimate_id, user=user)
    _assert_own_draft(row, user=user)

    try:
        estimates.update(
            row,
            EstimateDraft(**payload.model_dump()),
            actor=user,
            correlation_id=correlation_id,
        )
    except NotEditableError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except EstimateError as error:
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
        estimates=estimates,
    )


@router.post("/{estimate_id}/submit", response_model=EstimateDetail)
def submit_estimate(
    estimate_id: uuid.UUID,
    session: SessionDep,
    approvals: ApprovalServiceDep,
    estimates: EstimateServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.estimate_submit))],
) -> EstimateDetail:
    """Send a complete draft for approval."""
    row = _load(session, estimate_id, user=user)
    _assert_own_draft(row, user=user)

    try:
        estimates.submit(row, actor=user, correlation_id=correlation_id)
    except NotReadyError as error:
        # 422 rather than 409: the record is in the right state, its contents are
        # not yet sufficient, and the response names every gap.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"message": str(error), "problems": error.as_details},
        ) from error
    except RouteNotAvailableError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except NotEditableError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except EstimateError as error:
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
        estimates=estimates,
    )


@router.post("/{estimate_id}/withdraw", response_model=EstimateDetail)
def withdraw_estimate(
    estimate_id: uuid.UUID,
    payload: EstimateReasonRequest,
    session: SessionDep,
    approvals: ApprovalServiceDep,
    estimates: EstimateServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.estimate_edit))],
) -> EstimateDetail:
    """Pull an estimate back from approvers so it can be corrected.

    Restricted to the requester. An approver who thinks a request is wrong
    rejects it, with a reason the requester can read; quietly returning it to
    somebody's drafts is not a decision anybody is accountable for.
    """
    row = _load(session, estimate_id, user=user)
    if row.requester_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Only the person who raised this estimate can withdraw it. "
                "Reject it with a reason if it should not proceed."
            ),
        )

    try:
        estimates.withdraw(row, actor=user, reason=payload.reason, correlation_id=correlation_id)
    except NotEditableError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except EstimateError as error:
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
        estimates=estimates,
    )


@router.post("/{estimate_id}/cancel", response_model=EstimateDetail)
def cancel_estimate(
    estimate_id: uuid.UUID,
    payload: EstimateReasonRequest,
    session: SessionDep,
    approvals: ApprovalServiceDep,
    estimates: EstimateServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.estimate_edit))],
) -> EstimateDetail:
    """Abandon an estimate for good.

    The requester's to cancel, like withdrawal. An approver who wants it stopped
    rejects it, which is a decision with their name against it.
    """
    row = _load(session, estimate_id, user=user)
    if row.requester_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Only the person who raised this estimate can cancel it. "
                "Reject it with a reason if it should not proceed."
            ),
        )

    try:
        estimates.cancel(row, actor=user, reason=payload.reason, correlation_id=correlation_id)
    except EstimateError as error:
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
        estimates=estimates,
    )


@router.post("/{estimate_id}/decision", response_model=EstimateDetail)
def decide_estimate(
    estimate_id: uuid.UUID,
    payload: EstimateDecisionRequest,
    session: SessionDep,
    approvals: ApprovalServiceDep,
    estimates: EstimateServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.approval_decide))],
) -> EstimateDetail:
    """Record one approval decision, moving the estimate if the route closed.

    The step and level are named by the caller rather than inferred from who they
    are. A user eligible at two levels of the same route must say which one they
    are deciding, because "approved by Manager" and "approved by Head of
    Department" are different facts about the same signature.
    """
    row = _load(session, estimate_id, user=user)

    try:
        estimates.record_decision(
            row,
            step_order=payload.step_order,
            level=payload.level,
            outcome=payload.outcome,
            actor=user,
            comment=payload.comment,
            correlation_id=correlation_id,
        )
    except AuthorizationError as error:
        # Covers segregation of duties: whoever submitted this cannot decide it,
        # whatever roles they hold.
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except ApprovalError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except EstimateError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    session.commit()
    session.refresh(row)
    return _detail(
        row,
        session=session,
        principal=principal,
        user=user,
        approvals=approvals,
        estimates=estimates,
    )


def _assert_own_draft(estimate: Estimate, *, user: User) -> None:
    """Only the requester edits their own draft.

    A finance user can see every estimate, and letting them silently rewrite
    somebody else's request would make the requester's name on it a lie.
    """
    if estimate.requester_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "This estimate was raised by somebody else. Only they can change or submit it."
            ),
        )


# --------------------------------------------------------------- reference data


reference_router = APIRouter(prefix="/reference", tags=["reference"])


class ReferenceData(BaseModel):
    """Everything the estimate form needs to render its selectors.

    One request rather than four. The form cannot be used until all of it has
    arrived, so four requests would only add three ways for it to half-load.
    """

    vendors: list[NamedRefOut]
    cost_centres: list[NamedRefOut]
    gl_accounts: list[NamedRefOut]
    currencies: list[str]


@reference_router.get("", response_model=ReferenceData)
def reference_data(
    session: SessionDep,
    _: Annotated[Principal, Depends(RequirePermission(Permission.estimate_view))],
) -> ReferenceData:
    """Active vendors, cost centres and accounts, for the coding selectors."""
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

    return ReferenceData(
        vendors=[NamedRefOut(id=row.id, code=row.code, name=row.name) for row in vendors],
        cost_centres=[NamedRefOut(id=row.id, code=row.code, name=row.name) for row in centres],
        gl_accounts=[NamedRefOut(id=row.id, code=row.code, name=row.name) for row in accounts],
        currencies=sorted(CURRENCY_EXPONENTS),
    )
