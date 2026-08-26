"""Intake operational health.

Intake fails silently. A stopped worker, a rejected credential or a full mailbox
all produce the same observable outcome as a quiet week: nothing arrives. These
tests check that each of those conditions is reported as a problem rather than
being absorbed into a calm-looking dashboard, which is the whole point of the
report.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session
from tests.conftest import requires_db
from tests.integration.test_intake_service import (
    FakeScanner,
    build_message,
    build_service,
)

from finora.application.intake import ImapProvenance
from finora.application.intake_operations import (
    STALE_POLL_INTERVALS,
    IntakeOperationsReport,
    MailboxReport,
    OperationalState,
    build_report,
)
from finora.domain.intake import IntakeSource, ScanVerdict
from finora.infrastructure.db.models import InboundMessage, MailboxCheckpointRow

POLL_INTERVAL = 60


def add_checkpoint(
    session: Session,
    *,
    folder: str = "INBOX",
    last_polled_at: datetime | None = None,
    uid_validity: int = 100,
    last_seen_uid: int = 5,
    reset_reason: str | None = None,
) -> MailboxCheckpointRow:
    row = MailboxCheckpointRow(
        folder=folder,
        uid_validity=uid_validity,
        last_seen_uid=last_seen_uid,
    )
    row.last_polled_at = last_polled_at
    row.last_reset_reason = reset_reason
    if reset_reason:
        row.last_reset_at = datetime.now(UTC)
    session.add(row)
    session.commit()
    return row


def report_for(session: Session, mailbox: MailboxReport | None = None) -> IntakeOperationsReport:
    return build_report(session, poll_interval_seconds=POLL_INTERVAL, mailbox=mailbox)


def ingest(
    session: Session,
    *,
    message_id: str,
    scanner: FakeScanner | None = None,
    uid: int = 1,
) -> InboundMessage:
    """Put one real message through intake.

    IMAP provenance is supplied because a check constraint requires it for an
    `imap` message: a mailbox-sourced record with no folder or UID cannot be
    traced back to what was delivered.
    """
    service, _, _ = build_service(session, scanner=scanner)
    outcome = service.ingest(
        build_message(message_id=message_id),
        source=IntakeSource.imap,
        correlation_id=uuid.uuid4(),
        imap=ImapProvenance(folder="INBOX", uid=uid, uid_validity=100),
    )
    session.commit()
    return outcome.message


@requires_db
class TestWorkerLiveness:
    def test_no_checkpoint_at_all_is_not_reported_as_healthy(self, db_session: Session) -> None:
        """An empty intake table and a dead worker look identical from the outside.

        Reporting `healthy` here would mean the first thing an operator sees after
        a worker that never started is a green page.
        """
        report = report_for(db_session)

        assert report.state == OperationalState.unknown
        assert any("never recorded a poll" in concern for concern in report.concerns)

    def test_a_recent_poll_is_healthy(self, db_session: Session) -> None:
        add_checkpoint(db_session, last_polled_at=datetime.now(UTC))

        report = report_for(db_session)

        assert report.state == OperationalState.healthy
        assert report.concerns == []
        assert report.checkpoints[0].is_stalled is False
        assert report.checkpoints[0].seconds_since_poll is not None

    def test_one_missed_interval_is_still_healthy(self, db_session: Session) -> None:
        """Jitter is normal. Alerting on a single missed poll trains people to
        ignore the alert, which costs more than the delay it reports."""
        add_checkpoint(
            db_session,
            last_polled_at=datetime.now(UTC) - timedelta(seconds=POLL_INTERVAL + 5),
        )

        assert report_for(db_session).state == OperationalState.healthy

    def test_several_missed_intervals_is_stalled(self, db_session: Session) -> None:
        add_checkpoint(
            db_session,
            last_polled_at=datetime.now(UTC)
            - timedelta(seconds=POLL_INTERVAL * (STALE_POLL_INTERVALS + 1)),
        )

        report = report_for(db_session)

        assert report.state == OperationalState.stalled
        assert report.checkpoints[0].is_stalled is True
        assert any("stalled" in concern for concern in report.concerns)

    def test_a_checkpoint_that_never_polled_is_stalled(self, db_session: Session) -> None:
        """The row exists, so the worker created it and then stopped."""
        add_checkpoint(db_session, last_polled_at=None)

        report = report_for(db_session)

        assert report.state == OperationalState.stalled
        assert report.checkpoints[0].seconds_since_poll is None

    def test_a_checkpoint_reset_is_surfaced_without_alarming(self, db_session: Session) -> None:
        """A reset is worth knowing about but is not itself a failure: duplicate
        detection is what makes the re-read safe, and the message says so."""
        add_checkpoint(
            db_session,
            last_polled_at=datetime.now(UTC),
            reset_reason="uidvalidity_changed",
        )

        report = report_for(db_session)

        concern = next(c for c in report.concerns if "reset" in c)
        assert "uidvalidity changed" in concern
        assert "duplicates were suppressed" in concern.lower()


@requires_db
class TestBacklog:
    def test_a_cleanly_ingested_message_is_not_backlog(self, db_session: Session) -> None:
        add_checkpoint(db_session, last_polled_at=datetime.now(UTC))
        ingest(db_session, message_id="<one@v.example>")

        report = report_for(db_session)

        assert report.backlog.total == 1
        assert report.backlog.counts_by_status["ready"] == 1
        # Nothing is unresolved, so no age is reported. A dashboard that aged
        # every message would show a growing number that means nothing.
        assert report.backlog.needs_attention == 0
        assert report.backlog.oldest_unresolved_at is None
        assert report.state == OperationalState.healthy

    def test_a_quarantined_message_needs_attention_and_is_aged(self, db_session: Session) -> None:
        add_checkpoint(db_session, last_polled_at=datetime.now(UTC))
        ingest(
            db_session,
            message_id="<bad@v.example>",
            scanner=FakeScanner(verdict=ScanVerdict.infected, detail="Eicar-Test"),
        )

        report = report_for(db_session)

        assert report.backlog.quarantined == 1
        assert report.backlog.needs_attention == 1
        assert report.backlog.oldest_unresolved_at is not None
        assert report.state == OperationalState.attention
        concern = next(c for c in report.concerns if "quarantined" in c)
        assert "Nothing was released" in concern

    def test_a_long_wait_is_reported_even_when_the_worker_is_healthy(
        self, db_session: Session
    ) -> None:
        """A running worker and a stuck message are different failures.

        Sign-off and approval clocks run from receipt, so an old unresolved
        message has already spent time the workflow was counting on.
        """
        add_checkpoint(db_session, last_polled_at=datetime.now(UTC))
        message = ingest(
            db_session,
            message_id="<old@v.example>",
            scanner=FakeScanner(verdict=ScanVerdict.unscannable, detail="Encrypted archive"),
        )
        message.received_at = datetime.now(UTC) - timedelta(hours=4)
        db_session.commit()

        report = report_for(db_session)

        assert report.state == OperationalState.attention
        assert any("waiting 4 hours" in c for c in report.concerns)
        assert report.checkpoints[0].is_stalled is False


@requires_db
class TestMailbox:
    def test_unreachable_is_distinguished_from_rejected_credentials(
        self, db_session: Session
    ) -> None:
        """The remedies are different, so the report must not merge them."""
        add_checkpoint(db_session, last_polled_at=datetime.now(UTC))

        unreachable = report_for(
            db_session, MailboxReport(reachable=False, authenticated=False, detail="down")
        )
        rejected = report_for(
            db_session, MailboxReport(reachable=True, authenticated=False, detail="bad login")
        )

        assert any("cannot be reached" in c for c in unreachable.concerns)
        assert any("rejected the platform's credentials" in c for c in rejected.concerns)
        assert unreachable.state == OperationalState.stalled
        assert rejected.state == OperationalState.stalled

    def test_a_nearly_full_mailbox_is_called_out(self, db_session: Session) -> None:
        """A full mailbox refuses delivery outside this platform, so the warning
        has to arrive before the mailbox fills, not after."""
        add_checkpoint(db_session, last_polled_at=datetime.now(UTC))

        report = report_for(
            db_session,
            MailboxReport(
                reachable=True,
                authenticated=True,
                quota_supported=True,
                quota_used_kb=95_000,
                quota_limit_kb=100_000,
                quota_used_percent=95.0,
            ),
        )

        assert report.state == OperationalState.attention
        assert any("95% full" in c for c in report.concerns)

    def test_a_server_without_quota_support_says_so(self, db_session: Session) -> None:
        """Silence about quota is not the same as having room."""
        add_checkpoint(db_session, last_polled_at=datetime.now(UTC))

        report = report_for(
            db_session, MailboxReport(reachable=True, authenticated=True, quota_supported=False)
        )

        assert any("does not report quota" in c for c in report.concerns)

    def test_a_healthy_mailbox_adds_no_concern(self, db_session: Session) -> None:
        add_checkpoint(db_session, last_polled_at=datetime.now(UTC))

        report = report_for(
            db_session,
            MailboxReport(
                reachable=True,
                authenticated=True,
                quota_supported=True,
                quota_used_kb=1_000,
                quota_limit_kb=100_000,
                quota_used_percent=1.0,
            ),
        )

        assert report.state == OperationalState.healthy
        assert report.concerns == []
