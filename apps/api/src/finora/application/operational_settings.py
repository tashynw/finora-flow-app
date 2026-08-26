"""Operational settings: AI kill switch and a read-only workflow snapshot.

Secrets never appear here. The snapshot is for operators who need to confirm what
the process is running with — reminder cadence, tolerances, link lifetimes —
without opening the environment or the secret store.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

import structlog
from sqlalchemy import select
from sqlalchemy.orm import Session

from finora.config import Settings
from finora.domain.audit import ActorType, AuditAction
from finora.infrastructure.ai_gateway import (
    AI_KILL_SWITCH_SETTING_KEY,
    effective_kill_switch,
    set_runtime_kill_switch,
)
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import SystemSetting, User

logger = structlog.get_logger(__name__)

SUBJECT_TYPE = "system_setting"


class OperationalSettingsError(Exception):
    """An operational-settings change that cannot be made."""


class ValidationError(OperationalSettingsError):
    pass


def _require_reason(reason: str) -> str:
    cleaned = reason.strip()
    if len(cleaned) < 3:
        raise ValidationError("Say why the AI kill switch is being changed.")
    return cleaned


def get_snapshot(settings: Settings) -> dict[str, Any]:
    """AI status and workflow policy as plain dicts — no secrets."""
    return {
        "ai": {
            "enabled": settings.ai.enabled,
            "kill_switch_env": settings.ai.kill_switch_engaged,
            "kill_switch_effective": effective_kill_switch(settings.ai.kill_switch_engaged),
            "model_extraction": settings.ai.model_extraction,
            "model_classification": settings.ai.model_classification,
        },
        "workflow": {
            "reminder_interval_hours": settings.workflow.reminder_interval_hours,
            "reminder_max_count": settings.workflow.reminder_max_count,
            "display_timezone": settings.workflow.display_timezone,
            "base_currency": settings.workflow.base_currency,
            "invoice_tolerance_percent": settings.workflow.invoice_tolerance_percent,
            "invoice_tolerance_minor_units": settings.workflow.invoice_tolerance_minor_units,
            "sign_off_link_ttl_hours": settings.workflow.sign_off_link_ttl_hours,
            "vendor_check_in_link_ttl_hours": settings.workflow.vendor_check_in_link_ttl_hours,
            "link_ttl_seconds": settings.auth.link_ttl_seconds,
        },
    }


def set_ai_kill_switch(
    session: Session,
    audit: AuditRepository,
    actor: User,
    *,
    engaged: bool,
    reason: str,
    correlation_id: UUID | None = None,
) -> dict[str, Any]:
    """Persist and apply the AI kill-switch override.

    Upserts `ai.kill_switch`, updates the process-wide runtime flag, and records
    an audit entry. Manual workflows remain completable either way.
    """
    cleaned_reason = _require_reason(reason)
    value = {"engaged": bool(engaged)}

    existing = session.execute(
        select(SystemSetting).where(SystemSetting.key == AI_KILL_SWITCH_SETTING_KEY)
    ).scalar_one_or_none()

    before: bool | None = None
    if existing is None:
        row = SystemSetting(
            id=uuid4(),
            key=AI_KILL_SWITCH_SETTING_KEY,
            value=value,
            description="Runtime AI kill switch. When engaged, the gateway makes no calls.",
            updated_by_id=actor.id,
            change_reason=cleaned_reason,
        )
        session.add(row)
        subject_id = row.id
    else:
        previous = existing.value if isinstance(existing.value, dict) else {}
        prior = previous.get("engaged")
        before = prior if isinstance(prior, bool) else None
        existing.value = value
        existing.updated_by_id = actor.id
        existing.change_reason = cleaned_reason
        subject_id = existing.id

    session.flush()
    set_runtime_kill_switch(bool(engaged))

    audit.append(
        action=AuditAction.ai_kill_switch_changed,
        actor_type=ActorType.user,
        actor_id=actor.id,
        actor_label=actor.display_name,
        subject_type=SUBJECT_TYPE,
        subject_id=subject_id,
        correlation_id=correlation_id,
        detail={
            "key": AI_KILL_SWITCH_SETTING_KEY,
            "engaged": bool(engaged),
            "before": before,
            "reason": cleaned_reason,
        },
    )
    logger.info(
        "ai.kill_switch_changed",
        engaged=bool(engaged),
        actor_id=str(actor.id),
    )
    return {
        "engaged": bool(engaged),
        "kill_switch_effective": effective_kill_switch(
            # Env is irrelevant once runtime is set; pass False for clarity.
            False
        ),
    }
