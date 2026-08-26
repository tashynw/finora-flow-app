"""Approval matrix, level assignments and delegation.

Two things distinguish these endpoints from the record ones.

*A refusal here has to be actionable by somebody who did not write the rules.*
A rule can be wrong on its own terms, or fine on its own terms and wrong for the
matrix it would join. The two come back separately — `problems` against the field
that caused each, `faults` against the matrix — because the fix is in a different
place, and a screen that merged them would point the administrator at the wrong
input.

*Gaps are returned on success.* Every write that touches the matrix answers with
what the matrix now does, including the amounts nothing covers and the levels
nobody holds. That is not an error, it is the state of the configuration, and the
only moment somebody is reliably looking at it is just after they changed it.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from finora.api.deps import (
    AdministrationServiceDep,
    CorrelationDep,
    CurrentUserDep,
    RequireAnyPermission,
    RequirePermission,
    SessionDep,
)
from finora.application.administration import (
    AdministrationError,
    Assignment,
    DelegationRejectedError,
    MatrixIncoherentError,
    RuleRejectedError,
)
from finora.domain.approvals import LEVEL_LABELS, PlannedStep, RouteNotAvailableError
from finora.domain.delegation import DelegationProblem
from finora.domain.delegation import explain as explain_delegation
from finora.domain.delegation import field_for as field_for_delegation
from finora.domain.matrix import (
    MATRIX_RECORD_TYPES,
    RECORD_TYPE_LABELS,
    MatrixAudit,
    RuleDraft,
    RuleProblem,
    explain_rule_problem,
    field_for_rule_problem,
)
from finora.domain.money import CurrencyError, Money
from finora.domain.roles import (
    ApprovalLevel,
    AuthorizationError,
    Permission,
    permissions_for,
)
from finora.infrastructure.db.models import ApprovalAssignment, ApprovalRule, User

router = APIRouter(prefix="/admin", tags=["administration"])

_MATRIX_READ = Depends(RequirePermission(Permission.admin_approval_matrix))

#: Delegation is reached from two directions and neither role holds the other's
#: permission. Which of the two is allowed on which person is settled in the
#: service, where the target of the change is known.
_COVER = Depends(
    RequireAnyPermission(Permission.approval_delegate, Permission.admin_approval_matrix)
)


# ------------------------------------------------------------------ response models


class MatrixRuleOut(BaseModel):
    id: uuid.UUID
    name: str
    record_type: str
    record_type_label: str
    level: ApprovalLevel
    level_label: str
    step_order: int
    min_amount_minor_units: int
    max_amount_minor_units: int | None
    currency: str
    band_label: str
    department: str | None
    is_parallel: bool
    is_active: bool
    retired_at: datetime | None
    #: The rule this one replaced, so a screen can show the history of a band
    #: rather than a list of unrelated rows.
    supersedes_id: uuid.UUID | None


class MatrixNoteOut(BaseModel):
    """A fault or a gap: a machine-readable kind and a sentence to show."""

    kind: str
    message: str


class MatrixReadingOut(BaseModel):
    """What the matrix does at one probe amount."""

    currency: str
    department: str | None
    amount_minor_units: int
    amount_formatted: str
    steps: list[str]
    unreachable: str | None


class MatrixAuditOut(BaseModel):
    is_coherent: bool
    faults: list[MatrixNoteOut]
    gaps: list[MatrixNoteOut]
    readings: list[MatrixReadingOut]


class MatrixOut(BaseModel):
    record_type: str
    record_type_label: str
    rules: list[MatrixRuleOut]
    audit: MatrixAuditOut


class AdministrationProblemOut(BaseModel):
    code: str
    field: str
    message: str


class ApprovalAssignmentOut(BaseModel):
    id: uuid.UUID
    level: ApprovalLevel
    level_label: str
    user_id: uuid.UUID
    user_name: str
    user_email: str
    department: str | None
    is_active: bool
    is_covered_by_id: uuid.UUID | None
    is_covered_by_name: str | None


class ApprovalDelegationOut(BaseModel):
    user_id: uuid.UUID
    user_name: str
    delegate_to_id: uuid.UUID | None
    delegate_to_name: str | None
    out_of_office_until: datetime | None
    #: Whether this arrangement is doing anything right now, as opposed to being
    #: configured and dormant or configured and expired.
    is_in_effect: bool


class ApprovalPersonOut(BaseModel):
    """Somebody who could be put at a level, or named as cover."""

    id: uuid.UUID
    name: str
    email: str
    department: str | None
    #: Whether this account can record an approval decision at all. A screen
    #: shows it rather than hiding the person, because "Ada cannot approve" is a
    #: fact an administrator can act on and an absent name is not.
    may_decide: bool


class RoutePreviewOut(BaseModel):
    record_type: str
    amount_formatted: str
    department: str | None
    steps: list[str]
    #: Set when no route could be planned, with the reason, rather than an empty
    #: list that reads as "no approval needed".
    unreachable: str | None


# --------------------------------------------------------------------- request bodies


class MatrixRuleRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    record_type: str
    level: ApprovalLevel
    step_order: int = Field(ge=1)
    min_amount_minor_units: int = Field(ge=0)
    max_amount_minor_units: int | None = Field(default=None, ge=0)
    currency: str = Field(min_length=3, max_length=3)
    department: str | None = Field(default=None, max_length=200)
    is_parallel: bool = False
    reason: str = Field(min_length=1, max_length=500)
    #: When replacing a live rule rather than adding one. The old rule is retired
    #: in the same transaction and the new one points back at it.
    supersedes_id: uuid.UUID | None = None


class MatrixRetireRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


class ApprovalAssignRequest(BaseModel):
    user_id: uuid.UUID
    level: ApprovalLevel
    department: str | None = Field(default=None, max_length=200)


class ApprovalCoverRequest(BaseModel):
    """Empty on both fields means "I am back", which is always allowed."""

    delegate_to_id: uuid.UUID | None = None
    out_of_office_until: datetime | None = None


# ----------------------------------------------------------------------- conversions


def _band_label(rule: ApprovalRule) -> str:
    floor = Money(rule.min_amount_minor_units, rule.currency)
    if rule.max_amount_minor_units is None:
        return f"{floor.format()} and above"
    return f"{floor.format()} to {Money(rule.max_amount_minor_units, rule.currency).format()}"


def _rule_out(rule: ApprovalRule) -> MatrixRuleOut:
    return MatrixRuleOut(
        id=rule.id,
        name=rule.name,
        record_type=rule.record_type,
        record_type_label=RECORD_TYPE_LABELS.get(rule.record_type, rule.record_type),
        level=rule.level,
        level_label=LEVEL_LABELS[rule.level],
        step_order=rule.step_order,
        min_amount_minor_units=rule.min_amount_minor_units,
        max_amount_minor_units=rule.max_amount_minor_units,
        currency=rule.currency,
        band_label=_band_label(rule),
        department=rule.department,
        is_parallel=rule.is_parallel,
        is_active=rule.is_active,
        retired_at=rule.retired_at,
        supersedes_id=rule.supersedes_id,
    )


def _step_labels(steps: Sequence[PlannedStep]) -> list[str]:
    """A route as sentences, with concurrent steps saying so.

    Parallelism is two levels sharing a step order rather than a flag on either
    of them, so it is only visible from the route as a whole. Naming it matters:
    "2. Manager" twice reads as two approvals when it is one gate with two
    people, which is the difference between scrutiny doubled and scrutiny halved.
    """
    at_order: dict[int, int] = {}
    for step in steps:
        at_order[step.step_order] = at_order.get(step.step_order, 0) + 1

    return [
        f"{step.step_order}. {LEVEL_LABELS[step.level]}"
        + (" (together)" if at_order[step.step_order] > 1 else "")
        for step in steps
    ]


def _audit_out(verdict: MatrixAudit) -> MatrixAuditOut:
    return MatrixAuditOut(
        is_coherent=verdict.is_coherent,
        faults=[
            MatrixNoteOut(kind=kind.value, message=message) for kind, message in verdict.faults
        ],
        gaps=[MatrixNoteOut(kind=kind.value, message=message) for kind, message in verdict.gaps],
        readings=[
            MatrixReadingOut(
                currency=reading.currency,
                department=reading.department,
                amount_minor_units=reading.amount_minor_units,
                amount_formatted=reading.amount.format(),
                steps=_step_labels(reading.steps),
                unreachable=reading.unreachable,
            )
            for reading in verdict.readings
        ],
    )


def _assignment_out(assignment: Assignment) -> ApprovalAssignmentOut:
    return ApprovalAssignmentOut(
        id=assignment.id,
        level=assignment.level,
        level_label=assignment.level_label,
        user_id=assignment.user_id,
        user_name=assignment.user_name,
        user_email=assignment.user_email,
        department=assignment.department,
        is_active=assignment.is_active,
        is_covered_by_id=assignment.is_covered_by_id,
        is_covered_by_name=assignment.is_covered_by_name,
    )


def _rule_problems(problems: tuple[RuleProblem, ...]) -> list[dict[str, str]]:
    return [
        {
            "code": problem.value,
            "field": field_for_rule_problem(problem),
            "message": explain_rule_problem(problem),
        }
        for problem in problems
    ]


def _delegation_problems(problems: tuple[DelegationProblem, ...]) -> list[dict[str, str]]:
    return [
        {
            "code": problem.value,
            "field": field_for_delegation(problem),
            "message": explain_delegation(problem),
        }
        for problem in problems
    ]


def _known_record_type(record_type: str) -> str:
    if record_type not in MATRIX_RECORD_TYPES:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                f"There is no approval matrix for '{record_type}'. "
                f"Choose one of: {', '.join(sorted(MATRIX_RECORD_TYPES))}."
            ),
        )
    return record_type


# ---------------------------------------------------------------------- the matrix


@router.get("/matrix/{record_type}", response_model=MatrixOut, dependencies=[_MATRIX_READ])
def read_matrix(
    record_type: str,
    admin: AdministrationServiceDep,
    include_retired: Annotated[bool, Query()] = False,
) -> MatrixOut:
    """The rules for a record type and what they currently do."""
    known = _known_record_type(record_type)
    return MatrixOut(
        record_type=known,
        record_type_label=RECORD_TYPE_LABELS.get(known, known),
        rules=[
            _rule_out(rule)
            for rule in admin.rules(record_type=known, include_retired=include_retired)
        ],
        audit=_audit_out(admin.audit_of(record_type=known)),
    )


@router.post(
    "/matrix/rules",
    response_model=MatrixOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[_MATRIX_READ],
)
def add_rule(
    body: MatrixRuleRequest,
    admin: AdministrationServiceDep,
    session: SessionDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> MatrixOut:
    """Add a rule, or replace a live one by naming it in `supersedes_id`.

    Answers with the whole matrix rather than the rule that was written. The
    question an administrator has after saving is never "what did I just type",
    it is "what does this now do", and returning only the new row would leave
    them to work that out from the table.
    """
    known = _known_record_type(body.record_type)

    superseded: ApprovalRule | None = None
    if body.supersedes_id is not None:
        superseded = session.get(ApprovalRule, body.supersedes_id)
        if superseded is None or superseded.record_type != known:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="The rule this one would replace no longer exists.",
            )
        if not superseded.is_active:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "That rule has already been retired, so there is nothing to "
                    "replace. Add this as a new rule instead."
                ),
            )

    draft = RuleDraft(
        name=body.name,
        record_type=known,
        level=body.level,
        step_order=body.step_order,
        min_amount_minor_units=body.min_amount_minor_units,
        max_amount_minor_units=body.max_amount_minor_units,
        currency=body.currency.upper(),
        department=(body.department or "").strip() or None,
        is_parallel=body.is_parallel,
    )

    try:
        admin.add_rule(
            draft,
            actor=user,
            reason=body.reason,
            correlation_id=correlation_id,
            supersedes=superseded,
        )
    except RuleRejectedError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"message": str(error), "problems": _rule_problems(error.problems)},
        ) from error
    except MatrixIncoherentError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": str(error),
                "faults": [
                    {"kind": kind.value, "message": message}
                    for kind, message in error.verdict.faults
                ],
            },
        ) from error
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except AdministrationError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
        ) from error

    session.commit()
    return read_matrix(known, admin)


@router.post(
    "/matrix/rules/{rule_id}/retire", response_model=MatrixOut, dependencies=[_MATRIX_READ]
)
def retire_rule(
    rule_id: uuid.UUID,
    body: MatrixRetireRequest,
    admin: AdministrationServiceDep,
    session: SessionDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> MatrixOut:
    rule = session.get(ApprovalRule, rule_id)
    if rule is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such rule.")

    try:
        admin.retire_rule(rule, actor=user, reason=body.reason, correlation_id=correlation_id)
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except AdministrationError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    session.commit()
    return read_matrix(rule.record_type, admin)


@router.get(
    "/matrix/{record_type}/preview", response_model=RoutePreviewOut, dependencies=[_MATRIX_READ]
)
def preview_route(
    record_type: str,
    admin: AdministrationServiceDep,
    amount_minor_units: Annotated[int, Query(ge=0)],
    currency: Annotated[str, Query(min_length=3, max_length=3)],
    department: Annotated[str | None, Query(max_length=200)] = None,
) -> RoutePreviewOut:
    """Who would have to approve a given amount, under the live matrix.

    The same call the submission path makes. An administrator checking their work
    against a re-description of the rules would be checking the wrong thing.
    """
    known = _known_record_type(record_type)
    try:
        amount = Money(amount_minor_units, currency.upper())
    except CurrencyError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
        ) from error

    scope = (department or "").strip() or None
    try:
        steps = admin.preview(record_type=known, amount=amount, department=scope)
    except RouteNotAvailableError as error:
        return RoutePreviewOut(
            record_type=known,
            amount_formatted=amount.format(),
            department=scope,
            steps=[],
            unreachable=str(error),
        )

    return RoutePreviewOut(
        record_type=known,
        amount_formatted=amount.format(),
        department=scope,
        steps=[f"{order}. {LEVEL_LABELS[level]}" for order, level in steps],
        unreachable=None,
    )


# --------------------------------------------------------------------- assignments


@router.get("/people", response_model=list[ApprovalPersonOut], dependencies=[_COVER])
def read_people(session: SessionDep) -> list[ApprovalPersonOut]:
    """Everybody who could hold a level or be named as somebody's cover.

    Closed accounts are left out entirely: anything routed to them waits
    indefinitely, and offering the name is offering a way to stop a queue.
    """
    rows = (
        session.execute(select(User).where(User.is_active).order_by(User.display_name))
        .scalars()
        .all()
    )
    return [
        ApprovalPersonOut(
            id=row.id,
            name=row.display_name,
            email=row.email,
            department=row.department,
            may_decide=Permission.approval_decide in permissions_for(row.roles),
        )
        for row in rows
    ]


@router.get("/assignments", response_model=list[ApprovalAssignmentOut], dependencies=[_MATRIX_READ])
def read_assignments(
    admin: AdministrationServiceDep,
    level: Annotated[ApprovalLevel | None, Query()] = None,
) -> list[ApprovalAssignmentOut]:
    return [_assignment_out(row) for row in admin.assignments(level=level)]


@router.post(
    "/assignments",
    response_model=list[ApprovalAssignmentOut],
    status_code=status.HTTP_201_CREATED,
    dependencies=[_MATRIX_READ],
)
def assign_level(
    body: ApprovalAssignRequest,
    admin: AdministrationServiceDep,
    session: SessionDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> list[ApprovalAssignmentOut]:
    holder = session.get(User, body.user_id)
    if holder is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such person.")

    try:
        admin.assign(
            user=holder,
            level=body.level,
            department=(body.department or "").strip() or None,
            actor=user,
            correlation_id=correlation_id,
        )
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except AdministrationError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    session.commit()
    return read_assignments(admin)


@router.delete(
    "/assignments/{assignment_id}",
    response_model=list[ApprovalAssignmentOut],
    dependencies=[_MATRIX_READ],
)
def unassign_level(
    assignment_id: uuid.UUID,
    admin: AdministrationServiceDep,
    session: SessionDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> list[ApprovalAssignmentOut]:
    assignment = session.get(ApprovalAssignment, assignment_id)
    if assignment is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such assignment.")

    try:
        admin.unassign(assignment, actor=user, correlation_id=correlation_id)
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except AdministrationError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    session.commit()
    return read_assignments(admin)


# ---------------------------------------------------------------------- delegation


def _delegation_out(session: SessionDep, holder: User) -> ApprovalDelegationOut:
    delegate = (
        session.get(User, holder.delegate_to_id) if holder.delegate_to_id is not None else None
    )
    away = holder.out_of_office_until is not None and holder.out_of_office_until > datetime.now(
        holder.out_of_office_until.tzinfo
    )
    return ApprovalDelegationOut(
        user_id=holder.id,
        user_name=holder.display_name,
        delegate_to_id=delegate.id if delegate is not None else None,
        delegate_to_name=delegate.display_name if delegate is not None else None,
        out_of_office_until=holder.out_of_office_until,
        is_in_effect=away and delegate is not None,
    )


@router.get(
    "/delegations",
    response_model=list[ApprovalDelegationOut],
    dependencies=[_COVER],
)
def read_delegations(session: SessionDep) -> list[ApprovalDelegationOut]:
    """Everybody who currently has cover arranged, in effect or not.

    Dormant and expired arrangements are included on purpose. An expired one is
    the commonest reason an approval queue has silently stopped moving, and it is
    invisible on a screen that lists only what is working.
    """
    rows = (
        session.execute(
            select(User)
            .where(User.delegate_to_id.is_not(None) | User.out_of_office_until.is_not(None))
            .order_by(User.display_name)
        )
        .scalars()
        .all()
    )
    return [_delegation_out(session, row) for row in rows]


@router.put(
    "/delegations/{user_id}",
    response_model=ApprovalDelegationOut,
    dependencies=[_COVER],
)
def set_cover(
    user_id: uuid.UUID,
    body: ApprovalCoverRequest,
    admin: AdministrationServiceDep,
    session: SessionDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> ApprovalDelegationOut:
    """Arrange, change or clear cover.

    Your own needs the delegate permission; somebody else's needs the matrix
    permission, because arranging cover for another approver is a change to who
    can decide, which is an administrative act however kindly meant.
    """
    approver = session.get(User, user_id)
    if approver is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such person.")

    delegate: User | None = None
    if body.delegate_to_id is not None:
        delegate = session.get(User, body.delegate_to_id)
        if delegate is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="The person you named as cover does not exist.",
            )

    try:
        admin.set_cover(
            approver=approver,
            delegate=delegate,
            until=body.out_of_office_until,
            actor=user,
            correlation_id=correlation_id,
        )
    except DelegationRejectedError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"message": str(error), "problems": _delegation_problems(error.problems)},
        ) from error
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except AdministrationError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
        ) from error

    session.commit()
    session.refresh(approver)
    return _delegation_out(session, approver)
