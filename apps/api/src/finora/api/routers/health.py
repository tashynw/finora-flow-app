"""Health and readiness.

Liveness and readiness are separate on purpose. Liveness answers "is this
process alive", so it must not touch a dependency; a database blip should not
cause an orchestrator to kill an otherwise healthy process. Readiness answers
"should traffic be routed here", so it does check dependencies.
"""

from __future__ import annotations

import socket
from enum import StrEnum

from fastapi import APIRouter, Response, status
from pydantic import BaseModel
from sqlalchemy import text

from finora import __version__
from finora.api.deps import SessionDep, SettingsDep
from finora.infrastructure.ai_gateway import effective_kill_switch

router = APIRouter(tags=["health"])


class DependencyState(StrEnum):
    up = "up"
    down = "down"
    degraded = "degraded"
    not_configured = "not_configured"


class DependencyReport(BaseModel):
    name: str
    state: DependencyState
    detail: str | None = None


class LivenessResponse(BaseModel):
    status: str
    version: str


class ReadinessResponse(BaseModel):
    ready: bool
    version: str
    environment: str
    dependencies: list[DependencyReport]


@router.get("/health/live", response_model=LivenessResponse)
def liveness() -> LivenessResponse:
    return LivenessResponse(status="alive", version=__version__)


def _check_tcp(host: str, port: int, *, timeout: float = 2.0) -> tuple[DependencyState, str | None]:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return DependencyState.up, None
    except OSError as exc:
        return DependencyState.down, f"{host}:{port} unreachable ({exc.__class__.__name__})"


@router.get("/health/ready", response_model=ReadinessResponse)
def readiness(settings: SettingsDep, session: SessionDep, response: Response) -> ReadinessResponse:
    reports: list[DependencyReport] = []

    try:
        session.execute(text("SELECT 1"))
        reports.append(DependencyReport(name="postgresql", state=DependencyState.up))
    except Exception as exc:
        reports.append(
            DependencyReport(
                name="postgresql",
                state=DependencyState.down,
                detail=exc.__class__.__name__,
            )
        )

    redis_state, redis_detail = _check_tcp(settings.redis.host, settings.redis.port)
    reports.append(DependencyReport(name="redis", state=redis_state, detail=redis_detail))

    scanner_state, scanner_detail = _check_tcp(settings.scanner.host, settings.scanner.port)
    reports.append(
        DependencyReport(
            name="malware_scanner",
            state=scanner_state,
            detail=scanner_detail
            or ("fails closed when down" if scanner_state is DependencyState.up else None),
        )
    )

    if settings.object_store.endpoint_url:
        host, _, port = (
            settings.object_store.endpoint_url.removeprefix("http://")
            .removeprefix("https://")
            .partition(":")
        )
        s3_state, s3_detail = _check_tcp(host, int(port) if port else 443)
    else:
        s3_state, s3_detail = DependencyState.not_configured, "no endpoint configured"
    reports.append(DependencyReport(name="object_storage", state=s3_state, detail=s3_detail))

    imap_state, imap_detail = _check_tcp(settings.imap.host, settings.imap.port)
    reports.append(DependencyReport(name="imap", state=imap_state, detail=imap_detail))

    smtp_state, smtp_detail = _check_tcp(settings.smtp.host, settings.smtp.port)
    reports.append(DependencyReport(name="smtp", state=smtp_state, detail=smtp_detail))

    if effective_kill_switch(settings.ai.kill_switch_engaged):
        reports.append(
            DependencyReport(
                name="ai_gateway",
                state=DependencyState.not_configured,
                detail="kill switch engaged; manual workflows unaffected",
            )
        )
    elif not settings.ai.enabled:
        reports.append(
            DependencyReport(
                name="ai_gateway",
                state=DependencyState.not_configured,
                detail="disabled by configuration",
            )
        )
    else:
        reports.append(DependencyReport(name="ai_gateway", state=DependencyState.up))

    # Only PostgreSQL is required to serve traffic. AI, mail and scanning
    # failures degrade specific features and are surfaced in operational health
    # rather than taking the whole application out of rotation.
    critical = {"postgresql"}
    ready = all(r.state is not DependencyState.down for r in reports if r.name in critical)
    if not ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE

    return ReadinessResponse(
        ready=ready,
        version=__version__,
        environment=str(settings.environment),
        dependencies=reports,
    )
