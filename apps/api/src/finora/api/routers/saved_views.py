"""Personal saved views for work queue and registers."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from finora.api.deps import CurrentUserDep, SavedViewsServiceDep
from finora.application.saved_views import NotFoundError, SavedViewsError, ValidationError
from finora.infrastructure.db.models import SavedView

router = APIRouter(prefix="/saved-views", tags=["saved-views"])


class SavedViewOut(BaseModel):
    id: uuid.UUID
    scope: str
    name: str
    definition: dict[str, Any]
    is_default: bool


class SavedViewCreateRequest(BaseModel):
    scope: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=120)
    definition: dict[str, Any]
    is_default: bool = False


class SavedViewUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    definition: dict[str, Any] | None = None
    is_default: bool | None = None


def _out(row: SavedView) -> SavedViewOut:
    return SavedViewOut(
        id=row.id,
        scope=row.scope,
        name=row.name,
        definition=row.definition,
        is_default=row.is_default,
    )


def _refused(error: SavedViewsError) -> HTTPException:
    if isinstance(error, NotFoundError):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error))
    if isinstance(error, ValidationError):
        return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error))
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error))


@router.get("", response_model=list[SavedViewOut])
def list_views(
    service: SavedViewsServiceDep,
    user: CurrentUserDep,
    scope: str = Query(min_length=1, max_length=40),
) -> list[SavedViewOut]:
    try:
        return [_out(row) for row in service.list_for(user=user, scope=scope)]
    except SavedViewsError as error:
        raise _refused(error) from error


@router.post("", response_model=SavedViewOut, status_code=status.HTTP_201_CREATED)
def create_view(
    body: SavedViewCreateRequest,
    service: SavedViewsServiceDep,
    user: CurrentUserDep,
) -> SavedViewOut:
    try:
        row = service.create(
            user=user,
            scope=body.scope,
            name=body.name,
            definition=body.definition,
            is_default=body.is_default,
        )
    except SavedViewsError as error:
        raise _refused(error) from error
    return _out(row)


@router.patch("/{view_id}", response_model=SavedViewOut)
def update_view(
    view_id: uuid.UUID,
    body: SavedViewUpdateRequest,
    service: SavedViewsServiceDep,
    user: CurrentUserDep,
) -> SavedViewOut:
    try:
        row = service.update(
            user=user,
            view_id=view_id,
            name=body.name,
            definition=body.definition,
            is_default=body.is_default,
        )
    except SavedViewsError as error:
        raise _refused(error) from error
    return _out(row)


@router.delete("/{view_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_view(
    view_id: uuid.UUID,
    service: SavedViewsServiceDep,
    user: CurrentUserDep,
) -> None:
    try:
        service.delete(user=user, view_id=view_id)
    except SavedViewsError as error:
        raise _refused(error) from error
