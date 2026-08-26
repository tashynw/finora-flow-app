"""Estimates, approval routes and their steps.

Three tables, two enumerated types, one sequence and the default approval matrix.

`workflow_state` and `approval_level` already exist from the foundation
migration, so the columns using them declare `create_type=False`; without it
each `CREATE TABLE` would try to create the type again and fail. The two new
types are created explicitly at the start for the same reason the reading
migration does it: `approval_step_state` is referenced once here but naming the
creation makes the drop in `downgrade` symmetrical.

The approval matrix is seeded with a documented default rather than left empty.
An empty matrix means no estimate can be submitted at all, because a route that
cannot be planned is refused rather than skipped, and a platform that refuses
every submission until somebody runs SQL is not a working platform. The bands
below are configuration and are expected to be confirmed against the
authoritative requirements document; the reasoning behind the chosen figures is
in `docs/requirements/approval-matrix.md`.

Revision ID: 68366a8aa492
Revises: d0e05cb20551
Create Date: 2026-08-05 14:24:11.995968
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "68366a8aa492"
down_revision: str | None = "d0e05cb20551"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Created and dropped explicitly by this migration, so the columns must not also
# try to manage them.
approval_route_state = postgresql.ENUM(
    "open",
    "approved",
    "rejected",
    "withdrawn",
    name="approval_route_state",
    create_type=False,
)
approval_step_state = postgresql.ENUM(
    "waiting",
    "ready",
    "approved",
    "rejected",
    "withdrawn",
    name="approval_step_state",
    create_type=False,
)

_NEW_TYPES = (approval_route_state, approval_step_state)

# Already present. Referenced without creation.
workflow_state = postgresql.ENUM(name="workflow_state", create_type=False)
approval_level = postgresql.ENUM(name="approval_level", create_type=False)

#: Opening a route and abandoning one are distinct acts a trail needs words for.
#: "Who withdrew this from approval after the Unit Head had already agreed to it"
#: is a question `state_changed` alone cannot answer.
_NEW_AUDIT_ACTIONS = ("approval_requested", "approval_withdrawn")

#: The reference sequence. Not restarted per year: a reference that resets is a
#: reference two records can share once the years are stripped, and references
#: get stripped every time somebody types one into a search box.
_REFERENCE_SEQUENCE = "estimate_reference_seq"

#: The default approval matrix for estimates, in JMD minor units.
#:
#: Cumulative by construction: every band has no upper bound, so a larger amount
#: matches more rules and therefore needs more approvals. JMD 40,000 needs the
#: Unit Head alone; JMD 600,000 needs the Unit Head, then the Manager, then the
#: Head of Department, in that order.
#:
#: Only JMD is seeded, because it is the only currency the requirements state a
#: figure for. An amount in another currency is refused at submission with a
#: message saying bands have to be configured for it, which is the fail-closed
#: direction: bands invented for USD would be a guess that silently decided who
#: may approve a foreign-currency spend.
_DEFAULT_MATRIX = (
    # (step, level, minimum in minor units, plain-language name)
    (1, "unit_head", 0, "Unit Head, all estimates"),
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

    op.create_table(
        "approval_requests",
        sa.Column("record_type", sa.String(length=80), nullable=False),
        sa.Column("record_id", sa.UUID(), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("state", approval_route_state, nullable=False),
        sa.Column("current_step_order", sa.Integer(), nullable=True),
        sa.Column("amount_minor_units", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.CHAR(length=3), nullable=False),
        sa.Column("department", sa.String(length=200), nullable=True),
        sa.Column("requester_id", sa.UUID(), nullable=False),
        sa.Column(
            "opened_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
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
            "(state = 'open') = (closed_at IS NULL)",
            name=op.f("ck_approval_requests_closed_route_records_when"),
        ),
        sa.CheckConstraint(
            "(state = 'open') = (current_step_order IS NOT NULL)",
            name=op.f("ck_approval_requests_open_route_has_an_open_step"),
        ),
        sa.CheckConstraint(
            "amount_minor_units > 0", name=op.f("ck_approval_requests_amount_is_positive")
        ),
        sa.CheckConstraint("attempt > 0", name=op.f("ck_approval_requests_attempt_positive")),
        sa.ForeignKeyConstraint(
            ["requester_id"],
            ["users.id"],
            name=op.f("fk_approval_requests_requester_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_approval_requests")),
        sa.UniqueConstraint(
            "record_type", "record_id", "attempt", name="uq_approval_requests_attempt"
        ),
    )
    op.create_index(
        op.f("ix_approval_requests_current_step_order"),
        "approval_requests",
        ["current_step_order"],
        unique=False,
    )
    op.create_index(
        "ix_approval_requests_record",
        "approval_requests",
        ["record_type", "record_id", "attempt"],
        unique=False,
    )
    op.create_index(
        op.f("ix_approval_requests_record_id"), "approval_requests", ["record_id"], unique=False
    )
    op.create_index(
        op.f("ix_approval_requests_state"), "approval_requests", ["state"], unique=False
    )
    # Partial unique index: one open route per record. A second open route would
    # mean two sets of approvers deciding the same spend independently.
    op.create_index(
        "uq_approval_requests_one_open",
        "approval_requests",
        ["record_type", "record_id"],
        unique=True,
        postgresql_where=sa.text("state = 'open'"),
    )

    op.create_table(
        "approval_steps",
        sa.Column("request_id", sa.UUID(), nullable=False),
        sa.Column("step_order", sa.Integer(), nullable=False),
        sa.Column("level", approval_level, nullable=False),
        sa.Column("state", approval_step_state, nullable=False),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("decided_by_id", sa.UUID(), nullable=True),
        sa.Column("decided_by_label", sa.String(length=300), nullable=True),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column("on_behalf_of_id", sa.UUID(), nullable=True),
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
            "(state IN ('approved', 'rejected')) = (decided_at IS NOT NULL)",
            name=op.f("ck_approval_steps_decision_records_when"),
        ),
        sa.CheckConstraint(
            "state <> 'rejected' OR (comment IS NOT NULL AND comment <> '')",
            name=op.f("ck_approval_steps_rejection_is_explained"),
        ),
        sa.CheckConstraint(
            "(decided_at IS NULL) = (decided_by_id IS NULL)",
            name=op.f("ck_approval_steps_decision_names_its_actor"),
        ),
        sa.CheckConstraint("step_order > 0", name=op.f("ck_approval_steps_step_order_positive")),
        sa.ForeignKeyConstraint(
            ["decided_by_id"],
            ["users.id"],
            name=op.f("fk_approval_steps_decided_by_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["on_behalf_of_id"],
            ["users.id"],
            name=op.f("fk_approval_steps_on_behalf_of_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["request_id"],
            ["approval_requests.id"],
            name=op.f("fk_approval_steps_request_id_approval_requests"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_approval_steps")),
        sa.UniqueConstraint("request_id", "step_order", "level", name="uq_approval_steps_step"),
    )
    op.create_index(
        op.f("ix_approval_steps_request_id"), "approval_steps", ["request_id"], unique=False
    )

    op.create_table(
        "estimates",
        sa.Column("reference", sa.String(length=30), nullable=False),
        sa.Column("state", workflow_state, nullable=False),
        sa.Column("requester_id", sa.UUID(), nullable=False),
        sa.Column("document_id", sa.UUID(), nullable=True),
        sa.Column("vendor_id", sa.UUID(), nullable=True),
        sa.Column("vendor_name", sa.String(length=300), nullable=False),
        sa.Column("estimate_number", sa.String(length=120), nullable=True),
        sa.Column("estimate_date", sa.Date(), nullable=True),
        sa.Column("needed_by", sa.Date(), nullable=True),
        sa.Column("currency", sa.CHAR(length=3), nullable=True),
        sa.Column("total_minor_units", sa.BigInteger(), nullable=True),
        sa.Column("description", sa.String(length=500), nullable=False),
        sa.Column("justification", sa.Text(), nullable=False),
        sa.Column("cost_centre_id", sa.UUID(), nullable=True),
        sa.Column("gl_account_id", sa.UUID(), nullable=True),
        sa.Column("department", sa.String(length=200), nullable=True),
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
            "state = 'draft' OR (vendor_name <> '' AND description <> '' "
            "AND justification <> '' AND estimate_date IS NOT NULL "
            "AND total_minor_units IS NOT NULL AND cost_centre_id IS NOT NULL "
            "AND submitted_at IS NOT NULL)",
            name=op.f("ck_estimates_submitted_estimate_is_complete"),
        ),
        sa.CheckConstraint(
            "state IN ('approved', 'cancelled', 'draft', 'exception', "
            "'pending_approval', 'rejected')",
            name=op.f("ck_estimates_state_is_valid_for_estimate"),
        ),
        sa.CheckConstraint(
            "(submitted_at IS NULL) = (submitted_by_id IS NULL)",
            name=op.f("ck_estimates_submission_names_its_actor"),
        ),
        sa.CheckConstraint(
            "total_minor_units IS NULL OR currency IS NOT NULL",
            name=op.f("ck_estimates_total_states_its_currency"),
        ),
        sa.CheckConstraint(
            "total_minor_units IS NULL OR total_minor_units > 0",
            name=op.f("ck_estimates_total_is_positive"),
        ),
        sa.ForeignKeyConstraint(
            ["cost_centre_id"],
            ["cost_centres.id"],
            name=op.f("fk_estimates_cost_centre_id_cost_centres"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_estimates_document_id_documents"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["gl_account_id"],
            ["gl_accounts.id"],
            name=op.f("fk_estimates_gl_account_id_gl_accounts"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["requester_id"],
            ["users.id"],
            name=op.f("fk_estimates_requester_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["submitted_by_id"],
            ["users.id"],
            name=op.f("fk_estimates_submitted_by_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["vendor_id"],
            ["vendors.id"],
            name=op.f("fk_estimates_vendor_id_vendors"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_estimates")),
        sa.UniqueConstraint("document_id", name=op.f("uq_estimates_document_id")),
    )
    op.create_index(
        op.f("ix_estimates_estimate_number"), "estimates", ["estimate_number"], unique=False
    )
    op.create_index("ix_estimates_queue", "estimates", ["state", "created_at"], unique=False)
    op.create_index(op.f("ix_estimates_reference"), "estimates", ["reference"], unique=True)
    op.create_index(op.f("ix_estimates_requester_id"), "estimates", ["requester_id"], unique=False)
    op.create_index(
        "ix_estimates_requester_queue", "estimates", ["requester_id", "state"], unique=False
    )
    op.create_index(op.f("ix_estimates_state"), "estimates", ["state"], unique=False)

    _seed_default_matrix()


def _seed_default_matrix() -> None:
    """Insert the default estimate approval bands, if the table is empty of them.

    Guarded so that re-running against a database where an administrator has
    already configured bands does not add a second, conflicting set. Idempotent
    rather than unconditional, because this migration will be run against the
    pilot database that people have been using.
    """
    bind = op.get_bind()
    already = bind.execute(
        sa.text("SELECT count(*) FROM approval_rules WHERE record_type = 'estimate'")
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
            :id, :name, 'estimate', CAST(:level AS approval_level),
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


def downgrade() -> None:
    op.execute("DELETE FROM approval_rules WHERE record_type = 'estimate'")

    op.drop_index(op.f("ix_estimates_state"), table_name="estimates")
    op.drop_index("ix_estimates_requester_queue", table_name="estimates")
    op.drop_index(op.f("ix_estimates_requester_id"), table_name="estimates")
    op.drop_index(op.f("ix_estimates_reference"), table_name="estimates")
    op.drop_index("ix_estimates_queue", table_name="estimates")
    op.drop_index(op.f("ix_estimates_estimate_number"), table_name="estimates")
    op.drop_table("estimates")

    op.drop_index(op.f("ix_approval_steps_request_id"), table_name="approval_steps")
    op.drop_table("approval_steps")

    op.drop_index(
        "uq_approval_requests_one_open",
        table_name="approval_requests",
        postgresql_where=sa.text("state = 'open'"),
    )
    op.drop_index(op.f("ix_approval_requests_state"), table_name="approval_requests")
    op.drop_index(op.f("ix_approval_requests_record_id"), table_name="approval_requests")
    op.drop_index("ix_approval_requests_record", table_name="approval_requests")
    op.drop_index(op.f("ix_approval_requests_current_step_order"), table_name="approval_requests")
    op.drop_table("approval_requests")

    op.execute(f"DROP SEQUENCE IF EXISTS {_REFERENCE_SEQUENCE}")

    # The two audit actions added above are left in place, for the reason given
    # in the reading migration: an entry naming one may already exist, and the
    # trail is append-only and hash-chained. An unused enum value is harmless.

    # After the tables, or the types are still in use.
    for enum_name in ("approval_step_state", "approval_route_state"):
        op.execute(f"DROP TYPE IF EXISTS {enum_name}")
