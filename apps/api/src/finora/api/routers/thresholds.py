"""Purchase-order threshold administration.

One row per currency. An invoice at or below the figure needs no order; above
it, a purchase order is required. Soft-deactivate with `is_active` only.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from finora.api.deps import (
    CorrelationDep,
    CurrentUserDep,
    RequirePermission,
    ThresholdServiceDep,
)
from finora.application.thresholds import (
    NotFoundError,
    ThresholdError,
    ValidationError,
)
from finora.domain.roles import Permission
from finora.infrastructure.db.models import PurchaseOrderThreshold

router = APIRouter(prefix="/admin/thresholds", tags=["thresholds"])

_THRESHOLDS = Depends(RequirePermission(Permission.admin_thresholds))


class ThresholdOut(BaseModel):
    id: uuid.UUID
    currency: str
    applies_above_minor_units: int
    is_active: bool


class ThresholdUpsertRequest(BaseModel):
    currency: str = Field(min_length=3, max_length=3)
    applies_above_minor_units: int = Field(ge=0)
    reason: str = Field(min_length=3, max_length=500)


class ActiveRequest(BaseModel):
    is_active: bool
    reason: str = Field(min_length=3, max_length=500)


def _threshold_out(row: PurchaseOrderThreshold) -> ThresholdOut:
    return ThresholdOut(
        id=row.id,
        currency=row.currency,
        applies_above_minor_units=row.applies_above_minor_units,
        is_active=row.is_active,
    )


def _refused(error: ThresholdError) -> HTTPException:
    if isinstance(error, NotFoundError):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error))
    if isinstance(error, ValidationError):
        return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error))
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error))


@router.get("", response_model=list[ThresholdOut], dependencies=[_THRESHOLDS])
def list_thresholds(
    service: ThresholdServiceDep,
    include_inactive: Annotated[bool, Query()] = True,
) -> list[ThresholdOut]:
    return [
        _threshold_out(row) for row in service.list_thresholds(include_inactive=include_inactive)
    ]


@router.put("", response_model=ThresholdOut, dependencies=[_THRESHOLDS])
def upsert_threshold(
    body: ThresholdUpsertRequest,
    service: ThresholdServiceDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> ThresholdOut:
    try:
        row = service.upsert(
            actor=actor,
            currency=body.currency,
            applies_above_minor_units=body.applies_above_minor_units,
            reason=body.reason,
            correlation_id=correlation_id,
        )
    except ThresholdError as error:
        raise _refused(error) from error
    return _threshold_out(row)


@router.post(
    "/{threshold_id}/active",
    response_model=ThresholdOut,
    dependencies=[_THRESHOLDS],
)
def set_threshold_active(
    threshold_id: uuid.UUID,
    body: ActiveRequest,
    service: ThresholdServiceDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> ThresholdOut:
    try:
        row = service.set_active(
            actor=actor,
            threshold_id=threshold_id,
            is_active=body.is_active,
            reason=body.reason,
            correlation_id=correlation_id,
        )
    except ThresholdError as error:
        raise _refused(error) from error
    return _threshold_out(row)
