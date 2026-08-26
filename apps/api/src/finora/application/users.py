"""Create and maintain the accounts people sign in with.

Role grants are where threat model T5's residual risk lives: editing the approval
matrix and deciding approvals are not actions on the same record, so the
per-record segregation check never sees both sides. Composition is refused here,
when the roles are written, rather than hoped for by configuration discipline.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

import structlog
from sqlalchemy import select
from sqlalchemy.orm import Session

from finora.domain.audit import ActorType, AuditAction
from finora.domain.roles import (
    Role,
    RoleCompositionError,
    assert_roles_compatible,
    permissions_for,
)
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import User, UserRole

logger = structlog.get_logger(__name__)

USER_SUBJECT = "user"


class UsersError(Exception):
    """A user-administration change that cannot be made."""


class NotFoundError(UsersError):
    pass


class ValidationError(UsersError):
    pass


class UsersService:
    def __init__(self, session: Session, *, audit: AuditRepository) -> None:
        self._session = session
        self._audit = audit

    def list_users(self, *, include_inactive: bool = True) -> list[User]:
        query = select(User).order_by(User.display_name)
        if not include_inactive:
            query = query.where(User.is_active.is_(True))
        return list(self._session.execute(query).scalars())

    def get_user(self, user_id: UUID) -> User:
        row = self._session.get(User, user_id)
        if row is None or row.archived_at is not None:
            raise NotFoundError("That account was not found.")
        return row

    def create_user(
        self,
        *,
        actor: User,
        email: str,
        display_name: str,
        department: str | None,
        roles: list[Role],
        reason: str,
        correlation_id: UUID | None = None,
    ) -> User:
        cleaned_email = email.strip().lower()
        cleaned_name = display_name.strip()
        cleaned_reason = reason.strip()
        if not cleaned_email or "@" not in cleaned_email:
            raise ValidationError("A valid email address is required.")
        if not cleaned_name:
            raise ValidationError("A display name is required.")
        if len(cleaned_reason) < 3:
            raise ValidationError("Say why this account is being created.")

        proposed = frozenset(roles)
        try:
            assert_roles_compatible(proposed)
        except RoleCompositionError:
            raise

        existing = self._session.execute(
            select(User).where(User.email == cleaned_email)
        ).scalar_one_or_none()
        if existing is not None and existing.archived_at is None:
            raise ValidationError("An account with that email already exists.")

        row = User(
            id=uuid4(),
            email=cleaned_email,
            display_name=cleaned_name,
            department=(department or "").strip() or None,
            is_active=True,
        )
        self._session.add(row)
        self._session.flush()

        for role in sorted(proposed, key=lambda item: item.value):
            self._session.add(
                UserRole(
                    id=uuid4(),
                    user_id=row.id,
                    role=role,
                    granted_by_id=actor.id,
                    granted_reason=cleaned_reason,
                )
            )
        self._session.flush()
        self._session.refresh(row)

        self._audit.append(
            action=AuditAction.role_assigned,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=USER_SUBJECT,
            subject_id=row.id,
            correlation_id=correlation_id,
            detail={
                "email": row.email,
                "display_name": row.display_name,
                "roles": sorted(role.value for role in proposed),
                "reason": cleaned_reason,
                "created": True,
            },
        )
        logger.info(
            "user.created",
            user_id=str(row.id),
            email=row.email,
            roles=sorted(role.value for role in proposed),
        )
        return row

    def set_roles(
        self,
        *,
        actor: User,
        user_id: UUID,
        roles: list[Role],
        reason: str,
        correlation_id: UUID | None = None,
    ) -> User:
        row = self.get_user(user_id)
        cleaned_reason = reason.strip()
        if len(cleaned_reason) < 3:
            raise ValidationError("Say why these roles are changing.")

        proposed = frozenset(roles)
        try:
            assert_roles_compatible(proposed)
        except RoleCompositionError:
            raise

        current = frozenset(row.roles)
        if proposed == current:
            return row

        for assignment in list(row.role_assignments):
            self._session.delete(assignment)
        self._session.flush()

        for role in sorted(proposed, key=lambda item: item.value):
            self._session.add(
                UserRole(
                    id=uuid4(),
                    user_id=row.id,
                    role=role,
                    granted_by_id=actor.id,
                    granted_reason=cleaned_reason,
                )
            )
        self._session.flush()
        self._session.refresh(row)

        self._audit.append(
            action=AuditAction.role_assigned,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=USER_SUBJECT,
            subject_id=row.id,
            correlation_id=correlation_id,
            detail={
                "email": row.email,
                "before": sorted(role.value for role in current),
                "after": sorted(role.value for role in proposed),
                "reason": cleaned_reason,
            },
        )
        logger.info(
            "user.roles_set",
            user_id=str(row.id),
            before=sorted(role.value for role in current),
            after=sorted(role.value for role in proposed),
        )
        return row

    def set_active(
        self,
        *,
        actor: User,
        user_id: UUID,
        is_active: bool,
        reason: str,
        correlation_id: UUID | None = None,
    ) -> User:
        row = self.get_user(user_id)
        cleaned_reason = reason.strip()
        if len(cleaned_reason) < 3:
            raise ValidationError("Say why this account is being changed.")
        if row.id == actor.id and not is_active:
            raise ValidationError("You cannot deactivate your own account.")
        if row.is_active is is_active:
            return row

        row.is_active = is_active
        if not is_active:
            row.out_of_office_until = None
            row.delegate_to_id = None
        self._session.flush()

        self._audit.append(
            action=AuditAction.configuration_changed,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=USER_SUBJECT,
            subject_id=row.id,
            correlation_id=correlation_id,
            detail={
                "email": row.email,
                "is_active": is_active,
                "reason": cleaned_reason,
                "changed_at": datetime.now(UTC).isoformat(),
            },
        )
        logger.info(
            "user.active_set",
            user_id=str(row.id),
            is_active=is_active,
        )
        return row


def permission_labels(roles: frozenset[Role] | set[Role] | list[Role]) -> list[str]:
    return sorted(permission.value for permission in permissions_for(roles))
