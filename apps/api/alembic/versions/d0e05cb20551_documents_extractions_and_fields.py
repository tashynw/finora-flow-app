"""Documents, versioned extraction attempts and their fields.

Three tables and six enumerated types supporting the reading of a document and its
human review.

The enumerated types are created explicitly at the start rather than inline on the
columns that use them. `document_kind` and `extraction_status` each appear on two
tables, and an inline definition would emit `CREATE TYPE` once per table and fail
on the second.

Revision ID: d0e05cb20551
Revises: ce51d1d766ff
Create Date: 2026-08-05 11:44:06.456656
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d0e05cb20551"
down_revision: str | None = "ce51d1d766ff"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# `create_type=False` throughout: the types are created and dropped by this
# migration explicitly, so SQLAlchemy must not also try to manage them per column.
document_kind = postgresql.ENUM(
    "invoice",
    "estimate",
    "credit_note",
    "receipt",
    "purchase_order",
    "statement",
    "remittance_advice",
    "unknown",
    name="document_kind",
    create_type=False,
)
extraction_status = postgresql.ENUM(
    "pending",
    "extracting",
    "extracted",
    "needs_review",
    "accepted",
    "manual_entry_required",
    "failed",
    name="extraction_status",
    create_type=False,
)
text_source = postgresql.ENUM(
    "text_layer",
    "vision",
    "plain_text",
    "none",
    name="text_source",
    create_type=False,
)
field_name = postgresql.ENUM(
    "vendor_name",
    "vendor_tax_id",
    "document_number",
    "document_date",
    "due_date",
    "currency",
    "subtotal",
    "tax_total",
    "total",
    "purchase_order_number",
    "estimate_reference",
    "payment_terms",
    name="extraction_field_name",
    create_type=False,
)
field_origin = postgresql.ENUM(
    "rule",
    "model",
    "human",
    "absent",
    name="extraction_field_origin",
    create_type=False,
)
field_review = postgresql.ENUM(
    "unreviewed",
    "confirmed",
    "corrected",
    "cleared",
    name="extraction_field_review",
    create_type=False,
)

_TYPES = (
    document_kind,
    extraction_status,
    text_source,
    field_name,
    field_origin,
    field_review,
)


#: Reading a document and reviewing it are audited acts, so the trail needs words
#: for them. Added to the existing type rather than folded into `record_updated`,
#: because "a person changed the total a machine read" is the specific thing an
#: auditor searches for.
_NEW_AUDIT_ACTIONS = (
    "extraction_completed",
    "extraction_corrected",
    "extraction_accepted",
)


def upgrade() -> None:
    bind = op.get_bind()
    for enum_type in _TYPES:
        enum_type.create(bind, checkfirst=True)

    for action in _NEW_AUDIT_ACTIONS:
        op.execute(f"ALTER TYPE audit_action ADD VALUE IF NOT EXISTS '{action}'")

    op.create_table(
        "documents",
        sa.Column("attachment_id", sa.UUID(), nullable=False),
        sa.Column("message_id", sa.UUID(), nullable=False),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("content_type", sa.String(length=160), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.CHAR(length=64), nullable=False),
        sa.Column("object_key", sa.String(length=500), nullable=False),
        sa.Column("kind", document_kind, nullable=False),
        sa.Column("status", extraction_status, nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.CheckConstraint("size_bytes > 0", name=op.f("ck_documents_document_size_positive")),
        sa.ForeignKeyConstraint(
            ["attachment_id"],
            ["message_attachments.id"],
            name=op.f("fk_documents_attachment_id_message_attachments"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["message_id"],
            ["inbound_messages.id"],
            name=op.f("fk_documents_message_id_inbound_messages"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_documents")),
        sa.UniqueConstraint("attachment_id", name=op.f("uq_documents_attachment_id")),
    )
    op.create_index(op.f("ix_documents_kind"), "documents", ["kind"], unique=False)
    op.create_index(op.f("ix_documents_message_id"), "documents", ["message_id"], unique=False)
    op.create_index(
        "ix_documents_review_queue", "documents", ["status", "created_at"], unique=False
    )
    op.create_index(op.f("ix_documents_sha256"), "documents", ["sha256"], unique=False)
    op.create_index(op.f("ix_documents_status"), "documents", ["status"], unique=False)

    op.create_table(
        "document_extractions",
        sa.Column("document_id", sa.UUID(), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("is_current", sa.Boolean(), nullable=False),
        sa.Column("status", extraction_status, nullable=False),
        sa.Column("kind", document_kind, nullable=False),
        sa.Column("kind_confidence", sa.Float(), nullable=False),
        sa.Column("kind_evidence", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("text_source", text_source, nullable=False),
        sa.Column("page_count", sa.Integer(), nullable=False),
        sa.Column("review_threshold", sa.Float(), nullable=False),
        sa.Column("low_threshold", sa.Float(), nullable=False),
        sa.Column("signals", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("notes", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("injection_findings", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("acknowledged_signals", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("gateway_outcome", sa.String(length=40), nullable=True),
        sa.Column("model_name", sa.String(length=160), nullable=True),
        sa.Column("prompt_id", sa.String(length=80), nullable=True),
        sa.Column("prompt_version", sa.Integer(), nullable=True),
        sa.Column("prompt_sha256", sa.String(length=64), nullable=True),
        sa.Column("model_latency_ms", sa.Integer(), nullable=True),
        sa.Column("suggestions_discarded", sa.Integer(), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failure_reason", sa.String(length=500), nullable=True),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("accepted_by_id", sa.UUID(), nullable=True),
        sa.Column("accepted_note", sa.String(length=1000), nullable=True),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(accepted_at IS NULL) = (accepted_by_id IS NULL)",
            name=op.f("ck_document_extractions_acceptance_names_its_actor"),
        ),
        sa.CheckConstraint(
            "(model_name IS NULL) = (prompt_sha256 IS NULL)",
            name=op.f("ck_document_extractions_model_provenance_is_complete"),
        ),
        sa.CheckConstraint("attempt > 0", name=op.f("ck_document_extractions_attempt_positive")),
        sa.CheckConstraint(
            "kind_confidence >= 0 AND kind_confidence <= 1",
            name=op.f("ck_document_extractions_kind_confidence_is_a_fraction"),
        ),
        sa.CheckConstraint(
            "review_threshold > 0 AND review_threshold <= 1",
            name=op.f("ck_document_extractions_review_threshold_is_a_fraction"),
        ),
        sa.CheckConstraint(
            "low_threshold > 0 AND low_threshold <= review_threshold",
            name=op.f("ck_document_extractions_low_threshold_below_review"),
        ),
        sa.ForeignKeyConstraint(
            ["accepted_by_id"],
            ["users.id"],
            name=op.f("fk_document_extractions_accepted_by_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_document_extractions_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_document_extractions")),
        sa.UniqueConstraint("document_id", "attempt", name="uq_document_extractions_attempt"),
    )
    op.create_index(
        op.f("ix_document_extractions_document_id"),
        "document_extractions",
        ["document_id"],
        unique=False,
    )
    # Partial unique index: exactly one attempt per document may be the current
    # one. Superseded attempts stay in the table and stay readable.
    op.create_index(
        "uq_document_extractions_current",
        "document_extractions",
        ["document_id"],
        unique=True,
        postgresql_where=sa.text("is_current"),
    )

    op.create_table(
        "extraction_fields",
        sa.Column("extraction_id", sa.UUID(), nullable=False),
        sa.Column("name", field_name, nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("origin", field_origin, nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("review", field_review, nullable=False),
        sa.Column("amount_minor_units", sa.BigInteger(), nullable=True),
        sa.Column("currency", sa.CHAR(length=3), nullable=True),
        sa.Column("value_date", sa.Date(), nullable=True),
        sa.Column("evidence_page", sa.Integer(), nullable=True),
        sa.Column("evidence_snippet", sa.Text(), nullable=True),
        sa.Column("evidence_boxes", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("adjustments", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("notes", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("reader_text", sa.Text(), nullable=True),
        sa.Column("reader_confidence", sa.Float(), nullable=True),
        sa.Column("corrected_by_id", sa.UUID(), nullable=True),
        sa.Column("corrected_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("correction_reason", sa.String(length=1000), nullable=True),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "origin <> 'absent' OR (confidence = 0 AND text = '')",
            name=op.f("ck_extraction_fields_absent_value_carries_nothing"),
        ),
        sa.CheckConstraint(
            "origin <> 'human' OR (corrected_by_id IS NOT NULL AND corrected_at IS NOT NULL)",
            name=op.f("ck_extraction_fields_human_value_names_its_author"),
        ),
        sa.CheckConstraint(
            "amount_minor_units IS NULL OR currency IS NOT NULL",
            name=op.f("ck_extraction_fields_amount_states_its_currency"),
        ),
        sa.CheckConstraint(
            "confidence >= 0 AND confidence <= 1",
            name=op.f("ck_extraction_fields_confidence_is_a_fraction"),
        ),
        sa.ForeignKeyConstraint(
            ["corrected_by_id"],
            ["users.id"],
            name=op.f("fk_extraction_fields_corrected_by_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["extraction_id"],
            ["document_extractions.id"],
            name=op.f("fk_extraction_fields_extraction_id_document_extractions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_extraction_fields")),
        sa.UniqueConstraint("extraction_id", "name", name="uq_extraction_fields_name"),
    )
    op.create_index(
        op.f("ix_extraction_fields_extraction_id"),
        "extraction_fields",
        ["extraction_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_extraction_fields_extraction_id"), table_name="extraction_fields")
    op.drop_table("extraction_fields")
    op.drop_index(
        "uq_document_extractions_current",
        table_name="document_extractions",
        postgresql_where=sa.text("is_current"),
    )
    op.drop_index(op.f("ix_document_extractions_document_id"), table_name="document_extractions")
    op.drop_table("document_extractions")
    op.drop_index(op.f("ix_documents_status"), table_name="documents")
    op.drop_index(op.f("ix_documents_sha256"), table_name="documents")
    op.drop_index("ix_documents_review_queue", table_name="documents")
    op.drop_index(op.f("ix_documents_message_id"), table_name="documents")
    op.drop_index(op.f("ix_documents_kind"), table_name="documents")
    op.drop_table("documents")

    # The three audit actions added above are deliberately left in place. An audit
    # entry naming one may already exist, and the audit table is append-only and
    # hash-chained: deleting a row to satisfy a schema rollback would break the
    # chain and destroy the record of what happened. An unused enum value is
    # harmless; a broken chain is not recoverable.

    # After the tables, or the types are still in use.
    for enum_name in (
        "extraction_field_review",
        "extraction_field_origin",
        "extraction_field_name",
        "text_source",
        "extraction_status",
        "document_kind",
    ):
        op.execute(f"DROP TYPE IF EXISTS {enum_name}")
