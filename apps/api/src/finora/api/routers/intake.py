"""Intake endpoints.

Two rules shape every response here.

Nothing unscanned or quarantined is served. A download link is only ever issued
for an attachment whose verdict is `clean`; a quarantined or unjudged file
returns a refusal that explains itself, and the object store refuses to sign a
quarantine URL even if a bug reached that far.

Raw headers are a separate permission. The full envelope is useful when
investigating a suspicious forward, and is also where a spoofed sender would be
visible, so it is available to operators rather than to everyone who can see the
message.
"""

from __future__ import annotations

import uuid
from dataclasses import asdict
from datetime import datetime
from typing import Annotated

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from finora.api.deps import (
    AuditDep,
    CorrelationDep,
    IntakeServiceDep,
    ObjectStoreDep,
    RequirePermission,
    SessionDep,
    SettingsDep,
)
from finora.api.security import Principal
from finora.application import intake_operations as intake_ops
from finora.application.document_tasks import read_pending_documents
from finora.application.imap_worker import ManualUpload
from finora.application.intake import DuplicateMessageError
from finora.domain.audit import ActorType, AuditAction
from finora.domain.intake import (
    RELEASABLE_VERDICTS,
    IntakeSource,
    IntakeStatus,
    ScanVerdict,
)
from finora.domain.roles import Permission
from finora.infrastructure.db.models import InboundMessage, MessageAttachment
from finora.infrastructure.object_store import Bucket, ObjectStoreError

router = APIRouter(prefix="/intake", tags=["intake"])


# ------------------------------------------------------------------- schemas


class AttachmentSummary(BaseModel):
    id: uuid.UUID
    filename: str
    content_type: str
    size_bytes: int
    sha256: str
    scan_verdict: ScanVerdict | None
    scan_detail: str | None
    is_quarantined: bool
    inline: bool
    rejection_reason: str | None
    rejection_detail: str | None

    #: Whether a download link can be issued. Computed here rather than left to
    #: the client, so a UI that forgets to check cannot offer the link.
    can_download: bool


class MessageSummary(BaseModel):
    id: uuid.UUID
    source: IntakeSource
    status: IntakeStatus
    subject: str
    from_address: str | None
    from_display_name: str | None
    forwarded_from_address: str | None
    received_at: datetime
    sent_at: datetime | None
    attachment_count: int
    quarantined_count: int
    has_warnings: bool


class MessageDetail(MessageSummary):
    message_id: str | None
    reply_to_address: str | None
    to_addresses: list[str]
    cc_addresses: list[str]
    forwarded_shape: str | None
    body_text: str
    raw_sha256: str
    raw_size_bytes: int
    parse_warnings: list[str]
    failure_reason: str | None
    attachments: list[AttachmentSummary]

    #: Populated only for a principal holding `intake:view_raw_headers`.
    imap_folder: str | None = None
    imap_uid: int | None = None


class MessagePage(BaseModel):
    items: list[MessageSummary]
    total: int
    limit: int
    offset: int


class SignedUrlResponse(BaseModel):
    url: str
    expires_in_seconds: int
    filename: str


class UploadAccepted(BaseModel):
    message_id: uuid.UUID
    status: IntakeStatus
    stored_attachments: int
    quarantined_attachments: int
    rejected_attachments: int
    #: Attachments that will be read for values. The reading starts immediately
    #: after this response and the queue shows its progress.
    enrolled_documents: int
    warnings: list[str] = Field(default_factory=list)


class CheckpointReport(BaseModel):
    folder: str
    uid_validity: int
    last_seen_uid: int
    last_polled_at: datetime | None
    seconds_since_poll: int | None
    last_reset_at: datetime | None
    last_reset_reason: str | None
    is_stalled: bool


class BacklogReport(BaseModel):
    counts_by_status: dict[str, int]
    in_flight: int
    quarantined: int
    failed: int
    needs_attention: int
    total: int
    oldest_unresolved_at: datetime | None
    oldest_unresolved_age_seconds: int | None


class MailboxReport(BaseModel):
    reachable: bool
    authenticated: bool
    detail: str | None
    quota_supported: bool
    quota_used_kb: int | None
    quota_limit_kb: int | None
    quota_used_percent: float | None


class OperationsReport(BaseModel):
    generated_at: datetime
    state: str
    checkpoints: list[CheckpointReport]
    backlog: BacklogReport
    mailbox: MailboxReport | None
    concerns: list[str]


# ------------------------------------------------------------------ mapping


