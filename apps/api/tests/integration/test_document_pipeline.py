"""Reading a document and reviewing what was read.

The properties under test are the ones that decide whether a number on a screen
can be trusted: a model never overwrites a rule, a rule never overwrites a
person, an accepted reading is never replaced by a re-run, a document carrying
bank details cannot be accepted without someone saying they checked them, and
every one of those acts leaves an audit entry.

Documents are plain text rather than PDFs. The reader's PDF handling has its own
unit tests; here the point is what the pipeline does with whatever the reader
returned, and a text invoice exercises the classification, rules, persistence and
review paths without a binary fixture in the repository.
"""

from __future__ import annotations

import itertools
import uuid
from dataclasses import dataclass, field

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from tests.conftest import make_user, requires_db
from tests.integration.test_intake_service import (
    FakeObjectStore,
    FakeScanner,
    build_message,
    build_service,
)

from finora.application.document_pipeline import (
    AlreadyAcceptedError,
    DocumentPipeline,
    FieldValueRejectedError,
    NotAcceptableYetError,
)
from finora.application.intake import ImapProvenance
from finora.config import ExtractionSettings
from finora.domain.audit import AuditAction
from finora.domain.extraction import (
    DocumentKind,
    DocumentSignal,
    Evidence,
    ExtractionStatus,
    FieldName,
    FieldOrigin,
    FieldReview,
)
from finora.domain.intake import IntakeSource, ScanVerdict
from finora.domain.roles import Role
from finora.infrastructure.ai_gateway import (
    DiscardedSuggestion,
    DiscardReason,
    FieldSuggestion,
    GatewayOutcome,
    KindSuggestion,
    ModelCall,
    SuggestionResult,
)
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import (
    AuditEntryRow,
    Document,
    DocumentExtraction,
    ExtractionField,
)
from finora.infrastructure.object_store import Bucket

INVOICE = b"""KINGSTON SUPPLIES LIMITED
TAX INVOICE
Invoice Number: INV-4471
Invoice Date: 2026-03-15
Due Date: 2026-04-14
Purchase Order: PO-99120
Vendor: Kingston Supplies Limited
Subtotal: JMD 100,000.00
Tax: JMD 15,000.00
Total: JMD 115,000.00
"""

#: An invoice with no title and no labels. Nothing deterministic can be read from
#: it, which is the case a model exists for.
UNLABELLED = b"""Kingston Supplies Limited
4471
2026-03-15
JMD 115,000.00
"""

#: An invoice that says what it is but does not label its number. The kind is
#: settled, so there is something worth asking a model about.
UNNUMBERED = b"""KINGSTON SUPPLIES LIMITED
TAX INVOICE
Invoice Date: 2026-03-15
Vendor: Kingston Supplies Limited
Total: JMD 115,000.00
"""

WITH_BANK_DETAILS = (
    INVOICE
    + b"""Bank: National Commercial Bank
Account Number: 4455667788
"""
)


# ------------------------------------------------------------------- doubles


@dataclass
class FakeGateway:
    """A gateway that answers exactly what a test tells it to.

    Deliberately not a mock of the HTTP layer. What matters here is how the
    pipeline treats an answer, a refusal and an absence, and the real gateway's
    verification of an answer against the document is tested separately.
    """

    field_result: SuggestionResult | None = None
    kind_result: KindSuggestion | None = None
    field_calls: list[frozenset[FieldName]] = field(default_factory=list)
    kind_calls: int = 0

    def availability(self) -> GatewayOutcome | None:
        return None if (self.field_result or self.kind_result) else GatewayOutcome.disabled

    def suggest_fields(
        self, document: object, *, kind: DocumentKind, wanted: frozenset[FieldName]
    ) -> SuggestionResult:
        self.field_calls.append(wanted)
        return self.field_result or SuggestionResult(outcome=GatewayOutcome.disabled)

    def suggest_kind(self, document: object) -> KindSuggestion:
        self.kind_calls += 1
        return self.kind_result or KindSuggestion(outcome=GatewayOutcome.disabled)


