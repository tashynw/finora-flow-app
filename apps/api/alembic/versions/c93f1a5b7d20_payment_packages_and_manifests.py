"""Payment packages: many approved invoices, submitted to the bank as one thing.

Two tables and a sequence, and one absence worth explaining.

**There is no state column on `payment_packages`.** Every other record here —
estimate, invoice, purchase order — runs on `workflow_state`, because each is a
claim about money that somebody has to agree to. A package agrees to nothing:
an invoice is approved before it can be added, and putting eighty approved
invoices in one envelope does not create an eighty-first decision. Open,
submitted and cancelled are read from `submitted_at` and `cancelled_at`, the way
a purchase order's open and closed are read from `closed_at`.

That is a control and not only a modelling preference. The state a package would
need on the shared machine is `draft -> ready_for_submission`, which is not a
declared transition for anything; adding it so a container could carry a status
would have given every record in the system a documented route from draft to the
bank that goes nowhere near an approval.

**`payment_package_lines.invoice_id` is unique across the whole table**, not
unique within a package. That single index is the double-payment control: an
invoice can be in one package, ever. Cancelling a package deletes its lines, so
what it held becomes payable again by another one; the fact that it was in this
one, and who took it out, is in the audit trail, which is where a deleted row's
story belongs.

**The lines copy the supplier, number and amount** from the invoice rather than
reading them through the key. The manifest is a statement about what was
submitted on a particular day, and regenerating it from invoices edited since
would rewrite that statement silently. The copies are also what makes the stored
digest checkable at all: the file can be rebuilt years later and compared.

Revision ID: c93f1a5b7d20
Revises: b41c7a29e5d8
Create Date: 2026-08-06 11:42:18.005611
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c93f1a5b7d20"
down_revision: str | None = "b41c7a29e5d8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


#: Package references come from here, for the same reason order numbers do: the
#: reference goes to the bank and comes back on a statement, and two packages
#: sharing one would make the return ambiguous.
_REFERENCE_SEQUENCE = "payment_package_reference_seq"

_METHODS = ("bank_transfer", "cheque", "wire", "direct_debit")


def upgrade() -> None:
    # Created here and marked as already existing for the column below, so the
    # table definition does not try to create the type a second time.
    payment_method = postgresql.ENUM(*_METHODS, name="payment_method", create_type=False)
    postgresql.ENUM(*_METHODS, name="payment_method").create(op.get_bind())

    op.execute(f"CREATE SEQUENCE IF NOT EXISTS {_REFERENCE_SEQUENCE} AS BIGINT START WITH 1")

    _create_packages(payment_method)
    _create_lines()


def downgrade() -> None:
    op.drop_table("payment_package_lines")
    op.drop_table("payment_packages")
    op.execute(f"DROP SEQUENCE IF EXISTS {_REFERENCE_SEQUENCE}")
    postgresql.ENUM(name="payment_method").drop(op.get_bind())


def _create_packages(payment_method: postgresql.ENUM) -> None:
    op.create_table(
        "payment_packages",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("reference", sa.String(length=30), nullable=False, unique=True),
        sa.Column("description", sa.String(length=500), nullable=False, server_default=""),
        # Optional while the package is assembled and required by the domain
        # before submission. Not tied to `submitted_at` in a constraint, because
        # a package abandoned before anybody chose a method is legitimate.
        sa.Column("payment_method", payment_method, nullable=True),
        sa.Column("intended_payment_date", sa.Date(), nullable=True),
        sa.Column("created_by_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("submitted_at", sa.DateTime(timezone=True)),
        sa.Column("submitted_by_id", postgresql.UUID(as_uuid=True)),
        sa.Column("submission_reference", sa.String(length=120)),
        sa.Column("manifest_sha256", sa.CHAR(length=64)),
        sa.Column("manifest_line_count", sa.Integer()),
        sa.Column("cancelled_at", sa.DateTime(timezone=True)),
        sa.Column("cancelled_by_id", postgresql.UUID(as_uuid=True)),
        sa.Column("cancelled_reason", sa.Text()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.ForeignKeyConstraint(
            ["created_by_id"], ["users.id"], name="fk_payment_packages_created_by"
        ),
        sa.ForeignKeyConstraint(
            ["submitted_by_id"], ["users.id"], name="fk_payment_packages_submitted_by"
        ),
        sa.ForeignKeyConstraint(
            ["cancelled_by_id"], ["users.id"], name="fk_payment_packages_cancelled_by"
        ),
        # A submission names its moment, its author, the bank's reference and
        # what was sent. All of them or none: a package recorded as submitted
        # with no evidence of what went is worse than one not recorded at all,
        # because it looks answered.
        sa.CheckConstraint(
            "(submitted_at IS NULL) = (submitted_by_id IS NULL)",
            name="submission_names_its_actor",
        ),
        sa.CheckConstraint(
            "(submitted_at IS NULL) = (submission_reference IS NULL)",
            name="submission_carries_its_reference",
        ),
        sa.CheckConstraint(
            "(submitted_at IS NULL) = (manifest_sha256 IS NULL)",
            name="submission_keeps_its_manifest",
        ),
        sa.CheckConstraint(
            "(manifest_sha256 IS NULL) = (manifest_line_count IS NULL)",
            name="manifest_states_its_size",
        ),
        sa.CheckConstraint(
            "(cancelled_at IS NULL) = (cancelled_by_id IS NULL)",
            name="cancellation_names_its_actor",
        ),
        # A package that went to the bank cannot also have been abandoned.
        sa.CheckConstraint(
            "submitted_at IS NULL OR cancelled_at IS NULL",
            name="package_went_or_was_abandoned_not_both",
        ),
    )
    op.create_index("ix_payment_packages_reference", "payment_packages", ["reference"])
    op.create_index("ix_payment_packages_submitted_at", "payment_packages", ["submitted_at"])
    op.create_index(
        "ix_payment_packages_submission_reference", "payment_packages", ["submission_reference"]
    )
    # The register's default view: everything still being assembled.
    op.create_index(
        "ix_payment_packages_open",
        "payment_packages",
        ["created_at"],
        postgresql_where=sa.text("submitted_at IS NULL AND cancelled_at IS NULL"),
    )
    op.create_index(
        "ix_payment_packages_submitted",
        "payment_packages",
        ["submitted_at", "intended_payment_date"],
    )


def _create_lines() -> None:
    op.create_table(
        "payment_package_lines",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("package_id", postgresql.UUID(as_uuid=True), nullable=False),
        # Unique across the table rather than within the package. One invoice,
        # one package, ever: this is what stops the same money going out twice.
        sa.Column("invoice_id", postgresql.UUID(as_uuid=True), nullable=False, unique=True),
        sa.Column("invoice_reference", sa.String(length=30), nullable=False),
        sa.Column("invoice_number", sa.String(length=120)),
        sa.Column("vendor_id", postgresql.UUID(as_uuid=True)),
        sa.Column("vendor_name", sa.String(length=300), nullable=False),
        sa.Column("currency", sa.CHAR(length=3), nullable=False),
        sa.Column("amount_minor_units", sa.BigInteger(), nullable=False),
        sa.Column("due_date", sa.Date()),
        sa.Column("added_by_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        # Cascade, unlike every other key here. Lines have no meaning apart from
        # their package and a cancelled one takes them with it.
        sa.ForeignKeyConstraint(
            ["package_id"],
            ["payment_packages.id"],
            name="fk_payment_package_lines_package",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["invoice_id"],
            ["invoices.id"],
            name="fk_payment_package_lines_invoice",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["vendor_id"],
            ["vendors.id"],
            name="fk_payment_package_lines_vendor",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["added_by_id"], ["users.id"], name="fk_payment_package_lines_added_by"
        ),
        sa.CheckConstraint("amount_minor_units > 0", name="line_amount_is_positive"),
    )
    op.create_index("ix_payment_package_lines_package_id", "payment_package_lines", ["package_id"])
    op.create_index("ix_payment_package_lines_vendor_id", "payment_package_lines", ["vendor_id"])
    op.create_index(
        "ix_payment_package_lines_vendor", "payment_package_lines", ["package_id", "vendor_name"]
    )