def _attachment_summary(row: MessageAttachment) -> AttachmentSummary:
    return AttachmentSummary(
        id=row.id,
        filename=row.filename,
        content_type=row.content_type,
        size_bytes=row.size_bytes,
        sha256=row.sha256,
        scan_verdict=row.scan_verdict,
        scan_detail=row.scan_detail,
        is_quarantined=row.is_quarantined,
        inline=row.inline,
        rejection_reason=row.rejection_reason,
        rejection_detail=row.rejection_detail,
        can_download=_releasable_key(row) is not None,
    )


def _releasable_key(row: MessageAttachment) -> str | None:
    """The object key, but only if this file may leave the platform.

    The single place that decision is made. Returning the key rather than a
    boolean means a caller cannot obtain a key without passing the check.
    """
    if row.object_key is None or row.is_quarantined:
        return None
    if row.scan_verdict not in RELEASABLE_VERDICTS:
        return None
    return row.object_key


def _summary(row: InboundMessage) -> MessageSummary:
    attachments = row.attachments
    return MessageSummary(
        id=row.id,
        source=row.source,
        status=row.status,
        subject=row.subject,
        from_address=row.from_address,
        from_display_name=row.from_display_name,
        forwarded_from_address=row.forwarded_from_address,
        received_at=row.received_at,
        sent_at=row.sent_at,
        attachment_count=len(attachments),
        quarantined_count=sum(1 for a in attachments if a.is_quarantined),
        has_warnings=bool(row.parse_warnings),
    )


# -------------------------------------------------------------- operations


@router.get("/operations", response_model=OperationsReport)
def intake_operations(
    session: SessionDep,
    settings: SettingsDep,
    _: Annotated[Principal, Depends(RequirePermission(Permission.operations_view))],
    probe_mailbox: Annotated[
        bool,
        Query(description="Also open a live mailbox connection to check credentials and quota."),
    ] = False,
) -> OperationsReport:
    """Whether intake is actually running, and what is waiting.

    The live mailbox probe is opt-in. It opens a real IMAP connection, so polling
    it on a dashboard refresh would add login attempts that some providers
    rate-limit or treat as suspicious. Stored state answers the common question
    ("is the worker alive") without touching the network.
    """
    mailbox = intake_ops.probe_mailbox(settings.imap) if probe_mailbox else None
    report = intake_ops.build_report(
        session,
        poll_interval_seconds=settings.imap.poll_interval_seconds,
        mailbox=mailbox,
    )

    return OperationsReport(
        generated_at=report.generated_at,
        state=report.state,
        checkpoints=[CheckpointReport(**asdict(c)) for c in report.checkpoints],
        backlog=BacklogReport(
            counts_by_status=report.backlog.counts_by_status,
            in_flight=report.backlog.in_flight,
            quarantined=report.backlog.quarantined,
            failed=report.backlog.failed,
            needs_attention=report.backlog.needs_attention,
            total=report.backlog.total,
            oldest_unresolved_at=report.backlog.oldest_unresolved_at,
            oldest_unresolved_age_seconds=report.backlog.oldest_unresolved_age_seconds,
        ),
        mailbox=MailboxReport(**asdict(report.mailbox)) if report.mailbox else None,
        concerns=report.concerns,
    )


# ------------------------------------------------------------------- reads


@router.get("/messages", response_model=MessagePage)
def list_messages(
    session: SessionDep,
    _: Annotated[Principal, Depends(RequirePermission(Permission.intake_view))],
    status_filter: Annotated[IntakeStatus | None, Query(alias="status")] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> MessagePage:
    """Messages awaiting or past triage, newest first."""
    conditions = []
    if status_filter is not None:
        conditions.append(InboundMessage.status == status_filter)

    total = session.execute(
        select(func.count()).select_from(InboundMessage).where(*conditions)
    ).scalar_one()

    rows = (
        session.execute(
            select(InboundMessage)
            .where(*conditions)
            .order_by(InboundMessage.received_at.desc())
            .limit(limit)
            .offset(offset)
        )
        .scalars()
        .all()
    )

    return MessagePage(
        items=[_summary(row) for row in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/messages/{message_id}", response_model=MessageDetail)
def get_message(
    message_id: uuid.UUID,
    session: SessionDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.intake_view))],
) -> MessageDetail:
    row = session.get(InboundMessage, message_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="That message could not be found.",
        )

    summary = _summary(row)
    detail = MessageDetail(
        **summary.model_dump(),
        message_id=row.message_id,
        reply_to_address=row.reply_to_address,
        to_addresses=row.to_addresses,
        cc_addresses=row.cc_addresses,
        forwarded_shape=row.forwarded_shape,
        body_text=row.body_text,
        raw_sha256=row.raw_sha256,
        raw_size_bytes=row.raw_size_bytes,
        parse_warnings=row.parse_warnings,
        failure_reason=row.failure_reason,
        attachments=[_attachment_summary(a) for a in row.attachments],
    )

    # Mailbox provenance is only meaningful to someone investigating intake, and
    # is where a forged envelope would show, so it needs its own permission.
    if principal.has(Permission.intake_view_raw_headers):
        detail.imap_folder = row.imap_folder
        detail.imap_uid = row.imap_uid

    return detail