@dataclass
class Reviewer:
    user_id: uuid.UUID
    display_name: str


#: Mailbox UIDs are unique within a folder, so each ingested message needs its own.
_UIDS = itertools.count(1)


def build_pipeline(
    session: Session,
    *,
    store: FakeObjectStore,
    gateway: FakeGateway | None = None,
    settings: ExtractionSettings | None = None,
) -> DocumentPipeline:
    return DocumentPipeline(
        session=session,
        object_store=store,  # type: ignore[arg-type]
        gateway=gateway or FakeGateway(),  # type: ignore[arg-type]
        audit=AuditRepository(session),
        settings=settings or ExtractionSettings(),
    )


def ingest_document(
    session: Session,
    *,
    body: bytes = INVOICE,
    filename: str = "invoice.txt",
    content_type: str = "text/plain",
    store: FakeObjectStore | None = None,
    scanner: FakeScanner | None = None,
) -> tuple[Document, FakeObjectStore]:
    """Put one document through intake, the only way a document is created."""
    service, store, _ = build_service(session, store=store, scanner=scanner)
    outcome = service.ingest(
        build_message(
            attachment=body,
            filename=filename,
            content_type=content_type,
            # Unique per call, so a test that ingests several documents is not
            # refused as a duplicate delivery of one message.
            message_id=f"<{uuid.uuid4()}@vendor.example>",
        ),
        source=IntakeSource.imap,
        correlation_id=uuid.uuid4(),
        imap=ImapProvenance(folder="INBOX", uid=next(_UIDS), uid_validity=100),
    )
    session.commit()

    document = session.execute(
        select(Document).where(Document.message_id == outcome.message.id)
    ).scalar_one()
    return document, store


def reviewer(session: Session, *, roles: list[Role] | None = None) -> Reviewer:
    user = make_user(
        session,
        email=f"reviewer-{uuid.uuid4().hex[:8]}@company.example",
        display_name="Ann Reviewer",
        roles=roles or [Role.finance],
    )
    return Reviewer(user_id=user.id, display_name=user.display_name)


def field_of(extraction: DocumentExtraction, name: FieldName) -> ExtractionField:
    return next(row for row in extraction.fields if row.name is name)


def audit_actions(session: Session) -> list[AuditAction]:
    return list(
        session.execute(select(AuditEntryRow.action).order_by(AuditEntryRow.sequence)).scalars()
    )


# ------------------------------------------------------------------ enrolment


@requires_db
class TestEnrolment:
    def test_a_clean_readable_attachment_becomes_a_document_awaiting_a_reading(
        self, db_session: Session
    ) -> None:
        document, _ = ingest_document(db_session)

        assert document.status is ExtractionStatus.pending
        assert document.kind is DocumentKind.unknown
        assert document.filename == "invoice.txt"

    def test_an_attachment_no_reader_understands_is_not_enrolled(self, db_session: Session) -> None:
        service, _, _ = build_service(db_session)
        outcome = service.ingest(
            build_message(
                attachment=b"\xff\xd8\xff\xe0 not really a photograph",
                filename="signature.jpg",
                content_type="image/jpeg",
            ),
            source=IntakeSource.imap,
            correlation_id=uuid.uuid4(),
            imap=ImapProvenance(folder="INBOX", uid=next(_UIDS), uid_validity=100),
        )
        db_session.commit()

        # A photograph of a signature is an attachment, not a document the
        # business acts on. It stays viewable and out of the review queue.
        assert outcome.enrolled_documents == 0
        assert (
            db_session.execute(
                select(Document).where(Document.message_id == outcome.message.id)
            ).all()
            == []
        )

    def test_an_infected_attachment_is_never_enrolled(self, db_session: Session) -> None:
        service, _, _ = build_service(
            db_session, scanner=FakeScanner(verdict=ScanVerdict.infected, detail="Test.Sig")
        )
        outcome = service.ingest(
            build_message(),
            source=IntakeSource.imap,
            correlation_id=uuid.uuid4(),
            imap=ImapProvenance(folder="INBOX", uid=next(_UIDS), uid_validity=100),
        )
        db_session.commit()

        assert outcome.quarantined_attachments == 1
        assert outcome.enrolled_documents == 0

    def test_ingesting_the_same_message_twice_does_not_enrol_it_twice(
        self, db_session: Session
    ) -> None:
        document, store = ingest_document(db_session)
        pipeline = build_pipeline(db_session, store=store)

        message = document.attachment.message
        assert pipeline.enrol(message) == []


