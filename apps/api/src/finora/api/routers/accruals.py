"""Accrual period endpoints.

A period is open or locked, not a state machine. Editing and locking are
separate permissions, and the person who edits may not lock the same period.
A suggestion or AI action never finalizes or locks anything.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Annotated, Any, Literal, cast

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field

from finora.api.deps import (
    AccrualServiceDep,
    CorrelationDep,
    CurrentUserDep,
    RequirePermission,
    SessionDep,
)
from finora.application.accruals import (
    AccrualError,
    AccrualService,
    ConflictError,
    NotFoundError,
    ValidationError,
)
from finora.domain.accruals import (
    CANDIDATE_STANDING_LABELS,
    PERIOD_STANDING_DESCRIPTIONS,
    PERIOD_STANDING_LABELS,
    CandidateStanding,
    PeriodStanding,
    period_standing,
)
from finora.domain.money import Money
from finora.domain.roles import Permission, SegregationOfDutiesError, has_permission
from finora.infrastructure.db.models import AccrualCandidate, AccrualExport, AccrualPeriod

router = APIRouter(prefix="/accruals", tags=["accruals"])


# ------------------------------------------------------------------ schemas


class AccrualMoneyOut(BaseModel):
    minor_units: int
    currency: str
    formatted: str


class AccrualReferenceRef(BaseModel):
    id: uuid.UUID
    code: str
    name: str


class AccrualCandidateOut(BaseModel):
    id: uuid.UUID
    reference: str
    invoice_id: uuid.UUID | None
    invoice_reference: str | None
    invoice_number: str | None
    standing: CandidateStanding
    standing_label: str
    currency: str
    amount: AccrualMoneyOut
    original_amount: AccrualMoneyOut
    vendor_name: str
    description: str
    department: str | None
    gl_account: AccrualReferenceRef | None
    cost_centre: AccrualReferenceRef | None
    edit_reason: str | None
    note: str | None
    finalized_at: datetime | None
    version: int


class AccrualExportOut(BaseModel):
    id: uuid.UUID
    version: int
    format: str
    official: bool
    filename: str
    sha256: str
    byte_size: int
    row_count: int
    generated_at: datetime


class AccrualPeriodSummary(BaseModel):
    id: uuid.UUID
    reference: str
    period_start: date
    period_end: date
    label: str
    standing: PeriodStanding
    standing_label: str
    standing_description: str
    candidate_count: int
    open_candidate_count: int
    locked_at: datetime | None
    lock_reason: str | None


class AccrualPeriodDetail(AccrualPeriodSummary):
    candidates: list[AccrualCandidateOut]
    exports: list[AccrualExportOut]
    actions: dict[str, bool]


class AccrualOpenBody(BaseModel):
    period_start: date
    period_end: date
    label: str = Field(default="", max_length=200)


class AccrualEditCandidateBody(BaseModel):
    amount_minor: int | None = Field(default=None, ge=0)
    currency: str = Field(default="JMD", min_length=3, max_length=3)
    exclude: bool = False
    reason: str = Field(min_length=1, max_length=2000)
    note: str | None = Field(default=None, max_length=2000)
    description: str | None = Field(default=None, max_length=500)
    expected_version: int | None = None


class AccrualFinalizeCandidateBody(BaseModel):
    expected_version: int | None = None


class AccrualLockBody(BaseModel):
    reason: str = Field(min_length=3, max_length=2000)
    expected_version: int | None = None


class AccrualExportBody(BaseModel):
    format: Literal["csv", "xlsx"] = "csv"
    official: bool = False


class AccrualProblemOut(BaseModel):
    code: str
    field: str
    message: str


# ----------------------------------------------------------------- helpers


def _money(minor_units: int, currency: str) -> AccrualMoneyOut:
    amount = Money(minor_units, currency)
    return AccrualMoneyOut(
        minor_units=amount.minor_units,
        currency=amount.currency,
        formatted=amount.format(),
    )


def _ref(row: Any | None) -> AccrualReferenceRef | None:
    if row is None:
        return None
    return AccrualReferenceRef(id=row.id, code=row.code, name=row.name)


def _candidate(row: AccrualCandidate) -> AccrualCandidateOut:
    return AccrualCandidateOut(
        id=row.id,
        reference=row.reference,
        invoice_id=row.invoice_id,
        invoice_reference=row.invoice_reference,
        invoice_number=row.invoice_number,
        standing=row.standing,
        standing_label=CANDIDATE_STANDING_LABELS[row.standing],
        currency=row.currency,
        amount=_money(row.amount_minor_units, row.currency),
        original_amount=_money(row.original_amount_minor_units, row.currency),
        vendor_name=row.vendor_name,
        description=row.description,
        department=row.department,
        gl_account=_ref(row.gl_account),
        cost_centre=_ref(row.cost_centre),
        edit_reason=row.edit_reason,
        note=row.note,
        finalized_at=row.finalized_at,
        version=row.version,
    )


def _export_out(row: AccrualExport) -> AccrualExportOut:
    return AccrualExportOut(
        id=row.id,
        version=row.version,
        format=row.format,
        official=row.official,
        filename=row.filename,
        sha256=row.sha256,
        byte_size=row.byte_size,
        row_count=row.row_count,
        generated_at=row.generated_at,
    )


def _as_int(value: object) -> int:
    return int(cast(int, value))


def _period_summary(period: AccrualPeriod, *, service: AccrualService) -> AccrualPeriodSummary:
    standing = period_standing(locked_at=period.locked_at)
    summary = service.period_summary(period)
    return AccrualPeriodSummary(
        id=period.id,
        reference=period.reference,
        period_start=period.period_start,
        period_end=period.period_end,
        label=period.label,
        standing=standing,
        standing_label=PERIOD_STANDING_LABELS[standing],
        standing_description=PERIOD_STANDING_DESCRIPTIONS[standing],
        candidate_count=_as_int(summary["candidate_count"]),
        open_candidate_count=_as_int(summary["open_candidate_count"]),
        locked_at=period.locked_at,
        lock_reason=period.lock_reason,
    )


def _period_actions(
    period: AccrualPeriod,
    *,
    service: AccrualService,
    user: Any,
) -> dict[str, bool]:
    """Derive which buttons are available for this user on this period."""
    taken = service.actions_taken(period, user=user)
    is_open = period.locked_at is None

    may_edit = has_permission(user.roles, Permission.accrual_edit)
    may_finalize = has_permission(user.roles, Permission.accrual_finalize)
    may_lock = has_permission(user.roles, Permission.accrual_lock_period)
    may_export = has_permission(user.roles, Permission.accrual_export)

    # SoD: edit blocks lock on the same period, and vice versa.
    if Permission.accrual_lock_period in taken:
        may_edit = False
    if Permission.accrual_edit in taken:
        may_lock = False

    summary = service.period_summary(period)
    candidates_present = _as_int(summary["candidate_count"]) > 0
    all_settled = candidates_present and _as_int(summary["open_candidate_count"]) == 0

    return {
        "edit": may_edit and is_open,
        "generate": may_edit and is_open,
        "finalize": may_finalize and is_open,
        "lock": may_lock and is_open and all_settled,
        "export": may_export,
    }


def _period_detail(
    period: AccrualPeriod,
    *,
    service: AccrualService,
    user: Any,
) -> AccrualPeriodDetail:
    summary = _period_summary(period, service=service)
    return AccrualPeriodDetail(
        **summary.model_dump(),
        candidates=[_candidate(row) for row in period.candidates],
        exports=[_export_out(row) for row in period.exports],
        actions=_period_actions(period, service=service, user=user),
    )


def _refused(error: AccrualError) -> HTTPException:
    if isinstance(error, NotFoundError):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error))
    if isinstance(error, ConflictError):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=error.message)
    if isinstance(error, ValidationError):
        first = error.problems[0] if error.problems else None
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "message": first.message if first else str(error),
                "code": str(first.code) if first else "unprocessable",
                "problems": [
                    {"code": str(item.code), "field": item.field, "message": item.message}
                    for item in error.problems
                ],
            },
        )
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error))


# ----------------------------------------------------------------- endpoints


@router.get("/periods", response_model=list[AccrualPeriodSummary])
def list_periods(
    service: AccrualServiceDep,
    _: Annotated[None, Depends(RequirePermission(Permission.accrual_view))],
    standing: PeriodStanding | None = None,
) -> list[AccrualPeriodSummary]:
    periods = service.list_periods(standing=standing)
    return [_period_summary(period, service=service) for period in periods]


@router.post("/periods", response_model=AccrualPeriodDetail, status_code=status.HTTP_201_CREATED)
def open_period(
    body: AccrualOpenBody,
    service: AccrualServiceDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
    _: Annotated[None, Depends(RequirePermission(Permission.accrual_edit))],
) -> AccrualPeriodDetail:
    try:
        period = service.open_period(
            actor=actor,
            period_start=body.period_start,
            period_end=body.period_end,
            label=body.label,
            correlation_id=correlation_id,
        )
    except AccrualError as error:
        raise _refused(error) from error
    # Reload with full relationships for the detail view.
    period = service.get_period(period.id)
    return _period_detail(period, service=service, user=actor)


@router.get("/periods/{period_id}", response_model=AccrualPeriodDetail)
def get_period(
    period_id: uuid.UUID,
    service: AccrualServiceDep,
    actor: CurrentUserDep,
    _: Annotated[None, Depends(RequirePermission(Permission.accrual_view))],
) -> AccrualPeriodDetail:
    try:
        period = service.get_period(period_id)
    except AccrualError as error:
        raise _refused(error) from error
    return _period_detail(period, service=service, user=actor)


@router.post(
    "/periods/{period_id}/candidates/generate",
    response_model=AccrualPeriodDetail,
)
def generate_candidates(
    period_id: uuid.UUID,
    service: AccrualServiceDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
    _: Annotated[None, Depends(RequirePermission(Permission.accrual_edit))],
) -> AccrualPeriodDetail:
    try:
        period, _created = service.generate_candidates(
            actor=actor,
            period_id=period_id,
            correlation_id=correlation_id,
        )
    except SegregationOfDutiesError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except AccrualError as error:
        raise _refused(error) from error
    return _period_detail(period, service=service, user=actor)


@router.patch("/candidates/{candidate_id}", response_model=AccrualCandidateOut)
def edit_candidate(
    candidate_id: uuid.UUID,
    body: AccrualEditCandidateBody,
    service: AccrualServiceDep,
    session: SessionDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
    _: Annotated[None, Depends(RequirePermission(Permission.accrual_edit))],
) -> AccrualCandidateOut:
    try:
        updated = service.edit_candidate(
            actor=actor,
            candidate_id=candidate_id,
            amount_minor=body.amount_minor,
            currency=body.currency,
            exclude=body.exclude,
            reason=body.reason,
            note=body.note,
            description=body.description,
            expected_version=body.expected_version,
            correlation_id=correlation_id,
        )
    except SegregationOfDutiesError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except AccrualError as error:
        raise _refused(error) from error
    session.refresh(updated, attribute_names=["gl_account", "cost_centre"])
    return _candidate(updated)


@router.post("/candidates/{candidate_id}/finalize", response_model=AccrualCandidateOut)
def finalize_candidate(
    candidate_id: uuid.UUID,
    body: AccrualFinalizeCandidateBody,
    service: AccrualServiceDep,
    session: SessionDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
    _: Annotated[None, Depends(RequirePermission(Permission.accrual_finalize))],
) -> AccrualCandidateOut:
    try:
        updated = service.finalize_candidate(
            actor=actor,
            candidate_id=candidate_id,
            expected_version=body.expected_version,
            correlation_id=correlation_id,
        )
    except AccrualError as error:
        raise _refused(error) from error
    session.refresh(updated, attribute_names=["gl_account", "cost_centre"])
    return _candidate(updated)


@router.post("/periods/{period_id}/lock", response_model=AccrualPeriodDetail)
def lock_period(
    period_id: uuid.UUID,
    body: AccrualLockBody,
    service: AccrualServiceDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
    _: Annotated[None, Depends(RequirePermission(Permission.accrual_lock_period))],
) -> AccrualPeriodDetail:
    try:
        period = service.lock_period(
            actor=actor,
            period_id=period_id,
            reason=body.reason,
            expected_version=body.expected_version,
            correlation_id=correlation_id,
        )
    except SegregationOfDutiesError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except AccrualError as error:
        raise _refused(error) from error
    # Reload to pick up updated locked_at and refreshed relationships.
    period = service.get_period(period.id)
    return _period_detail(period, service=service, user=actor)


@router.post("/periods/{period_id}/export")
def export_period(
    period_id: uuid.UUID,
    body: AccrualExportBody,
    service: AccrualServiceDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
    _: Annotated[None, Depends(RequirePermission(Permission.accrual_export))],
) -> Response:
    try:
        result = service.export_period(
            actor=actor,
            period_id=period_id,
            format=body.format,
            official=body.official,
            correlation_id=correlation_id,
        )
    except AccrualError as error:
        raise _refused(error) from error

    media_type = (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        if body.format == "xlsx"
        else "text/csv"
    )
    return Response(
        content=result.data,
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{result.export.filename}"',
            "X-Accrual-Export-Version": str(result.export.version),
            "X-Accrual-Export-SHA256": result.export.sha256,
        },
    )
