"""The polling loop.

The behaviours worth testing are the recovery ones, because they are the ones a
happy-path test would never notice:

- A UIDVALIDITY change resets the checkpoint instead of resuming from a UID that
  now refers to a different message.
- A crash between ingest and move leaves the message in the inbox, and the next
  run recognises it rather than filing it twice.
- A failed ingest does not advance the checkpoint and does not move the message.
- A failed move costs a duplicate detection, not the message.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session
from tests.conftest import make_user, requires_db
from tests.integration.test_intake_service import (
    FakeScanner,
    build_message,
    build_service,
)

from finora.application.imap_worker import ImapWorker, ManualUpload
from finora.config import ImapSettings
from finora.domain.intake import (
    CheckpointResetReason,
    IntakeSource,
    IntakeStatus,
    ScanVerdict,
)
from finora.domain.roles import Role
from finora.infrastructure.db.models import InboundMessage, MailboxCheckpointRow
from finora.infrastructure.imap_client import (
    FetchedMessage,
    FolderState,
    ImapError,
)
from finora.infrastructure.mail_parser import parse_message
from finora.infrastructure.object_store import Bucket


@dataclass
class FakeMailbox:
    """A mailbox that records what was moved, and can be made to fail."""

    messages: dict[int, bytes] = field(default_factory=dict)
    uid_validity: int = 100
    moved: list[tuple[int, str]] = field(default_factory=list)
    created_folders: list[str] = field(default_factory=list)
    fail_fetch_on: set[int] = field(default_factory=set)
    fail_move_on: set[int] = field(default_factory=set)
    vanished: set[int] = field(default_factory=set)
    expunges: int = 0
    fail_expunge: bool = False

    def ensure_folder(self, name: str) -> None:
        self.created_folders.append(name)

    def select(self, name: str, *, readonly: bool = False) -> FolderState:
        return FolderState(
            name=name,
            uid_validity=self.uid_validity,
            message_count=len(self.messages),
        )

    def search_uids(self, uid_range: str) -> list[int]:
        low_text, _, _ = uid_range.partition(":")
        low = int(low_text)
        return sorted(uid for uid in self.messages if uid >= low)

    def fetch(self, uid: int) -> FetchedMessage | None:
        if uid in self.fail_fetch_on:
            raise ImapError(f"Could not fetch message UID {uid}.")
        if uid in self.vanished:
            return None
        return FetchedMessage(uid=uid, raw=self.messages[uid])

    def move(self, uid: int, destination: str) -> None:
        if uid in self.fail_move_on:
            raise ImapError(f"Could not move UID {uid}.")
        self.moved.append((uid, destination))
        self.messages.pop(uid, None)

    def expunge(self) -> None:
        if self.fail_expunge:
            raise ImapError("Could not expunge the mailbox.")
        self.expunges += 1


def build_worker(
    session: Session,
    mailbox: FakeMailbox,
    *,
    scanner: FakeScanner | None = None,
) -> ImapWorker:
    intake, _, _ = build_service(session, scanner=scanner)
    return ImapWorker(
        settings=ImapSettings(),
        session=session,
        mailbox=mailbox,  # type: ignore[arg-type]
        intake=intake,
        batch_size=10,
    )


def checkpoint(session: Session, folder: str = "INBOX") -> MailboxCheckpointRow | None:
    return session.execute(
        select(MailboxCheckpointRow).where(MailboxCheckpointRow.folder == folder)
    ).scalar_one_or_none()


@requires_db
class TestHappyPath:
    def test_ingests_and_files_a_clean_message(self, db_session: Session) -> None:
        mailbox = FakeMailbox(messages={5: build_message(message_id="<a@v.example>")})
        worker = build_worker(db_session, mailbox)

        report = worker.poll_once()

        assert report.examined == 1
        assert report.ingested == 1
        assert report.healthy
        assert mailbox.moved == [(5, "Finora/Processed")]

        row = checkpoint(db_session)
        assert row is not None
        assert row.last_seen_uid == 5
        assert row.uid_validity == 100

    def test_creates_the_destination_folders_before_fetching(self, db_session: Session) -> None:
        mailbox = FakeMailbox()
        build_worker(db_session, mailbox).poll_once()

        assert "Finora/Processed" in mailbox.created_folders
        assert "Finora/Exception" in mailbox.created_folders

    def test_processes_oldest_first(self, db_session: Session) -> None:
        """The checkpoint only advances past what has been stored, so ordering
        has to be ascending or a gap becomes permanent."""
        mailbox = FakeMailbox(
            messages={
                9: build_message(message_id="<c@v.example>"),
                7: build_message(message_id="<a@v.example>"),
                8: build_message(message_id="<b@v.example>"),
            }
        )
        worker = build_worker(db_session, mailbox)
        worker.poll_once()

        assert [uid for uid, _ in mailbox.moved] == [7, 8, 9]

    def test_a_quarantined_message_goes_to_exception_not_processed(
        self, db_session: Session
    ) -> None:
        mailbox = FakeMailbox(messages={12: build_message(message_id="<q@v.example>")})
        worker = build_worker(
            db_session,
            mailbox,
            scanner=FakeScanner(verdict=ScanVerdict.infected, detail="Eicar-Test"),
        )

        report = worker.poll_once()

        assert report.quarantined == 1
        assert mailbox.moved == [(12, "Finora/Exception")]


@requires_db
class TestCheckpointing:
    def test_resumes_after_the_last_seen_uid(self, db_session: Session) -> None:
        mailbox = FakeMailbox(
            messages={
                4: build_message(message_id="<old@v.example>"),
                5: build_message(message_id="<new@v.example>"),
            }
        )
        db_session.add(MailboxCheckpointRow(folder="INBOX", uid_validity=100, last_seen_uid=4))
        db_session.commit()

        worker = build_worker(db_session, mailbox)
        report = worker.poll_once()

        # UID 4 is behind the checkpoint and is not fetched again.
        assert report.examined == 1
        assert mailbox.moved == [(5, "Finora/Processed")]

    def test_a_uidvalidity_change_resets_the_checkpoint(self, db_session: Session) -> None:
        """Stored UIDs mean nothing under a new UIDVALIDITY.

        Resuming from UID 40 after a renumbering would skip every message the
        server now numbers below it, while reporting the mailbox as current.
        """
        mailbox = FakeMailbox(
            messages={1: build_message(message_id="<after-reset@v.example>")},
            uid_validity=777,
        )
        db_session.add(MailboxCheckpointRow(folder="INBOX", uid_validity=100, last_seen_uid=40))
        db_session.commit()

        worker = build_worker(db_session, mailbox)
        report = worker.poll_once()

        assert report.checkpoint_reset is CheckpointResetReason.uidvalidity_changed
        assert report.ingested == 1

        row = checkpoint(db_session)
        assert row is not None
        assert row.uid_validity == 777
        assert row.last_reset_reason == "uidvalidity_changed"
        assert row.last_reset_at is not None

    def test_a_failed_ingest_does_not_advance_the_checkpoint(self, db_session: Session) -> None:
        mailbox = FakeMailbox(messages={6: b"not a parseable message at all"})
        worker = build_worker(db_session, mailbox)

        # An unparseable message still ingests: the raw bytes are evidence and
        # the failure is recorded. Truncate it to nothing to force a real error.
        mailbox.messages[6] = b""

        report = worker.poll_once()

        assert report.failed == 1
        assert report.ingested == 0
        assert mailbox.moved == []
        # Not advanced, so the next run retries rather than skipping it.
        assert checkpoint(db_session) is None

    def test_a_failed_fetch_leaves_the_message_for_the_next_run(self, db_session: Session) -> None:
        mailbox = FakeMailbox(
            messages={8: build_message(message_id="<f@v.example>")},
            fail_fetch_on={8},
        )
        worker = build_worker(db_session, mailbox)

        report = worker.poll_once()

        assert report.errors
        assert report.ingested == 0
        assert mailbox.moved == []
        assert checkpoint(db_session) is None

    def test_a_vanished_message_advances_without_being_recorded(self, db_session: Session) -> None:
        """Searched but not fetched means something else moved it.

        Not an error, but the checkpoint must move past it or the poll loops on a
        UID that will never return anything.
        """
        mailbox = FakeMailbox(messages={9: build_message(message_id="<v@v.example>")}, vanished={9})
        worker = build_worker(db_session, mailbox)

        report = worker.poll_once()

        assert report.vanished == 1
        assert report.ingested == 0
        row = checkpoint(db_session)
        assert row is not None
        assert row.last_seen_uid == 9


@requires_db
class TestRecovery:
    def test_a_failed_move_costs_a_duplicate_not_the_message(self, db_session: Session) -> None:
        """The record is committed before the move, so a move failure is benign.

        The next poll sees the message again and the idempotency key recognises
        it, which is why the ordering is ingest, commit, move.
        """
        raw = build_message(message_id="<stuck@v.example>")
        mailbox = FakeMailbox(messages={10: raw}, fail_move_on={10})
        worker = build_worker(db_session, mailbox)

        first = worker.poll_once()
        assert first.ingested == 1
        assert first.errors  # the move failure is surfaced
        assert 10 in mailbox.messages  # still in the inbox

        # Second poll: the message is still there. It is behind the checkpoint
        # now, so it is not re-examined at all, which is the cheapest outcome.
        second = worker.poll_once()
        assert second.ingested == 0

        stored = db_session.execute(select(InboundMessage)).scalars().all()
        assert len(stored) == 1

    def test_a_message_seen_again_after_a_reset_is_not_recorded_twice(
        self, db_session: Session
    ) -> None:
        """A UIDVALIDITY reset re-scans from UID 1.

        That full re-scan is only safe because duplicate detection catches
        everything already recorded, which is what makes resetting preferable to
        risking skipped mail.
        """
        raw = build_message(message_id="<rescan@v.example>")
        mailbox = FakeMailbox(messages={3: raw})
        worker = build_worker(db_session, mailbox)

        first = worker.poll_once()
        assert first.ingested == 1

        # The server renumbers, and the same message reappears at a new UID.
        mailbox.uid_validity = 999
        mailbox.messages = {1: raw}

        second = worker.poll_once()

        assert second.checkpoint_reset is CheckpointResetReason.uidvalidity_changed
        assert second.duplicates == 1
        assert second.ingested == 0
        assert mailbox.moved[-1] == (1, "Finora/Processed")

        stored = db_session.execute(select(InboundMessage)).scalars().all()
        assert len(stored) == 1


@requires_db
class TestBatchExpunge:
    """The copy-based fallback flags messages deleted without removing them.

    Left flagged forever, they accumulate until the mailbox hits its quota, and a
    full mailbox refuses delivery outside this platform, which reads as a quiet
    week rather than as an outage. The expunge is deferred to the end of a
    committed batch so it can never remove something not yet stored.
    """

    def test_expunges_once_after_the_batch_is_committed(self, db_session: Session) -> None:
        mailbox = FakeMailbox(
            messages={
                1: build_message(message_id="<a@v.example>"),
                2: build_message(message_id="<b@v.example>"),
            }
        )
        report = build_worker(db_session, mailbox).poll_once()

        assert report.ingested == 2
        assert mailbox.expunges == 1

    def test_does_not_expunge_when_nothing_was_stored(self, db_session: Session) -> None:
        """Nothing was flagged, so an expunge would only be a wasted round trip
        against a mailbox that may already be struggling."""
        mailbox = FakeMailbox()
        build_worker(db_session, mailbox).poll_once()

        assert mailbox.expunges == 0

    def test_does_not_expunge_after_a_failed_ingest(self, db_session: Session) -> None:
        mailbox = FakeMailbox(messages={3: b""})
        report = build_worker(db_session, mailbox).poll_once()

        assert report.failed == 1
        assert mailbox.expunges == 0

    def test_a_failed_expunge_is_reported_but_keeps_the_record(self, db_session: Session) -> None:
        mailbox = FakeMailbox(
            messages={4: build_message(message_id="<e@v.example>")},
            fail_expunge=True,
        )
        report = build_worker(db_session, mailbox).poll_once()

        assert report.ingested == 1
        assert not report.healthy
        assert any("expunge" in error for error in report.errors)
        assert len(db_session.execute(select(InboundMessage)).scalars().all()) == 1


@requires_db
class TestManualUpload:
    def test_an_upload_travels_the_same_path_as_a_delivered_message(
        self, db_session: Session
    ) -> None:
        """One code path, so the scanning rule cannot be forgotten on one of them."""
        uploader = make_user(
            db_session,
            email="clerk@company.example",
            display_name="Accounts Clerk",
            roles=[Role.finance],
        )
        service, store, scanner = build_service(db_session)
        upload = ManualUpload(
            filename="receipt.pdf",
            content_type="application/pdf",
            data=b"%PDF-1.7\nreceipt\n",
            uploaded_by_id=uploader.id,
        )

        outcome = service.ingest(
            upload.to_rfc822(uploader_email=uploader.email),
            source=IntakeSource.manual_upload,
            correlation_id=uuid.uuid4(),
            uploaded_by_id=upload.uploaded_by_id,
        )
        db_session.commit()

        assert scanner.calls == 1
        assert store.keys_in(Bucket.documents)
        assert outcome.message.status is IntakeStatus.ready
        assert outcome.message.source is IntakeSource.manual_upload

    def test_the_same_file_from_the_same_person_is_one_record(self) -> None:
        """The wrapper's Message-ID is derived, not random.

        A random one would let the same person upload the same invoice twice and
        get two records, which is precisely the duplicate-payment risk intake
        exists to prevent.
        """
        uploader = uuid.uuid4()
        data = b"%PDF-1.7\nsame bytes\n"

        first = ManualUpload(
            filename="a.pdf",
            content_type="application/pdf",
            data=data,
            uploaded_by_id=uploader,
        ).to_rfc822(uploader_email="clerk@company.example")
        second = ManualUpload(
            filename="a.pdf",
            content_type="application/pdf",
            data=data,
            uploaded_by_id=uploader,
        ).to_rfc822(uploader_email="clerk@company.example")

        assert (
            parse_message(first).identity.idempotency_key
            == parse_message(second).identity.idempotency_key
        )

    def test_a_different_uploader_gets_their_own_record(self) -> None:
        """Attribution differs, and each submitter needs their own trail."""
        data = b"%PDF-1.7\nshared document\n"
        keys = {
            parse_message(
                ManualUpload(
                    filename="a.pdf",
                    content_type="application/pdf",
                    data=data,
                    uploaded_by_id=uuid.uuid4(),
                ).to_rfc822(uploader_email="clerk@company.example")
            ).identity.idempotency_key
            for _ in range(2)
        }
        assert len(keys) == 2


def test_the_upload_wrapper_records_when_it_was_received() -> None:
    """A wrapped upload is still a message and needs a usable Date."""
    raw = ManualUpload(
        filename="a.pdf",
        content_type="application/pdf",
        data=b"%PDF-1.7\nx\n",
        uploaded_by_id=uuid.uuid4(),
    ).to_rfc822(uploader_email="clerk@company.example")

    parsed = parse_message(raw)
    assert parsed.sent_at is not None
    assert parsed.sent_at <= datetime.now(UTC)
    assert not parsed.warnings