# -------------------------------------------------------------------- reading


@requires_db
class TestReadingWithRulesAlone:
    def test_a_labelled_invoice_is_read_without_asking_a_model(self, db_session: Session) -> None:
        document, store = ingest_document(db_session)
        gateway = FakeGateway()
        pipeline = build_pipeline(db_session, store=store, gateway=gateway)

        outcome = pipeline.read(document, correlation_id=uuid.uuid4())
        db_session.commit()

        extraction = outcome.extraction
        assert extraction.attempt == 1
        assert extraction.is_current
        assert extraction.kind is DocumentKind.invoice
        assert field_of(extraction, FieldName.document_number).text == "INV-4471"
        assert field_of(extraction, FieldName.total).amount_minor_units == 115_000_00
        assert field_of(extraction, FieldName.total).currency == "JMD"
        assert field_of(extraction, FieldName.document_number).origin is FieldOrigin.rule

    def test_no_model_provenance_is_recorded_when_no_model_was_involved(
        self, db_session: Session
    ) -> None:
        document, store = ingest_document(db_session)
        pipeline = build_pipeline(db_session, store=store)

        extraction = pipeline.read(document, correlation_id=uuid.uuid4()).extraction
        db_session.commit()

        # A prompt hash with no model, or the reverse, is a partial record of
        # something that has to be reproducible in full. Neither is written.
        assert extraction.model_name is None
        assert extraction.prompt_sha256 is None

    def test_the_thresholds_in_force_are_stored_on_the_attempt(self, db_session: Session) -> None:
        document, store = ingest_document(db_session)
        pipeline = build_pipeline(
            db_session,
            store=store,
            settings=ExtractionSettings(
                review_confidence_threshold=0.9, low_confidence_threshold=0.4
            ),
        )

        extraction = pipeline.read(document, correlation_id=uuid.uuid4()).extraction
        db_session.commit()

        # Stored rather than read from configuration later, so lowering a
        # threshold does not retrospectively reclassify a document.
        assert extraction.review_threshold == pytest.approx(0.9)
        assert extraction.low_threshold == pytest.approx(0.4)

    def test_a_document_with_bank_details_is_flagged_and_held_for_review(
        self, db_session: Session
    ) -> None:
        document, store = ingest_document(db_session, body=WITH_BANK_DETAILS)
        pipeline = build_pipeline(db_session, store=store)

        extraction = pipeline.read(document, correlation_id=uuid.uuid4()).extraction
        db_session.commit()

        assert DocumentSignal.bank_details_present.value in extraction.signals
        assert extraction.status is ExtractionStatus.needs_review

    def test_a_file_that_cannot_be_read_asks_for_the_values_by_hand(
        self, db_session: Session
    ) -> None:
        document, store = ingest_document(db_session, body=b"   \n  \n")
        pipeline = build_pipeline(db_session, store=store)

        extraction = pipeline.read(document, correlation_id=uuid.uuid4()).extraction
        db_session.commit()

        assert extraction.status is ExtractionStatus.manual_entry_required
        assert document.status is ExtractionStatus.manual_entry_required

    def test_a_stored_file_whose_content_no_longer_matches_is_not_read(
        self, db_session: Session
    ) -> None:
        document, store = ingest_document(db_session)
        store.objects[(Bucket.documents, document.object_key)] = b"substituted after scanning"
        pipeline = build_pipeline(db_session, store=store)

        extraction = pipeline.read(document, correlation_id=uuid.uuid4()).extraction
        db_session.commit()

        # Reading whatever is at a key is not the same as reading the file that
        # was scanned, so a mismatch produces a refusal a person has to resolve.
        assert extraction.status is ExtractionStatus.manual_entry_required
        assert any("no longer matches" in note for note in extraction.notes)

    def test_the_reading_is_audited_with_what_produced_it(self, db_session: Session) -> None:
        document, store = ingest_document(db_session)
        pipeline = build_pipeline(db_session, store=store)

        pipeline.read(document, correlation_id=uuid.uuid4())
        db_session.commit()

        entry = db_session.execute(
            select(AuditEntryRow)
            .where(AuditEntryRow.action == AuditAction.extraction_completed)
            .order_by(AuditEntryRow.sequence.desc())
        ).scalar()
        assert entry is not None
        assert entry.subject_id == document.id
        assert entry.detail["kind"] == "invoice"
        assert entry.detail["sha256"] == document.sha256


