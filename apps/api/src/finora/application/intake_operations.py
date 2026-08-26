"""Operational health for intake.

Intake is the one part of the platform whose failure mode is silence. If the
worker stops, the scanner goes down or the mailbox fills, no user sees an error:
invoices simply stop arriving, which looks exactly like a quiet week. Every
measure here exists to make that silence visible.

The report is deliberately built from what is stored rather than from counters
held in memory, so a worker restart does not reset it.
"""

from __future__ import annotations

import socket
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import structlog
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from finora.config import ImapSettings
from finora.domain.intake import TERMINAL_INTAKE_STATUSES, IntakeStatus
from finora.infrastructure.db.models import InboundMessage, MailboxCheckpointRow
from finora.infrastructure.imap_client import ImapError, ImapMailbox

logger = structlog.get_logger(__name__)

#: A poll is expected every `poll_interval_seconds`. Three missed intervals is
#: treated as stalled: one missed interval is normal jitter, and waiting longer
#: would let a dead worker sit unnoticed through a working morning.
STALE_POLL_INTERVALS: int = 3

#: How long a message may sit unresolved before it is called out. Chosen to sit
#: under the three-hour sign-off reminder from the invoice workflow, so intake
#: cannot be the reason that clock is missed.
OLDEST_UNRESOLVED_WARN_AFTER = timedelta(hours=1)


class OperationalState:
    """Not an enum on purpose: these strings are compared in one place only."""

    healthy = "healthy"
    attention = "attention"
    stalled = "stalled"
    unknown = "unknown"


@dataclass(frozen=True, slots=True)
class CheckpointReport:
    folder: str
    uid_validity: int
    last_seen_uid: int
    last_polled_at: datetime | None
    seconds_since_poll: int | None
    last_reset_at: datetime | None
    last_reset_reason: str | None
    is_stalled: bool


@dataclass(frozen=True, slots=True)
class BacklogReport:
    """How much intake work is unresolved, and how old the oldest of it is.

    A count alone is not enough. Ten messages that arrived a minute ago is a
    healthy queue; one message stuck for six hours is an incident, and only the
    age distinguishes them.

    `in_flight` counts messages in a non-terminal status. Because scanning happens
    inside the ingest transaction, a committed row can never legitimately be
    mid-flight, so any non-zero value here means a process died holding a
    transaction open. It is reported rather than assumed impossible, since
    "impossible" states are the ones nobody notices.
    """

    counts_by_status: dict[str, int]
    in_flight: int
    quarantined: int
    failed: int
    oldest_unresolved_at: datetime | None
    oldest_unresolved_age_seconds: int | None

    @property
    def total(self) -> int:
        return sum(self.counts_by_status.values())

    @property
    def needs_attention(self) -> int:
        """Messages a person has to deal with before their document is usable."""
        return self.quarantined + self.failed


@dataclass(frozen=True, slots=True)
class MailboxReport:
    """Reachability, authentication and quota, each reported separately.

    They are separate because the remedy differs: an unreachable host is a
    network problem, a rejected login is a credential rotation, and a full
    mailbox needs someone to archive mail. Collapsing them into one "mail is
    broken" flag would send an operator looking in the wrong place.
    """

    reachable: bool
    authenticated: bool
    detail: str | None = None
    quota_supported: bool = False
    quota_used_kb: int | None = None
    quota_limit_kb: int | None = None
    quota_used_percent: float | None = None


@dataclass(frozen=True, slots=True)
class IntakeOperationsReport:
    generated_at: datetime
    state: str
    checkpoints: list[CheckpointReport]
    backlog: BacklogReport
    mailbox: MailboxReport | None
    concerns: list[str] = field(default_factory=list)


