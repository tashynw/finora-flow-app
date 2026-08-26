"""Intake ingestion.

The properties under test are the ones that would let a bad file through or lose
a good one: an infected attachment never reaches the documents bucket, an
unreachable scanner does not read as clean, the same message twice produces one
record, and the raw original is stored before anything refers to it.

The object store and scanner are replaced with in-memory doubles. Both real
adapters have their own unit tests; here the point is the ordering and the
decisions built on top of them.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.message import EmailMessage
from email.utils import format_datetime

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from tests.conftest import requires_db

from finora.application.intake import (
    DuplicateMessageError,
    ImapProvenance,
    IntakeService,
)
from finora.domain.audit import AuditAction
from finora.domain.intake import (
    AttachmentLimits,
    IntakeSource,
    IntakeStatus,
    ScanVerdict,
    sha256_hex,
)
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import (
    AuditEntryRow,
    InboundMessage,
    MessageAttachment,
)
from finora.infrastructure.object_store import (
    Bucket,
    ImmutableObjectError,
    StoredObject,
)
from finora.infrastructure.scanner import (
    ScannerUnavailableError,
    ScanResult,
)

PDF = b"%PDF-1.7\nfake but correctly signed\n"
EICAR_SHAPED = b"%PDF-1.7\npretend this matched a signature\n"


# ------------------------------------------------------------------- doubles


@dataclass
class FakeObjectStore:
    """In-memory store that keeps the immutability rule the real one enforces."""

    objects: dict[tuple[Bucket, str], bytes] = field(default_factory=dict)
    hashes: dict[tuple[Bucket, str], str] = field(default_factory=dict)
    put_order: list[tuple[Bucket, str]] = field(default_factory=list)
    fail_next: bool = False

    def put(
        self,
        *,
        bucket: Bucket,
        key: str,
        data: bytes,
        content_type: str,
        sha256: str,
        metadata: dict[str, str] | None = None,
    ) -> StoredObject:
        if self.fail_next:
            self.fail_next = False
            from finora.infrastructure.object_store import ObjectStoreError

            raise ObjectStoreError("Storage refused the write.")
        self.objects[(bucket, key)] = data
        self.hashes[(bucket, key)] = sha256
        self.put_order.append((bucket, key))
        return StoredObject(
            bucket=bucket,
            key=key,
            size_bytes=len(data),
            sha256=sha256,
            content_type=content_type,
            stored_at=datetime.now(UTC),
        )

    def put_immutable(
        self,
        *,
        bucket: Bucket,
        key: str,
        data: bytes,
        content_type: str,
        sha256: str,
        metadata: dict[str, str] | None = None,
    ) -> StoredObject:
        existing = self.hashes.get((bucket, key))
        if existing is not None:
            if existing == sha256:
                return StoredObject(
                    bucket=bucket,
                    key=key,
                    size_bytes=len(self.objects[(bucket, key)]),
                    sha256=sha256,
                    content_type=content_type,
                    stored_at=datetime.now(UTC),
                )
            raise ImmutableObjectError("Refusing to replace a stored original.")
        return self.put(
            bucket=bucket,
            key=key,
            data=data,
            content_type=content_type,
            sha256=sha256,
            metadata=metadata,
        )

    def get(self, *, bucket: Bucket, key: str, expected_sha256: str | None = None) -> bytes:
        from finora.infrastructure.object_store import ObjectStoreError

        if (bucket, key) not in self.objects:
            raise ObjectStoreError(f"No such object '{key}'.")
        data = self.objects[(bucket, key)]
        # Mirrors the real adapter: content that no longer matches the hash
        # recorded at intake is refused rather than returned.
        if expected_sha256 is not None and sha256_hex(data) != expected_sha256:
            raise ObjectStoreError(f"'{key}' does not match the hash it was stored with.")
        return data

    def signed_url(
        self,
        *,
        bucket: Bucket,
        key: str,
        download_filename: str | None = None,
        expires_in: int | None = None,
    ) -> str:
        # Mirrors the real adapter's refusal, so a test cannot pass against a
        # double that is more permissive than production.
        if bucket is Bucket.quarantine:
            from finora.infrastructure.object_store import ObjectStoreError

            raise ObjectStoreError("Quarantined content cannot be served.")
        if (bucket, key) not in self.objects:
            from finora.infrastructure.object_store import ObjectStoreError

            raise ObjectStoreError(f"No such object '{key}'.")
        return f"https://storage.invalid/{bucket.value}/{key}?signature=fake"

    def keys_in(self, bucket: Bucket) -> list[str]:
        return [key for (b, key) in self.objects if b is bucket]


@dataclass
class FakeScanner:
    verdict: ScanVerdict = ScanVerdict.clean
    detail: str | None = None
    raise_unavailable: bool = False
    calls: int = 0

    def scan_or_refuse(self, data: bytes) -> ScanResult:
        self.calls += 1
        if self.raise_unavailable:
            raise ScannerUnavailableError(
                "The file could not be scanned, so it has not been accepted."
            )
        return ScanResult(verdict=self.verdict, detail=self.detail, engine="fake/1")


def build_message(
    *,
    subject: str = "Invoice 12345",
    sender: str = "billing@vendor.example",
    message_id: str | None = "<abc-123@vendor.example>",
    attachment: bytes | None = PDF,
    filename: str = "invoice.pdf",
    content_type: str = "application/pdf",
) -> bytes:
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = f"Vendor Billing <{sender}>"
    message["To"] = "invoices@company.example"
    message["Date"] = format_datetime(datetime.now(UTC))
    if message_id:
        message["Message-ID"] = message_id
    message.set_content("Please find the invoice attached.")

    if attachment is not None:
        maintype, _, subtype = content_type.partition("/")
        message.add_attachment(attachment, maintype=maintype, subtype=subtype, filename=filename)
    return message.as_bytes()


def build_service(
    session: Session,
    *,
    store: FakeObjectStore | None = None,
    scanner: FakeScanner | None = None,
    max_bytes: int = 25 * 1024 * 1024,
) -> tuple[IntakeService, FakeObjectStore, FakeScanner]:
    store = store or FakeObjectStore()
    scanner = scanner or FakeScanner()
    service = IntakeService(
        session=session,
        object_store=store,  # type: ignore[arg-type]
        scanner=scanner,  # type: ignore[arg-type]
        audit=AuditRepository(session),
        limits=AttachmentLimits(
            max_bytes=max_bytes,
            max_archive_entries=500,
            max_archive_expansion_ratio=100,
        ),
    )
    return service, store, scanner


# --------------------------------------------------------------------- tests


@requires_db
class TestCleanIngest:
    def test_stores_the_raw_original_before_any_attachment(self, db_session: Session) -> None:
        service, store, _ = build_service(db_session)

        service.ingest(
            build_message(),
            source=IntakeSource.imap,
            correlation_id=uuid.uuid4(),
            imap=ImapProvenance(folder="INBOX", uid=7, uid_validity=100),
        )
        db_session.commit()

        # The raw message is the evidence. If an attachment could be stored
        # first, a crash in between would leave a document with no provenance.
        assert store.put_order[0][0] is Bucket.raw_messages
        assert any(b is Bucket.documents for b, _ in store.put_order[1:])

    def test_records_the_message_as_ready_with_a_clean_attachment(
        self, db_session: Session
    ) -> None:
        service, store, scanner = build_service(db_session)

        outcome = service.ingest(
            build_message(),
            source=IntakeSource.imap,
            correlation_id=uuid.uuid4(),
            imap=ImapProvenance(folder="INBOX", uid=7, uid_validity=100),
        )
        db_session.commit()

        assert outcome.message.status is IntakeStatus.ready
        assert outcome.stored_attachments == 1
        assert outcome.quarantined_attachments == 0
        assert not outcome.needs_attention
        assert scanner.calls == 1
        assert len(store.keys_in(Bucket.documents)) == 1
        assert store.keys_in(Bucket.quarantine) == []

    def test_keeps_the_sender_and_reply_to_separately(self, db_session: Session) -> None:
        """A Reply-To that disagrees with From is a redirection signal.

        Collapsing the two would hide exactly the discrepancy a reviewer needs.
        """
        service, _, _ = build_service(db_session)

        message = EmailMessage()
        message["Subject"] = "Updated bank details"
        message["From"] = "Real Vendor <billing@vendor.example>"
        message["Reply-To"] = "attacker@lookalike.example"
        message["To"] = "invoices@company.example"
        message["Message-ID"] = "<spoof-1@vendor.example>"
        message["Date"] = format_datetime(datetime.now(UTC))
        message.set_content("Please pay to the account below.")

        outcome = service.ingest(
            message.as_bytes(),
            source=IntakeSource.imap,
            correlation_id=uuid.uuid4(),
            imap=ImapProvenance(folder="INBOX", uid=8, uid_validity=100),
        )
        db_session.commit()

        assert outcome.message.from_address == "billing@vendor.example"
        assert outcome.message.reply_to_address == "attacker@lookalike.example"


@requires_db
class TestScanning:
    def test_an_infected_attachment_never_reaches_the_documents_bucket(
        self, db_session: Session
    ) -> None:
        service, store, _ = build_service(
            db_session,
            scanner=FakeScanner(verdict=ScanVerdict.infected, detail="Eicar-Test"),
        )

        outcome = service.ingest(
            build_message(attachment=EICAR_SHAPED),
            source=IntakeSource.imap,
            correlation_id=uuid.uuid4(),
            imap=ImapProvenance(folder="INBOX", uid=9, uid_validity=100),
        )
        db_session.commit()

        assert store.keys_in(Bucket.documents) == []
        assert len(store.keys_in(Bucket.quarantine)) == 1
        assert outcome.message.status is IntakeStatus.quarantined
        assert outcome.quarantined_attachments == 1

        attachment = outcome.message.attachments[0]
        assert attachment.is_quarantined is True
        assert attachment.scan_verdict is ScanVerdict.infected
        assert attachment.scan_detail == "Eicar-Test"

    def test_an_unreachable_scanner_does_not_read_as_clean(self, db_session: Session) -> None:
        """The central rule: an absent answer is not a clean answer."""
        service, store, _ = build_service(db_session, scanner=FakeScanner(raise_unavailable=True))

        outcome = service.ingest(
            build_message(),
            source=IntakeSource.imap,
            correlation_id=uuid.uuid4(),
            imap=ImapProvenance(folder="INBOX", uid=10, uid_validity=100),
        )
        db_session.commit()

        assert store.keys_in(Bucket.documents) == []
        assert outcome.message.status is IntakeStatus.quarantined
        assert outcome.message.attachments[0].scan_verdict is ScanVerdict.error

    def test_an_unscannable_file_is_quarantined_rather_than_released(
        self, db_session: Session
    ) -> None:
        service, store, _ = build_service(
            db_session,
            scanner=FakeScanner(verdict=ScanVerdict.unscannable, detail="encrypted archive"),
        )

        outcome = service.ingest(
            build_message(),
            source=IntakeSource.imap,
            correlation_id=uuid.uuid4(),
            imap=ImapProvenance(folder="INBOX", uid=11, uid_validity=100),
        )
        db_session.commit()

        assert store.keys_in(Bucket.documents) == []
        assert outcome.message.attachments[0].is_quarantined is True

    def test_quarantine_is_audited(self, db_session: Session) -> None:
        service, _, _ = build_service(db_session, scanner=FakeScanner(verdict=ScanVerdict.infected))

        service.ingest(
            build_message(),
            source=IntakeSource.imap,
            correlation_id=uuid.uuid4(),
            imap=ImapProvenance(folder="INBOX", uid=12, uid_validity=100),
        )
        db_session.commit()

        actions = set(db_session.execute(select(AuditEntryRow.action)).scalars().all())
        assert AuditAction.document_quarantined in actions
        assert AuditAction.message_ingested in actions


@requires_db
class TestRefusals:
    def test_an_oversized_attachment_is_recorded_not_silently_dropped(
        self, db_session: Session
    ) -> None:
        """A discarded invoice is indistinguishable from one never sent."""
        service, store, scanner = build_service(db_session, max_bytes=10)

        outcome = service.ingest(
            build_message(attachment=PDF),
            source=IntakeSource.imap,
            correlation_id=uuid.uuid4(),
            imap=ImapProvenance(folder="INBOX", uid=13, uid_validity=100),
        )
        db_session.commit()

        assert outcome.rejected_attachments == 1
        assert outcome.message.status is IntakeStatus.failed
        assert store.keys_in(Bucket.documents) == []
        # Refused before storage means refused before scanning: there is nothing
        # to scan and nothing to store.
        assert scanner.calls == 0

        attachment = outcome.message.attachments[0]
        assert attachment.object_key is None
        assert attachment.rejection_reason == "too_large"
        assert "above the" in (attachment.rejection_detail or "")

    def test_an_executable_disguised_as_a_pdf_is_refused(self, db_session: Session) -> None:
        service, store, _ = build_service(db_session)

        outcome = service.ingest(
            build_message(attachment=b"MZ\x90\x00this is a windows executable"),
            source=IntakeSource.imap,
            correlation_id=uuid.uuid4(),
            imap=ImapProvenance(folder="INBOX", uid=14, uid_validity=100),
        )
        db_session.commit()

        assert outcome.rejected_attachments == 1
        assert outcome.message.attachments[0].rejection_reason == ("content_type_mismatch")
        assert store.keys_in(Bucket.documents) == []

    def test_quarantine_takes_precedence_over_a_rejection(self, db_session: Session) -> None:
        """An infected file is a security event, not a formatting problem.

        A message carrying both must not be filed as merely `failed`, or the
        infection is buried under a validation error.
        """
        service, _, _ = build_service(db_session, scanner=FakeScanner(verdict=ScanVerdict.infected))

        message = EmailMessage()
        message["Subject"] = "Two files"
        message["From"] = "billing@vendor.example"
        message["To"] = "invoices@company.example"
        message["Message-ID"] = "<mixed-1@vendor.example>"
        message["Date"] = format_datetime(datetime.now(UTC))
        message.set_content("Two attachments.")
        message.add_attachment(PDF, maintype="application", subtype="pdf", filename="good.pdf")
        message.add_attachment(
            b"MZ\x90\x00", maintype="application", subtype="pdf", filename="bad.pdf"
        )

        outcome = service.ingest(
            message.as_bytes(),
            source=IntakeSource.imap,
            correlation_id=uuid.uuid4(),
            imap=ImapProvenance(folder="INBOX", uid=15, uid_validity=100),
        )
        db_session.commit()

        assert outcome.quarantined_attachments == 1
        assert outcome.rejected_attachments == 1
        assert outcome.message.status is IntakeStatus.quarantined


@requires_db
class TestIdempotency:
    def test_the_same_message_twice_produces_one_record(self, db_session: Session) -> None:
        service, _, _ = build_service(db_session)
        raw = build_message()

        service.ingest(
            raw,
            source=IntakeSource.imap,
            correlation_id=uuid.uuid4(),
            imap=ImapProvenance(folder="INBOX", uid=20, uid_validity=100),
        )
        db_session.commit()

        with pytest.raises(DuplicateMessageError):
            service.ingest(
                raw,
                source=IntakeSource.imap,
                correlation_id=uuid.uuid4(),
                imap=ImapProvenance(folder="INBOX", uid=21, uid_validity=100),
            )
        db_session.commit()

        count = db_session.execute(select(InboundMessage)).scalars().all()
        assert len(count) == 1

    def test_a_re_forward_is_recognised_by_message_id(self, db_session: Session) -> None:
        """Two forwards of one message differ in bytes but not in Message-ID."""
        service, _, _ = build_service(db_session)

        first = build_message(subject="Invoice 12345")
        second = build_message(subject="Fwd: Invoice 12345")
        assert first != second

        service.ingest(
            first,
            source=IntakeSource.imap,
            correlation_id=uuid.uuid4(),
            imap=ImapProvenance(folder="INBOX", uid=22, uid_validity=100),
        )
        db_session.commit()

        with pytest.raises(DuplicateMessageError):
            service.ingest(
                second,
                source=IntakeSource.imap,
                correlation_id=uuid.uuid4(),
                imap=ImapProvenance(folder="INBOX", uid=23, uid_validity=100),
            )

    def test_a_message_without_an_id_falls_back_to_the_raw_hash(self, db_session: Session) -> None:
        service, _, _ = build_service(db_session)
        raw = build_message(message_id=None)

        outcome = service.ingest(
            raw,
            source=IntakeSource.imap,
            correlation_id=uuid.uuid4(),
            imap=ImapProvenance(folder="INBOX", uid=24, uid_validity=100),
        )
        db_session.commit()

        assert outcome.message.idempotency_key.startswith("raw:")

        with pytest.raises(DuplicateMessageError):
            service.ingest(
                raw,
                source=IntakeSource.imap,
                correlation_id=uuid.uuid4(),
                imap=ImapProvenance(folder="INBOX", uid=25, uid_validity=100),
            )

    def test_a_duplicate_is_audited_with_the_existing_record(self, db_session: Session) -> None:
        service, _, _ = build_service(db_session)
        raw = build_message()

        first = service.ingest(
            raw,
            source=IntakeSource.imap,
            correlation_id=uuid.uuid4(),
            imap=ImapProvenance(folder="INBOX", uid=26, uid_validity=100),
        )
        db_session.commit()
        original_id = first.message.id

        with pytest.raises(DuplicateMessageError) as raised:
            service.ingest(
                raw,
                source=IntakeSource.imap,
                correlation_id=uuid.uuid4(),
                imap=ImapProvenance(folder="INBOX", uid=27, uid_validity=100),
            )
        db_session.commit()

        assert raised.value.existing.id == original_id
        actions = db_session.execute(select(AuditEntryRow.action)).scalars().all()
        assert AuditAction.message_duplicate_detected in set(actions)


@requires_db
class TestConstraints:
    def test_a_stored_attachment_cannot_lack_a_verdict(self, db_session: Session) -> None:
        """Enforced by the database, not only by the service.

        A future code path that forgets to scan must fail loudly rather than
        quietly filing an unjudged file as available.
        """
        from sqlalchemy.exc import IntegrityError

        service, _, _ = build_service(db_session)
        outcome = service.ingest(
            build_message(),
            source=IntakeSource.imap,
            correlation_id=uuid.uuid4(),
            imap=ImapProvenance(folder="INBOX", uid=30, uid_validity=100),
        )
        db_session.commit()

        db_session.add(
            MessageAttachment(
                message_id=outcome.message.id,
                position=99,
                filename="unjudged.pdf",
                original_filename="unjudged.pdf",
                content_type="application/pdf",
                size_bytes=10,
                sha256="a" * 64,
                object_key="documents/unjudged.pdf",
                scan_verdict=None,
            )
        )
        with pytest.raises(IntegrityError):
            db_session.flush()
        db_session.rollback()

    def test_a_quarantined_attachment_cannot_be_marked_clean(self, db_session: Session) -> None:
        from sqlalchemy.exc import IntegrityError

        service, _, _ = build_service(db_session)
        outcome = service.ingest(
            build_message(),
            source=IntakeSource.imap,
            correlation_id=uuid.uuid4(),
            imap=ImapProvenance(folder="INBOX", uid=31, uid_validity=100),
        )
        db_session.commit()

        db_session.add(
            MessageAttachment(
                message_id=outcome.message.id,
                position=98,
                filename="contradiction.pdf",
                original_filename="contradiction.pdf",
                content_type="application/pdf",
                size_bytes=10,
                sha256="b" * 64,
                object_key="quarantine/contradiction.pdf",
                is_quarantined=True,
                scan_verdict=ScanVerdict.clean,
            )
        )
        with pytest.raises(IntegrityError):
            db_session.flush()
        db_session.rollback()
