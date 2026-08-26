"""Retention policies per record class.

Provisional defaults until the requirements document confirms retention periods.
An administrator can change days and soft-deactivate a policy; new record
classes are not invented through the API in v1.

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-08-26 01:00:00.000000
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d4e5f6a7b8c9"
down_revision: str | None = "c3d4e5f6a7b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: Provisional until the requirements document confirms them.
_DEFAULT_POLICIES: tuple[tuple[str, int, str], ...] = (
    ("inbound_messages", 2555, "Inbound mail and attachments"),
    ("documents", 2555, "Accepted document readings"),
    ("estimates", 2555, "Estimates and approval history"),
    ("invoices", 2555, "Invoices and payment history"),
    ("payment_packages", 2555, "Payment packages and manifests"),
    ("audit_entries", 3650, "Immutable audit trail"),
    ("credit_card_periods", 2555, "Credit-card statement periods"),
    ("accrual_periods", 2555, "Month-end accrual periods"),
)


def upgrade() -> None:
    op.create_table(
        "retention_policies",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
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
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("record_class", sa.String(length=60), nullable=False),
        sa.Column("retention_days", sa.Integer(), nullable=False),
        sa.Column("description", sa.String(length=255), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.CheckConstraint("retention_days >= 1", name="retention_days_positive"),
        sa.CheckConstraint(
            "char_length(trim(record_class)) >= 1",
            name="retention_record_class_present",
        ),
        sa.CheckConstraint(
            "char_length(trim(description)) >= 1",
            name="retention_description_present",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("record_class"),
    )
    op.create_index(
        "ix_retention_policies_record_class",
        "retention_policies",
        ["record_class"],
        unique=False,
    )

    bind = op.get_bind()
    bind.execute(
        sa.text(
            "INSERT INTO retention_policies "
            "(id, record_class, retention_days, description, is_active, version) "
            "VALUES (:id, :record_class, :retention_days, :description, TRUE, 1) "
            "ON CONFLICT (record_class) DO NOTHING"
        ),
        [
            {
                "id": uuid.uuid4(),
                "record_class": record_class,
                "retention_days": days,
                "description": description,
            }
            for record_class, days, description in _DEFAULT_POLICIES
        ],
    )


def downgrade() -> None:
    op.drop_index("ix_retention_policies_record_class", table_name="retention_policies")
    op.drop_table("retention_policies")
