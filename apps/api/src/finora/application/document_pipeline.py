"""Turning a stored attachment into a reading a person can check.

The order is the safety property again, as it is in intake:

1. Enrol. A clean, stored, non-inline attachment becomes a document with status
   `pending`. Enrolment is cheap and happens inside the intake transaction, so a
   message can never be ready with attachments nothing will ever read.
2. Read. Bytes are fetched from the store and verified against the hash recorded
   at intake, because reading whatever is at a key is not the same as reading the
   file that was scanned.
3. Classify from the document's own words. Only if that fails is a model asked
   what the document is, and its answer never lowers a threshold.
4. Apply deterministic rules. Whatever they find is traceable to a label and a
   rectangle on a page.
5. Ask a model only for the fields the rules could not read, and only for values
   it can be verified to have copied out of the document. Everything it proposes
   is scored below any review threshold and marked as its work.
6. Write one attempt, never overwriting an earlier one.

Two rules run through all of it. A person's value outranks a rule's, which
outranks a model's, and re-reading a document never disturbs what a person
accepted. Both are enforced here rather than trusted to callers, because the
whole point of the confidence and evidence machinery is that nobody downstream
has to wonder where a number came from.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Final, Protocol
from uuid import UUID

import structlog
from sqlalchemy import select
from sqlalchemy.orm import Session

from finora.application.extraction_rules import Proposal, read_fields, type_value
from finora.config import ExtractionSettings
from finora.domain.audit import ActorType, AuditAction
from finora.domain.classification import classify
from finora.domain.extraction import (
    FIELD_LABELS,
    KIND_LABELS,
    MODEL_PROPOSAL_CONFIDENCE,
    ConfidenceThresholds,
    DocumentKind,
    DocumentSignal,
    Evidence,
    ExtractionResult,
    ExtractionStatus,
    FieldCandidate,
    FieldName,
    FieldOrigin,
    FieldReview,
    absent,
    required_fields,
    useful_fields,
)
from finora.domain.intake import ScanVerdict
from finora.domain.text_layout import Box, DocumentText, TextSource
from finora.infrastructure.ai_gateway import AiGateway, GatewayOutcome, SuggestionResult
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import (
    Document,
    DocumentExtraction,
    ExtractionField,
    InboundMessage,
    MessageAttachment,
)
from finora.infrastructure.document_text import (
    PDF_TYPES,
    TEXT_TYPES,
    ReadingLimits,
    read_document,
    unreadable,
)
from finora.infrastructure.object_store import Bucket, ObjectStore, ObjectStoreError

logger = structlog.get_logger(__name__)


class DocumentNotReadyError(Exception):
    """The document cannot be read yet, or must not be read again."""


class Reviewer(Protocol):
    """Whoever is making a change: enough of them to attribute it.

    A structural type rather than an import of the API's `Principal`, so the
    application layer does not depend on the transport layer to know who acted.
    """

    @property
    def user_id(self) -> UUID: ...

    @property
    def display_name(self) -> str: ...


class FieldValueRejectedError(Exception):
    """What a reviewer typed cannot be stored in this field, and why."""


class NotAcceptableYetError(Exception):
    """The reading is not ready to be accepted. Carries everything outstanding."""

    def __init__(self, blockers: list[str]) -> None:
        self.blockers = blockers
        super().__init__("This reading is not ready to be accepted.")


class AlreadyAcceptedError(Exception):
    """A person has accepted this reading, so it will not be replaced.

    Re-reading is how a prompt change or a rule fix reaches old documents, and
    it must not be how an accepted invoice quietly acquires a different total.
    Superseding an accepted reading is a deliberate administrative act with its
    own audit entry, not a side effect of a batch job.
    """


@dataclass(slots=True)
class ReadOutcome:
    """What one reading attempt produced, for the caller to report."""

    document: Document
    extraction: DocumentExtraction
    fields_read: int = 0
    fields_proposed: int = 0
    suggestions_discarded: int = 0
    gateway_outcome: GatewayOutcome | None = None

    @property
    def needs_review(self) -> bool:
        return self.extraction.status is not ExtractionStatus.extracted


@dataclass(slots=True)
class BatchOutcome:
    read: list[ReadOutcome] = field(default_factory=list)
    failures: list[tuple[UUID, str]] = field(default_factory=list)

    @property
    def attempted(self) -> int:
        return len(self.read) + len(self.failures)


#: Content types worth enrolling as documents. An attachment outside this set is
#: kept and viewable but is not put in front of a reviewer as something to read,
#: because a spreadsheet of line items and a signature image are both attachments
#: and only one of them is a document the business acts on.
READABLE_TYPES: Final[frozenset[str]] = PDF_TYPES | TEXT_TYPES

#: Gateway outcomes that mean no answer was obtained, as opposed to an answer
#: that was obtained and rejected.
_UNAVAILABLE_OUTCOMES: Final[frozenset[GatewayOutcome]] = frozenset(
    {
        GatewayOutcome.disabled,
        GatewayOutcome.kill_switch,
        GatewayOutcome.circuit_open,
        GatewayOutcome.unavailable,
    }
)

#: What a model's answer about a document's kind is worth. Deliberately equal to
#: `MODEL_PROPOSAL_CONFIDENCE` and for the same reason: it was not read off the
#: document's own title, so a person confirms it. It matters more here than for a
#: single field, because the kind decides which fields are required at all, and a
#: wrong kind quietly changes what "complete" means.
MODEL_KIND_CONFIDENCE: Final[float] = MODEL_PROPOSAL_CONFIDENCE

#: Warnings a reviewer has to answer for before a reading can be accepted, and
#: which nothing on the screen can answer on their behalf. Both ask for an act
#: outside the workspace, which is exactly why neither may be cleared by simply
#: confirming the fields.
SIGNALS_REQUIRING_ACKNOWLEDGEMENT: Final[tuple[DocumentSignal, ...]] = (
    DocumentSignal.bank_details_present,
    DocumentSignal.prompt_injection_suspected,
)

ACKNOWLEDGEMENT_PROMPTS: Final[dict[DocumentSignal, str]] = {
    DocumentSignal.bank_details_present: (
        "This document carries bank or payment details. Confirm them against the "
        "vendor master through a channel you already trust, then acknowledge that "
        "you have done so."
    ),
    DocumentSignal.prompt_injection_suspected: (
        "This document contains text written to instruct an automated reader. Look "
        "at the document yourself and acknowledge that you have."
    ),
}


def enrol_documents(session: Session, message: InboundMessage) -> list[Document]:
    """Register every readable attachment of a message as a document to be read.

    A module function rather than only a pipeline method because intake calls it
    inside the ingest transaction, where no gateway or object store is needed. A
    message that committed without its documents enrolled would be a message
    nothing ever reads, so this cannot be left to the caller to remember.

    Idempotent by construction: `documents.attachment_id` is unique, and an
    attachment already enrolled is skipped, so a retried message produces no
    duplicates.
    """
    existing = set(
        session.execute(select(Document.attachment_id).where(Document.message_id == message.id))
        .scalars()
        .all()
    )

    created: list[Document] = []
    for attachment in message.attachments:
        if attachment.id in existing or not _is_enrollable(attachment):
            continue
        created.append(
            Document(
                attachment_id=attachment.id,
                message_id=message.id,
                filename=attachment.filename,
                content_type=attachment.content_type,
                size_bytes=attachment.size_bytes,
                sha256=attachment.sha256,
                # Never empty for an enrollable attachment: `_is_enrollable`
                # requires a clean verdict, and the database requires a verdict
                # for anything stored. Written this way for the type checker.
                object_key=attachment.object_key or "",
                kind=DocumentKind.unknown,
                status=ExtractionStatus.pending,
            )
        )

    if created:
        session.add_all(created)
        session.flush()
    return created


def _is_enrollable(attachment: MessageAttachment) -> bool:
    """Whether this attachment is a document the business acts on.

    A signature image and a spreadsheet of line items are both attachments; only
    one of them is something to put in front of a reviewer as a document to read.
    """
    return (
        attachment.scan_verdict is ScanVerdict.clean
        and not attachment.is_quarantined
        and not attachment.inline
        and bool(attachment.object_key)
        and attachment.content_type.split(";")[0].strip().casefold() in READABLE_TYPES
    )


class DocumentPipeline:
    def __init__(
        self,
        *,
        session: Session,
        object_store: ObjectStore,
        gateway: AiGateway,
        audit: AuditRepository,
        settings: ExtractionSettings,
    ) -> None:
        self._session = session
        self._store = object_store
        self._gateway = gateway
        self._audit = audit
        self._settings = settings

    @property
    def thresholds(self) -> ConfidenceThresholds:
        return ConfidenceThresholds(
            review=self._settings.review_confidence_threshold,
            low=self._settings.low_confidence_threshold,
        )

    # ---------------------------------------------------------------- enrolment

    def enrol(self, message: InboundMessage) -> list[Document]:
        return enrol_documents(self._session, message)

    # ------------------------------------------------------------------ reading

    def read_pending(self, *, correlation_id: UUID, limit: int | None = None) -> BatchOutcome:
        """Read the documents waiting for it, oldest first.

        Each document is read in its own nested transaction. One unreadable file
        in a batch must not discard the readings of the others, and a failure is
        recorded against that document rather than raised at the batch.
        """
        pending = (
            self._session.execute(
                select(Document)
                .where(Document.status == ExtractionStatus.pending)
                .order_by(Document.created_at)
                .limit(limit or self._settings.batch_size)
            )
            .scalars()
            .all()
        )

        outcome = BatchOutcome()
        for document in pending:
            savepoint = self._session.begin_nested()
            try:
                outcome.read.append(self.read(document, correlation_id=correlation_id))
                savepoint.commit()
            except Exception as error:
                savepoint.rollback()
                logger.exception(
                    "document.read_failed",
                    document_id=str(document.id),
                    correlation_id=str(correlation_id),
                )
                outcome.failures.append((document.id, str(error)))
                self._record_failure(document, reason=str(error), correlation_id=correlation_id)
        return outcome

    def read(
        self,
        document: Document,
        *,
        correlation_id: UUID,
        actor_label: str = "document reader",
    ) -> ReadOutcome:
        """Read one document and record the attempt."""
        current = self._current(document)
        if current is not None and current.status is ExtractionStatus.accepted:
            raise AlreadyAcceptedError(
                "This document's values have been accepted. Reading it again would "
                "replace what a person confirmed."
            )

        document.status = ExtractionStatus.extracting
        self._session.flush()

        text = self._load(document)
        kind, kind_confidence, kind_evidence, kind_notes, gateway_kind = self._decide_kind(text)

        result = read_fields(text, kind=kind)
        result.kind_confidence = kind_confidence
        result.kind_evidence = kind_evidence
        result.notes.extend(kind_notes)

        suggestions = self._ask_for_gaps(text, result)
        if suggestions is not None and suggestions.suggestions:
            # Re-read with the proposals in hand, so cross-checks and the
            # missing-field signals are computed from the merged field set.
            proposals = {
                item.name: Proposal(text=item.text, evidence=item.evidence)
                for item in suggestions.suggestions
            }
            merged = read_fields(text, kind=kind, proposals=proposals)
            merged.kind_confidence = kind_confidence
            merged.kind_evidence = kind_evidence
            merged.notes.extend(kind_notes)
            result = merged

        self._note_gateway(result, suggestions)

        extraction = self._record(
            document,
            result=result,
            text=text,
            suggestions=suggestions,
            gateway_kind=gateway_kind,
            correlation_id=correlation_id,
            actor_label=actor_label,
        )

        return ReadOutcome(
            document=document,
            extraction=extraction,
            fields_read=sum(
                1
                for candidate in result.fields.values()
                if candidate.origin is FieldOrigin.rule and candidate.is_present
            ),
            fields_proposed=sum(
                1 for candidate in result.fields.values() if candidate.origin is FieldOrigin.model
            ),
            suggestions_discarded=len(suggestions.discarded) if suggestions else 0,
            gateway_outcome=suggestions.outcome if suggestions else None,
        )

    # ------------------------------------------------------------------ loading

    def _load(self, document: Document) -> DocumentText:
        """Fetch the document's bytes and read text out of them.

        The hash is verified on the way through. An object whose content no
        longer matches what was scanned is not read at all: it is reported as
        unreadable, which puts it in front of a person instead of extracting
        values from a file whose provenance has broken.
        """
        try:
            data = self._store.get(
                bucket=Bucket.documents,
                key=document.object_key,
                expected_sha256=document.sha256,
            )
        except ObjectStoreError as error:
            logger.warning("document.fetch_failed", document_id=str(document.id), error=str(error))
            return unreadable(
                "The stored file could not be retrieved, or no longer matches what "
                "was received. Its values cannot be read. Contact an administrator."
            )

        return read_document(
            data,
            content_type=document.content_type,
            limits=ReadingLimits(
                max_pages=self._settings.max_read_pages,
                max_seconds=self._settings.max_read_seconds,
            ),
        )

    # ----------------------------------------------------------- classification

    def _decide_kind(
        self, text: DocumentText
    ) -> tuple[DocumentKind, float, Evidence | None, list[str], GatewayOutcome | None]:
        """What kind of document this is, and how sure of that anyone should be."""
        if text.source is TextSource.none:
            return DocumentKind.unknown, 0.0, None, [], None

        deterministic = classify(text)
        if deterministic.kind is not DocumentKind.unknown:
            return (
                deterministic.kind,
                deterministic.confidence,
                deterministic.evidence,
                list(deterministic.notes),
                None,
            )

        suggestion = self._gateway.suggest_kind(text)
        notes = list(deterministic.notes)
        if suggestion.note:
            notes.append(suggestion.note)
        if suggestion.outcome is not GatewayOutcome.answered:
            return DocumentKind.unknown, 0.0, None, notes, suggestion.outcome
        if suggestion.kind is DocumentKind.unknown:
            return DocumentKind.unknown, 0.0, None, notes, suggestion.outcome

        notes.append(
            "The document does not say what it is. The assistive reader identified "
            f"it as: {KIND_LABELS[suggestion.kind]}. Confirm that before the values "
            "are used, because the kind decides which fields this document needs."
        )
        return (
            suggestion.kind,
            MODEL_KIND_CONFIDENCE,
            suggestion.evidence,
            notes,
            suggestion.outcome,
        )

    # -------------------------------------------------------------- suggestions

    def _ask_for_gaps(
        self, text: DocumentText, result: ExtractionResult
    ) -> SuggestionResult | None:
        """Ask the gateway for the fields no rule could read.

        Returns None when there was nothing worth asking about, which keeps
        "no gaps" distinguishable from "asked and got nothing" in the record.
        """
        if text.source is TextSource.none or not text.has_text:
            return None

        wanted = frozenset(
            name
            for name in useful_fields(result.kind)
            # Currency is settled document-wide from the symbols present, so it
            # is never asked for.
            if name is not FieldName.currency
            and not result.fields.get(name, absent(name, "")).is_present
        )
        if not wanted:
            return None

        return self._gateway.suggest_fields(text, kind=result.kind, wanted=wanted)

    @staticmethod
    def _note_gateway(result: ExtractionResult, suggestions: SuggestionResult | None) -> None:
        """Record what the gateway did, including that it did nothing."""
        if suggestions is None:
            return
        if suggestions.discarded:
            result.add_signal(DocumentSignal.model_output_rejected)
        if suggestions.outcome in _UNAVAILABLE_OUTCOMES:
            result.add_signal(DocumentSignal.model_unavailable)
        if suggestions.note:
            result.notes.append(suggestions.note)

    # ---------------------------------------------------------------- recording

    def _record(
        self,
        document: Document,
        *,
        result: ExtractionResult,
        text: DocumentText,
        suggestions: SuggestionResult | None,
        gateway_kind: GatewayOutcome | None,
        correlation_id: UUID,
        actor_label: str,
    ) -> DocumentExtraction:
        """Write the attempt, its fields, and the audit entry for both."""
        thresholds = self.thresholds
        status = result.status(thresholds)
        call = suggestions.call if suggestions else None

        for superseded in document.extractions:
            superseded.is_current = False

        extraction = DocumentExtraction(
            attempt=self._next_attempt(document),
            is_current=True,
            status=status,
            kind=result.kind,
            kind_confidence=result.kind_confidence,
            kind_evidence=_evidence_json(result.kind_evidence),
            text_source=result.text_source,
            page_count=result.page_count,
            review_threshold=thresholds.review,
            low_threshold=thresholds.low,
            signals=[str(signal) for signal in result.signals],
            notes=list(dict.fromkeys(result.notes)),
            injection_findings=[
                {"description": finding.description, "excerpt": finding.excerpt}
                for finding in result.injection_findings
            ],
            gateway_outcome=str(suggestions.outcome) if suggestions else None,
            model_name=call.model if call else None,
            prompt_id=call.prompt_id if call else None,
            prompt_version=call.prompt_version if call else None,
            prompt_sha256=call.prompt_sha256 if call else None,
            model_latency_ms=call.latency_ms if call else None,
            suggestions_discarded=len(suggestions.discarded) if suggestions else 0,
            completed_at=datetime.now(UTC),
        )
        # Appended to the relationship rather than inserted with a foreign key, so
        # that `document.extractions` is accurate immediately. A second read in
        # the same session would otherwise compute attempt 1 again from a stale
        # collection and collide with the first.
        document.extractions.append(extraction)
        self._session.flush()

        for candidate in _ordered(result, kind=result.kind):
            extraction.fields.append(_field_row(candidate))
        self._session.flush()

        document.kind = result.kind
        document.status = status
        self._session.flush()

        detail: dict[str, object] = {
            "attempt": extraction.attempt,
            "kind": str(result.kind),
            "kind_confidence": round(result.kind_confidence, 4),
            "status": str(status),
            "text_source": str(result.text_source),
            "page_count": result.page_count,
            "review_threshold": thresholds.review,
            "signals": [str(signal) for signal in result.signals],
            "fields_present": len(result.present_fields()),
            "sha256": document.sha256,
        }
        if suggestions is not None:
            detail["gateway_outcome"] = str(suggestions.outcome)
            detail["suggestions_accepted"] = len(suggestions.suggestions)
            detail["suggestions_discarded"] = len(suggestions.discarded)
            detail["discard_reasons"] = sorted({str(item.reason) for item in suggestions.discarded})
        if gateway_kind is not None:
            detail["kind_gateway_outcome"] = str(gateway_kind)
        if call is not None:
            detail.update(call.as_detail())

        self._audit.append(
            action=AuditAction.extraction_completed,
            actor_type=ActorType.service,
            actor_id=None,
            actor_label=actor_label,
            subject_type="document",
            subject_id=document.id,
            correlation_id=correlation_id,
            detail=detail,
        )

        logger.info(
            "document.read",
            document_id=str(document.id),
            attempt=extraction.attempt,
            kind=str(result.kind),
            status=str(status),
            signals=[str(signal) for signal in result.signals],
            text_source=str(text.source),
        )
        return extraction

    def _record_failure(self, document: Document, *, reason: str, correlation_id: UUID) -> None:
        """Mark a document as failed, in its own transaction.

        Separate from the rolled-back attempt on purpose: the savepoint that
        discarded the half-written attempt also discarded any record that it was
        tried, and a document silently back in `pending` would be retried
        forever with nobody told.
        """
        document.status = ExtractionStatus.failed
        self._audit.append(
            action=AuditAction.extraction_completed,
            actor_type=ActorType.service,
            actor_id=None,
            actor_label="document reader",
            subject_type="document",
            subject_id=document.id,
            correlation_id=correlation_id,
            detail={"status": str(ExtractionStatus.failed), "reason": reason[:500]},
        )
        self._session.flush()

    # -------------------------------------------------------------------- review

    def current(self, document: Document) -> DocumentExtraction:
        """The attempt the workspace is showing, or a refusal explaining there is none."""
        extraction = self._current(document)
        if extraction is None:
            raise DocumentNotReadyError(
                "This document has not been read yet, so there is nothing to review."
            )
        return extraction

    def correct_field(
        self,
        document: Document,
        *,
        name: FieldName,
        text: str,
        principal: Reviewer,
        reason: str | None,
        correlation_id: UUID,
    ) -> ExtractionField:
        """Record a person's value for a field, keeping the reader's beside it.

        The reader's original is preserved on first correction only. Correcting a
        correction leaves `reader_text` as the machine's answer rather than the
        previous human one, because the question that column answers is "what did
        the reader say", and the full sequence of edits is in the audit trail.
        """
        extraction = self._editable(document)
        row = self._field_row(extraction, name)

        typed = type_value(name, text, currency_code=self._currency_of(extraction))
        if typed.problem:
            raise FieldValueRejectedError(typed.problem)
        if not typed.text:
            raise FieldValueRejectedError(
                "Enter a value, or mark the field as not present on the document."
            )

        before = row.text
        if row.origin is not FieldOrigin.human:
            row.reader_text = row.text
            row.reader_confidence = row.confidence

        row.text = typed.text
        row.origin = FieldOrigin.human
        # A person's own reading of the document is not a probability. It is shown
        # as confirmed rather than scored, and 1.0 here is the record of that,
        # not a claim about a model's certainty.
        row.confidence = 1.0
        row.review = FieldReview.corrected
        row.amount_minor_units = typed.amount_minor_units
        row.currency = typed.currency
        row.value_date = typed.value_date
        row.notes = list(typed.notes)
        row.corrected_by_id = principal.user_id
        row.corrected_at = datetime.now(UTC)
        row.correction_reason = (reason or "").strip()[:1000] or None

        self._recompute(document, extraction)
        self._audit.append(
            action=AuditAction.extraction_corrected,
            actor_type=ActorType.user,
            actor_id=principal.user_id,
            actor_label=principal.display_name,
            subject_type="document",
            subject_id=document.id,
            correlation_id=correlation_id,
            detail={
                "field": str(name),
                "attempt": extraction.attempt,
                "from": before,
                "to": row.text,
                "reader_text": row.reader_text,
                "reason": row.correction_reason,
            },
        )
        return row

    def review_field(
        self,
        document: Document,
        *,
        name: FieldName,
        review: FieldReview,
        principal: Reviewer,
        correlation_id: UUID,
    ) -> ExtractionField:
        """Confirm what the reader found, or record that the document does not carry it."""
        if review not in {FieldReview.confirmed, FieldReview.cleared}:
            raise FieldValueRejectedError(
                "A field is either confirmed as read, cleared as not present, or corrected."
            )

        extraction = self._editable(document)
        row = self._field_row(extraction, name)

        if review is FieldReview.confirmed and not row.text:
            raise FieldValueRejectedError(
                "There is no value to confirm. Enter one, or clear the field."
            )

        if review is FieldReview.cleared:
            if row.origin is not FieldOrigin.human:
                row.reader_text = row.text
                row.reader_confidence = row.confidence
            row.text = ""
            row.origin = FieldOrigin.absent
            row.confidence = 0.0
            row.amount_minor_units = None
            row.currency = None
            row.value_date = None
            row.corrected_by_id = principal.user_id
            row.corrected_at = datetime.now(UTC)

        row.review = review
        self._recompute(document, extraction)
        self._audit.append(
            action=AuditAction.extraction_corrected,
            actor_type=ActorType.user,
            actor_id=principal.user_id,
            actor_label=principal.display_name,
            subject_type="document",
            subject_id=document.id,
            correlation_id=correlation_id,
            detail={
                "field": str(name),
                "attempt": extraction.attempt,
                "review": str(review),
                "reader_text": row.reader_text,
            },
        )
        return row

    def set_kind(
        self,
        document: Document,
        *,
        kind: DocumentKind,
        principal: Reviewer,
        correlation_id: UUID,
    ) -> DocumentExtraction:
        """Record a person's decision about what a document is.

        Confirmed by a person rather than scored, because the kind decides which
        fields the document is required to have, and a reviewer who has read the
        page knows better than either the rules or a model.
        """
        extraction = self._editable(document)
        before = extraction.kind
        extraction.kind = kind
        extraction.kind_confidence = 1.0
        document.kind = kind

        # The required set may have changed, so a field the old kind did not need
        # has to exist as a row for the reviewer to fill.
        present = {row.name for row in extraction.fields}
        for name in sorted(required_fields(kind), key=lambda item: item.value):
            if name not in present:
                extraction.fields.append(
                    _field_row(absent(name, "This document type needs this field. Enter it."))
                )
        self._session.flush()

        self._recompute(document, extraction)
        self._audit.append(
            action=AuditAction.extraction_corrected,
            actor_type=ActorType.user,
            actor_id=principal.user_id,
            actor_label=principal.display_name,
            subject_type="document",
            subject_id=document.id,
            correlation_id=correlation_id,
            detail={"attempt": extraction.attempt, "kind_from": str(before), "kind_to": str(kind)},
        )
        return extraction

    def acknowledge(
        self,
        document: Document,
        *,
        signal: DocumentSignal,
        principal: Reviewer,
        correlation_id: UUID,
    ) -> DocumentExtraction:
        """Record that a reviewer has seen a warning and dealt with it.

        Only warnings that ask a person to do something outside this screen can be
        acknowledged: bank details on the page have to be checked against the
        vendor master, and a document written to instruct a machine has to be
        looked at by someone. Neither is answerable by confirming a field, so
        without this a document carrying either could never be accepted.
        """
        if signal not in SIGNALS_REQUIRING_ACKNOWLEDGEMENT:
            raise FieldValueRejectedError(
                "That warning is not something to acknowledge. It clears when the "
                "values it refers to are confirmed or corrected."
            )
        extraction = self._editable(document)
        if signal.value not in extraction.signals:
            raise FieldValueRejectedError("This document does not carry that warning.")

        if signal.value not in extraction.acknowledged_signals:
            # Reassigned rather than appended: SQLAlchemy does not track mutation
            # inside a JSONB list, and an in-place append would not be written.
            extraction.acknowledged_signals = [*extraction.acknowledged_signals, signal.value]

        self._recompute(document, extraction)
        self._audit.append(
            action=AuditAction.extraction_corrected,
            actor_type=ActorType.user,
            actor_id=principal.user_id,
            actor_label=principal.display_name,
            subject_type="document",
            subject_id=document.id,
            correlation_id=correlation_id,
            detail={
                "attempt": extraction.attempt,
                "acknowledged_signal": signal.value,
                "prompt": ACKNOWLEDGEMENT_PROMPTS[signal],
            },
        )
        return extraction

    def accept(
        self,
        document: Document,
        *,
        principal: Reviewer,
        note: str | None,
        correlation_id: UUID,
    ) -> DocumentExtraction:
        """Confirm a reading, making its values usable downstream.

        No segregation-of-duties pair guards this against `extraction:edit`.
        Correcting a misread total and confirming the corrected set is one job
        done by one reviewer, and splitting it would put a second person in front
        of every document to retype nothing. The two-person control that matters
        is downstream: whoever submits an invoice cannot approve it.
        """
        extraction = self._editable(document)
        blockers = self.acceptance_blockers(extraction)
        if blockers:
            raise NotAcceptableYetError(blockers)

        now = datetime.now(UTC)
        extraction.status = ExtractionStatus.accepted
        extraction.accepted_at = now
        extraction.accepted_by_id = principal.user_id
        extraction.accepted_note = (note or "").strip()[:1000] or None
        document.status = ExtractionStatus.accepted
        self._session.flush()

        self._audit.append(
            action=AuditAction.extraction_accepted,
            actor_type=ActorType.user,
            actor_id=principal.user_id,
            actor_label=principal.display_name,
            subject_type="document",
            subject_id=document.id,
            correlation_id=correlation_id,
            detail={
                "attempt": extraction.attempt,
                "kind": str(extraction.kind),
                "note": extraction.accepted_note,
                "fields": {
                    str(row.name): {
                        "text": row.text,
                        "origin": str(row.origin),
                        "review": str(row.review),
                        "confidence": round(row.confidence, 4),
                    }
                    for row in extraction.fields
                },
            },
        )
        return extraction

    def acceptance_blockers(self, extraction: DocumentExtraction) -> list[str]:
        """Everything standing between this reading and acceptance, in plain words.

        Returned as a list rather than raised one at a time so the workspace can
        show a reviewer the whole remaining task instead of revealing it one
        refusal per attempt.
        """
        blockers: list[str] = []
        if extraction.kind is DocumentKind.unknown:
            blockers.append(
                "Say what kind of document this is. The kind decides which fields it needs."
            )

        rows = {row.name: row for row in extraction.fields}
        for name in sorted(required_fields(extraction.kind), key=lambda item: item.value):
            row = rows.get(name)
            if row is None or not row.text:
                blockers.append(f"{FIELD_LABELS[name]} is needed and has no value.")

        threshold = extraction.review_threshold
        for name, row in sorted(rows.items(), key=lambda item: item[0].value):
            if not row.text or row.review is not FieldReview.unreviewed:
                continue
            if row.confidence < threshold:
                blockers.append(
                    f"{FIELD_LABELS[name]} was read with low confidence. "
                    "Check it against the document and confirm or correct it."
                )

        acknowledged = set(extraction.acknowledged_signals)
        for signal in SIGNALS_REQUIRING_ACKNOWLEDGEMENT:
            if signal.value in extraction.signals and signal.value not in acknowledged:
                blockers.append(ACKNOWLEDGEMENT_PROMPTS[signal])

        return blockers

    # -------------------------------------------------------- review internals

    def _editable(self, document: Document) -> DocumentExtraction:
        extraction = self.current(document)
        if extraction.status is ExtractionStatus.accepted:
            raise AlreadyAcceptedError(
                "This reading has been accepted and cannot be changed. Ask an "
                "administrator to reopen it if a value is wrong."
            )
        if extraction.status is ExtractionStatus.extracting:
            raise DocumentNotReadyError("This document is still being read. Try again shortly.")
        return extraction

    def _field_row(self, extraction: DocumentExtraction, name: FieldName) -> ExtractionField:
        """The row for a field, created if this reading has none.

        Created rather than refused, because a reviewer may legitimately supply a
        purchase order number the document never mentioned, and a field the rules
        had no reason to look for has no row.
        """
        for row in extraction.fields:
            if row.name is name:
                return row
        row = _field_row(absent(name, "Entered by a reviewer."))
        extraction.fields.append(row)
        self._session.flush()
        return row

    def _currency_of(self, extraction: DocumentExtraction) -> str | None:
        for row in extraction.fields:
            if row.name is FieldName.currency and row.text:
                return row.text.upper()[:3]
        return None

    def _recompute(self, document: Document, extraction: DocumentExtraction) -> None:
        """Move the reading between `needs_review` and `extracted` after an edit.

        Acceptance is never reached this way. A document whose every field has
        been checked is ready for a person to accept, and remains not accepted
        until one does.
        """
        status = (
            ExtractionStatus.extracted
            if not self.acceptance_blockers(extraction)
            else ExtractionStatus.needs_review
        )
        extraction.status = status
        document.status = status
        self._session.flush()

    def _current(self, document: Document) -> DocumentExtraction | None:
        return next((item for item in document.extractions if item.is_current), None)

    def _next_attempt(self, document: Document) -> int:
        return max((item.attempt for item in document.extractions), default=0) + 1


def _ordered(result: ExtractionResult, *, kind: DocumentKind) -> list[FieldCandidate]:
    """Every field worth recording, including the ones that were not found.

    A required field that is missing gets a row saying so, because a reviewer
    reading the workspace needs "not on the document" to be an answer rather than
    an absence they have to notice.
    """
    rows = dict(result.fields)
    for name in required_fields(kind):
        rows.setdefault(name, absent(name, "This was not found on the document."))
    return [rows[name] for name in FieldName if name in rows]


def _field_row(candidate: FieldCandidate) -> ExtractionField:
    evidence = candidate.evidence
    return ExtractionField(
        name=candidate.name,
        text=candidate.text,
        origin=candidate.origin,
        confidence=candidate.confidence,
        review=FieldReview.unreviewed,
        amount_minor_units=candidate.amount_minor_units,
        currency=candidate.currency,
        value_date=candidate.value_date,
        evidence_page=evidence.page_number if evidence else None,
        evidence_snippet=evidence.snippet if evidence else None,
        evidence_boxes=[_box_json(box) for box in evidence.boxes] if evidence else [],
        adjustments=[
            {"reason": item.reason, "delta": item.delta} for item in candidate.adjustments
        ],
        notes=list(candidate.notes),
    )


def _evidence_json(evidence: Evidence | None) -> dict[str, object] | None:
    if evidence is None:
        return None
    return {
        "page_number": evidence.page_number,
        "snippet": evidence.snippet,
        "boxes": [_box_json(box) for box in evidence.boxes],
    }


def _box_json(box: Box) -> dict[str, float]:
    return {
        "x": round(box.x, 2),
        "y": round(box.y, 2),
        "width": round(box.width, 2),
        "height": round(box.height, 2),
    }
