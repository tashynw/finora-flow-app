"""The mailbox polling loop.

The ordering of the three operations per message is what makes this recoverable:
ingest, then commit, then move. A crash between any two of them leaves the
message in the inbox, where the next run finds it again and the idempotency key
recognises it. The alternative ordering, moving first, loses mail whenever the
process dies mid-batch.

Messages are handled oldest-first and the checkpoint advances one message at a
time, only after that message is committed. The checkpoint therefore never points
past something that was not stored.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.message import EmailMessage
from email.utils import format_datetime
from uuid import UUID, uuid4

import structlog
from sqlalchemy import select
from sqlalchemy.orm import Session

from finora.application.intake import (
    DuplicateMessageError,
    ImapProvenance,
    IntakeService,
)
from finora.config import ImapSettings
from finora.domain.intake import (
    CheckpointResetReason,
    IntakeSource,
    MailboxCheckpoint,
    next_uid_range,
    sha256_hex,
)
from finora.infrastructure.db.models import MailboxCheckpointRow
from finora.infrastructure.imap_client import ImapError, ImapMailbox

logger = structlog.get_logger(__name__)


@dataclass(slots=True)
class PollReport:
    """What one poll did, in terms an operator can act on."""

    folder: str
    uid_validity: int
    checkpoint_reset: CheckpointResetReason | None = None
    examined: int = 0
    ingested: int = 0
    duplicates: int = 0
    quarantined: int = 0
    failed: int = 0
    vanished: int = 0
    errors: list[str] = field(default_factory=list)

    @property
    def healthy(self) -> bool:
        return not self.errors and not self.failed


class ImapWorker:
    def __init__(
        self,
        *,
        settings: ImapSettings,
        session: Session,
        mailbox: ImapMailbox,
        intake: IntakeService,
        batch_size: int = 25,
    ) -> None:
        self._settings = settings
        self._session = session
        self._mailbox = mailbox
        self._intake = intake
        self._batch_size = batch_size

    # ------------------------------------------------------------- checkpoints

    def _load_checkpoint(self, folder: str) -> MailboxCheckpointRow | None:
        return self._session.execute(
            select(MailboxCheckpointRow).where(MailboxCheckpointRow.folder == folder)
        ).scalar_one_or_none()

    def _to_domain(self, row: MailboxCheckpointRow | None) -> MailboxCheckpoint | None:
        if row is None:
            return None
        return MailboxCheckpoint(
            folder=row.folder,
            uid_validity=row.uid_validity,
            last_seen_uid=row.last_seen_uid,
        )

    def _record_checkpoint(
        self,
        *,
        folder: str,
        uid_validity: int,
        last_seen_uid: int,
        reset_reason: CheckpointResetReason | None = None,
    ) -> None:
        row = self._load_checkpoint(folder)
        now = datetime.now(UTC)
        if row is None:
            row = MailboxCheckpointRow(folder=folder, uid_validity=uid_validity)
            self._session.add(row)

        row.uid_validity = uid_validity
        row.last_seen_uid = last_seen_uid
        row.last_polled_at = now
        if reset_reason is not None:
            row.last_reset_at = now
            row.last_reset_reason = str(reset_reason)
        self._session.flush()

    # -------------------------------------------------------------------- poll

    def poll_once(self) -> PollReport:
        """Fetch and ingest one batch from the inbox."""
        inbox = self._settings.folder_inbox
        self._mailbox.ensure_folder(self._settings.folder_processed)
        self._mailbox.ensure_folder(self._settings.folder_exception)

        state = self._mailbox.select(inbox)
        stored = self._to_domain(self._load_checkpoint(inbox))

        uid_range, reset = next_uid_range(
            stored, uid_validity=state.uid_validity, batch_size=self._batch_size
        )
        report = PollReport(folder=inbox, uid_validity=state.uid_validity, checkpoint_reset=reset)

        if reset is not None:
            logger.warning(
                "imap.checkpoint_reset",
                folder=inbox,
                reason=str(reset),
                previous_uid_validity=stored.uid_validity if stored else None,
                uid_validity=state.uid_validity,
            )
            # Written before any fetch, so a crash mid-batch does not leave a
            # stale UIDVALIDITY that would make the next run skip real mail.
            self._record_checkpoint(
                folder=inbox,
                uid_validity=state.uid_validity,
                last_seen_uid=0,
                reset_reason=reset,
            )
            self._session.commit()

        uids = self._mailbox.search_uids(uid_range)[: self._batch_size]
        report.examined = len(uids)

        for uid in uids:
            self._handle_one(uid, state.uid_validity, report)

        self._expunge_after_batch(report)
        return report

    def _expunge_after_batch(self, report: PollReport) -> None:
        """Clear the copy-fallback's Deleted markers, once the batch is durable.

        Only reached after every message in the batch has been committed, so
        nothing here can lose mail. On a server advertising MOVE nothing is
        flagged and this is a no-op; on one without it, skipping the expunge would
        leave flagged messages accumulating in the inbox until the mailbox hit its
        quota, which stops delivery in a way that looks like a quiet day.
        """
        if not (report.ingested or report.duplicates):
            return
        try:
            self._mailbox.expunge()
        except ImapError as error:
            report.errors.append(f"Could not expunge {report.folder}: {error}")
            logger.warning("imap.expunge_failed", folder=report.folder, error=str(error))

    def _handle_one(self, uid: int, uid_validity: int, report: PollReport) -> None:
        correlation_id = uuid4()
        log = logger.bind(uid=uid, correlation_id=str(correlation_id))

        try:
            fetched = self._mailbox.fetch(uid)
        except ImapError as error:
            # A fetch failure is transient. Nothing is moved and the checkpoint
            # is not advanced, so the message is retried on the next poll.
            report.errors.append(f"UID {uid}: {error}")
            log.warning("imap.fetch_failed", error=str(error))
            return

        if fetched is None:
            # Moved or deleted by something else between search and fetch.
            report.vanished += 1
            self._advance(uid, uid_validity)
            return

        try:
            outcome = self._intake.ingest(
                fetched.raw,
                source=IntakeSource.imap,
                correlation_id=correlation_id,
                imap=ImapProvenance(folder=report.folder, uid=uid, uid_validity=uid_validity),
                actor_label="imap worker",
            )
        except DuplicateMessageError as duplicate:
            report.duplicates += 1
            log.info("imap.duplicate", existing_id=str(duplicate.existing.id))
            self._commit_and_advance(uid, uid_validity)
            self._move(uid, self._settings.folder_processed, report, log)
            return
        except Exception as error:
            # Ingest failed for a reason this run cannot resolve. Roll back, leave
            # the message where it is, and surface it. Moving it to Exception here
            # would need a commit to be honest about, and there is nothing to
            # commit.
            self._session.rollback()
            report.failed += 1
            report.errors.append(f"UID {uid}: {error}")
            log.error("imap.ingest_failed", error=str(error))
            return

        if outcome.quarantined_attachments:
            report.quarantined += 1
        report.ingested += 1

        # Commit before the move, so the durable record exists before the mailbox
        # stops being a copy of it.
        self._commit_and_advance(uid, uid_validity)

        destination = (
            self._settings.folder_exception
            if outcome.needs_attention
            else self._settings.folder_processed
        )
        self._move(uid, destination, report, log)

    def _move(
        self,
        uid: int,
        destination: str,
        report: PollReport,
        log: structlog.stdlib.BoundLogger,
    ) -> None:
        try:
            self._mailbox.move(uid, destination)
        except ImapError as error:
            # The message is already stored and committed, so a failed move costs
            # a duplicate detection on the next poll rather than any data.
            report.errors.append(f"UID {uid}: could not move to {destination}.")
            log.warning("imap.move_failed", destination=destination, error=str(error))

    def _advance(self, uid: int, uid_validity: int) -> None:
        self._record_checkpoint(
            folder=self._settings.folder_inbox,
            uid_validity=uid_validity,
            last_seen_uid=uid,
        )

    def _commit_and_advance(self, uid: int, uid_validity: int) -> None:
        self._advance(uid, uid_validity)
        self._session.commit()


@dataclass(frozen=True, slots=True)
class ManualUpload:
    """A file uploaded by a person rather than delivered by the mailbox.

    Wrapped into a minimal RFC 822 message so that upload and mailbox intake
    converge on one code path, one storage layout and one audit shape. A separate
    path for uploads would be a second place for the scanning rule to be
    forgotten.
    """

    filename: str
    content_type: str
    data: bytes
    uploaded_by_id: UUID
    note: str | None = None

    def to_rfc822(self, *, uploader_email: str) -> bytes:
        message = EmailMessage()
        message["Subject"] = f"Manual upload: {self.filename}"
        message["From"] = uploader_email
        message["Date"] = format_datetime(datetime.now(UTC))
        # Derived from the content and the uploader rather than generated, so the
        # same person re-uploading the same file is recognised as a duplicate
        # instead of creating a second invoice. A random Message-ID would defeat
        # that, and the raw hash cannot carry it because the Date header differs
        # between two uploads of identical bytes.
        #
        # Two *different* people uploading the same file do get separate records:
        # attribution differs, and each submitter needs their own trail.
        message["Message-ID"] = (
            f"<{sha256_hex(self.data)}.{self.uploaded_by_id}@upload.finora.invalid>"
        )
        message["X-Finora-Intake-Source"] = "manual_upload"
        message.set_content(self.note or f"Uploaded by {uploader_email}.")

        maintype, _, subtype = self.content_type.partition("/")
        message.add_attachment(
            self.data,
            maintype=maintype or "application",
            subtype=subtype or "octet-stream",
            filename=self.filename,
        )
        return message.as_bytes()
