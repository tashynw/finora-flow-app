"""Queueing mail, and draining the queue.

Two halves that deliberately never run in the same place. `enqueue` is called by
business code inside the transaction that decided a message was warranted, and
writes a row. `OutboxDrain` is called by a worker afterwards and does the talking
to the mail server. Nothing in the first half can block on the network and nothing
in the second half can change a business record.

The claim protocol is the only subtle part. Two workers polling the same queue must
not both send the same message, so a row is claimed with `FOR UPDATE SKIP LOCKED`
and stamped `sending` before the send is attempted. A worker that dies mid-send
leaves a row stranded in `sending`, which is recovered by age rather than by a
person: after `CLAIM_TIMEOUT` the claim is treated as void and the row becomes
available again. That risks sending twice in the narrow case of a worker that is
merely slow rather than dead, which is the right way round: a duplicate reminder
is an annoyance, whereas a sign-off request that never arrives stops a payment.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol
from uuid import UUID

import structlog
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from finora.domain.audit import ActorType, AuditAction
from finora.domain.notifications import (
    CLAIM_TIMEOUT,
    MessageKind,
    OutboxState,
    retry_delay,
)
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import OutboxMessage

logger = structlog.get_logger(__name__)


class Mailer(Protocol):
    """Sends one message, or raises.

    A protocol so the drain can be exercised without a mail server, and so the
    SMTP client stays replaceable. Nothing here knows about SMTP.
    """

    def send(self, message: OutboxMessage) -> None: ...


@dataclass(frozen=True, slots=True)
class DrainResult:
    attempted: int
    sent: int
    failed: int
    abandoned: int

    @property
    def had_work(self) -> bool:
        return self.attempted > 0


def enqueue(
    session: Session,
    *,
    kind: MessageKind,
    idempotency_key: str,
    record_type: str,
    record_id: UUID,
    to_address: str,
    to_name: str,
    subject: str,
    body_text: str,
    cc_addresses: list[str] | None = None,
    in_reply_to: str | None = None,
    reply_to_address: str | None = None,
    correlation_id: UUID | None = None,
    domain: str = "finora.invalid",
) -> OutboxMessage | None:
    """Queue a message, or return None because it is already queued.

    The idempotency key is what makes a scheduler safe to run twice. A caller
    builds one that names the thing that should happen once — this record, this
    purpose, this point in its cycle — and a repeat becomes a no-op rather than a
    second email to somebody who is already annoyed.

    Uses a savepoint, so a collision does not poison the caller's transaction. The
    business change that prompted the message must still commit: a sign-off that
    rolls back because its notification was already queued would be absurd.
    """
    existing = session.execute(
        select(OutboxMessage).where(OutboxMessage.idempotency_key == idempotency_key)
    ).scalar_one_or_none()
    if existing is not None:
        return None

    message = OutboxMessage(
        kind=kind,
        state=OutboxState.pending,
        idempotency_key=idempotency_key,
        record_type=record_type,
        record_id=record_id,
        to_address=to_address,
        to_name=to_name,
        cc_addresses=list(cc_addresses or []),
        subject=subject,
        body_text=body_text,
        message_id=f"<{uuid.uuid4()}@{domain}>",
        in_reply_to=in_reply_to,
        reply_to_address=reply_to_address,
        available_at=datetime.now(UTC),
        correlation_id=correlation_id,
    )

    try:
        with session.begin_nested():
            session.add(message)
            session.flush()
    except IntegrityError:
        # Another transaction inserted the same key between the check above and
        # this flush. The unique index is the real guarantee; the earlier query is
        # only there to avoid the common case reaching it.
        logger.debug("outbox.duplicate_suppressed", idempotency_key=idempotency_key)
        return None

    return message


class OutboxDrain:
    """Sends what is waiting. Run by a worker, never inside a request."""

    def __init__(
        self,
        *,
        session: Session,
        mailer: Mailer,
        audit: AuditRepository,
        max_attempts: int = 5,
    ) -> None:
        self._session = session
        self._mailer = mailer
        self._audit = audit
        self._max_attempts = max_attempts

    def run_once(self, *, batch_size: int = 20) -> DrainResult:
        """Claim a batch and attempt each message in it."""
        claimed = self._claim(batch_size=batch_size)
        sent = failed = abandoned = 0

        for message in claimed:
            outcome = self._attempt(message)
            if outcome is OutboxState.sent:
                sent += 1
            elif outcome is OutboxState.abandoned:
                abandoned += 1
            else:
                failed += 1

        return DrainResult(attempted=len(claimed), sent=sent, failed=failed, abandoned=abandoned)

    def _claim(self, *, batch_size: int) -> list[OutboxMessage]:
        """Take ownership of up to `batch_size` messages that are ready to go.

        `SKIP LOCKED` is what makes more than one worker safe: a row another
        worker is already holding is passed over rather than waited for, so two
        workers share the queue instead of serialising on it.
        """
        now = datetime.now(UTC)
        stale = now - CLAIM_TIMEOUT

        rows = list(
            self._session.execute(
                select(OutboxMessage)
                .where(
                    OutboxMessage.available_at <= now,
                    or_(
                        OutboxMessage.state.in_([OutboxState.pending, OutboxState.failed]),
                        # Recovered by age. A worker that crashed mid-send left
                        # this row claimed and nothing else will ever release it.
                        (OutboxMessage.state == OutboxState.sending)
                        & (OutboxMessage.claimed_at < stale),
                    ),
                )
                .order_by(OutboxMessage.available_at, OutboxMessage.created_at)
                .limit(batch_size)
                .with_for_update(skip_locked=True)
            )
            .scalars()
            .all()
        )

        for row in rows:
            row.state = OutboxState.sending
            row.claimed_at = now
        self._session.flush()
        # Committed before any send is attempted, so the claim is visible to other
        # workers even while this one is talking to the mail server.
        self._session.commit()
        return rows

    def _attempt(self, message: OutboxMessage) -> OutboxState:
        message.attempts += 1
        try:
            self._mailer.send(message)
        except Exception as error:
            # Deliberately broad. Every way a send can go wrong is the same event
            # as far as the queue is concerned, and a mailer that raised something
            # unforeseen must still leave the row retryable rather than killing
            # the worker and stranding the rest of the batch.
            return self._record_failure(message, error)
        return self._record_success(message)

    def _record_success(self, message: OutboxMessage) -> OutboxState:
        message.state = OutboxState.sent
        message.sent_at = datetime.now(UTC)
        message.last_error = None
        self._session.flush()

        self._audit.append(
            action=AuditAction.mail_sent,
            actor_type=ActorType.service,
            actor_id=None,
            actor_label="outbox worker",
            subject_type=message.record_type,
            subject_id=message.record_id,
            correlation_id=message.correlation_id,
            detail={
                "kind": str(message.kind),
                "to": message.to_address,
                "cc": list(message.cc_addresses),
                "subject": message.subject,
                "message_id": message.message_id,
                "attempts": message.attempts,
            },
        )
        self._session.commit()
        logger.info(
            "outbox.sent",
            message_id=message.message_id,
            kind=str(message.kind),
            attempts=message.attempts,
        )
        return OutboxState.sent

    def _record_failure(self, message: OutboxMessage, error: Exception) -> OutboxState:
        """Back off and retry, or give up and say so.

        Giving up is a recorded event rather than a silent stop, because an
        approver who was never told is indistinguishable from one who is ignoring
        the request, and the two need entirely different interventions.
        """
        exhausted = message.attempts >= self._max_attempts
        message.state = OutboxState.abandoned if exhausted else OutboxState.failed
        message.claimed_at = None
        message.last_error = f"{type(error).__name__}: {error}"[:2000]
        if not exhausted:
            message.available_at = datetime.now(UTC) + retry_delay(message.attempts)
        self._session.flush()

        self._audit.append(
            action=AuditAction.mail_failed,
            actor_type=ActorType.service,
            actor_id=None,
            actor_label="outbox worker",
            subject_type=message.record_type,
            subject_id=message.record_id,
            correlation_id=message.correlation_id,
            detail={
                "kind": str(message.kind),
                "to": message.to_address,
                "attempts": message.attempts,
                "error": message.last_error,
                "given_up": exhausted,
            },
        )
        self._session.commit()

        logger.warning(
            "outbox.failed",
            message_id=message.message_id,
            kind=str(message.kind),
            attempts=message.attempts,
            given_up=exhausted,
            error=message.last_error,
        )
        return OutboxState.abandoned if exhausted else OutboxState.failed


def pending_count(session: Session) -> int:
    """How much mail is waiting. For the operational health screen."""
    return (
        session.execute(
            select(func.count())
            .select_from(OutboxMessage)
            .where(OutboxMessage.state.in_([OutboxState.pending, OutboxState.failed]))
        ).scalar_one()
        or 0
    )