def probe_mailbox(settings: ImapSettings, *, timeout: float = 3.0) -> MailboxReport:
    """Check reachability, then credentials, then quota, in that order.

    Ordered so that each answer is meaningful. A login failure against an
    unreachable host says nothing about the credentials, so reachability is
    established first and reported on its own.

    Never raises. This is a health probe, and a probe that can fail the page it
    reports on is worse than no probe.
    """
    try:
        with socket.create_connection((settings.host, settings.port), timeout=timeout):
            pass
    except OSError as error:
        return MailboxReport(
            reachable=False,
            authenticated=False,
            detail=f"{settings.host}:{settings.port} is unreachable ({error.__class__.__name__}).",
        )

    if not settings.username:
        return MailboxReport(
            reachable=True,
            authenticated=False,
            detail="No mailbox credentials are configured.",
        )

    mailbox = ImapMailbox(settings)
    try:
        mailbox.connect()
    except ImapError as error:
        logger.warning("intake.mailbox_probe_login_failed", error=str(error))
        return MailboxReport(
            reachable=True,
            authenticated=False,
            detail="The mail server refused the configured credentials.",
        )

    try:
        quota = mailbox.quota(settings.folder_inbox)
        ratio = quota.used_ratio
        return MailboxReport(
            reachable=True,
            authenticated=True,
            quota_supported=quota.supported,
            quota_used_kb=quota.used_kb,
            quota_limit_kb=quota.limit_kb,
            quota_used_percent=ratio * 100 if ratio is not None else None,
        )
    except ImapError as error:
        # Authenticated but the quota query failed. Reported as authenticated,
        # because that is true and is what the credential remedy depends on.
        return MailboxReport(reachable=True, authenticated=True, detail=str(error))
    finally:
        mailbox.close()


def _stalled(
    last_polled_at: datetime | None, *, poll_interval_seconds: int
) -> tuple[bool, int | None]:
    if last_polled_at is None:
        # Never polled. Stalled rather than unknown: a checkpoint row that has
        # never recorded a poll means the worker has not run since it was created.
        return True, None
    age = int((datetime.now(UTC) - last_polled_at).total_seconds())
    return age > poll_interval_seconds * STALE_POLL_INTERVALS, age


def build_report(
    session: Session,
    *,
    poll_interval_seconds: int,
    mailbox: MailboxReport | None = None,
) -> IntakeOperationsReport:
    """Assemble the intake health picture from stored state.

    `mailbox` is passed in rather than probed here, so that rendering this report
    never depends on a live IMAP connection. A page that cannot load because the
    mailbox is down is the least useful moment for it to fail.
    """
    checkpoints: list[CheckpointReport] = []
    rows = session.execute(
        select(MailboxCheckpointRow).order_by(MailboxCheckpointRow.folder)
    ).scalars()
    for row in rows:
        is_stalled, age = _stalled(row.last_polled_at, poll_interval_seconds=poll_interval_seconds)
        checkpoints.append(
            CheckpointReport(
                folder=row.folder,
                uid_validity=row.uid_validity,
                last_seen_uid=row.last_seen_uid,
                last_polled_at=row.last_polled_at,
                seconds_since_poll=age,
                last_reset_at=row.last_reset_at,
                last_reset_reason=row.last_reset_reason,
                is_stalled=is_stalled,
            )
        )

    counts = {
        str(status): count
        for status, count in session.execute(
            select(InboundMessage.status, func.count()).group_by(InboundMessage.status)
        ).all()
    }

    in_flight_statuses = [s for s in IntakeStatus if s not in TERMINAL_INTAKE_STATUSES]

    # Anything that did not land cleanly on `ready`: still in flight, quarantined
    # or failed. All three leave a document unusable, and the age of the oldest is
    # what turns a queue into an incident.
    unresolved = [*in_flight_statuses, IntakeStatus.quarantined, IntakeStatus.failed]
    oldest = session.execute(
        select(func.min(InboundMessage.received_at)).where(InboundMessage.status.in_(unresolved))
    ).scalar_one_or_none()

    backlog = BacklogReport(
        counts_by_status=counts,
        in_flight=sum(counts.get(str(s), 0) for s in in_flight_statuses),
        quarantined=counts.get(str(IntakeStatus.quarantined), 0),
        failed=counts.get(str(IntakeStatus.failed), 0),
        oldest_unresolved_at=oldest,
        oldest_unresolved_age_seconds=(
            int((datetime.now(UTC) - oldest).total_seconds()) if oldest is not None else None
        ),
    )

    concerns = _concerns(checkpoints, backlog, mailbox)
    return IntakeOperationsReport(
        generated_at=datetime.now(UTC),
        state=_state(checkpoints, backlog, mailbox),
        checkpoints=checkpoints,
        backlog=backlog,
        mailbox=mailbox,
        concerns=concerns,
    )


