"""Ingesting one message.

The ordering here is the safety property, not an implementation detail:

1. Store the raw bytes first, immutably. Until that succeeds nothing else runs,
   because a record that refers to evidence which was never stored is worse than
   no record at all.
2. Claim the idempotency key in the database. A unique constraint decides the
   winner, so two workers delivering the same message produce one record rather
   than two racing checks that both pass.
3. Validate each attachment against intake policy.
4. Scan. Only a clean verdict permits storage in the documents bucket; anything
   else goes to quarantine, which has no signed-URL path at all.
5. Mark the message ready only once every attachment has a verdict.
6. Ask whether this is a reply to something the platform sent, and if it is, file
   it against that conversation instead of enrolling it as paperwork.
7. Enrol the clean, readable attachments as documents awaiting a reading.

Step 6 sits where it does deliberately. It runs after scanning, so a reply that
arrives carrying malware is quarantined like anything else rather than waved
through because it threaded correctly; and before enrolment, so a supplier
writing "yes, the money came in" is never queued for somebody to read as an
invoice. Its attachments are still stored and scanned — a remittance advice
attached to a reply is worth keeping — they are simply not put in the extraction
queue.

A failure at any step leaves the message in a state that says so. Nothing is
recorded as ready on the strength of a step that did not run.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from uuid import UUID

import structlog
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from finora.application.document_pipeline import enrol_documents
from finora.application.reply_routing import ReplyRouter, RoutingOutcome
from finora.domain.audit import ActorType, AuditAction
from finora.domain.intake import (
    RELEASABLE_VERDICTS,
    AttachmentLimits,
    AttachmentRejectedError,
    IntakeSource,
    IntakeStatus,
    ScanVerdict,
    sha256_hex,
    validate_attachment,
)
from finora.domain.mail_correlation import ReplyHeaders, automatic_kind
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import InboundMessage, MessageAttachment
from finora.infrastructure.mail_parser import ParsedMessage, parse_message
from finora.infrastructure.object_store import (
    Bucket,
    ObjectStore,
    attachment_key,
    raw_message_key,
)
from finora.infrastructure.scanner import (
    MalwareScanner,
    ScannerUnavailableError,
)

logger = structlog.get_logger(__name__)


class DuplicateMessageError(Exception):
    """The message has already been ingested.

    Carries the existing record so the caller can point at it rather than
    reporting a generic conflict.
    """

    def __init__(self, existing: InboundMessage) -> None:
        super().__init__("This message has already been received and is already in the workspace.")
        self.existing = existing


@dataclass(frozen=True, slots=True)
class ImapProvenance:
    folder: str
    uid: int
    uid_validity: int


@dataclass(slots=True)
class IngestOutcome:
    message: InboundMessage
    stored_attachments: int = 0
    quarantined_attachments: int = 0
    rejected_attachments: int = 0
    #: Attachments registered as documents to be read for values.
    enrolled_documents: int = 0
    warnings: list[str] = field(default_factory=list)
    #: What the message turned out to be a reply to, when it was one. `None`
    #: when no router was configured; a routing outcome with `handled` false
    #: when the router looked and found nothing.
    routing: RoutingOutcome | None = None

    @property
    def needs_attention(self) -> bool:
        return bool(self.quarantined_attachments or self.rejected_attachments or self.warnings)

    @property
    def is_conversation(self) -> bool:
        """True when this belongs on a conversation rather than in the queue."""
        return self.routing is not None and self.routing.handled


class IntakeService:
    def __init__(
        self,
        *,
        session: Session,
        object_store: ObjectStore,
        scanner: MalwareScanner,
        audit: AuditRepository,
        limits: AttachmentLimits,
        replies: ReplyRouter | None = None,
    ) -> None:
        self._session = session
        self._store = object_store
        self._scanner = scanner
        self._audit = audit
        self._limits = limits
        # Optional so that the tests and tools which only care about storing and
        # scanning a message need not stand up the whole payment side to do it.
        # Absent, every message is treated as paperwork, which is what intake
        # did before there was anything to reply to.
        self._replies = replies

    # ------------------------------------------------------------------ lookup

    def find_by_identity(self, idempotency_key: str) -> InboundMessage | None:
        return self._session.execute(
            select(InboundMessage).where(InboundMessage.idempotency_key == idempotency_key)
        ).scalar_one_or_none()

    # ----------------------------------------------------------------- ingest

    def ingest(
        self,
        raw: bytes,
        *,
        source: IntakeSource,
        correlation_id: UUID,
        imap: ImapProvenance | None = None,
        uploaded_by_id: UUID | None = None,
        actor_label: str = "intake worker",
    ) -> IngestOutcome:
        """Ingest one raw RFC 822 message."""
        if not raw:
            raise ValueError("Cannot ingest an empty message.")

        parsed = parse_message(raw)
        identity = parsed.identity
        received_at = datetime.now(UTC)

        existing = self.find_by_identity(identity.idempotency_key)
        if existing is not None:
            # Appended rather than committed here, so the caller decides whether
            # the surrounding transaction survives. The worker commits after
            # handling the duplicate, which is what keeps this entry.
            self._audit.append(
                action=AuditAction.message_duplicate_detected,
                actor_type=ActorType.service,
                actor_id=uploaded_by_id,
                actor_label=actor_label,
                subject_type="inbound_message",
                subject_id=existing.id,
                correlation_id=correlation_id,
                detail={
                    "idempotency_key": identity.idempotency_key,
                    "source": str(source),
                },
            )
            raise DuplicateMessageError(existing)

        # Step 1. The evidence goes down before anything references it.
        raw_key = raw_message_key(received_at=received_at, raw_sha256=parsed.raw_sha256)
        self._store.put_immutable(
            bucket=Bucket.raw_messages,
            key=raw_key,
            data=raw,
            content_type="message/rfc822",
            sha256=parsed.raw_sha256,
            metadata={"source": str(source)},
        )

        message = self._build_message(
            parsed,
            source=source,
            raw_key=raw_key,
            received_at=received_at,
            imap=imap,
            uploaded_by_id=uploaded_by_id,
        )

        # Step 2. Let the unique constraint arbitrate, rather than trusting the
        # lookup above to have won a race against a concurrent worker.
        self._session.add(message)
        try:
            self._session.flush()
        except IntegrityError:
            self._session.rollback()
            duplicate = self.find_by_identity(identity.idempotency_key)
            if duplicate is not None:
                raise DuplicateMessageError(duplicate) from None
            raise

        outcome = IngestOutcome(message=message, warnings=list(parsed.warnings))

        # Steps 3 and 4.
        for position, candidate in enumerate(parsed.attachments):
            self._process_attachment(
                message=message,
                position=position,
                filename=candidate.filename,
                declared_content_type=candidate.declared_content_type,
                data=candidate.data,
                inline=candidate.inline,
                original_filename=candidate.filename,
                outcome=outcome,
                correlation_id=correlation_id,
                actor_label=actor_label,
            )

        # Step 5.
        message.status = self._resolve_status(outcome)
        message.parse_warnings = outcome.warnings
        self._session.flush()

        # Step 6.
        if self._replies is not None:
            outcome.routing = self._replies.route(message, correlation_id=correlation_id)

        # Step 7. Inside this transaction on purpose: a message that committed
        # without its readable attachments enrolled would be a message nothing
        # ever reads, and nobody would be told.
        if not outcome.is_conversation:
            outcome.enrolled_documents = len(enrol_documents(self._session, message))

        self._audit.append(
            action=AuditAction.message_ingested,
            actor_type=ActorType.service if imap else ActorType.user,
            actor_id=uploaded_by_id,
            actor_label=actor_label,
            subject_type="inbound_message",
            subject_id=message.id,
            correlation_id=correlation_id,
            detail={
                "source": str(source),
                "status": str(message.status),
                "raw_sha256": parsed.raw_sha256,
                "attachments_stored": outcome.stored_attachments,
                "attachments_quarantined": outcome.quarantined_attachments,
                "attachments_rejected": outcome.rejected_attachments,
                "documents_enrolled": outcome.enrolled_documents,
                # The sender is recorded, but is never treated as verified. The
                # vendor of record is decided by a person against the master.
                "from_address": parsed.from_address,
                "reply_to_address": parsed.reply_to_address,
                # Present only when this was a reply, so the ordinary invoice
                # arriving from a supplier is not padded with four nulls.
                **(
                    {
                        "replied_to_type": outcome.routing.record_type,
                        "replied_to_id": str(outcome.routing.record_id),
                        "correlated_by": str(outcome.routing.basis),
                        "claim_recorded": outcome.routing.claim_recorded,
                    }
                    if outcome.routing is not None and outcome.routing.record_id is not None
                    else {}
                ),
            },
        )

        return outcome

    # --------------------------------------------------------------- internals

    def _build_message(
        self,
        parsed: ParsedMessage,
        *,
        source: IntakeSource,
        raw_key: str,
        received_at: datetime,
        imap: ImapProvenance | None,
        uploaded_by_id: UUID | None,
    ) -> InboundMessage:
        return InboundMessage(
            source=source,
            status=IntakeStatus.scanning,
            idempotency_key=parsed.identity.idempotency_key,
            raw_sha256=parsed.raw_sha256,
            raw_object_key=raw_key,
            raw_size_bytes=parsed.raw_size_bytes,
            imap_folder=imap.folder if imap else None,
            imap_uid=imap.uid if imap else None,
            imap_uid_validity=imap.uid_validity if imap else None,
            uploaded_by_id=uploaded_by_id,
            message_id=parsed.message_id,
            subject=parsed.subject[:1000],
            from_address=parsed.from_address,
            from_display_name=parsed.from_display_name,
            reply_to_address=parsed.reply_to_address,
            to_addresses=parsed.to_addresses,
            cc_addresses=parsed.cc_addresses,
            delivered_to_addresses=parsed.delivered_to,
            in_reply_to=parsed.in_reply_to,
            references=list(parsed.references),
            # Decided here rather than later, while the full header set is still
            # in hand. Half of what identifies an automatic reply — the empty
            # return path, the delivery-status content type, the `Precedence` —
            # is not worth a column of its own, and by the time anything
            # considers this message a claim the raw bytes are in object storage
            # and nobody is going to fetch them back to re-read a header.
            automatic_kind=automatic_kind(
                ReplyHeaders(
                    message_id=parsed.message_id,
                    in_reply_to=parsed.in_reply_to,
                    references=tuple(parsed.references),
                    subject=parsed.subject,
                    from_address=parsed.from_address,
                    to_addresses=tuple(parsed.to_addresses),
                    delivered_to=tuple(parsed.delivered_to),
                    auto_submitted=parsed.auto_submitted,
                    precedence=parsed.precedence,
                    return_path=parsed.return_path,
                    autoreply_markers=tuple(parsed.autoreply_markers),
                    content_type=parsed.content_type,
                )
            ),
            forwarded_from_address=parsed.forwarded_from_address,
            forwarded_shape=parsed.forwarded_shape,
            sent_at=parsed.sent_at,
            received_at=received_at,
            body_text=parsed.body_text,
            parse_warnings=list(parsed.warnings),
        )

    def _process_attachment(
        self,
        *,
        message: InboundMessage,
        position: int,
        filename: str,
        declared_content_type: str | None,
        data: bytes,
        inline: bool,
        original_filename: str,
        outcome: IngestOutcome,
        correlation_id: UUID,
        actor_label: str,
    ) -> None:
        try:
            validated = validate_attachment(
                filename=filename,
                declared_content_type=declared_content_type,
                data=data,
                limits=self._limits,
            )
        except AttachmentRejectedError as rejection:
            # Recorded, not dropped. A silently discarded invoice is
            # indistinguishable from one that was never sent.
            self._session.add(
                MessageAttachment(
                    message_id=message.id,
                    position=position,
                    filename=filename[:255] or "attachment",
                    original_filename=original_filename[:500] or "attachment",
                    content_type=(declared_content_type or "application/octet-stream")[:160],
                    size_bytes=max(len(data), 1),
                    sha256=sha256_hex(data),
                    object_key=None,
                    scan_verdict=None,
                    rejection_reason=str(rejection.reason),
                    rejection_detail=str(rejection)[:500],
                    inline=inline,
                )
            )
            outcome.rejected_attachments += 1
            outcome.warnings.append(f"{filename}: {rejection}")
            return

        scan = self._scan(validated.filename, data, outcome)
        releasable = scan.verdict in RELEASABLE_VERDICTS

        bucket = Bucket.documents if releasable else Bucket.quarantine
        key = attachment_key(
            message_id=str(message.id),
            sha256=validated.sha256,
            filename=validated.filename,
        )
        self._store.put(
            bucket=bucket,
            key=key,
            data=data,
            content_type=validated.content_type,
            sha256=validated.sha256,
            metadata={"scan_verdict": str(scan.verdict)},
        )

        self._session.add(
            MessageAttachment(
                message_id=message.id,
                position=position,
                filename=validated.filename,
                original_filename=validated.original_filename[:500],
                content_type=validated.content_type,
                size_bytes=validated.size_bytes,
                sha256=validated.sha256,
                object_key=key,
                is_quarantined=not releasable,
                inline=inline,
                scan_verdict=scan.verdict,
                scan_detail=(scan.detail or None) and scan.detail[:500],
                scan_engine=scan.engine,
                scanned_at=datetime.now(UTC),
            )
        )

        if releasable:
            outcome.stored_attachments += 1
        else:
            outcome.quarantined_attachments += 1
            outcome.warnings.append(
                f"{validated.filename}: quarantined ({scan.detail or scan.verdict})."
            )
            self._audit.append(
                action=AuditAction.document_quarantined,
                actor_type=ActorType.service,
                actor_label=actor_label,
                subject_type="message_attachment",
                subject_id=message.id,
                correlation_id=correlation_id,
                detail={
                    "filename": validated.filename,
                    "sha256": validated.sha256,
                    "verdict": str(scan.verdict),
                    "detail": scan.detail,
                },
            )

    def _scan(self, filename: str, data: bytes, outcome: IngestOutcome) -> ScanOutcome:
        """Scan, converting a fail-closed refusal into a recorded verdict.

        The refusal still prevents release, because only `clean` is releasable.
        Turning it into a verdict here means the file is quarantined with a
        reason instead of aborting the whole message and losing the others.
        """
        try:
            result = self._scanner.scan_or_refuse(data)
        except ScannerUnavailableError as error:
            logger.warning("intake.scan_refused", filename=filename, error=str(error))
            return ScanOutcome(verdict=ScanVerdict.error, detail=str(error), engine=None)
        return ScanOutcome(verdict=result.verdict, detail=result.detail, engine=result.engine)

    @staticmethod
    def _resolve_status(outcome: IngestOutcome) -> IntakeStatus:
        """A message is only ready when nothing about it needs a person.

        Quarantine takes precedence over rejection, because an infected file is a
        security event and must not be filed as a formatting problem.
        """
        if outcome.quarantined_attachments:
            return IntakeStatus.quarantined
        if outcome.rejected_attachments:
            return IntakeStatus.failed
        return IntakeStatus.ready


@dataclass(frozen=True, slots=True)
class ScanOutcome:
    verdict: ScanVerdict
    detail: str | None
    engine: str | None
