"""Credit-card statements, periods and the lines that must be coded.

Three tables. A card account is the thing statements arrive for. A period is
one billing window on that card, open until somebody closes it. A transaction
is one charge, with coding and receipt matching on the row.

**No workflow state on the period.** Open and closed are read from `closed_at`,
the same way a payment package is open or submitted. A statement is a container
of charges that already happened at the bank; inventing a state machine edge
for it would put a container on the machine that governs claims about money.

**Coding and closing are separate acts.** The application layer records who
coded a line and who closed the period, and segregation of duties refuses the
same person both against the same period. The database only insists that a
close names who and why.

**A suggestion never closes anything.** Proposed GL, cost centre and receipt
sit beside the applied values with a disposition. Closing a period does not
read them.

**The same statement file cannot be imported twice** against the same card:
`source_sha256` is unique per card, so a double-click at month-end does not
double the charges.

Revision ID: a1b2c3d4e5f6
Revises: e7f2a91c4b60
Create Date: 2026-08-09 23:50:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a1b2c3d4e5f6"
down_revision: str | None = "e7f2a91c4b60"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_REFERENCE_SEQUENCE = "credit_card_period_reference_seq"

_SUGGESTION_DISPOSITIONS = ("pending", "accepted", "edited", "rejected")

_NEW_AUDIT_ACTIONS = (
    "credit_card_statement_imported",
    "credit_card_transaction_coded",
    "credit_card_receipt_matched",
    "credit_card_period_closed",
)


def upgrade() -> None:
    for value in _NEW_AUDIT_ACTIONS:
        op.execute(f"ALTER TYPE audit_action ADD VALUE IF NOT EXISTS '{value}'")

    suggestion_disposition = postgresql.ENUM(
        *_SUGGESTION_DISPOSITIONS,
        name="suggestion_disposition",
        create_type=False,
    )
    suggestion_disposition.create(op.get_bind(), checkfirst=True)

    op.execute(sa.text(f"CREATE SEQUENCE IF NOT EXISTS {_REFERENCE_SEQUENCE} START 1"))

    op.create_table(
        "credit_card_accounts",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("label", sa.String(length=200), nullable=False),
        sa.Column("last_four", sa.CHAR(length=4), nullable=False),
        sa.Column("cardholder_name", sa.String(length=120), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
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
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("archived_reason", sa.String(length=500), nullable=True),
        sa.CheckConstraint("char_length(last_four) = 4", name="card_last_four_length"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("last_four", "cardholder_name", name="uq_credit_card_identity"),
    )

    op.create_table(
        "credit_card_periods",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("reference", sa.String(length=30), nullable=False),
        sa.Column("card_id", sa.UUID(), nullable=False),
        sa.Column("period_start", sa.Date(), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("statement_date", sa.Date(), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("source_sha256", sa.String(length=64), nullable=False),
        sa.Column("source_filename", sa.String(length=255), nullable=False),
        sa.Column("imported_by_id", sa.UUID(), nullable=False),
        sa.Column(
            "imported_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_by_id", sa.UUID(), nullable=True),
        sa.Column("close_reason", sa.Text(), nullable=True),
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
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.CheckConstraint("period_end >= period_start", name="period_dates_ordered"),
        sa.CheckConstraint(
            "(closed_at IS NULL) = (closed_by_id IS NULL)",
            name="a_close_names_who_closed_it",
        ),
        sa.CheckConstraint(
            "(closed_at IS NULL) = (close_reason IS NULL)",
            name="a_close_records_why",
        ),
        sa.ForeignKeyConstraint(
            ["card_id"],
            ["credit_card_accounts.id"],
            name=op.f("fk_credit_card_periods_card_id_credit_card_accounts"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["closed_by_id"],
            ["users.id"],
            name=op.f("fk_credit_card_periods_closed_by_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["imported_by_id"],
            ["users.id"],
            name=op.f("fk_credit_card_periods_imported_by_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("reference"),
        sa.UniqueConstraint("card_id", "source_sha256", name="uq_credit_card_statement_once"),
    )
    op.create_index(
        op.f("ix_credit_card_periods_reference"),
        "credit_card_periods",
        ["reference"],
        unique=True,
    )
    op.create_index(
        op.f("ix_credit_card_periods_card_id"),
        "credit_card_periods",
        ["card_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_credit_card_periods_closed_at"),
        "credit_card_periods",
        ["closed_at"],
        unique=False,
    )
    op.create_index(
        "ix_credit_card_periods_open",
        "credit_card_periods",
        ["card_id"],
        unique=False,
        postgresql_where=sa.text("closed_at IS NULL"),
    )

    op.create_table(
        "credit_card_transactions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("period_id", sa.UUID(), nullable=False),
        sa.Column("source_row", sa.Integer(), nullable=False),
        sa.Column("posted_on", sa.Date(), nullable=False),
        sa.Column("merchant", sa.String(length=300), nullable=False),
        sa.Column("cardholder", sa.String(length=120), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("external_reference", sa.String(length=80), nullable=True),
        sa.Column("amount_minor_units", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("category", sa.String(length=120), nullable=True),
        sa.Column("gl_account_id", sa.UUID(), nullable=True),
        sa.Column("cost_centre_id", sa.UUID(), nullable=True),
        sa.Column("exception_reason", sa.Text(), nullable=True),
        sa.Column("coded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("coded_by_id", sa.UUID(), nullable=True),
        sa.Column("receipt_document_id", sa.UUID(), nullable=True),
        sa.Column("receipt_waived", sa.Boolean(), nullable=False),
        sa.Column("receipt_waiver_reason", sa.Text(), nullable=True),
        sa.Column("receipt_match_confidence", sa.Float(), nullable=True),
        sa.Column("matched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("matched_by_id", sa.UUID(), nullable=True),
        sa.Column("suggested_gl_account_id", sa.UUID(), nullable=True),
        sa.Column("suggested_cost_centre_id", sa.UUID(), nullable=True),
        sa.Column("suggested_receipt_document_id", sa.UUID(), nullable=True),
        sa.Column("suggestion_evidence", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("suggestion_disposition", suggestion_disposition, nullable=True),
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
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.CheckConstraint(
            "NOT (exception_reason IS NOT NULL AND gl_account_id IS NOT NULL)",
            name="exception_or_gl_not_both",
        ),
        sa.CheckConstraint(
            "NOT (exception_reason IS NOT NULL AND cost_centre_id IS NOT NULL)",
            name="exception_or_cost_centre_not_both",
        ),
        sa.CheckConstraint(
            "NOT (receipt_document_id IS NOT NULL AND receipt_waived)",
            name="receipt_matched_or_waived_not_both",
        ),
        sa.ForeignKeyConstraint(
            ["coded_by_id"],
            ["users.id"],
            name=op.f("fk_credit_card_transactions_coded_by_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["cost_centre_id"],
            ["cost_centres.id"],
            name=op.f("fk_credit_card_transactions_cost_centre_id_cost_centres"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["gl_account_id"],
            ["gl_accounts.id"],
            name=op.f("fk_credit_card_transactions_gl_account_id_gl_accounts"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["matched_by_id"],
            ["users.id"],
            name=op.f("fk_credit_card_transactions_matched_by_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["period_id"],
            ["credit_card_periods.id"],
            name=op.f("fk_credit_card_transactions_period_id_credit_card_periods"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["receipt_document_id"],
            ["documents.id"],
            name=op.f("fk_credit_card_transactions_receipt_document_id_documents"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["suggested_cost_centre_id"],
            ["cost_centres.id"],
            name=op.f("fk_credit_card_transactions_suggested_cost_centre_id_cost_centres"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["suggested_gl_account_id"],
            ["gl_accounts.id"],
            name=op.f("fk_credit_card_transactions_suggested_gl_account_id_gl_accounts"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["suggested_receipt_document_id"],
            ["documents.id"],
            name=op.f("fk_credit_card_transactions_suggested_receipt_document_id_documents"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("period_id", "source_row", name="uq_credit_card_txn_row"),
    )
    op.create_index(
        op.f("ix_credit_card_transactions_period_id"),
        "credit_card_transactions",
        ["period_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_credit_card_transactions_posted_on"),
        "credit_card_transactions",
        ["posted_on"],
        unique=False,
    )
    op.create_index(
        op.f("ix_credit_card_transactions_gl_account_id"),
        "credit_card_transactions",
        ["gl_account_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_credit_card_transactions_cost_centre_id"),
        "credit_card_transactions",
        ["cost_centre_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_credit_card_transactions_receipt_document_id"),
        "credit_card_transactions",
        ["receipt_document_id"],
        unique=False,
    )
    op.create_index(
        "ix_credit_card_transactions_uncoded",
        "credit_card_transactions",
        ["period_id"],
        unique=False,
        postgresql_where=sa.text(
            "gl_account_id IS NULL AND cost_centre_id IS NULL AND exception_reason IS NULL"
        ),
    )


def downgrade() -> None:
    op.drop_index("ix_credit_card_transactions_uncoded", table_name="credit_card_transactions")
    op.drop_table("credit_card_transactions")
    op.drop_index("ix_credit_card_periods_open", table_name="credit_card_periods")
    op.drop_table("credit_card_periods")
    op.drop_table("credit_card_accounts")
    op.execute(sa.text(f"DROP SEQUENCE IF EXISTS {_REFERENCE_SEQUENCE}"))
    op.execute(sa.text("DROP TYPE IF EXISTS suggestion_disposition"))
