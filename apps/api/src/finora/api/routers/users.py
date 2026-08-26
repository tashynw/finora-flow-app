"""User and role administration.

Accounts are created and roles are granted here. The composition check that
refuses `admin:approval_matrix` together with `approval:decide` lives in the
domain and is enforced on every create and role change — not merely hoped for
by which stock roles the seeds happen to use.
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
    UsersServiceDep,
)
from finora.application.users import (
    NotFoundError,
    UsersError,
    ValidationError,
    permission_labels,
)
from finora.domain.roles import Permission, Role, RoleCompositionError
from finora.infrastructure.db.models import User

router = APIRouter(prefix="/admin/users", tags=["users"])

_USERS = Depends(RequirePermission(Permission.admin_users))


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    department: str | None
    is_active: bool
    roles: list[str]
    permissions: list[str]


class UserCreateRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    display_name: str = Field(min_length=1, max_length=200)
    department: str | None = Field(default=None, max_length=200)
    roles: list[Role] = Field(min_length=1)
    reason: str = Field(min_length=3, max_length=500)


class UserRolesRequest(BaseModel):
    roles: list[Role]
    reason: str = Field(min_length=3, max_length=500)


class UserActiveRequest(BaseModel):
    is_active: bool
    reason: str = Field(min_length=3, max_length=500)


def _user_out(row: User) -> UserOut:
    roles = sorted(role.value for role in row.roles)
    return UserOut(
        id=row.id,
        email=row.email,
        display_name=row.display_name,
        department=row.department,
        is_active=row.is_active,
        roles=roles,
        permissions=permission_labels(row.roles),
    )


def _refused(error: UsersError | RoleCompositionError) -> HTTPException:
    if isinstance(error, NotFoundError):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error))
    if isinstance(error, RoleCompositionError):
        return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error))
    if isinstance(error, ValidationError):
        return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error))
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error))


@router.get("", response_model=list[UserOut], dependencies=[_USERS])
def list_users(
    service: UsersServiceDep,
    include_inactive: Annotated[bool, Query()] = True,
) -> list[UserOut]:
    return [_user_out(row) for row in service.list_users(include_inactive=include_inactive)]


@router.get("/{user_id}", response_model=UserOut, dependencies=[_USERS])
def read_user(user_id: uuid.UUID, service: UsersServiceDep) -> UserOut:
    try:
        return _user_out(service.get_user(user_id))
    except UsersError as error:
        raise _refused(error) from error


@router.post("", response_model=UserOut, status_code=status.HTTP_201_CREATED, dependencies=[_USERS])
def create_user(
    body: UserCreateRequest,
    service: UsersServiceDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> UserOut:
    try:
        row = service.create_user(
            actor=actor,
            email=body.email,
            display_name=body.display_name,
            department=body.department,
            roles=body.roles,
            reason=body.reason,
            correlation_id=correlation_id,
        )
    except (UsersError, RoleCompositionError) as error:
        raise _refused(error) from error
    return _user_out(row)


@router.put("/{user_id}/roles", response_model=UserOut, dependencies=[_USERS])
def set_roles(
    user_id: uuid.UUID,
    body: UserRolesRequest,
    service: UsersServiceDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> UserOut:
    try:
        row = service.set_roles(
            actor=actor,
            user_id=user_id,
            roles=body.roles,
            reason=body.reason,
            correlation_id=correlation_id,
        )
    except (UsersError, RoleCompositionError) as error:
        raise _refused(error) from error
    return _user_out(row)


@router.post("/{user_id}/active", response_model=UserOut, dependencies=[_USERS])
def set_active(
    user_id: uuid.UUID,
    body: UserActiveRequest,
    service: UsersServiceDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> UserOut:
    try:
        row = service.set_active(
            actor=actor,
            user_id=user_id,
            is_active=body.is_active,
            reason=body.reason,
            correlation_id=correlation_id,
        )
    except UsersError as error:
        raise _refused(error) from error
    return _user_out(row)
