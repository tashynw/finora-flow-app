"""Maintain the vendor, GL account and cost-centre catalogues.

These rows feed every coding selector in the product. Soft-deactivate is preferred
over hard delete: an archived code stays readable against historical documents,
and the unique constraint on code still prevents a recycled identity from
pretending it was always that supplier or account.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

import structlog
from sqlalchemy import select
from sqlalchemy.orm import Session

from finora.domain.audit import ActorType, AuditAction
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import CostCentre, GlAccount, User, Vendor

logger = structlog.get_logger(__name__)

VENDOR_SUBJECT = "vendor"
GL_ACCOUNT_SUBJECT = "gl_account"
COST_CENTRE_SUBJECT = "cost_centre"


class ReferenceDataError(Exception):
    """A reference-data change that cannot be made."""


class NotFoundError(ReferenceDataError):
    pass


class ValidationError(ReferenceDataError):
    pass


def _require_reason(reason: str, *, prompt: str) -> str:
    cleaned = reason.strip()
    if len(cleaned) < 3:
        raise ValidationError(prompt)
    return cleaned


def _require_code(code: str) -> str:
    cleaned = code.strip().upper()
    if not cleaned:
        raise ValidationError("A code is required.")
    if len(cleaned) > 50:
        raise ValidationError("That code is too long.")
    return cleaned


def _require_name(name: str) -> str:
    cleaned = name.strip()
    if not cleaned:
        raise ValidationError("A name is required.")
    if len(cleaned) > 300:
        raise ValidationError("That name is too long.")
    return cleaned


class ReferenceDataService:
    def __init__(self, session: Session, *, audit: AuditRepository) -> None:
        self._session = session
        self._audit = audit

    # ------------------------------------------------------------------ vendors

    def list_vendors(self, *, include_inactive: bool = True) -> list[Vendor]:
        if include_inactive:
            query = select(Vendor).order_by(Vendor.code)
        else:
            query = (
                select(Vendor)
                .where(Vendor.is_active.is_(True), Vendor.archived_at.is_(None))
                .order_by(Vendor.code)
            )
        return list(self._session.execute(query).scalars())

    def get_vendor(self, vendor_id: UUID) -> Vendor:
        row = self._session.get(Vendor, vendor_id)
        if row is None:
            raise NotFoundError("That vendor was not found.")
        return row

    def create_vendor(
        self,
        *,
        actor: User,
        code: str,
        name: str,
        reason: str,
        email: str | None = None,
        phone: str | None = None,
        default_currency: str = "JMD",
        payment_terms_days: int | None = None,
        correlation_id: UUID | None = None,
    ) -> Vendor:
        cleaned_code = _require_code(code)
        cleaned_name = _require_name(name)
        cleaned_reason = _require_reason(reason, prompt="Say why this vendor is being added.")
        cleaned_currency = (default_currency or "JMD").strip().upper() or "JMD"
        if len(cleaned_currency) != 3:
            raise ValidationError("Currency must be a three-letter code.")
        if payment_terms_days is not None and payment_terms_days < 0:
            raise ValidationError("Payment terms cannot be negative.")

        existing = self._session.execute(
            select(Vendor).where(Vendor.code == cleaned_code)
        ).scalar_one_or_none()
        if existing is not None:
            raise ValidationError("A vendor with that code already exists.")

        row = Vendor(
            id=uuid4(),
            code=cleaned_code,
            name=cleaned_name,
            email=(email or "").strip() or None,
            phone=(phone or "").strip() or None,
            default_currency=cleaned_currency,
            payment_terms_days=payment_terms_days,
            is_active=True,
        )
        self._session.add(row)
        self._session.flush()

        self._audit.append(
            action=AuditAction.configuration_changed,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=VENDOR_SUBJECT,
            subject_id=row.id,
            correlation_id=correlation_id,
            detail={
                "action": "created",
                "code": row.code,
                "name": row.name,
                "reason": cleaned_reason,
            },
        )
        logger.info("vendor.created", vendor_id=str(row.id), code=row.code)
        return row

    def update_vendor(
        self,
        *,
        actor: User,
        vendor_id: UUID,
        reason: str,
        name: str | None = None,
        email: str | None = None,
        phone: str | None = None,
        default_currency: str | None = None,
        payment_terms_days: int | None = None,
        correlation_id: UUID | None = None,
    ) -> Vendor:
        row = self.get_vendor(vendor_id)
        cleaned_reason = _require_reason(reason, prompt="Say why this vendor is changing.")

        before = {
            "name": row.name,
            "email": row.email,
            "phone": row.phone,
            "default_currency": row.default_currency,
            "payment_terms_days": row.payment_terms_days,
        }

        if name is not None:
            row.name = _require_name(name)
        if email is not None:
            row.email = email.strip() or None
        if phone is not None:
            row.phone = phone.strip() or None
        if default_currency is not None:
            cleaned_currency = default_currency.strip().upper()
            if len(cleaned_currency) != 3:
                raise ValidationError("Currency must be a three-letter code.")
            row.default_currency = cleaned_currency
        if payment_terms_days is not None:
            if payment_terms_days < 0:
                raise ValidationError("Payment terms cannot be negative.")
            row.payment_terms_days = payment_terms_days

        self._session.flush()

        self._audit.append(
            action=AuditAction.configuration_changed,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=VENDOR_SUBJECT,
            subject_id=row.id,
            correlation_id=correlation_id,
            detail={
                "action": "updated",
                "code": row.code,
                "before": before,
                "after": {
                    "name": row.name,
                    "email": row.email,
                    "phone": row.phone,
                    "default_currency": row.default_currency,
                    "payment_terms_days": row.payment_terms_days,
                },
                "reason": cleaned_reason,
            },
        )
        logger.info("vendor.updated", vendor_id=str(row.id), code=row.code)
        return row

    def set_vendor_active(
        self,
        *,
        actor: User,
        vendor_id: UUID,
        is_active: bool,
        reason: str,
        correlation_id: UUID | None = None,
    ) -> Vendor:
        row = self.get_vendor(vendor_id)
        cleaned_reason = _require_reason(
            reason,
            prompt="Say why this vendor is being changed.",
        )
        if row.is_active is is_active and (
            (is_active and row.archived_at is None)
            or (not is_active and row.archived_at is not None)
        ):
            return row

        now = datetime.now(UTC)
        row.is_active = is_active
        if is_active:
            row.archived_at = None
            row.archived_reason = None
        else:
            row.archived_at = now
            row.archived_reason = cleaned_reason
        self._session.flush()

        self._audit.append(
            action=AuditAction.configuration_changed,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=VENDOR_SUBJECT,
            subject_id=row.id,
            correlation_id=correlation_id,
            detail={
                "action": "reactivated" if is_active else "deactivated",
                "code": row.code,
                "is_active": is_active,
                "reason": cleaned_reason,
                "changed_at": now.isoformat(),
            },
        )
        logger.info("vendor.active_set", vendor_id=str(row.id), is_active=is_active)
        return row

    # --------------------------------------------------------------- GL accounts

    def list_gl_accounts(self, *, include_inactive: bool = True) -> list[GlAccount]:
        if include_inactive:
            query = select(GlAccount).order_by(GlAccount.code)
        else:
            query = (
                select(GlAccount)
                .where(GlAccount.is_active.is_(True), GlAccount.archived_at.is_(None))
                .order_by(GlAccount.code)
            )
        return list(self._session.execute(query).scalars())

    def get_gl_account(self, account_id: UUID) -> GlAccount:
        row = self._session.get(GlAccount, account_id)
        if row is None:
            raise NotFoundError("That GL account was not found.")
        return row

    def create_gl_account(
        self,
        *,
        actor: User,
        code: str,
        name: str,
        reason: str,
        correlation_id: UUID | None = None,
    ) -> GlAccount:
        cleaned_code = _require_code(code)
        cleaned_name = _require_name(name)
        cleaned_reason = _require_reason(reason, prompt="Say why this GL account is being added.")

        existing = self._session.execute(
            select(GlAccount).where(GlAccount.code == cleaned_code)
        ).scalar_one_or_none()
        if existing is not None:
            raise ValidationError("A GL account with that code already exists.")

        row = GlAccount(
            id=uuid4(),
            code=cleaned_code,
            name=cleaned_name,
            is_active=True,
        )
        self._session.add(row)
        self._session.flush()

        self._audit.append(
            action=AuditAction.configuration_changed,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=GL_ACCOUNT_SUBJECT,
            subject_id=row.id,
            correlation_id=correlation_id,
            detail={
                "action": "created",
                "code": row.code,
                "name": row.name,
                "reason": cleaned_reason,
            },
        )
        logger.info("gl_account.created", account_id=str(row.id), code=row.code)
        return row

    def update_gl_account(
        self,
        *,
        actor: User,
        account_id: UUID,
        reason: str,
        name: str | None = None,
        correlation_id: UUID | None = None,
    ) -> GlAccount:
        row = self.get_gl_account(account_id)
        cleaned_reason = _require_reason(reason, prompt="Say why this GL account is changing.")
        before_name = row.name
        if name is not None:
            row.name = _require_name(name)
        self._session.flush()

        self._audit.append(
            action=AuditAction.configuration_changed,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=GL_ACCOUNT_SUBJECT,
            subject_id=row.id,
            correlation_id=correlation_id,
            detail={
                "action": "updated",
                "code": row.code,
                "before": {"name": before_name},
                "after": {"name": row.name},
                "reason": cleaned_reason,
            },
        )
        logger.info("gl_account.updated", account_id=str(row.id), code=row.code)
        return row

    def set_gl_account_active(
        self,
        *,
        actor: User,
        account_id: UUID,
        is_active: bool,
        reason: str,
        correlation_id: UUID | None = None,
    ) -> GlAccount:
        row = self.get_gl_account(account_id)
        cleaned_reason = _require_reason(reason, prompt="Say why this GL account is being changed.")
        if row.is_active is is_active and (
            (is_active and row.archived_at is None)
            or (not is_active and row.archived_at is not None)
        ):
            return row

        now = datetime.now(UTC)
        row.is_active = is_active
        if is_active:
            row.archived_at = None
            row.archived_reason = None
        else:
            row.archived_at = now
            row.archived_reason = cleaned_reason
        self._session.flush()

        self._audit.append(
            action=AuditAction.configuration_changed,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=GL_ACCOUNT_SUBJECT,
            subject_id=row.id,
            correlation_id=correlation_id,
            detail={
                "action": "reactivated" if is_active else "deactivated",
                "code": row.code,
                "is_active": is_active,
                "reason": cleaned_reason,
                "changed_at": now.isoformat(),
            },
        )
        logger.info("gl_account.active_set", account_id=str(row.id), is_active=is_active)
        return row

    # -------------------------------------------------------------- cost centres

    def list_cost_centres(self, *, include_inactive: bool = True) -> list[CostCentre]:
        if include_inactive:
            query = select(CostCentre).order_by(CostCentre.code)
        else:
            query = (
                select(CostCentre)
                .where(CostCentre.is_active.is_(True), CostCentre.archived_at.is_(None))
                .order_by(CostCentre.code)
            )
        return list(self._session.execute(query).scalars())

    def get_cost_centre(self, centre_id: UUID) -> CostCentre:
        row = self._session.get(CostCentre, centre_id)
        if row is None:
            raise NotFoundError("That cost centre was not found.")
        return row

    def create_cost_centre(
        self,
        *,
        actor: User,
        code: str,
        name: str,
        reason: str,
        department: str | None = None,
        correlation_id: UUID | None = None,
    ) -> CostCentre:
        cleaned_code = _require_code(code)
        cleaned_name = _require_name(name)
        cleaned_reason = _require_reason(reason, prompt="Say why this cost centre is being added.")

        existing = self._session.execute(
            select(CostCentre).where(CostCentre.code == cleaned_code)
        ).scalar_one_or_none()
        if existing is not None:
            raise ValidationError("A cost centre with that code already exists.")

        row = CostCentre(
            id=uuid4(),
            code=cleaned_code,
            name=cleaned_name,
            department=(department or "").strip() or None,
            is_active=True,
        )
        self._session.add(row)
        self._session.flush()

        self._audit.append(
            action=AuditAction.configuration_changed,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=COST_CENTRE_SUBJECT,
            subject_id=row.id,
            correlation_id=correlation_id,
            detail={
                "action": "created",
                "code": row.code,
                "name": row.name,
                "department": row.department,
                "reason": cleaned_reason,
            },
        )
        logger.info("cost_centre.created", centre_id=str(row.id), code=row.code)
        return row

    def update_cost_centre(
        self,
        *,
        actor: User,
        centre_id: UUID,
        reason: str,
        name: str | None = None,
        department: str | None = None,
        correlation_id: UUID | None = None,
    ) -> CostCentre:
        row = self.get_cost_centre(centre_id)
        cleaned_reason = _require_reason(reason, prompt="Say why this cost centre is changing.")
        before = {"name": row.name, "department": row.department}
        if name is not None:
            row.name = _require_name(name)
        if department is not None:
            row.department = department.strip() or None
        self._session.flush()

        self._audit.append(
            action=AuditAction.configuration_changed,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=COST_CENTRE_SUBJECT,
            subject_id=row.id,
            correlation_id=correlation_id,
            detail={
                "action": "updated",
                "code": row.code,
                "before": before,
                "after": {"name": row.name, "department": row.department},
                "reason": cleaned_reason,
            },
        )
        logger.info("cost_centre.updated", centre_id=str(row.id), code=row.code)
        return row

    def set_cost_centre_active(
        self,
        *,
        actor: User,
        centre_id: UUID,
        is_active: bool,
        reason: str,
        correlation_id: UUID | None = None,
    ) -> CostCentre:
        row = self.get_cost_centre(centre_id)
        cleaned_reason = _require_reason(
            reason, prompt="Say why this cost centre is being changed."
        )
        if row.is_active is is_active and (
            (is_active and row.archived_at is None)
            or (not is_active and row.archived_at is not None)
        ):
            return row

        now = datetime.now(UTC)
        row.is_active = is_active
        if is_active:
            row.archived_at = None
            row.archived_reason = None
        else:
            row.archived_at = now
            row.archived_reason = cleaned_reason
        self._session.flush()

        self._audit.append(
            action=AuditAction.configuration_changed,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=COST_CENTRE_SUBJECT,
            subject_id=row.id,
            correlation_id=correlation_id,
            detail={
                "action": "reactivated" if is_active else "deactivated",
                "code": row.code,
                "is_active": is_active,
                "reason": cleaned_reason,
                "changed_at": now.isoformat(),
            },
        )
        logger.info("cost_centre.active_set", centre_id=str(row.id), is_active=is_active)
        return row
