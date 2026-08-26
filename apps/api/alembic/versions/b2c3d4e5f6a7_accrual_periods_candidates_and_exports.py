"""Month-end accrual periods, candidates and versioned exports.

Three tables. A period is one reporting window, open until somebody locks it.
A candidate is usually an unpaid invoice proposed for that window. An export is
a versioned CSV or spreadsheet taken from the period, with a digest so a later
rebuild can be checked.

**No workflow state on the period.** Open and locked are read from `locked_at`.

**Editing and locking are separate acts.** Segregation of duties refuses the
same person both against the same period.

**Official exports require a lock.** Draft exports are allowed while open and
are labelled as such.

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-08-25 22:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b2c3d4e5f6a7"
down_revision: str | None = "a1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_REFERENCE_SEQUENCE = "accrual_period_reference_seq"
_CANDIDATE_SEQUENCE = "accrual_candidate_reference_seq"

_STANDINGS = ("proposed", "adjusted", "finalized", "excluded")

_NEW_AUDIT_ACTIONS = (
    "accrual_period_opened",
    "accrual_candidates_generated",
    "accrual_candidate_edited",
    "accrual_candidate_finalized",
)


def upgrade() -> None:
    for value in _NEW_AUDIT_ACTIONS:
        op.execute(f"ALTER TYPE audit_action ADD VALUE IF NOT EXISTS '{value}'")

    standing = postgresql.ENUM(
        *_STANDINGS,
        name="accrual_candidate_standing",
        create_type=False,
    )
    standing.create(op.get_bind(), checkfirst=True)

    op.execute(sa.text(f"CREATE SEQUENCE IF NOT EXISTS {_REFERENCE_SEQUENCE} START 1"))
    op.execute(sa.text(f"CREATE SEQUENCE IF NOT EXISTS {_CANDIDATE_SEQUENCE} START 1"))

    op.create_table(
        "accrual_periods",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("reference", sa.String(length=30), nullable=False),
        sa.Column("period_start", sa.Date(), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("label", sa.String(length=200), nullable=False),
        sa.Column("opened_by_id", sa.UUID(), nullable=False),
        sa.Column(
            "opened_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("locked_by_id", sa.UUID(), nullable=True),
        sa.Column("lock_reason", sa.Text(), nullable=True),
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
        sa.CheckConstraint("period_end >= period_start", name="accrual_period_dates_ordered"),
        sa.CheckConstraint(
            "(locked_at IS NULL) = (locked_by_id IS NULL)",
            name="an_accrual_lock_names_who",
        ),
        sa.CheckConstraint(
            "(locked_at IS NULL) = (lock_reason IS NULL)",
            name="an_accrual_lock_records_why",
        ),
        sa.ForeignKeyConstraint(["opened_by_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["locked_by_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("reference"),
    )
    op.create_index("ix_accrual_periods_reference", "accrual_periods", ["reference"])
    op.create_index("ix_accrual_periods_locked_at", "accrual_periods", ["locked_at"])

    op.create_table(
        "accrual_candidates",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("period_id", sa.UUID(), nullable=False),
        sa.Column("reference", sa.String(length=30), nullable=False),
        sa.Column("invoice_id", sa.UUID(), nullable=True),
        sa.Column(
            "standing",
            postgresql.ENUM(
                *_STANDINGS,
                name="accrual_candidate_standing",
                create_type=False,
            ),
            nullable=False,
        ),
        sa.Column("currency", sa.CHAR(length=3), nullable=False),
        sa.Column("amount_minor_units", sa.BigInteger(), nullable=False),
        sa.Column("original_amount_minor_units", sa.BigInteger(), nullable=False),
        sa.Column("vendor_name", sa.String(length=300), nullable=False),
        sa.Column("invoice_number", sa.String(length=120), nullable=True),
        sa.Column("invoice_reference", sa.String(length=30), nullable=True),
        sa.Column("description", sa.String(length=500), nullable=False),
        sa.Column("department", sa.String(length=200), nullable=True),
        sa.Column("gl_account_id", sa.UUID(), nullable=True),
        sa.Column("cost_centre_id", sa.UUID(), nullable=True),
        sa.Column("edit_reason", sa.Text(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("finalized_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finalized_by_id", sa.UUID(), nullable=True),
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
        sa.ForeignKeyConstraint(["period_id"], ["accrual_periods.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["invoice_id"], ["invoices.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["gl_account_id"], ["gl_accounts.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["cost_centre_id"], ["cost_centres.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["finalized_by_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("period_id", "reference", name="uq_accrual_candidate_reference"),
        sa.UniqueConstraint("period_id", "invoice_id", name="uq_accrual_candidate_invoice_once"),
    )
    op.create_index("ix_accrual_candidates_period_id", "accrual_candidates", ["period_id"])
    op.create_index("ix_accrual_candidates_invoice_id", "accrual_candidates", ["invoice_id"])
    op.create_index(
        "ix_accrual_candidates_standing",
        "accrual_candidates",
        ["period_id", "standing"],
    )

    op.create_table(
        "accrual_exports",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("period_id", sa.UUID(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("format", sa.String(length=10), nullable=False),
        sa.Column("official", sa.Boolean(), nullable=False),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("byte_size", sa.Integer(), nullable=False),
        sa.Column("row_count", sa.Integer(), nullable=False),
        sa.Column("generated_by_id", sa.UUID(), nullable=False),
        sa.Column(
            "generated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
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
        sa.CheckConstraint("format IN ('csv', 'xlsx')", name="accrual_export_format"),
        sa.CheckConstraint("version >= 1", name="accrual_export_version_positive"),
        sa.ForeignKeyConstraint(["period_id"], ["accrual_periods.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["generated_by_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("period_id", "version", name="uq_accrual_export_version"),
    )
    op.create_index("ix_accrual_exports_period_id", "accrual_exports", ["period_id"])


def downgrade() -> None:
    op.drop_table("accrual_exports")
    op.drop_table("accrual_candidates")
    op.drop_table("accrual_periods")
    op.execute(sa.text(f"DROP SEQUENCE IF EXISTS {_CANDIDATE_SEQUENCE}"))
    op.execute(sa.text(f"DROP SEQUENCE IF EXISTS {_REFERENCE_SEQUENCE}"))
    op.execute(sa.text("DROP TYPE IF EXISTS accrual_candidate_standing"))
