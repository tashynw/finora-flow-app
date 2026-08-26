"""Maintain retention periods per record class.

Classes are seeded by migration. v1 updates days and soft-deactivates only —
arbitrary new classes are not created through the API. Defaults are provisional
until the requirements document confirms them.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

import structlog
from sqlalchemy import select
from sqlalchemy.orm import Session

from finora.domain.audit import ActorType, AuditAction
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import RetentionPolicy, User

logger = structlog.get_logger(__name__)

RETENTION_SUBJECT = "retention_policy"


class RetentionError(Exception):
    """A retention change that cannot be made."""


class NotFoundError(RetentionError):
    pass


class ValidationError(RetentionError):
    pass


def _require_reason(reason: str, *, prompt: str) -> str:
    cleaned = reason.strip()
    if len(cleaned) < 3:
        raise ValidationError(prompt)
    return cleaned


def _require_days(retention_days: int) -> int:
    if not isinstance(retention_days, int) or isinstance(retention_days, bool):
        raise ValidationError("Retention must be a whole number of days.")
    if retention_days < 1:
        raise ValidationError("Retention must be at least one day.")
    return retention_days


class RetentionService:
    def __init__(self, session: Session, *, audit: AuditRepository) -> None:
        self._session = session
        self._audit = audit

    def list_policies(self, *, include_inactive: bool = True) -> list[RetentionPolicy]:
        query = select(RetentionPolicy).order_by(RetentionPolicy.record_class)
        if not include_inactive:
            query = query.where(RetentionPolicy.is_active.is_(True))
        return list(self._session.execute(query).scalars())

    def get_policy(self, policy_id: UUID) -> RetentionPolicy:
        row = self._session.get(RetentionPolicy, policy_id)
        if row is None:
            raise NotFoundError("That retention policy was not found.")
        return row

    def update(
        self,
        *,
        actor: User,
        policy_id: UUID,
        retention_days: int,
        reason: str,
        correlation_id: UUID | None = None,
    ) -> RetentionPolicy:
        row = self.get_policy(policy_id)
        cleaned_days = _require_days(retention_days)
        cleaned_reason = _require_reason(
            reason, prompt="Say why this retention period is changing."
        )

        if row.retention_days == cleaned_days:
            return row

        before = {"retention_days": row.retention_days}
        row.retention_days = cleaned_days
        self._session.flush()

        self._audit.append(
            action=AuditAction.configuration_changed,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RETENTION_SUBJECT,
            subject_id=row.id,
            correlation_id=correlation_id,
            detail={
                "action": "updated",
                "record_class": row.record_class,
                "before": before,
                "after": {"retention_days": row.retention_days},
                "reason": cleaned_reason,
            },
        )
        logger.info(
            "retention_policy.updated",
            policy_id=str(row.id),
            record_class=row.record_class,
            retention_days=row.retention_days,
        )
        return row

    def set_active(
        self,
        *,
        actor: User,
        policy_id: UUID,
        is_active: bool,
        reason: str,
        correlation_id: UUID | None = None,
    ) -> RetentionPolicy:
        row = self.get_policy(policy_id)
        cleaned_reason = _require_reason(
            reason,
            prompt="Say why this retention policy is being changed.",
        )
        if row.is_active is is_active:
            return row

        now = datetime.now(UTC)
        row.is_active = is_active
        self._session.flush()

        self._audit.append(
            action=AuditAction.configuration_changed,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RETENTION_SUBJECT,
            subject_id=row.id,
            correlation_id=correlation_id,
            detail={
                "action": "reactivated" if is_active else "deactivated",
                "record_class": row.record_class,
                "is_active": is_active,
                "reason": cleaned_reason,
                "changed_at": now.isoformat(),
            },
        )
        logger.info(
            "retention_policy.active_set",
            policy_id=str(row.id),
            record_class=row.record_class,
            is_active=is_active,
        )
        return row
