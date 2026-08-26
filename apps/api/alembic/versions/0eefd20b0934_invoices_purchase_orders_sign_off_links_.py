"""Invoices, purchase orders, signed sign-off links, reminders and the mail outbox.

Five tables and four enumerated types.

The types are created explicitly at the top rather than inline on the columns,
which is the convention the earlier migrations follow and is load-bearing here:
`reminder_purpose` is used by both `reminder_schedules` and `signed_links`, and an
inline declaration on each would issue `CREATE TYPE` twice and fail on the second.
`workflow_state` already exists from the foundation migration and is referenced
without creation.

Two decisions in here are worth more than the schema they produce.

`uq_invoices_live_vendor_number` is a partial unique index rather than a plain
one. The same vendor genuinely does re-use a number after a cancellation, and
refusing that would leave finance unable to record a corrected invoice; but two
*live* invoices with one number is a double payment waiting to happen, which is
the most expensive ordinary failure in accounts payable. So the index excludes
cancelled, rejected and archived rows. It is a database constraint and not only an
application rule because a defect in the application layer must not be sufficient
to pay a supplier twice.

Drafts are excluded too, which is the less obvious half. A suspected duplicate has
to be recordable, because the person who spots it needs both records in front of
them to decide which is real, and a constraint violation on save would deny them
that while explaining nothing. The application refuses to move either one forward
while the other is live, so this index is left guarding only what the application
cannot see: two of them crossing the same instant.

`invoices` has no seeded reference sequence shared with estimates. A separate
`invoice_reference_seq` is created, so an invoice is INV-000001 while an estimate
is EST-000001. Sharing one sequence would produce records whose numbers interleave
and whose gaps look like deletions to anyone reading a register.

Revision ID: 0eefd20b0934
Revises: 68366a8aa492
Create Date: 2026-08-05 22:58:17.805705
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0eefd20b0934"
down_revision: str | None = "68366a8aa492"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Created and dropped explicitly by this migration, so the columns must not also
# try to manage them.
purchase_order_state = postgresql.ENUM(
    "open",
    "closed",
    "cancelled",
    name="purchase_order_state",
    create_type=False,
)
reminder_purpose = postgresql.ENUM(
    "sign_off",
    "approval",
    name="reminder_purpose",
    create_type=False,
)
message_kind = postgresql.ENUM(
    "sign_off_request",
    "sign_off_reminder",
    "sign_off_escalation",
    "approval_request",
    "approval_reminder",
    "approval_escalation",
    "decision_notice",
    name="message_kind",
    create_type=False,
)
outbox_state = postgresql.ENUM(
    "pending",
    "sending",
    "sent",
    "failed",
    "abandoned",
    name="outbox_state",
    create_type=False,
)

_NEW_TYPES = (purchase_order_state, reminder_purpose, message_kind, outbox_state)

# Already present. Referenced without creation.
workflow_state = postgresql.ENUM(name="workflow_state", create_type=False)

#: Acts this phase can record that the trail had no words for. Receipt sign-off
#: existed already; being asked for it, refusing it, being chased about it and
#: following a link to it did not, and each is a question somebody asks.
_NEW_AUDIT_ACTIONS = (
    "sign_off_requested",
    "sign_off_declined",
    "reminder_sent",
    "escalated",
    "link_issued",
    "link_followed",
    "link_refused",
)

#: Invoices count on their own sequence, for the reason given in the docstring.
_REFERENCE_SEQUENCE = "invoice_reference_seq"

#: The bands an invoice is routed through, mirroring the estimate defaults so that
#: a spend approved at one level is not paid at another.
_DEFAULT_MATRIX = (
    # (step, level, minimum in minor units, plain-language name)
    (1, "unit_head", 0, "Unit Head, all invoices"),
    (2, "manager", 5_000_000, "Manager, JMD 50,000 and above"),
    (3, "hod", 50_000_000, "Head of Department, JMD 500,000 and above"),
    (4, "coo", 500_000_000, "Chief Operating Officer, JMD 5,000,000 and above"),
)


def upgrade() -> None:
    bind = op.get_bind()
    for enum_type in _NEW_TYPES:
        enum_type.create(bind, checkfirst=True)

    for action in _NEW_AUDIT_ACTIONS:
        op.execute(f"ALTER TYPE audit_action ADD VALUE IF NOT EXISTS '{action}'")

    op.execute(f"CREATE SEQUENCE IF NOT EXISTS {_REFERENCE_SEQUENCE} AS BIGINT START WITH 1")

    _create_purchase_orders()
    _create_invoices()
    _create_signed_links()
    _create_reminder_schedules()
    _create_outbox_messages()
    _seed_invoice_matrix()


def _seed_invoice_matrix() -> None:
    """Give invoices their own approval bands, matching the estimate ones.

    Separate rows rather than a shared record type, even though the figures are
    identical today. The two are different decisions — an estimate approves an
    intention to spend, an invoice approves a payment — and an organisation that
    wants a second signature on payments but not on requests must be able to say so
    without the change leaking into the other. Phase 6 makes these editable; this
    only stops an invoice being unroutable in the meantime.

    Guarded, like the estimate seed, so re-running against a database somebody has
    already configured does not add a second conflicting set.
    """
    bind = op.get_bind()
    already = bind.execute(
        sa.text("SELECT count(*) FROM approval_rules WHERE record_type = 'invoice'")
    ).scalar_one()
    if already:
        return

    insert = sa.text(
        """
        INSERT INTO approval_rules (
            id, name, record_type, level,
            min_amount_minor_units, max_amount_minor_units, currency,
            step_order, is_parallel, department, is_active,
            created_at, updated_at, version
        ) VALUES (
            :id, :name, 'invoice', CAST(:level AS approval_level),
            :minimum, NULL, 'JMD',
            :step_order, false, NULL, true,
            now(), now(), 1
        )
        """
    )
    for step_order, level, minimum, name in _DEFAULT_MATRIX:
        bind.execute(
            insert,
            {
                "id": uuid.uuid4(),
                "name": name,
                "level": level,
                "minimum": minimum,
                "step_order": step_order,
            },
        )


def _create_purchase_orders() -> None:
    op.create_table(
        "purchase_orders",
        sa.Column("number", sa.String(length=60), nullable=False),
        sa.Column("state", purchase_order_state, nullable=False),
        sa.Column("vendor_id", sa.UUID(), nullable=False),
        sa.Column("currency", sa.CHAR(length=3), nullable=False),
        sa.Column("total_minor_units", sa.BigInteger(), nullable=False),
        sa.Column("description", sa.String(length=500), nullable=False),
        sa.Column("estimate_id", sa.UUID(), nullable=True),
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
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("archived_reason", sa.String(length=500), nullable=True),
        sa.CheckConstraint(
            "total_minor_units > 0", name=op.f("ck_purchase_orders_total_is_positive")
        ),
        sa.ForeignKeyConstraint(
            ["estimate_id"],
            ["estimates.id"],
            name=op.f("fk_purchase_orders_estimate_id_estimates"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["vendor_id"],
            ["vendors.id"],
            name=op.f("fk_purchase_orders_vendor_id_vendors"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_purchase_orders")),
    )
    op.create_index(op.f("ix_purchase_orders_number"), "purchase_orders", ["number"], unique=True)
    op.create_index(op.f("ix_purchase_orders_state"), "purchase_orders", ["state"], unique=False)
    op.create_index(
        "ix_purchase_orders_vendor", "purchase_orders", ["vendor_id", "state"], unique=False
    )


def _create_invoices() -> None:
    op.create_table(
        "invoices",
        sa.Column("reference", sa.String(length=30), nullable=False),
        sa.Column("state", workflow_state, nullable=False),
        sa.Column("requester_id", sa.UUID(), nullable=True),
        sa.Column("created_by_id", sa.UUID(), nullable=False),
        sa.Column("document_id", sa.UUID(), nullable=True),
        sa.Column("vendor_id", sa.UUID(), nullable=True),
        sa.Column("vendor_name", sa.String(length=300), nullable=False),
        sa.Column("invoice_number", sa.String(length=120), nullable=True),
        sa.Column("invoice_date", sa.Date(), nullable=True),
        sa.Column("due_date", sa.Date(), nullable=True),
        sa.Column("currency", sa.CHAR(length=3), nullable=True),
        sa.Column("total_minor_units", sa.BigInteger(), nullable=True),
        sa.Column("description", sa.String(length=500), nullable=False),
        sa.Column("estimate_id", sa.UUID(), nullable=True),
        sa.Column("purchase_order_id", sa.UUID(), nullable=True),
        sa.Column("cost_centre_id", sa.UUID(), nullable=True),
        sa.Column("gl_account_id", sa.UUID(), nullable=True),
        sa.Column("department", sa.String(length=200), nullable=True),
        sa.Column("signed_off_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("signed_off_by_id", sa.UUID(), nullable=True),
        sa.Column("sign_off_note", sa.Text(), nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("submitted_by_id", sa.UUID(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("archived_reason", sa.String(length=500), nullable=True),
        sa.CheckConstraint(
            "state IN ('accrual_needed', 'approved', 'cancelled', 'draft', 'exception', "
            "'outstanding', 'paid', 'pending_approval', 'pending_sign_off', "
            "'ready_for_submission', 'rejected', 'submitted')",
            name=op.f("ck_invoices_state_is_valid_for_invoice"),
        ),
        sa.CheckConstraint(
            "state IN ('draft', 'cancelled') OR (vendor_id IS NOT NULL AND vendor_name <> '' "
            "AND description <> '' AND invoice_number IS NOT NULL AND invoice_date IS NOT NULL "
            "AND total_minor_units IS NOT NULL AND cost_centre_id IS NOT NULL "
            "AND requester_id IS NOT NULL)",
            name=op.f("ck_invoices_live_invoice_is_complete"),
        ),
        sa.CheckConstraint(
            "(signed_off_at IS NULL) = (signed_off_by_id IS NULL)",
            name=op.f("ck_invoices_sign_off_names_its_actor"),
        ),
        sa.CheckConstraint(
            "(submitted_at IS NULL) = (submitted_by_id IS NULL)",
            name=op.f("ck_invoices_submission_names_its_actor"),
        ),
        sa.CheckConstraint(
            "total_minor_units IS NULL OR currency IS NOT NULL",
            name=op.f("ck_invoices_total_states_its_currency"),
        ),
        sa.CheckConstraint(
            "total_minor_units IS NULL OR total_minor_units > 0",
            name=op.f("ck_invoices_total_is_positive"),
        ),
        sa.ForeignKeyConstraint(
            ["cost_centre_id"],
            ["cost_centres.id"],
            name=op.f("fk_invoices_cost_centre_id_cost_centres"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["created_by_id"],
            ["users.id"],
            name=op.f("fk_invoices_created_by_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_invoices_document_id_documents"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["estimate_id"],
            ["estimates.id"],
            name=op.f("fk_invoices_estimate_id_estimates"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["gl_account_id"],
            ["gl_accounts.id"],
            name=op.f("fk_invoices_gl_account_id_gl_accounts"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["purchase_order_id"],
            ["purchase_orders.id"],
            name=op.f("fk_invoices_purchase_order_id_purchase_orders"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["requester_id"],
            ["users.id"],
            name=op.f("fk_invoices_requester_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["signed_off_by_id"],
            ["users.id"],
            name=op.f("fk_invoices_signed_off_by_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["submitted_by_id"],
            ["users.id"],
            name=op.f("fk_invoices_submitted_by_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["vendor_id"],
            ["vendors.id"],
            name=op.f("fk_invoices_vendor_id_vendors"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_invoices")),
        sa.UniqueConstraint("document_id", name=op.f("uq_invoices_document_id")),
    )
    op.create_index("ix_invoices_due", "invoices", ["state", "due_date"], unique=False)
    op.create_index(op.f("ix_invoices_estimate_id"), "invoices", ["estimate_id"], unique=False)
    op.create_index(
        op.f("ix_invoices_invoice_number"), "invoices", ["invoice_number"], unique=False
    )
    op.create_index(
        op.f("ix_invoices_purchase_order_id"), "invoices", ["purchase_order_id"], unique=False
    )
    op.create_index("ix_invoices_queue", "invoices", ["state", "created_at"], unique=False)
    op.create_index(op.f("ix_invoices_reference"), "invoices", ["reference"], unique=True)
    op.create_index(op.f("ix_invoices_requester_id"), "invoices", ["requester_id"], unique=False)
    op.create_index(
        "ix_invoices_requester_queue", "invoices", ["requester_id", "state"], unique=False
    )
    op.create_index(op.f("ix_invoices_state"), "invoices", ["state"], unique=False)
    op.create_index(op.f("ix_invoices_vendor_id"), "invoices", ["vendor_id"], unique=False)
    # The double-payment control. See the module docstring for why it is partial.
    op.create_index(
        "uq_invoices_live_vendor_number",
        "invoices",
        ["vendor_id", "invoice_number"],
        unique=True,
        postgresql_where=sa.text(
            "state NOT IN ('draft', 'cancelled', 'rejected') AND archived_at IS NULL"
        ),
    )


def _create_signed_links() -> None:
    op.create_table(
        "signed_links",
        sa.Column("token_sha256", sa.CHAR(length=64), nullable=False),
        sa.Column("record_type", sa.String(length=50), nullable=False),
        sa.Column("record_id", sa.UUID(), nullable=False),
        sa.Column("purpose", reminder_purpose, nullable=False),
        sa.Column("issued_to_id", sa.UUID(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.ForeignKeyConstraint(
            ["issued_to_id"],
            ["users.id"],
            name=op.f("fk_signed_links_issued_to_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_signed_links")),
    )
    op.create_index("ix_signed_links_expiry", "signed_links", ["expires_at"], unique=False)
    op.create_index(
        op.f("ix_signed_links_issued_to_id"), "signed_links", ["issued_to_id"], unique=False
    )
    op.create_index(
        "ix_signed_links_record", "signed_links", ["record_type", "record_id", "purpose"]
    )
    op.create_index(
        op.f("ix_signed_links_token_sha256"), "signed_links", ["token_sha256"], unique=True
    )


def _create_reminder_schedules() -> None:
    op.create_table(
        "reminder_schedules",
        sa.Column("record_type", sa.String(length=50), nullable=False),
        sa.Column("record_id", sa.UUID(), nullable=False),
        sa.Column("purpose", reminder_purpose, nullable=False),
        sa.Column("recipient_id", sa.UUID(), nullable=True),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("next_due_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sent_count", sa.Integer(), nullable=False),
        sa.Column("escalation_level", sa.Integer(), nullable=False),
        sa.Column("stopped_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("stopped_reason", sa.String(length=200), nullable=True),
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
        sa.CheckConstraint(
            "(stopped_at IS NULL) OR (next_due_at IS NULL)",
            name=op.f("ck_reminder_schedules_stopped_schedule_has_nothing_due"),
        ),
        sa.CheckConstraint(
            "escalation_level >= 0",
            name=op.f("ck_reminder_schedules_escalation_level_not_negative"),
        ),
        sa.CheckConstraint(
            "sent_count >= 0", name=op.f("ck_reminder_schedules_sent_count_not_negative")
        ),
        sa.ForeignKeyConstraint(
            ["recipient_id"],
            ["users.id"],
            name=op.f("fk_reminder_schedules_recipient_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_reminder_schedules")),
    )
    op.create_index(
        "ix_reminder_schedules_due", "reminder_schedules", ["next_due_at", "stopped_at"]
    )
    op.create_index(
        op.f("ix_reminder_schedules_next_due_at"), "reminder_schedules", ["next_due_at"]
    )
    op.create_index(
        op.f("ix_reminder_schedules_recipient_id"), "reminder_schedules", ["recipient_id"]
    )
    # One live cycle per record and purpose. A second would double every reminder,
    # which is the specific failure that teaches people to ignore them.
    op.create_index(
        "uq_reminder_schedules_live",
        "reminder_schedules",
        ["record_type", "record_id", "purpose"],
        unique=True,
        postgresql_where=sa.text("stopped_at IS NULL"),
    )


def _create_outbox_messages() -> None:
    op.create_table(
        "outbox_messages",
        sa.Column("kind", message_kind, nullable=False),
        sa.Column("state", outbox_state, nullable=False),
        sa.Column("idempotency_key", sa.String(length=200), nullable=False),
        sa.Column("record_type", sa.String(length=50), nullable=False),
        sa.Column("record_id", sa.UUID(), nullable=False),
        sa.Column("to_address", sa.String(length=320), nullable=False),
        sa.Column("to_name", sa.String(length=300), nullable=False),
        sa.Column("cc_addresses", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("subject", sa.String(length=400), nullable=False),
        sa.Column("body_text", sa.Text(), nullable=False),
        sa.Column("message_id", sa.String(length=300), nullable=False),
        sa.Column("in_reply_to", sa.String(length=300), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column(
            "available_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("correlation_id", sa.UUID(), nullable=True),
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
        sa.CheckConstraint(
            "(state = 'sent') = (sent_at IS NOT NULL)",
            name=op.f("ck_outbox_messages_sent_message_records_when"),
        ),
        sa.CheckConstraint("attempts >= 0", name=op.f("ck_outbox_messages_attempts_not_negative")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_outbox_messages")),
        sa.UniqueConstraint("idempotency_key", name=op.f("uq_outbox_messages_idempotency_key")),
        sa.UniqueConstraint("message_id", name=op.f("uq_outbox_messages_message_id")),
    )
    op.create_index(
        op.f("ix_outbox_messages_available_at"), "outbox_messages", ["available_at"], unique=False
    )
    op.create_index(op.f("ix_outbox_messages_kind"), "outbox_messages", ["kind"], unique=False)
    op.create_index(op.f("ix_outbox_messages_state"), "outbox_messages", ["state"], unique=False)
    op.create_index("ix_outbox_ready", "outbox_messages", ["state", "available_at"], unique=False)
    op.create_index(
        "ix_outbox_record", "outbox_messages", ["record_type", "record_id"], unique=False
    )


def downgrade() -> None:
    op.execute("DELETE FROM approval_rules WHERE record_type = 'invoice'")

    op.drop_index("ix_outbox_record", table_name="outbox_messages")
    op.drop_index("ix_outbox_ready", table_name="outbox_messages")
    op.drop_index(op.f("ix_outbox_messages_state"), table_name="outbox_messages")
    op.drop_index(op.f("ix_outbox_messages_kind"), table_name="outbox_messages")
    op.drop_index(op.f("ix_outbox_messages_available_at"), table_name="outbox_messages")
    op.drop_table("outbox_messages")

    op.drop_index(
        "uq_reminder_schedules_live",
        table_name="reminder_schedules",
        postgresql_where=sa.text("stopped_at IS NULL"),
    )
    op.drop_index(op.f("ix_reminder_schedules_recipient_id"), table_name="reminder_schedules")
    op.drop_index(op.f("ix_reminder_schedules_next_due_at"), table_name="reminder_schedules")
    op.drop_index("ix_reminder_schedules_due", table_name="reminder_schedules")
    op.drop_table("reminder_schedules")

    op.drop_index(op.f("ix_signed_links_token_sha256"), table_name="signed_links")
    op.drop_index("ix_signed_links_record", table_name="signed_links")
    op.drop_index(op.f("ix_signed_links_issued_to_id"), table_name="signed_links")
    op.drop_index("ix_signed_links_expiry", table_name="signed_links")
    op.drop_table("signed_links")

    op.drop_index(
        "uq_invoices_live_vendor_number",
        table_name="invoices",
        postgresql_where=sa.text(
            "state NOT IN ('draft', 'cancelled', 'rejected') AND archived_at IS NULL"
        ),
    )
    op.drop_index(op.f("ix_invoices_vendor_id"), table_name="invoices")
    op.drop_index(op.f("ix_invoices_state"), table_name="invoices")
    op.drop_index("ix_invoices_requester_queue", table_name="invoices")
    op.drop_index(op.f("ix_invoices_requester_id"), table_name="invoices")
    op.drop_index(op.f("ix_invoices_reference"), table_name="invoices")
    op.drop_index("ix_invoices_queue", table_name="invoices")
    op.drop_index(op.f("ix_invoices_purchase_order_id"), table_name="invoices")
    op.drop_index(op.f("ix_invoices_invoice_number"), table_name="invoices")
    op.drop_index(op.f("ix_invoices_estimate_id"), table_name="invoices")
    op.drop_index("ix_invoices_due", table_name="invoices")
    op.drop_table("invoices")

    # After invoices, which references it.
    op.drop_index("ix_purchase_orders_vendor", table_name="purchase_orders")
    op.drop_index(op.f("ix_purchase_orders_state"), table_name="purchase_orders")
    op.drop_index(op.f("ix_purchase_orders_number"), table_name="purchase_orders")
    op.drop_table("purchase_orders")

    op.execute(f"DROP SEQUENCE IF EXISTS {_REFERENCE_SEQUENCE}")

    # The audit actions added above are left in place, as the earlier migrations
    # do: an entry naming one may already exist, and the trail is append-only and
    # hash-chained, so removing the value would make a valid entry unreadable.
    # An unused enum value is harmless.

    # After the tables, or the types are still in use.
    for enum_name in ("outbox_state", "message_kind", "reminder_purpose", "purchase_order_state"):
        op.execute(f"DROP TYPE IF EXISTS {enum_name}")