@router.get("/attachments/{attachment_id}/download-url", response_model=SignedUrlResponse)
def attachment_download_url(
    attachment_id: uuid.UUID,
    session: SessionDep,
    store: ObjectStoreDep,
    settings: SettingsDep,
    audit: AuditDep,
    correlation_id: CorrelationDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.document_download))],
) -> SignedUrlResponse:
    """A short-lived link to one clean attachment."""
    row = session.get(MessageAttachment, attachment_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="That attachment could not be found.",
        )

    object_key = _releasable_key(row)
    if object_key is None:
        # Deliberately specific: an operator needs to know whether the file is
        # infected, still being scanned, or was never stored, because the next
        # action differs in each case.
        if row.is_quarantined:
            reason = (
                "This file was quarantined by the malware scanner and cannot be "
                "downloaded. Release it through the quarantine workflow if it is "
                "needed."
            )
        elif row.object_key is None:
            reason = (
                "This file was refused at intake and was never stored. "
                f"Reason: {row.rejection_detail or row.rejection_reason}."
            )
        else:
            reason = "This file has not finished scanning yet. Try again shortly."
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=reason)

    try:
        url = store.signed_url(
            bucket=Bucket.documents,
            key=object_key,
            download_filename=row.filename,
        )
    except ObjectStoreError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The document store is not available. Nothing was downloaded.",
        ) from error

    # Recorded before the link is handed over: who asked for which document is
    # exactly what an auditor needs, and a link that is issued has effectively
    # been used.
    audit.append(
        action=AuditAction.document_downloaded,
        actor_type=ActorType.user,
        actor_id=principal.user_id,
        actor_label=principal.display_name,
        subject_type="message_attachment",
        subject_id=row.id,
        correlation_id=correlation_id,
        detail={"filename": row.filename, "sha256": row.sha256},
    )
    session.commit()

    return SignedUrlResponse(
        url=url,
        expires_in_seconds=settings.object_store.signed_url_ttl_seconds,
        filename=row.filename,
    )


# ------------------------------------------------------------------ uploads


@router.post(
    "/uploads",
    response_model=UploadAccepted,
    status_code=status.HTTP_201_CREATED,
)
async def upload_document(
    session: SessionDep,
    intake: IntakeServiceDep,
    correlation_id: CorrelationDep,
    background: BackgroundTasks,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.intake_upload))],
    file: Annotated[UploadFile, File(description="The document to ingest.")],
    note: Annotated[str | None, Form()] = None,
) -> UploadAccepted:
    """Ingest an uploaded document through the same path as mailbox intake.

    The file is wrapped as RFC 822 so that upload and mailbox delivery share one
    validation, scanning, storage and audit path. A second path would be a second
    place for the scanning rule to be missed.
    """
    data = await file.read()
    if not data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The uploaded file is empty.",
        )

    upload = ManualUpload(
        filename=file.filename or "upload",
        content_type=file.content_type or "application/octet-stream",
        data=data,
        uploaded_by_id=principal.user_id,
        note=note,
    )

    try:
        outcome = intake.ingest(
            upload.to_rfc822(uploader_email=principal.email),
            source=IntakeSource.manual_upload,
            correlation_id=correlation_id,
            uploaded_by_id=principal.user_id,
            actor_label=principal.display_name,
        )
    except DuplicateMessageError as duplicate:
        session.commit()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "You have already uploaded this exact file. It is already in the "
                f"workspace as message {duplicate.existing.id}."
            ),
        ) from duplicate

    session.commit()

    # Reading happens after the response, in its own session. A twenty-page PDF
    # takes seconds, and the uploader is better served by an immediate answer and
    # a queue entry that fills in than by a held connection. Queued after the
    # commit, so the task cannot look for a document that was rolled back.
    if outcome.enrolled_documents:
        background.add_task(
            read_pending_documents,
            correlation_id=correlation_id,
            limit=outcome.enrolled_documents,
        )

    return UploadAccepted(
        message_id=outcome.message.id,
        status=outcome.message.status,
        stored_attachments=outcome.stored_attachments,
        quarantined_attachments=outcome.quarantined_attachments,
        rejected_attachments=outcome.rejected_attachments,
        enrolled_documents=outcome.enrolled_documents,
        warnings=outcome.warnings,
    )
