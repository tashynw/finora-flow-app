"""Operational settings: AI kill switch and read-only workflow snapshot."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from finora.api.deps import (
    AuditDep,
    CorrelationDep,
    CurrentUserDep,
    RequirePermission,
    SessionDep,
    SettingsDep,
)
from finora.application.operational_settings import (
    OperationalSettingsError,
    ValidationError,
    get_snapshot,
    set_ai_kill_switch,
)
from finora.domain.roles import Permission

router = APIRouter(prefix="/admin/operational-settings", tags=["operational-settings"])

_AI_CONFIG = Depends(RequirePermission(Permission.admin_ai_config))


class KillSwitchRequest(BaseModel):
    engaged: bool
    reason: str = Field(min_length=3, max_length=500)


class KillSwitchResponse(BaseModel):
    engaged: bool
    kill_switch_effective: bool


def _refused(error: OperationalSettingsError) -> HTTPException:
    if isinstance(error, ValidationError):
        return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error))
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error))


@router.get("", response_model=dict[str, Any], dependencies=[_AI_CONFIG])
def read_operational_settings(settings: SettingsDep) -> dict[str, Any]:
    """AI status and workflow policy snapshot. No secrets."""
    return get_snapshot(settings)


@router.post(
    "/ai-kill-switch",
    response_model=KillSwitchResponse,
    dependencies=[_AI_CONFIG],
)
def post_ai_kill_switch(
    body: KillSwitchRequest,
    session: SessionDep,
    audit: AuditDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> KillSwitchResponse:
    try:
        result = set_ai_kill_switch(
            session,
            audit,
            actor,
            engaged=body.engaged,
            reason=body.reason,
            correlation_id=correlation_id,
        )
    except OperationalSettingsError as error:
        raise _refused(error) from error
    return KillSwitchResponse(
        engaged=bool(result["engaged"]),
        kill_switch_effective=bool(result["kill_switch_effective"]),
    )