# ------------------------------------------------------------- model proposals


@requires_db
class TestModelProposals:
    def test_a_kind_nothing_downstream_processes_is_not_worth_a_model_call(
        self, db_session: Session
    ) -> None:
        document, store = ingest_document(db_session, body=UNLABELLED)
        gateway = FakeGateway(field_result=SuggestionResult(outcome=GatewayOutcome.nothing_usable))
        pipeline = build_pipeline(db_session, store=store, gateway=gateway)

        pipeline.read(document, correlation_id=uuid.uuid4())
        db_session.commit()

        # The kind decides which fields matter, so asking about fields for a
        # document of unknown kind would be a guess built on a guess.
        assert gateway.field_calls == []

    def test_a_model_is_only_asked_about_fields_no_rule_could_read(
        self, db_session: Session
    ) -> None:
        document, store = ingest_document(db_session)
        gateway = FakeGateway(field_result=SuggestionResult(outcome=GatewayOutcome.nothing_usable))
        pipeline = build_pipeline(db_session, store=store, gateway=gateway)

        pipeline.read(document, correlation_id=uuid.uuid4())
        db_session.commit()

        asked = gateway.field_calls[0] if gateway.field_calls else frozenset()
        # Agreement would add no information and disagreement would invite
        # overriding a traceable reading with a guess, so neither is requested.
        assert FieldName.total not in asked
        assert FieldName.document_number not in asked
        # Currency governs how every amount is read and is settled from the page.
        assert FieldName.currency not in asked

    def test_a_proposal_fills_a_gap_and_is_marked_as_the_models_work(
        self, db_session: Session
    ) -> None:
        document, store = ingest_document(db_session, body=UNLABELLED)
        gateway = FakeGateway(
            kind_result=KindSuggestion(
                outcome=GatewayOutcome.answered,
                kind=DocumentKind.invoice,
                evidence=Evidence(page_number=1, snippet="Kingston Supplies Limited"),
                call=ModelCall(
                    model="local/test",
                    prompt_id="document.kind",
                    prompt_version=1,
                    prompt_sha256="a" * 64,
                    latency_ms=12,
                    attempts=1,
                ),
            ),
            field_result=SuggestionResult(
                outcome=GatewayOutcome.answered,
                suggestions=(
                    FieldSuggestion(
                        name=FieldName.document_number,
                        text="4471",
                        evidence=Evidence(page_number=1, snippet="4471"),
                    ),
                ),
                call=ModelCall(
                    model="local/test",
                    prompt_id="document.fields",
                    prompt_version=1,
                    prompt_sha256="b" * 64,
                    latency_ms=34,
                    attempts=1,
                ),
            ),
        )
        pipeline = build_pipeline(db_session, store=store, gateway=gateway)

        extraction = pipeline.read(document, correlation_id=uuid.uuid4()).extraction
        db_session.commit()

        row = field_of(extraction, FieldName.document_number)
        assert row.text == "4471"
        assert row.origin is FieldOrigin.model
        assert row.confidence < extraction.review_threshold
        assert DocumentSignal.model_assisted.value in extraction.signals
        assert extraction.status is ExtractionStatus.needs_review
        assert extraction.model_name == "local/test"
        assert extraction.prompt_sha256 == "b" * 64

    def test_a_proposal_never_replaces_a_value_a_rule_found(self, db_session: Session) -> None:
        document, store = ingest_document(db_session)
        gateway = FakeGateway(
            field_result=SuggestionResult(
                outcome=GatewayOutcome.answered,
                suggestions=(
                    FieldSuggestion(
                        name=FieldName.document_number,
                        text="WRONG-9999",
                        evidence=Evidence(page_number=1, snippet="WRONG-9999"),
                    ),
                ),
                call=ModelCall(
                    model="local/test",
                    prompt_id="document.fields",
                    prompt_version=1,
                    prompt_sha256="c" * 64,
                    latency_ms=9,
                    attempts=1,
                ),
            )
        )
        pipeline = build_pipeline(db_session, store=store, gateway=gateway)

        extraction = pipeline.read(document, correlation_id=uuid.uuid4()).extraction
        db_session.commit()

        row = field_of(extraction, FieldName.document_number)
        assert row.text == "INV-4471"
        assert row.origin is FieldOrigin.rule

    def test_discarded_suggestions_are_counted_and_flagged(self, db_session: Session) -> None:
        document, store = ingest_document(db_session, body=UNNUMBERED)
        gateway = FakeGateway(
            field_result=SuggestionResult(
                outcome=GatewayOutcome.nothing_usable,
                discarded=(
                    DiscardedSuggestion(
                        name="total", text="9,999.00", reason=DiscardReason.not_found_in_document
                    ),
                ),
                note="The assistive reader proposed a value that is not in this document.",
            )
        )
        pipeline = build_pipeline(db_session, store=store, gateway=gateway)

        extraction = pipeline.read(document, correlation_id=uuid.uuid4()).extraction
        db_session.commit()

        assert extraction.suggestions_discarded == 1
        assert DocumentSignal.model_output_rejected.value in extraction.signals

    def test_an_unavailable_gateway_is_recorded_and_changes_nothing_else(
        self, db_session: Session
    ) -> None:
        document, store = ingest_document(db_session)
        pipeline = build_pipeline(db_session, store=store, gateway=FakeGateway())

        extraction = pipeline.read(document, correlation_id=uuid.uuid4()).extraction
        db_session.commit()

        # Every value on this document came from a rule, so an absent model is a
        # note rather than a failure.
        assert field_of(extraction, FieldName.total).text == "115,000.00"
        assert extraction.model_name is None


