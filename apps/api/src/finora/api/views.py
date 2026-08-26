"""Response shapes shared by every record that goes through approval.

An estimate and an invoice are different records with different rules, but the
route they travel is the same one, described by the same tables and answered by the
same service. Describing it twice would guarantee the two descriptions eventually
disagree — a step field added for one screen and missing on the other, or the
"whose turn is it" calculation drifting in one copy only.

So the route, its steps, the transition history and the resolved code references
live here, and each router keeps only the parts that are genuinely its own: its
problems, its actions, and its summary.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Protocol

from pydantic import BaseModel
from sqlalchemy.orm import Session

from finora.application.approvals import ApprovalService
from finora.domain.approvals import (
    LEVEL_LABELS,
    ROUTE_STATE_LABELS,
    RouteState,
    StepState,
)
from finora.domain.money import Money
from finora.domain.roles import ApprovalLevel
from finora.domain.workflow import STATE_LABELS, WorkflowState
from finora.infrastructure.db.models import ApprovalRequest, User


class NamedRefOut(BaseModel):
    """A coded reference, resolved so a screen never shows a bare identifier."""

    id: uuid.UUID
    code: str
    name: str


class StepOut(BaseModel):
    step_order: int
    level: ApprovalLevel
    level_label: str
    state: StepState
    decided_at: datetime | None
    decided_by_label: str | None
    comment: str | None
    #: Named when a delegate decided in place of the assigned approver.
    on_behalf_of_label: str | None
    #: Whether this caller may decide this step right now.
    is_mine_to_decide: bool
    #: Whose authority they would be acting under, when they are a delegate.
    would_act_for: str | None


class RouteOut(BaseModel):
    id: uuid.UUID
    attempt: int
    state: RouteState
    state_label: str
    summary: str
    amount_minor_units: int
    currency: str
    amount_formatted: str
    department: str | None
    opened_at: datetime
    closed_at: datetime | None
    steps: list[StepOut]


class PlannedStepOut(BaseModel):
    step_order: int
    level: ApprovalLevel
    level_label: str


class TransitionOut(BaseModel):
    from_state: WorkflowState | None
    to_state: WorkflowState
    to_state_label: str
    actor_label: str | None
    reason: str | None
    occurred_at: datetime


class CodedRow(Protocol):
    """Any row with a code and a name: a cost centre, a GL account, a vendor.

    Structural rather than a union of the concrete models, so a new coded reference
    table works here without this module being edited to know about it.
    """

    @property
    def id(self) -> uuid.UUID: ...

    @property
    def code(self) -> str: ...

    @property
    def name(self) -> str: ...


def ref_out(row: CodedRow | None) -> NamedRefOut | None:
    if row is None:
        return None
    return NamedRefOut(id=row.id, code=row.code, name=row.name)


def display_name(session: Session, user_id: uuid.UUID | None) -> str | None:
    if user_id is None:
        return None
    row = session.get(User, user_id)
    return row.display_name if row else None


def step_out(
    *,
    request: ApprovalRequest,
    step_order: int,
    level: ApprovalLevel,
    state: StepState,
    approvals: ApprovalService,
    session: Session,
    user: User,
) -> StepOut:
    row = next(
        item for item in request.steps if item.step_order == step_order and item.level is level
    )
    standing = (
        approvals.standing(request=request, level=level, user=user)
        if state is StepState.ready
        else None
    )
    mine = bool(standing and standing.may_decide and request.requester_id != user.id)
    return StepOut(
        step_order=step_order,
        level=level,
        level_label=LEVEL_LABELS[level],
        state=state,
        decided_at=row.decided_at,
        decided_by_label=row.decided_by_label,
        comment=row.comment,
        on_behalf_of_label=display_name(session, row.on_behalf_of_id),
        is_mine_to_decide=mine,
        would_act_for=standing.on_behalf_of_label if mine and standing else None,
    )


def route_out(
    request: ApprovalRequest,
    *,
    approvals: ApprovalService,
    session: Session,
    user: User,
) -> RouteOut:
    progress = approvals.progress(request)
    return RouteOut(
        id=request.id,
        attempt=request.attempt,
        state=request.state,
        state_label=ROUTE_STATE_LABELS[request.state],
        summary=approvals.summary(request),
        amount_minor_units=request.amount_minor_units,
        currency=request.currency,
        amount_formatted=Money(request.amount_minor_units, request.currency).format(),
        department=request.department,
        opened_at=request.opened_at,
        closed_at=request.closed_at,
        steps=[
            step_out(
                request=request,
                step_order=step.step_order,
                level=step.level,
                state=step.state,
                approvals=approvals,
                session=session,
                user=user,
            )
            for step in progress
        ],
    )


def awaiting_labels(request: ApprovalRequest | None, approvals: ApprovalService) -> list[str]:
    """The levels a route is currently waiting on, for a queue row."""
    if request is None or request.state is not RouteState.open:
        return []
    return sorted(
        LEVEL_LABELS[step.level]
        for step in approvals.progress(request)
        if step.state is StepState.ready
    )


def awaiting_me(request: ApprovalRequest | None, *, approvals: ApprovalService, user: User) -> bool:
    """Whether this route is waiting on this caller.

    A requester never decides their own route, whatever roles they hold, which is
    why the check is here rather than left to each caller to remember.
    """
    if request is None or request.state is not RouteState.open:
        return False
    if request.requester_id == user.id:
        return False
    return any(
        approvals.standing(request=request, level=step.level, user=user).may_decide
        for step in approvals.progress(request)
        if step.state is StepState.ready
    )


def transition_out(
    *,
    from_state: WorkflowState | None,
    to_state: WorkflowState,
    actor_label: str | None,
    reason: str | None,
    occurred_at: datetime,
) -> TransitionOut:
    return TransitionOut(
        from_state=from_state,
        to_state=to_state,
        to_state_label=STATE_LABELS[to_state],
        actor_label=actor_label,
        reason=reason,
        occurred_at=occurred_at,
    )
