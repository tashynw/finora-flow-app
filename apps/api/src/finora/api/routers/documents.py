"""Document reading and review endpoints.

Three rules shape every response.

Every value carries its provenance. A field is never sent as a bare string: it
comes with who produced it, how confident anyone should be, what the reason for
that confidence is, and where on the page it was found. A client that renders
only the value is losing information, and a client cannot accidentally present a
model's proposal as a finding.

Nothing is served that has not been scanned clean. A viewer URL is issued for a
document, which by construction is a clean stored attachment, and the object
store refuses to sign a quarantine key even if a bug reached that far.

Refusals explain the whole remaining task. `acceptance_blockers` is returned on
every read of a document, so the workspace can show a reviewer everything
outstanding at once rather than revealing it one rejected attempt at a time.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from finora.api.deps import (
    AuditDep,
    CorrelationDep,
    DocumentPipelineDep,
    ObjectStoreDep,
    RequirePermission,
    SessionDep,
    SettingsDep,
)
from finora.api.security import Principal
from finora.application.document_pipeline import (
    SIGNALS_REQUIRING_ACKNOWLEDGEMENT,
    AlreadyAcceptedError,
    DocumentNotReadyError,
    DocumentPipeline,
    FieldValueRejectedError,
    NotAcceptableYetError,
)
from finora.application.document_tasks import read_pending_documents
from finora.domain.audit import ActorType, AuditAction
from finora.domain.extraction import (
    FIELD_LABELS,
    KIND_LABELS,
    SIGNAL_EXPLANATIONS,
    ConfidenceBand,
    ConfidenceThresholds,
    DocumentKind,
    DocumentSignal,
    ExtractionStatus,
    FieldName,
    FieldOrigin,
    FieldReview,
)
from finora.domain.roles import Permission
from finora.domain.workflow import STATE_LABELS
from finora.infrastructure.db.models import (
    Document,
    DocumentExtraction,
    Estimate,
    ExtractionField,
    InboundMessage,
)
from finora.infrastructure.object_store import Bucket, ObjectStoreError

router = APIRouter(prefix="/documents", tags=["documents"])


# ------------------------------------------------------------------- schemas


class BoxOut(BaseModel):
    """A rectangle on a page, in PDF points from the top-left corner."""

    x: float
    y: float
    width: float
    height: float


class EvidenceOut(BaseModel):
    page_number: int
    snippet: str
    #: Required rather than defaulted, here and on every list below. A response
    #: model that defaults a list describes itself in the schema as a field the
    #: caller may not receive, and a browser then has to defend against an
    #: absence this API never produces.
    boxes: list[BoxOut]


class AdjustmentOut(BaseModel):
    """One named reason a confidence is not what the match alone would give."""

    reason: str
    delta: float


class FieldOut(BaseModel):
    name: FieldName
    label: str
    text: str
    origin: FieldOrigin
    confidence: float
    band: ConfidenceBand
    review: FieldReview

    amount_minor_units: int | None
    currency: str | None
    value_date: date | None

    evidence: EvidenceOut | None
    adjustments: list[AdjustmentOut]
    notes: list[str]

    #: What the reader said, when a person has since changed it.
    reader_text: str | None
    reader_confidence: float | None
    corrected_at: datetime | None
    correction_reason: str | None

    #: Whether this value still needs a person. Computed here so a client cannot
    #: reach a different answer from the one acceptance is judged against.
    needs_attention: bool


class SignalOut(BaseModel):
    signal: str
    explanation: str
    acknowledged: bool
    #: Whether acknowledging is what clears it, as opposed to fixing the fields.
    requires_acknowledgement: bool


class ExtractionOut(BaseModel):
    id: uuid.UUID
    attempt: int
    status: ExtractionStatus
    kind: DocumentKind
    kind_label: str
    kind_confidence: float
    kind_evidence: EvidenceOut | None
    text_source: str
    page_count: int
    review_threshold: float

    signals: list[SignalOut]
    notes: list[str]
    fields: list[FieldOut]

    #: Present only when a model was involved. Null is the normal case.
    model_name: str | None
    prompt_id: str | None
    prompt_version: int | None
    gateway_outcome: str | None
    suggestions_discarded: int

    completed_at: datetime | None
    accepted_at: datetime | None
    accepted_note: str | None


class DocumentSummary(BaseModel):
    id: uuid.UUID
    message_id: uuid.UUID
    filename: str
    content_type: str
    size_bytes: int
    kind: DocumentKind
    kind_label: str
    status: ExtractionStatus
    created_at: datetime

    #: Enough of the reading to sort and triage a queue without opening each row.
    lowest_confidence: float | None
    fields_needing_attention: int
    signal_count: int
    subject: str | None
    from_address: str | None


class RaisedRecordOut(BaseModel):
    """A record already raised from this document.

    Sent so the workspace can send a reader to it instead of offering to raise a
    second one and refusing. A document becomes at most one estimate, and the
    person looking at an accepted reading usually wants whatever it became.
    """

    kind: Literal["estimate"]
    id: uuid.UUID
    reference: str
    state_label: str


class DocumentDetail(DocumentSummary):
    sha256: str
    extraction: ExtractionOut | None
    acceptance_blockers: list[str]
    #: Earlier attempts, newest first, without their fields. Present so a reviewer
    #: can see that a document was re-read and when.
    history: list[AttemptSummary]
    raised_as: RaisedRecordOut | None


class AttemptSummary(BaseModel):
    id: uuid.UUID
    attempt: int
    status: ExtractionStatus
    kind: DocumentKind
    completed_at: datetime | None
    accepted_at: datetime | None
    model_name: str | None


class DocumentPage(BaseModel):
    items: list[DocumentSummary]
    total: int
    limit: int
    offset: int


class ViewerUrl(BaseModel):
    url: str
    expires_in_seconds: int
    filename: str
    content_type: str


class CorrectionRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    reason: str | None = Field(default=None, max_length=1000)


class ReviewRequest(BaseModel):
    review: FieldReview


class KindRequest(BaseModel):
    kind: DocumentKind


class AcknowledgeRequest(BaseModel):
    signal: DocumentSignal


class AcceptRequest(BaseModel):
    note: str | None = Field(default=None, max_length=1000)


class ReadRequested(BaseModel):
    documents_queued: int
    detail: str


DocumentDetail.model_rebuild()


# ------------------------------------------------------------------- mapping


def _thresholds(extraction: DocumentExtraction) -> ConfidenceThresholds:
    """The bands as they stood when this reading was made, not as configured now.

    Read off the attempt so a value shown as low confidence in March is still
    shown as low confidence when the document is reopened in September, whatever
    an administrator has changed since.
    """
    return ConfidenceThresholds(review=extraction.review_threshold, low=extraction.low_threshold)


def _needs_attention(row: ExtractionField, threshold: float) -> bool:
    """Whether this field still needs a person.

    A reviewed field never does, whatever its confidence, because a person has
    looked. An unreviewed one does whenever it is missing or was read below the
    threshold in force when it was read.
    """
    if row.review is not FieldReview.unreviewed:
        return False
    if not row.text:
        return True
    return row.confidence < threshold


def _evidence_out(payload: object) -> EvidenceOut | None:
    if not isinstance(payload, dict):
        return None
    boxes = payload.get("boxes") or []
    return EvidenceOut(
        page_number=int(payload.get("page_number") or 1),
        snippet=str(payload.get("snippet") or ""),
        boxes=[BoxOut(**box) for box in boxes if isinstance(box, dict)],
    )


def _field_out(row: ExtractionField, thresholds: ConfidenceThresholds) -> FieldOut:
    return FieldOut(
        name=row.name,
        label=FIELD_LABELS[row.name],
        text=row.text,
        origin=row.origin,
        confidence=round(row.confidence, 4),
        band=thresholds.band(row.confidence),
        review=row.review,
        amount_minor_units=row.amount_minor_units,
        currency=row.currency,
        value_date=row.value_date,
        evidence=(
            EvidenceOut(
                page_number=row.evidence_page,
                snippet=row.evidence_snippet or "",
                boxes=[BoxOut(**box) for box in row.evidence_boxes if isinstance(box, dict)],
            )
            if row.evidence_page is not None
            else None
        ),
        adjustments=[
            AdjustmentOut(reason=str(item.get("reason", "")), delta=float(item.get("delta", 0.0)))
            for item in row.adjustments
            if isinstance(item, dict)
        ],
        notes=[str(note) for note in row.notes],
        reader_text=row.reader_text,
        reader_confidence=row.reader_confidence,
        corrected_at=row.corrected_at,
        correction_reason=row.correction_reason,
        needs_attention=_needs_attention(row, thresholds.review),
    )


def _signals_out(extraction: DocumentExtraction) -> list[SignalOut]:
    acknowledged = set(extraction.acknowledged_signals)
    out: list[SignalOut] = []
    for raw in extraction.signals:
        name = str(raw)
        try:
            signal = DocumentSignal(name)
        except ValueError:
            # A signal recorded by an older version of the reader. Shown rather
            # than dropped: a warning nobody can explain is still a warning.
            out.append(
                SignalOut(
                    signal=name,
                    explanation="This warning is no longer described by this version.",
                    acknowledged=name in acknowledged,
                    requires_acknowledgement=False,
                )
            )
            continue
        out.append(
            SignalOut(
                signal=signal.value,
                explanation=SIGNAL_EXPLANATIONS.get(signal, signal.value.replace("_", " ")),
                acknowledged=signal.value in acknowledged,
                requires_acknowledgement=signal in SIGNALS_REQUIRING_ACKNOWLEDGEMENT,
            )
        )
    return out


def _extraction_out(extraction: DocumentExtraction) -> ExtractionOut:
    thresholds = _thresholds(extraction)
    return ExtractionOut(
        id=extraction.id,
        attempt=extraction.attempt,
        status=extraction.status,
        kind=extraction.kind,
        kind_label=KIND_LABELS[extraction.kind],
        kind_confidence=round(extraction.kind_confidence, 4),
        kind_evidence=_evidence_out(extraction.kind_evidence),
        text_source=str(extraction.text_source),
        page_count=extraction.page_count,
        review_threshold=thresholds.review,
        signals=_signals_out(extraction),
        notes=[str(note) for note in extraction.notes],
        fields=[_field_out(row, thresholds) for row in extraction.fields],
        model_name=extraction.model_name,
        prompt_id=extraction.prompt_id,
        prompt_version=extraction.prompt_version,
        gateway_outcome=extraction.gateway_outcome,
        suggestions_discarded=extraction.suggestions_discarded,
        completed_at=extraction.completed_at,
        accepted_at=extraction.accepted_at,
        accepted_note=extraction.accepted_note,
    )


def _summary(row: Document, message: InboundMessage | None) -> DocumentSummary:
    current = _current(row)
    threshold = current.review_threshold if current else 0.0
    return DocumentSummary(
        id=row.id,
        message_id=row.message_id,
        filename=row.filename,
        content_type=row.content_type,
        size_bytes=row.size_bytes,
        kind=row.kind,
        kind_label=KIND_LABELS[row.kind],
        status=row.status,
        created_at=row.created_at,
        lowest_confidence=(
            round(min((f.confidence for f in current.fields if f.text), default=0.0), 4)
            if current
            else None
        ),
        fields_needing_attention=(
            sum(1 for f in current.fields if _needs_attention(f, threshold)) if current else 0
        ),
        signal_count=len(current.signals) if current else 0,
        subject=message.subject if message else None,
        from_address=message.from_address if message else None,
    )


def _current(row: Document) -> DocumentExtraction | None:
    return next((item for item in row.extractions if item.is_current), None)


def _raised_as(session: Session, row: Document) -> RaisedRecordOut | None:
    """The estimate raised from this document, if there is one."""
    estimate = session.execute(
        select(Estimate).where(Estimate.document_id == row.id, Estimate.archived_at.is_(None))
    ).scalar_one_or_none()
    if estimate is None:
        return None
    return RaisedRecordOut(
        kind="estimate",
        id=estimate.id,
        reference=estimate.reference,
        state_label=STATE_LABELS[estimate.state],
    )


def _detail(
    row: Document,
    message: InboundMessage | None,
    blockers: list[str],
    raised_as: RaisedRecordOut | None,
) -> DocumentDetail:
    current = _current(row)
    return DocumentDetail(
        **_summary(row, message).model_dump(),
        sha256=row.sha256,
        extraction=_extraction_out(current) if current else None,
        acceptance_blockers=blockers,
        raised_as=raised_as,
        history=[
            AttemptSummary(
                id=item.id,
                attempt=item.attempt,
                status=item.status,
                kind=item.kind,
                completed_at=item.completed_at,
                accepted_at=item.accepted_at,
                model_name=item.model_name,
            )
            for item in sorted(row.extractions, key=lambda e: e.attempt, reverse=True)
            if not item.is_current
        ],
    )


def _load(session: Session, document_id: uuid.UUID) -> Document:
    row = session.get(Document, document_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="That document could not be found.",
        )
    return row


def _message_of(session: Session, row: Document) -> InboundMessage | None:
    return session.get(InboundMessage, row.message_id)


# --------------------------------------------------------------------- reads


@router.get("", response_model=DocumentPage)
def list_documents(
    session: SessionDep,
    _: Annotated[Principal, Depends(RequirePermission(Permission.extraction_view))],
    status_filter: Annotated[ExtractionStatus | None, Query(alias="status")] = None,
    kind_filter: Annotated[DocumentKind | None, Query(alias="kind")] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> DocumentPage:
    """The review queue, oldest first.

    Oldest first, unlike the message list. A message list is a record of what
    arrived and is read newest first; this is a work queue, and the document that
    has waited longest is the one to do next.
    """
    conditions = []
    if status_filter is not None:
        conditions.append(Document.status == status_filter)
    if kind_filter is not None:
        conditions.append(Document.kind == kind_filter)

    total = session.execute(
        select(func.count()).select_from(Document).where(*conditions)
    ).scalar_one()

    rows = (
        session.execute(
            select(Document)
            .where(*conditions)
            .order_by(Document.created_at)
            .limit(limit)
            .offset(offset)
        )
        .scalars()
        .all()
    )

    messages = (
        {
            message.id: message
            for message in session.execute(
                select(InboundMessage).where(
                    InboundMessage.id.in_({row.message_id for row in rows})
                )
            )
            .scalars()
            .all()
        }
        if rows
        else {}
    )

    return DocumentPage(
        items=[_summary(row, messages.get(row.message_id)) for row in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/{document_id}", response_model=DocumentDetail)
def get_document(
    document_id: uuid.UUID,
    session: SessionDep,
    pipeline: DocumentPipelineDep,
    _: Annotated[Principal, Depends(RequirePermission(Permission.extraction_view))],
) -> DocumentDetail:
    """One document, its current reading, and everything outstanding on it."""
    row = _load(session, document_id)
    current = _current(row)
    blockers = pipeline.acceptance_blockers(current) if current else []
    return _detail(row, _message_of(session, row), blockers, _raised_as(session, row))


@router.get("/{document_id}/viewer-url", response_model=ViewerUrl)
def viewer_url(
    document_id: uuid.UUID,
    session: SessionDep,
    store: ObjectStoreDep,
    settings: SettingsDep,
    audit: AuditDep,
    correlation_id: CorrelationDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.document_view))],
) -> ViewerUrl:
    """A short-lived link to the document itself, for the viewer to render.

    Served without a `Content-Disposition` of `attachment`, unlike the intake
    download link, because this URL is fetched by the viewer rather than followed
    by the browser. It is only ever issued for a document, and a document is by
    construction an attachment that scanned clean.
    """
    row = _load(session, document_id)
    try:
        url = store.signed_url(bucket=Bucket.documents, key=row.object_key)
    except ObjectStoreError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The document store is not available, so the document cannot be opened.",
        ) from error

    audit.append(
        action=AuditAction.document_viewed,
        actor_type=ActorType.user,
        actor_id=principal.user_id,
        actor_label=principal.display_name,
        subject_type="document",
        subject_id=row.id,
        correlation_id=correlation_id,
        detail={"filename": row.filename, "sha256": row.sha256},
    )
    session.commit()

    return ViewerUrl(
        url=url,
        expires_in_seconds=settings.object_store.signed_url_ttl_seconds,
        filename=row.filename,
        content_type=row.content_type,
    )


# -------------------------------------------------------------------- writes


@router.post("/read-pending", response_model=ReadRequested)
def read_pending(
    session: SessionDep,
    settings: SettingsDep,
    background: BackgroundTasks,
    correlation_id: CorrelationDep,
    _: Annotated[Principal, Depends(RequirePermission(Permission.extraction_edit))],
) -> ReadRequested:
    """Start reading the documents that are waiting.

    Queued rather than run inline: a backlog can be dozens of documents and the
    caller does not need to hold a connection open for it. Existing readings are
    untouched, so calling this twice is harmless.
    """
    waiting = session.execute(
        select(func.count())
        .select_from(Document)
        .where(Document.status == ExtractionStatus.pending)
    ).scalar_one()

    if waiting:
        background.add_task(read_pending_documents, correlation_id=correlation_id)

    limit = settings.extraction.batch_size
    return ReadRequested(
        documents_queued=min(waiting, limit),
        detail=(
            "Nothing is waiting to be read."
            if not waiting
            else f"Reading has started on {min(waiting, limit)} of {waiting} documents waiting."
        ),
    )


@router.post("/{document_id}/read", response_model=DocumentDetail)
def reread_document(
    document_id: uuid.UUID,
    session: SessionDep,
    pipeline: DocumentPipelineDep,
    correlation_id: CorrelationDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.extraction_edit))],
) -> DocumentDetail:
    """Read one document again, keeping every earlier attempt.

    Run inline rather than queued, because a person asking for this is waiting to
    see whether it helped. An accepted reading is refused: replacing what someone
    confirmed is an administrative act, not a button on the review screen.
    """
    row = _load(session, document_id)
    try:
        pipeline.read(row, correlation_id=correlation_id, actor_label=principal.display_name)
    except AlreadyAcceptedError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    session.commit()

    current = _current(row)
    blockers = pipeline.acceptance_blockers(current) if current else []
    return _detail(row, _message_of(session, row), blockers, _raised_as(session, row))


@router.patch("/{document_id}/fields/{field_name}", response_model=DocumentDetail)
def correct_field(
    document_id: uuid.UUID,
    field_name: FieldName,
    payload: CorrectionRequest,
    session: SessionDep,
    pipeline: DocumentPipelineDep,
    correlation_id: CorrelationDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.extraction_edit))],
) -> DocumentDetail:
    """Replace a value with what a person read on the document."""
    row = _load(session, document_id)
    try:
        pipeline.correct_field(
            row,
            name=field_name,
            text=payload.text,
            principal=principal,
            reason=payload.reason,
            correlation_id=correlation_id,
        )
    except FieldValueRejectedError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
        ) from error
    except AlreadyAcceptedError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except DocumentNotReadyError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    session.commit()
    return _reloaded(session, pipeline, row)


@router.post("/{document_id}/fields/{field_name}/review", response_model=DocumentDetail)
def review_field(
    document_id: uuid.UUID,
    field_name: FieldName,
    payload: ReviewRequest,
    session: SessionDep,
    pipeline: DocumentPipelineDep,
    correlation_id: CorrelationDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.extraction_edit))],
) -> DocumentDetail:
    """Confirm a value as read, or record that the document does not carry it."""
    row = _load(session, document_id)
    try:
        pipeline.review_field(
            row,
            name=field_name,
            review=payload.review,
            principal=principal,
            correlation_id=correlation_id,
        )
    except FieldValueRejectedError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
        ) from error
    except AlreadyAcceptedError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except DocumentNotReadyError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    session.commit()
    return _reloaded(session, pipeline, row)


@router.post("/{document_id}/kind", response_model=DocumentDetail)
def set_kind(
    document_id: uuid.UUID,
    payload: KindRequest,
    session: SessionDep,
    pipeline: DocumentPipelineDep,
    correlation_id: CorrelationDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.extraction_edit))],
) -> DocumentDetail:
    """Say what kind of document this is, when the document itself did not."""
    row = _load(session, document_id)
    try:
        pipeline.set_kind(
            row, kind=payload.kind, principal=principal, correlation_id=correlation_id
        )
    except AlreadyAcceptedError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except DocumentNotReadyError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    session.commit()
    return _reloaded(session, pipeline, row)


@router.post("/{document_id}/acknowledge", response_model=DocumentDetail)
def acknowledge_signal(
    document_id: uuid.UUID,
    payload: AcknowledgeRequest,
    session: SessionDep,
    pipeline: DocumentPipelineDep,
    correlation_id: CorrelationDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.extraction_edit))],
) -> DocumentDetail:
    """Record that a reviewer has seen a warning and acted on it."""
    row = _load(session, document_id)
    try:
        pipeline.acknowledge(
            row, signal=payload.signal, principal=principal, correlation_id=correlation_id
        )
    except FieldValueRejectedError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
        ) from error
    except AlreadyAcceptedError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except DocumentNotReadyError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    session.commit()
    return _reloaded(session, pipeline, row)


@router.post("/{document_id}/accept", response_model=DocumentDetail)
def accept_document(
    document_id: uuid.UUID,
    payload: AcceptRequest,
    session: SessionDep,
    pipeline: DocumentPipelineDep,
    correlation_id: CorrelationDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.extraction_accept))],
) -> DocumentDetail:
    """Confirm a reading, making its values available to the rest of the platform."""
    row = _load(session, document_id)
    try:
        pipeline.accept(row, principal=principal, note=payload.note, correlation_id=correlation_id)
    except NotAcceptableYetError as error:
        # 409 rather than 422: nothing about the request is wrong, the record is
        # simply not in a state where this is allowed yet.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"message": str(error), "blockers": error.blockers},
        ) from error
    except AlreadyAcceptedError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except DocumentNotReadyError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    session.commit()
    return _reloaded(session, pipeline, row)


def _reloaded(session: Session, pipeline: DocumentPipeline, row: Document) -> DocumentDetail:
    """The document as it now stands, after a write.

    Every write returns the whole document rather than the thing it changed. A
    correction can clear a signal, change the status and remove a blocker, and a
    client that had to infer those would be guessing at the state of a financial
    record.
    """
    session.refresh(row)
    current = _current(row)
    blockers = pipeline.acceptance_blockers(current) if current else []
    return _detail(row, _message_of(session, row), blockers, _raised_as(session, row))