# --------------------------------------------------------------------- review


@requires_db
class TestCorrectingWhatWasRead:
    def test_a_persons_value_replaces_the_readers_and_keeps_it(self, db_session: Session) -> None:
        document, store = ingest_document(db_session)
        pipeline = build_pipeline(db_session, store=store)
        pipeline.read(document, correlation_id=uuid.uuid4())
        db_session.commit()
        person = reviewer(db_session)

        row = pipeline.correct_field(
            document,
            name=FieldName.total,
            text="120,000.00",
            principal=person,
            reason="The document was amended by hand.",
            correlation_id=uuid.uuid4(),
        )
        db_session.commit()

        assert row.origin is FieldOrigin.human
        assert row.review is FieldReview.corrected
        assert row.amount_minor_units == 120_000_00
        assert row.currency == "JMD"
        assert row.reader_text == "115,000.00"
        assert row.corrected_by_id == person.user_id
        assert row.correction_reason == "The document was amended by hand."

    def test_correcting_twice_keeps_the_readers_answer_not_the_previous_persons(
        self, db_session: Session
    ) -> None:
        document, store = ingest_document(db_session)
        pipeline = build_pipeline(db_session, store=store)
        pipeline.read(document, correlation_id=uuid.uuid4())
        db_session.commit()
        person = reviewer(db_session)

        for value in ("120,000.00", "121,000.00"):
            pipeline.correct_field(
                document,
                name=FieldName.total,
                text=value,
                principal=person,
                reason=None,
                correlation_id=uuid.uuid4(),
            )
        db_session.commit()

        row = field_of(pipeline.current(document), FieldName.total)
        assert row.text == "121,000.00"
        assert row.reader_text == "115,000.00"

    def test_a_value_the_field_cannot_hold_is_refused_with_a_reason(
        self, db_session: Session
    ) -> None:
        document, store = ingest_document(db_session)
        pipeline = build_pipeline(db_session, store=store)
        pipeline.read(document, correlation_id=uuid.uuid4())
        db_session.commit()
        person = reviewer(db_session)

        with pytest.raises(FieldValueRejectedError, match="not a date"):
            pipeline.correct_field(
                document,
                name=FieldName.document_date,
                text="next Tuesday",
                principal=person,
                reason=None,
                correlation_id=uuid.uuid4(),
            )

    def test_clearing_a_field_records_that_the_document_does_not_carry_it(
        self, db_session: Session
    ) -> None:
        document, store = ingest_document(db_session)
        pipeline = build_pipeline(db_session, store=store)
        pipeline.read(document, correlation_id=uuid.uuid4())
        db_session.commit()
        person = reviewer(db_session)

        row = pipeline.review_field(
            document,
            name=FieldName.due_date,
            review=FieldReview.cleared,
            principal=person,
            correlation_id=uuid.uuid4(),
        )
        db_session.commit()

        assert row.origin is FieldOrigin.absent
        assert row.review is FieldReview.cleared
        assert row.reader_text == "2026-04-14"

    def test_a_reviewer_may_supply_a_field_the_rules_never_looked_for(
        self, db_session: Session
    ) -> None:
        document, store = ingest_document(db_session)
        pipeline = build_pipeline(db_session, store=store)
        pipeline.read(document, correlation_id=uuid.uuid4())
        db_session.commit()
        person = reviewer(db_session)

        row = pipeline.correct_field(
            document,
            name=FieldName.estimate_reference,
            text="EST-2211",
            principal=person,
            reason=None,
            correlation_id=uuid.uuid4(),
        )
        db_session.commit()

        assert row.text == "EST-2211"
        assert row.origin is FieldOrigin.human

    def test_every_correction_is_audited_with_both_values(self, db_session: Session) -> None:
        document, store = ingest_document(db_session)
        pipeline = build_pipeline(db_session, store=store)
        pipeline.read(document, correlation_id=uuid.uuid4())
        db_session.commit()
        person = reviewer(db_session)

        pipeline.correct_field(
            document,
            name=FieldName.total,
            text="120,000.00",
            principal=person,
            reason=None,
            correlation_id=uuid.uuid4(),
        )
        db_session.commit()

        entry = db_session.execute(
            select(AuditEntryRow)
            .where(AuditEntryRow.action == AuditAction.extraction_corrected)
            .order_by(AuditEntryRow.sequence.desc())
        ).scalar()
        assert entry is not None
        assert entry.actor_id == person.user_id
        assert entry.detail["from"] == "115,000.00"
        assert entry.detail["to"] == "120,000.00"


