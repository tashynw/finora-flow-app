"""Maintain purchase-order amount thresholds per currency.

One row per currency. An invoice at or below the figure needs no order; above
it, a purchase order is required. Soft-deactivate with `is_active` only — this
model has no SoftDeleteMixin — so a retired threshold stops applying without
losing the configured amount for audit and later reactivation.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

import structlog
from sqlalchemy import select
from sqlalchemy.orm import Session

from finora.domain.audit import ActorType, AuditAction
from finora.domain.money import CURRENCY_EXPONENTS, CurrencyError, Money
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import PurchaseOrderThreshold, User

logger = structlog.get_logger(__name__)

THRESHOLD_SUBJECT = "purchase_order_threshold"


class ThresholdError(Exception):
    """A threshold change that cannot be made."""


class NotFoundError(ThresholdError):
    pass


class ValidationError(ThresholdError):
    pass


def _require_reason(reason: str, *, prompt: str) -> str:
    cleaned = reason.strip()
    if len(cleaned) < 3:
        raise ValidationError(prompt)
    return cleaned


def _require_currency(currency: str) -> str:
    cleaned = (currency or "").strip().upper()
    if len(cleaned) != 3:
        raise ValidationError("Currency must be a three-letter code.")
    if cleaned not in CURRENCY_EXPONENTS:
        raise ValidationError(
            f"Unsupported currency {cleaned!r}. "
            "Add it to CURRENCY_EXPONENTS before configuring a threshold."
        )
    return cleaned


def _require_amount(applies_above_minor_units: int, currency: str) -> int:
    if not isinstance(applies_above_minor_units, int) or isinstance(
        applies_above_minor_units, bool
    ):
        raise ValidationError("The threshold amount must be a whole number of minor units.")
    if applies_above_minor_units < 0:
        raise ValidationError("The threshold amount cannot be negative.")
    try:
        Money(applies_above_minor_units, currency)
    except (CurrencyError, TypeError) as exc:
        raise ValidationError(str(exc)) from exc
    return applies_above_minor_units


class ThresholdService:
    def __init__(self, session: Session, *, audit: AuditRepository) -> None:
        self._session = session
        self._audit = audit

    def list_thresholds(self, *, include_inactive: bool = True) -> list[PurchaseOrderThreshold]:
        query = select(PurchaseOrderThreshold).order_by(PurchaseOrderThreshold.currency)
        if not include_inactive:
            query = query.where(PurchaseOrderThreshold.is_active.is_(True))
        return list(self._session.execute(query).scalars())

    def get_threshold(self, threshold_id: UUID) -> PurchaseOrderThreshold:
        row = self._session.get(PurchaseOrderThreshold, threshold_id)
        if row is None:
            raise NotFoundError("That purchase-order threshold was not found.")
        return row

    def upsert(
        self,
        *,
        actor: User,
        currency: str,
        applies_above_minor_units: int,
        reason: str,
        correlation_id: UUID | None = None,
    ) -> PurchaseOrderThreshold:
        """Create or replace the threshold for a currency.

        One row per currency. Re-saving the same currency updates the amount in
        place and reactivates a deactivated row, so administration never has to
        invent a second identity for the same control.
        """
        cleaned_currency = _require_currency(currency)
        cleaned_amount = _require_amount(applies_above_minor_units, cleaned_currency)
        cleaned_reason = _require_reason(
            reason, prompt="Say why this purchase-order threshold is changing."
        )

        existing = self._session.execute(
            select(PurchaseOrderThreshold).where(
                PurchaseOrderThreshold.currency == cleaned_currency
            )
        ).scalar_one_or_none()

        if existing is None:
            row = PurchaseOrderThreshold(
                id=uuid4(),
                currency=cleaned_currency,
                applies_above_minor_units=cleaned_amount,
                is_active=True,
            )
            self._session.add(row)
            self._session.flush()

            self._audit.append(
                action=AuditAction.configuration_changed,
                actor_type=ActorType.user,
                actor_id=actor.id,
                actor_label=actor.display_name,
                subject_type=THRESHOLD_SUBJECT,
                subject_id=row.id,
                correlation_id=correlation_id,
                detail={
                    "action": "created",
                    "currency": row.currency,
                    "applies_above_minor_units": row.applies_above_minor_units,
                    "reason": cleaned_reason,
                },
            )
            logger.info(
                "po_threshold.created",
                threshold_id=str(row.id),
                currency=row.currency,
            )
            return row

        before = {
            "applies_above_minor_units": existing.applies_above_minor_units,
            "is_active": existing.is_active,
        }
        existing.applies_above_minor_units = cleaned_amount
        existing.is_active = True
        self._session.flush()

        self._audit.append(
            action=AuditAction.configuration_changed,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=THRESHOLD_SUBJECT,
            subject_id=existing.id,
            correlation_id=correlation_id,
            detail={
                "action": "updated",
                "currency": existing.currency,
                "before": before,
                "after": {
                    "applies_above_minor_units": existing.applies_above_minor_units,
                    "is_active": existing.is_active,
                },
                "reason": cleaned_reason,
            },
        )
        logger.info(
            "po_threshold.updated",
            threshold_id=str(existing.id),
            currency=existing.currency,
        )
        return existing

    def set_active(
        self,
        *,
        actor: User,
        threshold_id: UUID,
        is_active: bool,
        reason: str,
        correlation_id: UUID | None = None,
    ) -> PurchaseOrderThreshold:
        row = self.get_threshold(threshold_id)
        cleaned_reason = _require_reason(
            reason,
            prompt="Say why this purchase-order threshold is being changed.",
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
            subject_type=THRESHOLD_SUBJECT,
            subject_id=row.id,
            correlation_id=correlation_id,
            detail={
                "action": "reactivated" if is_active else "deactivated",
                "currency": row.currency,
                "is_active": is_active,
                "reason": cleaned_reason,
                "changed_at": now.isoformat(),
            },
        )
        logger.info(
            "po_threshold.active_set",
            threshold_id=str(row.id),
            currency=row.currency,
            is_active=is_active,
        )
        return row
