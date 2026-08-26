"""Asking the supplier whether the money arrived, and filing what they say.

One table, five enums, two widened ones, and a change to `signed_links` that is
the interesting part of this migration.

**`signed_links.issued_to_id` becomes nullable, and gains a sibling.** Until now
every link was issued to a user, checked against that user's session, and worth
nothing to anybody else. A supplier has no account here, so a link to them cannot
be checked against a session at all. Rather than a second link table with its own
expiry, revocation and single-use logic — one of which would eventually be the
weaker — the same row takes either recipient, with a check constraint insisting on
exactly one. What differs is only the page at the far end: the supplier's records
a claim and can move nothing, which is what makes an unauthenticated destination
acceptable in the first place.

**`vendor_check_ins` has no lines and no state.** No lines, because a check-in
concerns exactly the lines of its package naming that supplier, and a package can
only be checked in on after submission, when its lines are already frozen. No
state, for the same reason a package has none: the conversation is not a claim
about money that anybody signs off. The invoices move on the state machine, and
only a reviewer moves them.

**One row per supplier per package**, enforced by a unique constraint rather than
by the service remembering to look. A bank pays a batch as one credit; asking a
supplier invoice by invoice would be asking them to do our arithmetic, and asking
twice would collect two answers with no rule for which one wins.

**`inbound_messages` learns to be a reply.** Threading headers are stored raw
because they are the evidence correlation reasoned from, and the conclusion is
stored beside them with the rule that reached it, so a reviewer looking at a
surprising reply can see how firmly it was tied to the conversation.

**`outbox_messages` learns to ask for a reply somewhere else.** External mail
sets a `Reply-To` carrying the conversation's tag, which is what files a reply
whose client discarded `In-Reply-To`, or one forwarded through a shared inbox and
sent on by hand. Internal mail leaves it null and continues to be replied to at
the address the platform sends as.

Revision ID: e7f2a91c4b60
Revises: c93f1a5b7d20
Create Date: 2026-08-06 08:14:52.117430
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e7f2a91c4b60"
down_revision: str | None = "c93f1a5b7d20"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


#: Check-in references, so a conversation with a supplier can be quoted in a
#: phone call without reciting a UUID.
_REFERENCE_SEQUENCE = "vendor_check_in_reference_seq"

_CLAIM_OUTCOMES = ("received", "partly_received", "not_received")
_CLAIM_CHANNELS = ("signed_link", "email_reply", "recorded_by_staff")
_REVIEW_OUTCOMES = ("paid", "outstanding")
_CORRELATION_BASES = ("in_reply_to", "references", "reply_address_tag", "subject_tag")
_AUTOMATIC_KINDS = ("vacation", "bounce", "bulk")

#: Added to types that already exist. Postgres allows this inside a transaction
#: from version 12 onwards, provided the new value is not then used in the same
#: transaction — nothing below does.
_NEW_REMINDER_PURPOSES = ("payment_check_in",)
_NEW_MESSAGE_KINDS = ("vendor_check_in_request", "vendor_check_in_reminder")
_NEW_AUDIT_ACTIONS = ("vendor_confirmation_requested", "vendor_confirmation_reviewed")


def upgrade() -> None:
    for value in _NEW_REMINDER_PURPOSES:
        op.execute(f"ALTER TYPE reminder_purpose ADD VALUE IF NOT EXISTS '{value}'")
    for value in _NEW_MESSAGE_KINDS:
        op.execute(f"ALTER TYPE message_kind ADD VALUE IF NOT EXISTS '{value}'")
    for value in _NEW_AUDIT_ACTIONS:
        op.execute(f"ALTER TYPE audit_action ADD VALUE IF NOT EXISTS '{value}'")

    for name, values in (
        ("vendor_claim_outcome", _CLAIM_OUTCOMES),
        ("vendor_claim_channel", _CLAIM_CHANNELS),
        ("vendor_review_outcome", _REVIEW_OUTCOMES),
        ("mail_correlation_basis", _CORRELATION_BASES),
        ("automatic_mail_kind", _AUTOMATIC_KINDS),
    ):
        postgresql.ENUM(*values, name=name).create(op.get_bind())

    op.execute(f"CREATE SEQUENCE IF NOT EXISTS {_REFERENCE_SEQUENCE} AS BIGINT START WITH 1")

    _open_links_to_vendors()
    _teach_inbound_messages_to_be_replies()
    _create_check_ins()

    # Where a reply should go, when that is not the address the platform sends
    # as. Only external mail sets it, and only so the tag in the address can
    # rescue a reply whose client dropped the threading headers.
    op.add_column("outbox_messages", sa.Column("reply_to_address", sa.String(length=320)))


def downgrade() -> None:
    op.drop_column("outbox_messages", "reply_to_address")
    op.drop_table("vendor_check_ins")
    op.execute(f"DROP SEQUENCE IF EXISTS {_REFERENCE_SEQUENCE}")

    op.drop_constraint("correlation_says_how_it_matched", "inbound_messages", type_="check")
    op.drop_constraint("correlation_names_a_record", "inbound_messages", type_="check")
    op.drop_index("ix_inbound_messages_correlated", table_name="inbound_messages")
    op.drop_index("ix_inbound_messages_automatic_kind", table_name="inbound_messages")
    op.drop_index("ix_inbound_messages_in_reply_to", table_name="inbound_messages")
    for column in (
        "automatic_kind",
        "correlation_basis",
        "correlated_record_id",
        "correlated_record_type",
        "delivered_to_addresses",
        "references",
        "in_reply_to",
    ):
        op.drop_column("inbound_messages", column)

    # Any link issued to a supplier is dropped rather than migrated. There is
    # nowhere for it to go: the column that held its recipient is about to
    # disappear, and a link with no recipient cannot be refused to the wrong one.
    op.execute("DELETE FROM signed_links WHERE issued_to_vendor_id IS NOT NULL")
    op.drop_constraint("link_has_exactly_one_recipient", "signed_links", type_="check")
    op.drop_index("ix_signed_links_issued_to_vendor_id", table_name="signed_links")
    op.drop_column("signed_links", "issued_to_vendor_id")
    op.alter_column("signed_links", "issued_to_id", nullable=False)

    for name in (
        "automatic_mail_kind",
        "mail_correlation_basis",
        "vendor_review_outcome",
        "vendor_claim_channel",
        "vendor_claim_outcome",
    ):
        postgresql.ENUM(name=name).drop(op.get_bind())

    # The two widened enums keep their new values. Removing a value from a
    # Postgres enum means rewriting the type and every column using it, which is
    # a great deal of risk to take on the way back from a migration; an unused
    # value costs nothing.


def _open_links_to_vendors() -> None:
    op.add_column(
        "signed_links",
        sa.Column("issued_to_vendor_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.alter_column("signed_links", "issued_to_id", nullable=True)
    op.create_foreign_key(
        "fk_signed_links_issued_to_vendor",
        "signed_links",
        "vendors",
        ["issued_to_vendor_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_signed_links_issued_to_vendor_id", "signed_links", ["issued_to_vendor_id"])
    # Exactly one recipient. Neither would be a link nobody could be refused;
    # both would be a link two parties could spend.
    op.create_check_constraint(
        "link_has_exactly_one_recipient",
        "signed_links",
        "(issued_to_id IS NULL) <> (issued_to_vendor_id IS NULL)",
    )


def _teach_inbound_messages_to_be_replies() -> None:
    op.add_column("inbound_messages", sa.Column("in_reply_to", sa.String(length=500)))
    op.add_column(
        "inbound_messages",
        sa.Column(
            "references",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="[]",
        ),
    )
    # Where the message was actually delivered, which is where a sub-addressed
    # tag survives a relay that rewrote `To`.
    op.add_column(
        "inbound_messages",
        sa.Column(
            "delivered_to_addresses",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="[]",
        ),
    )
    op.add_column("inbound_messages", sa.Column("correlated_record_type", sa.String(length=50)))
    op.add_column(
        "inbound_messages",
        sa.Column("correlated_record_id", postgresql.UUID(as_uuid=True)),
    )
    op.add_column(
        "inbound_messages",
        sa.Column(
            "correlation_basis",
            postgresql.ENUM(*_CORRELATION_BASES, name="mail_correlation_basis", create_type=False),
        ),
    )
    op.add_column(
        "inbound_messages",
        sa.Column(
            "automatic_kind",
            postgresql.ENUM(*_AUTOMATIC_KINDS, name="automatic_mail_kind", create_type=False),
        ),
    )

    op.create_index("ix_inbound_messages_in_reply_to", "inbound_messages", ["in_reply_to"])
    op.create_index("ix_inbound_messages_automatic_kind", "inbound_messages", ["automatic_kind"])
    op.create_index(
        "ix_inbound_messages_correlated",
        "inbound_messages",
        ["correlated_record_type", "correlated_record_id", "received_at"],
    )
    op.create_check_constraint(
        "correlation_names_a_record",
        "inbound_messages",
        "(correlated_record_type IS NULL) = (correlated_record_id IS NULL)",
    )
    op.create_check_constraint(
        "correlation_says_how_it_matched",
        "inbound_messages",
        "(correlated_record_id IS NULL) = (correlation_basis IS NULL)",
    )


def _create_check_ins() -> None:
    op.create_table(
        "vendor_check_ins",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("reference", sa.String(length=30), nullable=False, unique=True),
        sa.Column("package_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("vendor_id", postgresql.UUID(as_uuid=True)),
        sa.Column("vendor_name", sa.String(length=300), nullable=False),
        # Snapshotted. A later edit to the supplier's record must not rewrite
        # where the platform says it sent the question.
        sa.Column("vendor_email", sa.String(length=320)),
        # Identifies the conversation in a reply. Not a credential: it opens
        # nothing, which is why it can travel in a subject line.
        sa.Column("correlation_tag", sa.String(length=40), nullable=False, unique=True),
        sa.Column("created_by_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True)),
        sa.Column("answered_at", sa.DateTime(timezone=True)),
        sa.Column(
            "claim",
            postgresql.ENUM(*_CLAIM_OUTCOMES, name="vendor_claim_outcome", create_type=False),
        ),
        sa.Column(
            "claim_channel",
            postgresql.ENUM(*_CLAIM_CHANNELS, name="vendor_claim_channel", create_type=False),
        ),
        sa.Column("respondent_name", sa.String(length=120)),
        sa.Column("respondent_note", sa.Text()),
        sa.Column("answered_from_message_id", postgresql.UUID(as_uuid=True)),
        sa.Column("reviewed_at", sa.DateTime(timezone=True)),
        sa.Column("reviewed_by_id", postgresql.UUID(as_uuid=True)),
        sa.Column(
            "review_outcome",
            postgresql.ENUM(*_REVIEW_OUTCOMES, name="vendor_review_outcome", create_type=False),
        ),
        sa.Column("review_note", sa.Text()),
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
            ["package_id"],
            ["payment_packages.id"],
            name="fk_vendor_check_ins_package",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["vendor_id"], ["vendors.id"], name="fk_vendor_check_ins_vendor", ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["created_by_id"], ["users.id"], name="fk_vendor_check_ins_created_by"
        ),
        sa.ForeignKeyConstraint(
            ["reviewed_by_id"], ["users.id"], name="fk_vendor_check_ins_reviewed_by"
        ),
        # Cleared rather than cascading. Losing the message must not lose the
        # claim it carried; what is lost is only the pointer to the original.
        sa.ForeignKeyConstraint(
            ["answered_from_message_id"],
            ["inbound_messages.id"],
            name="fk_vendor_check_ins_answer_message",
            ondelete="SET NULL",
        ),
        sa.UniqueConstraint("package_id", "vendor_name", name="uq_vendor_check_in_per_package"),
        sa.CheckConstraint(
            "(answered_at IS NULL) = (claim IS NULL)", name="an_answer_says_what_it_was"
        ),
        sa.CheckConstraint(
            "(claim IS NULL) = (claim_channel IS NULL)", name="an_answer_says_how_it_arrived"
        ),
        sa.CheckConstraint(
            "(reviewed_at IS NULL) = (review_outcome IS NULL)",
            name="a_review_reaches_a_conclusion",
        ),
        sa.CheckConstraint(
            "(reviewed_at IS NULL) = (reviewed_by_id IS NULL)", name="a_review_names_its_reviewer"
        ),
        # Nothing is answered before it was asked. Without this a check-in could
        # hold a supplier's answer to a question never put to them, which is the
        # shape a forged confirmation would take.
        sa.CheckConstraint(
            "answered_at IS NULL OR sent_at IS NOT NULL", name="an_answer_follows_a_question"
        ),
    )

    op.create_index("ix_vendor_check_ins_reference", "vendor_check_ins", ["reference"])
    op.create_index("ix_vendor_check_ins_package_id", "vendor_check_ins", ["package_id"])
    op.create_index("ix_vendor_check_ins_vendor_id", "vendor_check_ins", ["vendor_id"])
    op.create_index("ix_vendor_check_ins_correlation_tag", "vendor_check_ins", ["correlation_tag"])
    op.create_index("ix_vendor_check_ins_sent_at", "vendor_check_ins", ["sent_at"])
    op.create_index("ix_vendor_check_ins_reviewed_at", "vendor_check_ins", ["reviewed_at"])
    op.create_index("ix_vendor_check_ins_review_outcome", "vendor_check_ins", ["review_outcome"])
    # The review queue, and the chasing queue.
    op.create_index(
        "ix_vendor_check_ins_needing_review",
        "vendor_check_ins",
        ["answered_at"],
        postgresql_where=sa.text("reviewed_at IS NULL"),
    )
    op.create_index(
        "ix_vendor_check_ins_awaiting",
        "vendor_check_ins",
        ["sent_at"],
        postgresql_where=sa.text("answered_at IS NULL AND reviewed_at IS NULL"),
    )