def _concerns(
    checkpoints: list[CheckpointReport],
    backlog: BacklogReport,
    mailbox: MailboxReport | None,
) -> list[str]:
    """Plain-language descriptions of anything that needs a person.

    Written as sentences an operator can act on rather than metric names, because
    the reader of this page is on call, not reading a dashboard they built.
    """
    concerns: list[str] = []

    if not checkpoints:
        concerns.append(
            "The mailbox worker has never recorded a poll. "
            "Nothing is being collected from the mailbox."
        )
    for checkpoint in checkpoints:
        if checkpoint.is_stalled:
            concerns.append(
                f"Polling of {checkpoint.folder} has stalled. "
                + (
                    f"The last poll was {checkpoint.seconds_since_poll // 60} minutes ago."
                    if checkpoint.seconds_since_poll is not None
                    else "It has never completed a poll."
                )
            )
        if checkpoint.last_reset_reason:
            concerns.append(
                f"The checkpoint for {checkpoint.folder} was reset "
                f"({checkpoint.last_reset_reason.replace('_', ' ')}). "
                "Messages were re-read; duplicates were suppressed by identity."
            )

    age = backlog.oldest_unresolved_age_seconds
    if age is not None and age > OLDEST_UNRESOLVED_WARN_AFTER.total_seconds():
        concerns.append(
            f"The oldest unresolved message has been waiting {age // 3600} hours. "
            "Sign-off and approval clocks start from receipt, so this delay is already spent."
        )

    if backlog.in_flight:
        concerns.append(
            f"{backlog.in_flight} message(s) are recorded as still being processed. "
            "Intake scans inside its transaction, so this means a worker died mid-ingest."
        )

    if backlog.failed:
        concerns.append(
            f"{backlog.failed} message(s) failed intake and hold no usable document. "
            "Each needs to be retried or resent."
        )
    if backlog.quarantined:
        concerns.append(
            f"{backlog.quarantined} message(s) carry a quarantined attachment. "
            "Nothing was released; a reviewer decides whether the sender is resent to."
        )

    if mailbox is not None:
        if not mailbox.reachable:
            concerns.append(
                "The mailbox cannot be reached. Mail is accumulating there rather than being lost."
            )
        elif not mailbox.authenticated:
            concerns.append(
                "The mailbox rejected the platform's credentials. Rotate or correct them; "
                "no mail is being collected until then."
            )
        if mailbox.quota_used_percent is not None and mailbox.quota_used_percent >= 85:
            concerns.append(
                f"The mailbox is {mailbox.quota_used_percent:.0f}% full. "
                "A full mailbox refuses delivery, and that refusal happens outside this platform."
            )
        elif mailbox.reachable and not mailbox.quota_supported:
            concerns.append(
                "The mail server does not report quota, so the platform cannot warn before the "
                "mailbox fills."
            )

    return concerns


def _state(
    checkpoints: list[CheckpointReport],
    backlog: BacklogReport,
    mailbox: MailboxReport | None,
) -> str:
    """One word for the top of the page.

    Stalled outranks attention because a stalled worker means the other numbers
    are stale and therefore misleadingly calm.
    """
    if not checkpoints:
        return OperationalState.unknown
    if any(c.is_stalled for c in checkpoints):
        return OperationalState.stalled
    if mailbox is not None and not (mailbox.reachable and mailbox.authenticated):
        return OperationalState.stalled

    age = backlog.oldest_unresolved_age_seconds
    if (
        backlog.needs_attention
        or backlog.in_flight
        or (age is not None and age > OLDEST_UNRESOLVED_WARN_AFTER.total_seconds())
        or (mailbox is not None and (mailbox.quota_used_percent or 0) >= 85)
    ):
        return OperationalState.attention
    return OperationalState.healthy
