"""Retention-policy administration.

One row per record class, seeded by migration. Update days or soft-deactivate;
v1 does not create arbitrary classes.
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
    RetentionServiceDep,
)
from finora.application.retention import (
    NotFoundError,
    RetentionError,
    ValidationError,
)
from finora.domain.roles import Permission
from finora.infrastructure.db.models import RetentionPolicy

router = APIRouter(prefix="/admin/retention", tags=["retention"])

_RETENTION = Depends(RequirePermission(Permission.admin_retention))


class RetentionPolicyOut(BaseModel):
    id: uuid.UUID
    record_class: str
    retention_days: int
    description: str
    is_active: bool


class RetentionUpdateRequest(BaseModel):
    retention_days: int = Field(ge=1)
    reason: str = Field(min_length=3, max_length=500)


class ActiveRequest(BaseModel):
    is_active: bool
    reason: str = Field(min_length=3, max_length=500)


def _policy_out(row: RetentionPolicy) -> RetentionPolicyOut:
    return RetentionPolicyOut(
        id=row.id,
        record_class=row.record_class,
        retention_days=row.retention_days,
        description=row.description,
        is_active=row.is_active,
    )


def _refused(error: RetentionError) -> HTTPException:
    if isinstance(error, NotFoundError):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error))
    if isinstance(error, ValidationError):
        return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error))
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error))


@router.get("", response_model=list[RetentionPolicyOut], dependencies=[_RETENTION])
def list_policies(
    service: RetentionServiceDep,
    include_inactive: Annotated[bool, Query()] = True,
) -> list[RetentionPolicyOut]:
    return [_policy_out(row) for row in service.list_policies(include_inactive=include_inactive)]


@router.patch(
    "/{policy_id}",
    response_model=RetentionPolicyOut,
    dependencies=[_RETENTION],
)
def update_policy(
    policy_id: uuid.UUID,
    body: RetentionUpdateRequest,
    service: RetentionServiceDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> RetentionPolicyOut:
    try:
        row = service.update(
            actor=actor,
            policy_id=policy_id,
            retention_days=body.retention_days,
            reason=body.reason,
            correlation_id=correlation_id,
        )
    except RetentionError as error:
        raise _refused(error) from error
    return _policy_out(row)


@router.post(
    "/{policy_id}/active",
    response_model=RetentionPolicyOut,
    dependencies=[_RETENTION],
)
def set_policy_active(
    policy_id: uuid.UUID,
    body: ActiveRequest,
    service: RetentionServiceDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> RetentionPolicyOut:
    try:
        row = service.set_active(
            actor=actor,
            policy_id=policy_id,
            is_active=body.is_active,
            reason=body.reason,
            correlation_id=correlation_id,
        )
    except RetentionError as error:
        raise _refused(error) from error
    return _policy_out(row)