@requires_db
class TestSayingWhatADocumentIs:
    def test_a_person_deciding_the_kind_adds_the_fields_that_kind_needs(
        self, db_session: Session
    ) -> None:
        document, store = ingest_document(db_session, body=UNLABELLED)
        pipeline = build_pipeline(db_session, store=store)
        pipeline.read(document, correlation_id=uuid.uuid4())
        db_session.commit()
        person = reviewer(db_session)

        extraction = pipeline.set_kind(
            document,
            kind=DocumentKind.invoice,
            principal=person,
            correlation_id=uuid.uuid4(),
        )
        db_session.commit()

        assert extraction.kind is DocumentKind.invoice
        assert extraction.kind_confidence == pytest.approx(1.0)
        assert document.kind is DocumentKind.invoice
        # An invoice needs a document number, which no rule looked for while the
        # kind was unknown, so a row now exists for the reviewer to fill.
        assert field_of(extraction, FieldName.document_number) is not None


@requires_db
class TestAcceptance:
    def test_a_reading_with_an_unanswered_warning_cannot_be_accepted(
        self, db_session: Session
    ) -> None:
        document, store = ingest_document(db_session, body=WITH_BANK_DETAILS)
        pipeline = build_pipeline(db_session, store=store)
        pipeline.read(document, correlation_id=uuid.uuid4())
        db_session.commit()
        person = reviewer(db_session)

        with pytest.raises(NotAcceptableYetError) as raised:
            pipeline.accept(document, principal=person, note=None, correlation_id=uuid.uuid4())

        assert any("vendor master" in blocker for blocker in raised.value.blockers)

    def test_acknowledging_a_warning_clears_it_and_is_audited(self, db_session: Session) -> None:
        document, store = ingest_document(db_session, body=WITH_BANK_DETAILS)
        pipeline = build_pipeline(db_session, store=store)
        pipeline.read(document, correlation_id=uuid.uuid4())
        db_session.commit()
        person = reviewer(db_session)

        extraction = pipeline.acknowledge(
            document,
            signal=DocumentSignal.bank_details_present,
            principal=person,
            correlation_id=uuid.uuid4(),
        )
        db_session.commit()

        assert DocumentSignal.bank_details_present.value in extraction.acknowledged_signals
        assert not any(
            "vendor master" in blocker for blocker in pipeline.acceptance_blockers(extraction)
        )
        assert AuditAction.extraction_corrected in audit_actions(db_session)

    def test_a_warning_this_document_does_not_carry_cannot_be_acknowledged(
        self, db_session: Session
    ) -> None:
        document, store = ingest_document(db_session)
        pipeline = build_pipeline(db_session, store=store)
        pipeline.read(document, correlation_id=uuid.uuid4())
        db_session.commit()
        person = reviewer(db_session)

        with pytest.raises(FieldValueRejectedError):
            pipeline.acknowledge(
                document,
                signal=DocumentSignal.bank_details_present,
                principal=person,
                correlation_id=uuid.uuid4(),
            )

    def test_a_reading_missing_a_required_field_cannot_be_accepted(
        self, db_session: Session
    ) -> None:
        document, store = ingest_document(db_session, body=UNLABELLED)
        pipeline = build_pipeline(db_session, store=store)
        pipeline.read(document, correlation_id=uuid.uuid4())
        db_session.commit()
        person = reviewer(db_session)
        pipeline.set_kind(
            document, kind=DocumentKind.invoice, principal=person, correlation_id=uuid.uuid4()
        )
        db_session.commit()

        with pytest.raises(NotAcceptableYetError) as raised:
            pipeline.accept(document, principal=person, note=None, correlation_id=uuid.uuid4())

        assert raised.value.blockers

    def test_a_reading_every_field_of_which_has_been_checked_can_be_accepted(
        self, db_session: Session
    ) -> None:
        document, store = ingest_document(db_session)
        pipeline = build_pipeline(db_session, store=store)
        pipeline.read(document, correlation_id=uuid.uuid4())
        db_session.commit()
        person = reviewer(db_session)

        extraction = pipeline.current(document)
        for row in list(extraction.fields):
            if row.text and row.confidence < extraction.review_threshold:
                pipeline.review_field(
                    document,
                    name=row.name,
                    review=FieldReview.confirmed,
                    principal=person,
                    correlation_id=uuid.uuid4(),
                )
        db_session.commit()

        accepted = pipeline.accept(
            document,
            principal=person,
            note="Checked against the paper copy.",
            correlation_id=uuid.uuid4(),
        )
        db_session.commit()

        assert accepted.status is ExtractionStatus.accepted
        assert accepted.accepted_by_id == person.user_id
        assert accepted.accepted_note == "Checked against the paper copy."
        assert document.status is ExtractionStatus.accepted

    def test_an_accepted_reading_cannot_be_edited(self, db_session: Session) -> None:
        document, store, person = _accepted(db_session)
        pipeline = build_pipeline(db_session, store=store)

        with pytest.raises(AlreadyAcceptedError):
            pipeline.correct_field(
                document,
                name=FieldName.total,
                text="1.00",
                principal=person,
                reason=None,
                correlation_id=uuid.uuid4(),
            )

    def test_an_accepted_reading_is_not_replaced_by_reading_the_document_again(
        self, db_session: Session
    ) -> None:
        document, store, _ = _accepted(db_session)
        pipeline = build_pipeline(db_session, store=store)

        # Re-reading is how a rule fix reaches old documents. It must not be how
        # an accepted invoice quietly acquires a different total.
        with pytest.raises(AlreadyAcceptedError):
            pipeline.read(document, correlation_id=uuid.uuid4())

    def test_acceptance_records_every_value_it_accepted(self, db_session: Session) -> None:
        _, _, person = _accepted(db_session)

        entry = db_session.execute(
            select(AuditEntryRow)
            .where(AuditEntryRow.action == AuditAction.extraction_accepted)
            .order_by(AuditEntryRow.sequence.desc())
        ).scalar()
        assert entry is not None
        assert entry.actor_id == person.user_id
        # The accepted values are in the entry itself, so what was approved is
        # answerable from the trail alone rather than from the current row.
        assert entry.detail["fields"]["total"]["text"] == "115,000.00"


