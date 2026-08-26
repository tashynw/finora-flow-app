"""Tamper-evident audit trail.

Audit entries form a hash chain: each entry commits to the hash of its
predecessor, so altering or removing a historical row breaks verification for
every entry after it. The chain does not prevent tampering, it makes tampering
detectable, which is what an auditor needs.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Final
from uuid import UUID

GENESIS_HASH: Final[str] = "0" * 64


class AuditAction(StrEnum):
    # Authentication and access
    sign_in = "sign_in"
    sign_in_failed = "sign_in_failed"
    sign_out = "sign_out"
    permission_denied = "permission_denied"

    # Records
    record_created = "record_created"
    record_updated = "record_updated"
    state_changed = "state_changed"

    # Documents
    document_stored = "document_stored"
    document_viewed = "document_viewed"
    document_downloaded = "document_downloaded"
    document_quarantined = "document_quarantined"
    document_released = "document_released"

    # Intake
    message_ingested = "message_ingested"
    message_duplicate_detected = "message_duplicate_detected"
    intake_retried = "intake_retried"
    scan_completed = "scan_completed"

    # Reading a document
    extraction_completed = "extraction_completed"
    extraction_corrected = "extraction_corrected"
    extraction_accepted = "extraction_accepted"

    # AI
    ai_suggestion_produced = "ai_suggestion_produced"
    ai_suggestion_accepted = "ai_suggestion_accepted"
    ai_suggestion_rejected = "ai_suggestion_rejected"
    ai_kill_switch_changed = "ai_kill_switch_changed"

    # Workflow decisions
    approval_requested = "approval_requested"
    approval_withdrawn = "approval_withdrawn"
    sign_off_requested = "sign_off_requested"
    signed_off = "signed_off"
    #: A refusal to confirm receipt, which is a finding rather than a delay. The
    #: goods did not arrive, or not as billed, and somebody said so.
    sign_off_declined = "sign_off_declined"
    approved = "approved"
    rejected = "rejected"
    delegated = "delegated"
    overridden = "overridden"

    # Payment
    package_submitted = "package_submitted"
    marked_paid = "marked_paid"
    #: A supplier told us whether the money arrived. Kept distinct from the two
    #: below because it is the one payment entry an outsider causes, and it
    #: settles nothing on its own.
    vendor_confirmation_received = "vendor_confirmation_received"
    #: Somebody inside the organisation weighed that claim and concluded. This is
    #: the entry that means an invoice moved; the one above never does.
    vendor_confirmation_reviewed = "vendor_confirmation_reviewed"
    vendor_confirmation_requested = "vendor_confirmation_requested"

    # Credit cards
    credit_card_statement_imported = "credit_card_statement_imported"
    credit_card_transaction_coded = "credit_card_transaction_coded"
    credit_card_receipt_matched = "credit_card_receipt_matched"
    credit_card_period_closed = "credit_card_period_closed"

    # Accruals
    accrual_period_opened = "accrual_period_opened"
    accrual_candidates_generated = "accrual_candidates_generated"
    accrual_candidate_edited = "accrual_candidate_edited"
    accrual_candidate_finalized = "accrual_candidate_finalized"

    # Periods and exports
    period_locked = "period_locked"
    export_generated = "export_generated"

    # Mail
    mail_sent = "mail_sent"
    mail_failed = "mail_failed"
    reminder_sent = "reminder_sent"
    escalated = "escalated"

    # Signed deep links. Both outcomes are recorded, because a run of refused
    # links is what an attempt to guess or replay one looks like from the inside.
    link_issued = "link_issued"
    link_followed = "link_followed"
    link_refused = "link_refused"

    # Configuration
    configuration_changed = "configuration_changed"
    role_assigned = "role_assigned"


class ActorType(StrEnum):
    user = "user"
    service = "service"
    scheduler = "scheduler"
    # AI is recorded distinctly so a suggestion is never mistaken for a human
    # decision when the trail is read back.
    ai = "ai"
    external_vendor = "external_vendor"
    anonymous = "anonymous"


def _canonical(payload: dict[str, Any]) -> str:
    """Deterministic JSON so the same content always hashes identically.

    Sorted keys and no insignificant whitespace; without this, a dictionary
    re-serialised in a different order would appear to be tampering.
    """
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)


def compute_entry_hash(
    *,
    sequence: int,
    previous_hash: str,
    occurred_at: datetime,
    action: AuditAction,
    actor_type: ActorType,
    actor_id: UUID | None,
    actor_label: str,
    subject_type: str,
    subject_id: UUID | None,
    correlation_id: UUID | None,
    detail: dict[str, Any],
) -> str:
    if occurred_at.tzinfo is None:
        raise ValueError("occurred_at must be timezone aware")
    material = _canonical(
        {
            "sequence": sequence,
            "previous_hash": previous_hash,
            "occurred_at": occurred_at.astimezone(UTC).isoformat(),
            "action": str(action),
            "actor_type": str(actor_type),
            "actor_id": str(actor_id) if actor_id else None,
            "actor_label": actor_label,
            "subject_type": subject_type,
            "subject_id": str(subject_id) if subject_id else None,
            "correlation_id": str(correlation_id) if correlation_id else None,
            "detail": detail,
        }
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class AuditEntry:
    sequence: int
    previous_hash: str
    entry_hash: str
    occurred_at: datetime
    action: AuditAction
    actor_type: ActorType
    actor_id: UUID | None
    actor_label: str
    subject_type: str
    subject_id: UUID | None
    correlation_id: UUID | None
    detail: dict[str, Any]

    def recompute_hash(self) -> str:
        return compute_entry_hash(
            sequence=self.sequence,
            previous_hash=self.previous_hash,
            occurred_at=self.occurred_at,
            action=self.action,
            actor_type=self.actor_type,
            actor_id=self.actor_id,
            actor_label=self.actor_label,
            subject_type=self.subject_type,
            subject_id=self.subject_id,
            correlation_id=self.correlation_id,
            detail=self.detail,
        )

    @property
    def is_self_consistent(self) -> bool:
        return self.recompute_hash() == self.entry_hash


# Keys whose values must never reach the audit trail. The trail is widely
# readable by auditors, so it must not become a secret store.
REDACTED_KEYS: Final[frozenset[str]] = frozenset(
    {
        "password",
        "secret",
        "token",
        "api_key",
        "apikey",
        "client_secret",
        "signing_key",
        "authorization",
        "cookie",
        "session",
        "private_key",
        "raw_body",
        "attachment_content",
    }
)

REDACTION_PLACEHOLDER: Final[str] = "[redacted]"


def _is_sensitive(key: str) -> bool:
    lowered = key.lower()
    return any(marker in lowered for marker in REDACTED_KEYS)


def _scrub_mapping(value: dict[str, Any]) -> dict[str, Any]:
    return {
        key: REDACTION_PLACEHOLDER if _is_sensitive(key) else _scrub(item)
        for key, item in value.items()
    }


def _scrub(value: Any) -> Any:
    if isinstance(value, dict):
        return _scrub_mapping(value)
    if isinstance(value, list):
        return [_scrub(item) for item in value]
    return value


def redact(detail: dict[str, Any]) -> dict[str, Any]:
    """Strip sensitive values, recursing through nested structures."""
    return _scrub_mapping(detail)


def build_entry(
    *,
    sequence: int,
    previous_hash: str,
    action: AuditAction,
    actor_type: ActorType,
    actor_label: str,
    subject_type: str,
    actor_id: UUID | None = None,
    subject_id: UUID | None = None,
    correlation_id: UUID | None = None,
    detail: dict[str, Any] | None = None,
    occurred_at: datetime | None = None,
) -> AuditEntry:
    """Create the next entry in the chain, with sensitive values removed."""
    if sequence < 1:
        raise ValueError("sequence starts at 1")
    safe_detail = redact(detail or {})
    when = occurred_at or datetime.now(UTC)
    entry_hash = compute_entry_hash(
        sequence=sequence,
        previous_hash=previous_hash,
        occurred_at=when,
        action=action,
        actor_type=actor_type,
        actor_id=actor_id,
        actor_label=actor_label,
        subject_type=subject_type,
        subject_id=subject_id,
        correlation_id=correlation_id,
        detail=safe_detail,
    )
    return AuditEntry(
        sequence=sequence,
        previous_hash=previous_hash,
        entry_hash=entry_hash,
        occurred_at=when,
        action=action,
        actor_type=actor_type,
        actor_id=actor_id,
        actor_label=actor_label,
        subject_type=subject_type,
        subject_id=subject_id,
        correlation_id=correlation_id,
        detail=safe_detail,
    )


@dataclass(frozen=True, slots=True)
class ChainVerification:
    is_intact: bool
    entries_checked: int
    first_broken_sequence: int | None
    reason: str | None

    @property
    def summary(self) -> str:
        if self.is_intact:
            return f"Audit chain intact across {self.entries_checked} entries."
        return f"Audit chain broken at entry {self.first_broken_sequence}: {self.reason}"


def verify_chain(entries: list[AuditEntry]) -> ChainVerification:
    """Walk the chain and report the first inconsistency.

    Detects a modified entry, a removed entry and a reordered entry, because
    each of those changes either a recomputed hash or the expected linkage.
    """
    if not entries:
        return ChainVerification(True, 0, None, None)

    expected_previous = GENESIS_HASH
    expected_sequence = entries[0].sequence

    for index, entry in enumerate(entries):
        if entry.sequence != expected_sequence:
            return ChainVerification(
                False,
                index,
                entry.sequence,
                f"expected sequence {expected_sequence}, found {entry.sequence}; "
                "an entry is missing or out of order",
            )
        if index == 0:
            # A partial range legitimately starts mid-chain, so only the very
            # first entry of the whole trail must link to genesis.
            if entry.sequence == 1 and entry.previous_hash != GENESIS_HASH:
                return ChainVerification(
                    False, index, entry.sequence, "first entry does not link to genesis"
                )
        elif entry.previous_hash != expected_previous:
            return ChainVerification(
                False,
                index,
                entry.sequence,
                "previous hash does not match the preceding entry",
            )
        if not entry.is_self_consistent:
            return ChainVerification(
                False,
                index,
                entry.sequence,
                "entry content does not match its recorded hash",
            )
        expected_previous = entry.entry_hash
        expected_sequence = entry.sequence + 1

    return ChainVerification(True, len(entries), None, None)
