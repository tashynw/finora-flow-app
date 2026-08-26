"""Persistence for the hash-chained audit trail.

Appends must be serialized. Two concurrent writers reading the same tail would
produce two entries claiming the same predecessor, forking the chain and making
verification fail even though nothing was tampered with. A PostgreSQL advisory
lock held for the remainder of the transaction prevents that without locking the
whole table against readers.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import ColumnElement, func, select, text
from sqlalchemy.orm import Session

from finora.domain.audit import (
    GENESIS_HASH,
    ActorType,
    AuditAction,
    AuditEntry,
    ChainVerification,
    build_entry,
    verify_chain,
)
from finora.infrastructure.db.models import AuditEntryRow

# Arbitrary but fixed key identifying the audit-append lock.
_AUDIT_LOCK_KEY = 0x4649_4E4F  # "FINO"


class AuditRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def append(
        self,
        *,
        action: AuditAction,
        actor_type: ActorType,
        actor_label: str,
        subject_type: str,
        actor_id: uuid.UUID | None = None,
        subject_id: uuid.UUID | None = None,
        correlation_id: uuid.UUID | None = None,
        detail: dict[str, Any] | None = None,
        source_ip: str | None = None,
        user_agent: str | None = None,
        occurred_at: datetime | None = None,
    ) -> AuditEntryRow:
        """Append one entry, extending the chain from the current tail."""
        # Held until the transaction ends, so the read of the tail and the
        # insert that follows are atomic with respect to other appenders.
        self._session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _AUDIT_LOCK_KEY})

        tail = self._session.execute(
            select(AuditEntryRow.sequence, AuditEntryRow.entry_hash)
            .order_by(AuditEntryRow.sequence.desc())
            .limit(1)
        ).first()

        if tail is None:
            next_sequence = 1
            previous_hash = GENESIS_HASH
        else:
            next_sequence = tail.sequence + 1
            previous_hash = tail.entry_hash

        entry = build_entry(
            sequence=next_sequence,
            previous_hash=previous_hash,
            action=action,
            actor_type=actor_type,
            actor_id=actor_id,
            actor_label=actor_label,
            subject_type=subject_type,
            subject_id=subject_id,
            correlation_id=correlation_id,
            detail=detail,
            occurred_at=occurred_at,
        )

        row = AuditEntryRow(
            sequence=entry.sequence,
            previous_hash=entry.previous_hash,
            entry_hash=entry.entry_hash,
            occurred_at=entry.occurred_at,
            action=entry.action,
            actor_type=entry.actor_type,
            actor_id=entry.actor_id,
            actor_label=entry.actor_label,
            subject_type=entry.subject_type,
            subject_id=entry.subject_id,
            correlation_id=entry.correlation_id,
            detail=entry.detail,
            source_ip=source_ip,
            user_agent=user_agent,
        )
        self._session.add(row)
        self._session.flush()
        return row

    def append_and_commit(self, **kwargs: Any) -> AuditEntryRow:
        """Append and commit immediately, for events that must outlive a refusal.

        A rejected request rolls its transaction back, which would discard a
        failed sign-in or a permission denial recorded inside it. Those are
        precisely the events an investigator needs, so they are committed on the
        spot.

        Only safe to call before the request has written any business data,
        otherwise a partial write would be committed alongside it. Both current
        call sites are refusal paths that have written nothing else. Committing
        here also releases the advisory lock, so the same transaction can safely
        append again later.
        """
        row = self.append(**kwargs)
        self._session.commit()
        return row

    # ------------------------------------------------------------------ reads

    def _to_domain(self, row: AuditEntryRow) -> AuditEntry:
        return AuditEntry(
            sequence=row.sequence,
            previous_hash=row.previous_hash,
            entry_hash=row.entry_hash,
            occurred_at=row.occurred_at,
            action=row.action,
            actor_type=row.actor_type,
            actor_id=row.actor_id,
            actor_label=row.actor_label,
            subject_type=row.subject_type,
            subject_id=row.subject_id,
            correlation_id=row.correlation_id,
            detail=row.detail,
        )

    def for_subject(
        self, subject_type: str, subject_id: uuid.UUID, limit: int = 200
    ) -> list[AuditEntryRow]:
        return list(
            self._session.execute(
                select(AuditEntryRow)
                .where(
                    AuditEntryRow.subject_type == subject_type,
                    AuditEntryRow.subject_id == subject_id,
                )
                .order_by(AuditEntryRow.sequence.desc())
                .limit(limit)
            ).scalars()
        )

    def get(self, sequence: int) -> AuditEntryRow | None:
        return self._session.execute(
            select(AuditEntryRow).where(AuditEntryRow.sequence == sequence)
        ).scalar_one_or_none()

    def _filter_clauses(
        self,
        *,
        action: AuditAction | None = None,
        subject_type: str | None = None,
        subject_id: uuid.UUID | None = None,
        actor_id: uuid.UUID | None = None,
    ) -> list[ColumnElement[bool]]:
        clauses: list[ColumnElement[bool]] = []
        if action is not None:
            clauses.append(AuditEntryRow.action == action)
        if subject_type is not None:
            clauses.append(AuditEntryRow.subject_type == subject_type)
        if subject_id is not None:
            clauses.append(AuditEntryRow.subject_id == subject_id)
        if actor_id is not None:
            clauses.append(AuditEntryRow.actor_id == actor_id)
        return clauses

    def page(
        self,
        *,
        offset: int = 0,
        limit: int = 100,
        action: AuditAction | None = None,
        subject_type: str | None = None,
        subject_id: uuid.UUID | None = None,
        actor_id: uuid.UUID | None = None,
    ) -> list[AuditEntryRow]:
        query = select(AuditEntryRow)
        clauses = self._filter_clauses(
            action=action,
            subject_type=subject_type,
            subject_id=subject_id,
            actor_id=actor_id,
        )
        if clauses:
            query = query.where(*clauses)
        return list(
            self._session.execute(
                query.order_by(AuditEntryRow.sequence.asc()).offset(offset).limit(limit)
            ).scalars()
        )

    def count(
        self,
        *,
        action: AuditAction | None = None,
        subject_type: str | None = None,
        subject_id: uuid.UUID | None = None,
        actor_id: uuid.UUID | None = None,
    ) -> int:
        query = select(func.count()).select_from(AuditEntryRow)
        clauses = self._filter_clauses(
            action=action,
            subject_type=subject_type,
            subject_id=subject_id,
            actor_id=actor_id,
        )
        if clauses:
            query = query.where(*clauses)
        return self._session.execute(query).scalar() or 0

    def verify(self, *, start_sequence: int = 1, limit: int | None = None) -> ChainVerification:
        """Verify a contiguous range of the chain.

        Verification is offered as a range because a mature trail is too large to
        hash in one request; an auditor checks segments and the segments join
        because each carries its predecessor's hash.
        """
        query = (
            select(AuditEntryRow)
            .where(AuditEntryRow.sequence >= start_sequence)
            .order_by(AuditEntryRow.sequence.asc())
        )
        if limit is not None:
            query = query.limit(limit)
        rows = list(self._session.execute(query).scalars())
        return verify_chain([self._to_domain(r) for r in rows])
