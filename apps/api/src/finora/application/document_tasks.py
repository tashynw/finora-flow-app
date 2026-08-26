"""Reading documents outside a request.

The composition root for the reader. Kept apart from `document_pipeline` so the
pipeline itself stays a plain object with everything injected and remains
testable without a database, a store or a gateway.

Reading is deliberately not done inside the request that uploads a file. A
twenty-page PDF takes seconds, and a user who has just uploaded an invoice should
get an answer immediately and watch the reading arrive, rather than hold a
connection open while a parser works. Until the Redis worker exists this runs as
a background task in the API process, which is why it takes its own session:
the request's session is committed and closed before the task starts.
"""

from __future__ import annotations

from uuid import UUID

import structlog

from finora.application.document_pipeline import BatchOutcome, DocumentPipeline
from finora.config import get_settings
from finora.infrastructure.ai_gateway import get_ai_gateway
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.session import session_scope
from finora.infrastructure.object_store import get_object_store

logger = structlog.get_logger(__name__)


def read_pending_documents(*, correlation_id: UUID, limit: int | None = None) -> BatchOutcome:
    """Read the documents waiting to be read, in their own transaction.

    Never raises. This is called from a background task and from a worker loop,
    where an exception has nowhere useful to go: each document's own failure is
    already recorded against that document, so a failure here means the batch
    could not be started at all, and that belongs in the log.
    """
    try:
        with session_scope() as session:
            pipeline = DocumentPipeline(
                session=session,
                object_store=get_object_store(),
                gateway=get_ai_gateway(),
                audit=AuditRepository(session),
                settings=get_settings().extraction,
            )
            outcome = pipeline.read_pending(correlation_id=correlation_id, limit=limit)
        logger.info(
            "documents.batch_read",
            correlation_id=str(correlation_id),
            read=len(outcome.read),
            failed=len(outcome.failures),
        )
        return outcome
    except Exception:
        logger.exception("documents.batch_failed", correlation_id=str(correlation_id))
        return BatchOutcome()