def _accepted(db_session: Session) -> tuple[Document, FakeObjectStore, Reviewer]:
    """A document read, fully reviewed and accepted, for tests about what follows."""
    document, store = ingest_document(db_session)
    pipeline = build_pipeline(db_session, store=store)
    pipeline.read(document, correlation_id=uuid.uuid4())
    db_session.commit()
    person = reviewer(db_session)

    extraction = pipeline.current(document)
    for row in list(extraction.fields):
        if row.text and row.confidence < extraction.review_threshold:
            pipeline.review_field(
                document,
                name=row.name,
                review=FieldReview.confirmed,
                principal=person,
                correlation_id=uuid.uuid4(),
            )
    pipeline.accept(document, principal=person, note=None, correlation_id=uuid.uuid4())
    db_session.commit()
    return document, store, person


# ---------------------------------------------------------------- re-readings


@requires_db
class TestRereading:
    def test_an_earlier_attempt_is_kept_and_no_longer_current(self, db_session: Session) -> None:
        document, store = ingest_document(db_session)
        pipeline = build_pipeline(db_session, store=store)
        pipeline.read(document, correlation_id=uuid.uuid4())
        db_session.commit()

        second = pipeline.read(document, correlation_id=uuid.uuid4()).extraction
        db_session.commit()
        db_session.refresh(document)

        assert second.attempt == 2
        assert [item.attempt for item in document.extractions] == [1, 2]
        assert [item.is_current for item in document.extractions] == [False, True]

    def test_a_batch_reads_what_is_waiting_and_leaves_the_rest(self, db_session: Session) -> None:
        store = FakeObjectStore()
        first, store = ingest_document(db_session, store=store)
        pipeline = build_pipeline(db_session, store=store)

        outcome = pipeline.read_pending(correlation_id=uuid.uuid4())
        db_session.commit()

        assert [item.document.id for item in outcome.read] == [first.id]
        assert pipeline.read_pending(correlation_id=uuid.uuid4()).read == []

    def test_a_batch_stops_at_the_configured_size(self, db_session: Session) -> None:
        store = FakeObjectStore()
        for _ in range(3):
            ingest_document(db_session, store=store)
        pipeline = build_pipeline(
            db_session, store=store, settings=ExtractionSettings(batch_size=2)
        )

        outcome = pipeline.read_pending(correlation_id=uuid.uuid4())
        db_session.commit()

        # Bounded so a large backlog is worked through in steady increments
        # rather than one long transaction.
        assert len(outcome.read) == 2
