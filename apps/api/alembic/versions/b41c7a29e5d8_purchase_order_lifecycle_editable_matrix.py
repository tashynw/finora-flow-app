"""A purchase order with a life of its own, and an approval matrix people can edit.

Three changes, all of them in service of taking configuration out of migrations
and putting it in front of an administrator.

**`approval_rules` gains a history.** Until now a rule was a row with an
`is_active` flag, which was enough while the only thing that ever wrote one was a
migration. Once a person can change them, editing a rule in place would destroy
the only record of what the matrix said when an approval was given: a route
recorded last quarter would name levels that no rule now readable would produce.
So a rule is never edited and never deleted. A change retires the old row —
stamping when and by whom — and writes a new one pointing back at it through
`supersedes_id`. The check constraint tying `is_active` to `retired_at` keeps the
two from disagreeing, because a rule that is inactive for some other reason is a
rule nobody can account for.

**`purchase_orders` grows from a stub into a record.** It was created last phase
as somewhere for an invoice to point, with the requisition workflow deferred; the
columns reflected that, being the four facts the invoice controls needed and
nothing about how the order came to exist. It now has the same shape as an
estimate — who raised it, what it is for, which cost centre it belongs to, when
it was committed and by whom, when it closed and why — and the same rule that
anything past draft is complete.

Its private `purchase_order_state` type goes with the stub, and the column joins
`workflow_state` alongside estimates and invoices. That is not tidying. An order
on the shared machine gets the declared transitions, the shared history table and
the same timeline on screen; a private enumeration would have needed its own of
each, and a second state vocabulary is a thing every later reader has to learn.

`open` and `closed` survive as words rather than as states, which is where they
belong. Both map to `approved` — the order has been agreed to — and the fact that
separates them, whether it is still taking invoices, becomes `closed_at`. That is
strictly more information than a state could hold: a closing now records when it
happened, who did it and why, so an order that ran out and an order somebody shut
early stop being indistinguishable.

**`purchase_order_thresholds` moves a control out of the environment.** The JMD
50,000 figure above which an invoice must name a purchase order was a setting,
which is to say it could only be changed by a deployment. It is a policy decision
belonging to the people who set the approval bands, so it now sits beside them,
one row per currency and no conversion between them.

Revision ID: b41c7a29e5d8
Revises: 0eefd20b0934
Create Date: 2026-08-06 09:14:02.117430
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b41c7a29e5d8"
down_revision: str | None = "0eefd20b0934"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


#: How the retired states read on the shared machine. Both live states become
#: `approved`, because both describe an order somebody agreed to; what separated
#: them moves to `closed_at`.
_STATE_MAPPING = (
    ("open", "approved"),
    ("closed", "approved"),
    ("cancelled", "cancelled"),
)

#: Every purchase order gets its number from here, so no two can share one. The
#: supplier quotes it back on their invoice and it is how their invoice is matched
#: to the commitment, which a duplicate would make ambiguous.
_NUMBER_SEQUENCE = "purchase_order_number_seq"

#: Orders route through the same bands as the spend they commit. Different bands
#: would mean the commitment and the payment were scrutinised by different people,
#: and the gap between them is where an unapproved commitment would live.
_DEFAULT_MATRIX = (
    # (step, level, minimum in minor units, plain-language name)
    (1, "unit_head", 0, "Unit Head, all purchase orders"),
    (2, "manager", 5_000_000, "Manager, JMD 50,000 and above"),
    (3, "hod", 50_000_000, "Head of Department, JMD 500,000 and above"),
    (4, "coo", 500_000_000, "Chief Operating Officer, JMD 5,000,000 and above"),
)

#: The figure the platform has enforced from configuration since Phase 5, seeded so
#: that the control does not change the day it becomes editable.
_DEFAULT_THRESHOLD_MINOR_UNITS = 5_000_000


def upgrade() -> None:
    _extend_approval_rules()
    _extend_purchase_orders()
    _convert_order_state()
    _constrain_purchase_orders()
    _create_thresholds()

    op.execute(f"CREATE SEQUENCE IF NOT EXISTS {_NUMBER_SEQUENCE} AS BIGINT START WITH 1")

    _seed_order_matrix()
    _seed_threshold()


def downgrade() -> None:
    op.drop_table("purchase_order_thresholds")
    op.execute(f"DROP SEQUENCE IF EXISTS {_NUMBER_SEQUENCE}")
    op.execute("DELETE FROM approval_rules WHERE record_type = 'purchase_order'")

    _unconstrain_purchase_orders()
    _revert_order_state()
    _revert_purchase_orders()
    _revert_approval_rules()


# ------------------------------------------------------------------ order states


def _convert_order_state() -> None:
    """Move the column onto the shared machine, keeping what the old states meant."""
    # Recorded before the states that carried it are gone. `updated_at` is the
    # nearest thing to a closing date these rows have, and it is honest: it is
    # when the row last changed, which for a closed order is when it was closed.
    op.execute(
        "UPDATE purchase_orders SET closed_at = updated_at, closed_by_id = raised_by_id "
        "WHERE state::text = 'closed'"
    )

    mapping = " ".join(f"WHEN '{before}' THEN '{after}'" for before, after in _STATE_MAPPING)
    op.execute("ALTER TABLE purchase_orders ALTER COLUMN state DROP DEFAULT")
    op.execute(
        "ALTER TABLE purchase_orders ALTER COLUMN state TYPE workflow_state "
        f"USING (CASE state::text {mapping} ELSE state::text END)::workflow_state"
    )
    op.execute("ALTER TABLE purchase_orders ALTER COLUMN state SET DEFAULT 'draft'")
    op.execute("DROP TYPE purchase_order_state")


def _revert_order_state() -> None:
    postgresql.ENUM("open", "closed", "cancelled", name="purchase_order_state").create(
        op.get_bind()
    )
    # Everything the narrow type cannot express becomes cancelled rather than
    # open. An order still being drafted or approved is not one a supplier may
    # bill against, and going back to a schema with nowhere to say that must not
    # turn an uncommitted order into a live one.
    op.execute(
        "UPDATE purchase_orders SET state = 'cancelled' "
        "WHERE state IN ('draft', 'pending_approval', 'rejected')"
    )
    op.execute("ALTER TABLE purchase_orders ALTER COLUMN state DROP DEFAULT")
    op.execute(
        "ALTER TABLE purchase_orders ALTER COLUMN state TYPE purchase_order_state "
        "USING (CASE WHEN state::text = 'approved' AND closed_at IS NOT NULL THEN 'closed' "
        "WHEN state::text = 'approved' THEN 'open' ELSE state::text END)::purchase_order_state"
    )
    op.execute("ALTER TABLE purchase_orders ALTER COLUMN state SET DEFAULT 'open'")


# --------------------------------------------------------------- approval rules


def _extend_approval_rules() -> None:
    op.add_column("approval_rules", sa.Column("retired_at", sa.DateTime(timezone=True)))
    op.add_column("approval_rules", sa.Column("retired_by_id", postgresql.UUID(as_uuid=True)))
    op.add_column("approval_rules", sa.Column("supersedes_id", postgresql.UUID(as_uuid=True)))
    op.add_column("approval_rules", sa.Column("created_by_id", postgresql.UUID(as_uuid=True)))

    op.create_foreign_key(
        "fk_approval_rules_retired_by",
        "approval_rules",
        "users",
        ["retired_by_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_approval_rules_created_by",
        "approval_rules",
        "users",
        ["created_by_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_approval_rules_supersedes",
        "approval_rules",
        "approval_rules",
        ["supersedes_id"],
        ["id"],
        ondelete="RESTRICT",
    )

    # Any rule already switched off predates retirement being recorded, so it has
    # no actor to name. Reactivated rather than back-dated to an invented one: the
    # seeded matrix has none switched off, so this touches nothing in practice and
    # would rather be visibly wrong than quietly fictional if it ever did.
    op.execute("UPDATE approval_rules SET is_active = TRUE WHERE is_active = FALSE")

    op.create_check_constraint(
        "retirement_names_its_actor",
        "approval_rules",
        "(retired_at IS NULL) = (retired_by_id IS NULL)",
    )
    op.create_check_constraint(
        "retired_rules_are_inactive",
        "approval_rules",
        "is_active = (retired_at IS NULL)",
    )


def _revert_approval_rules() -> None:
    op.drop_constraint("retired_rules_are_inactive", "approval_rules", type_="check")
    op.drop_constraint("retirement_names_its_actor", "approval_rules", type_="check")
    op.drop_constraint("fk_approval_rules_supersedes", "approval_rules", type_="foreignkey")
    op.drop_constraint("fk_approval_rules_created_by", "approval_rules", type_="foreignkey")
    op.drop_constraint("fk_approval_rules_retired_by", "approval_rules", type_="foreignkey")
    op.drop_column("approval_rules", "created_by_id")
    op.drop_column("approval_rules", "supersedes_id")
    op.drop_column("approval_rules", "retired_by_id")
    op.drop_column("approval_rules", "retired_at")


# -------------------------------------------------------------- purchase orders


def _extend_purchase_orders() -> None:
    op.add_column("purchase_orders", sa.Column("raised_by_id", postgresql.UUID(as_uuid=True)))
    op.add_column("purchase_orders", sa.Column("cost_centre_id", postgresql.UUID(as_uuid=True)))
    op.add_column("purchase_orders", sa.Column("gl_account_id", postgresql.UUID(as_uuid=True)))
    op.add_column("purchase_orders", sa.Column("department", sa.String(length=200)))
    op.add_column("purchase_orders", sa.Column("submitted_at", sa.DateTime(timezone=True)))
    op.add_column("purchase_orders", sa.Column("submitted_by_id", postgresql.UUID(as_uuid=True)))
    op.add_column("purchase_orders", sa.Column("opened_at", sa.DateTime(timezone=True)))
    op.add_column("purchase_orders", sa.Column("closed_at", sa.DateTime(timezone=True)))
    op.add_column("purchase_orders", sa.Column("closed_by_id", postgresql.UUID(as_uuid=True)))
    op.add_column("purchase_orders", sa.Column("closed_reason", sa.Text()))

    # Orders that existed before anyone recorded who raised them. They came from
    # the development seed or from a fixture, and the column is mandatory from
    # here on, so they are attributed to the earliest account on the system. The
    # migration fails loudly if there are orders and no accounts, which is the
    # right outcome: inventing an author for a financial commitment is worse than
    # refusing to migrate.
    op.execute(
        "UPDATE purchase_orders SET raised_by_id = "
        "(SELECT id FROM users ORDER BY created_at, id LIMIT 1) "
        "WHERE raised_by_id IS NULL"
    )
    # Everything already in the table was live, and a live order is by definition
    # past draft, so the completeness constraint below applies to it. Submission
    # is stamped from the row's own creation rather than now, so the register does
    # not show a batch of orders all committed the moment this ran.
    op.execute(
        "UPDATE purchase_orders SET submitted_at = created_at, submitted_by_id = raised_by_id, "
        "opened_at = created_at WHERE submitted_at IS NULL"
    )
    # Cost centre is new and mandatory on anything committed, and these rows
    # predate it being asked for. Attributed to the first cost centre rather than
    # left null, which the completeness rule would refuse. Wrong in the sense that
    # nobody chose it, and visibly so on the order, which is better than a
    # migration that cannot run.
    op.execute(
        "UPDATE purchase_orders SET cost_centre_id = "
        "(SELECT id FROM cost_centres ORDER BY code, id LIMIT 1) "
        "WHERE cost_centre_id IS NULL"
    )
    op.alter_column("purchase_orders", "raised_by_id", nullable=False)

    op.create_foreign_key(
        "fk_purchase_orders_raised_by",
        "purchase_orders",
        "users",
        ["raised_by_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_purchase_orders_submitted_by",
        "purchase_orders",
        "users",
        ["submitted_by_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_purchase_orders_closed_by",
        "purchase_orders",
        "users",
        ["closed_by_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_purchase_orders_cost_centre",
        "purchase_orders",
        "cost_centres",
        ["cost_centre_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_purchase_orders_gl_account",
        "purchase_orders",
        "gl_accounts",
        ["gl_account_id"],
        ["id"],
        ondelete="RESTRICT",
    )

    # A draft is written before its details are known, so the three columns that
    # made an order an order are now optional — and reinstated by the completeness
    # constraint the moment it leaves draft.
    op.alter_column("purchase_orders", "vendor_id", nullable=True)
    op.alter_column("purchase_orders", "currency", nullable=True)
    op.alter_column("purchase_orders", "total_minor_units", nullable=True)


def _constrain_purchase_orders() -> None:
    """The rules that mention a state, applied once the states are the new ones."""
    op.drop_constraint("total_is_positive", "purchase_orders", type_="check")
    op.create_check_constraint(
        "total_is_positive",
        "purchase_orders",
        "total_minor_units IS NULL OR total_minor_units > 0",
    )
    op.create_check_constraint(
        "total_states_its_currency",
        "purchase_orders",
        "total_minor_units IS NULL OR currency IS NOT NULL",
    )
    op.create_check_constraint(
        "submission_names_its_actor",
        "purchase_orders",
        "(submitted_at IS NULL) = (submitted_by_id IS NULL)",
    )
    op.create_check_constraint(
        "closing_names_its_actor",
        "purchase_orders",
        "(closed_at IS NULL) = (closed_by_id IS NULL)",
    )
    op.create_check_constraint(
        "only_a_live_order_closes",
        "purchase_orders",
        "closed_at IS NULL OR state = 'approved'",
    )
    op.create_check_constraint(
        "committed_order_is_complete",
        "purchase_orders",
        "state = 'draft' OR ("
        "vendor_id IS NOT NULL AND description <> '' "
        "AND total_minor_units IS NOT NULL AND cost_centre_id IS NOT NULL "
        "AND submitted_at IS NOT NULL)",
    )
    op.create_check_constraint(
        "state_is_valid_for_purchase_order",
        "purchase_orders",
        "state IN ('approved', 'cancelled', 'draft', 'pending_approval', 'rejected')",
    )
    op.create_index("ix_purchase_orders_queue", "purchase_orders", ["state", "created_at"])


def _unconstrain_purchase_orders() -> None:
    """Lift the state-dependent rules so the column can go back to the old type."""
    op.drop_index("ix_purchase_orders_queue", table_name="purchase_orders")
    for constraint in (
        "state_is_valid_for_purchase_order",
        "committed_order_is_complete",
        "only_a_live_order_closes",
        "closing_names_its_actor",
        "submission_names_its_actor",
        "total_states_its_currency",
        "total_is_positive",
    ):
        op.drop_constraint(constraint, "purchase_orders", type_="check")
    op.create_check_constraint("total_is_positive", "purchase_orders", "total_minor_units > 0")


def _revert_purchase_orders() -> None:
    for constraint in (
        "fk_purchase_orders_gl_account",
        "fk_purchase_orders_cost_centre",
        "fk_purchase_orders_closed_by",
        "fk_purchase_orders_submitted_by",
        "fk_purchase_orders_raised_by",
    ):
        op.drop_constraint(constraint, "purchase_orders", type_="foreignkey")

    for column in (
        "closed_reason",
        "closed_by_id",
        "closed_at",
        "opened_at",
        "submitted_by_id",
        "submitted_at",
        "department",
        "gl_account_id",
        "cost_centre_id",
        "raised_by_id",
    ):
        op.drop_column("purchase_orders", column)

    # The old schema had no draft, so an order with no supplier or no figure has
    # nowhere to be in it. Removed rather than filled in with invented values.
    # Nothing can have been billed against one — an invoice may only name a live
    # order — and if something has, the foreign key refuses the delete and the
    # downgrade stops, which is the right way for that surprise to surface.
    op.execute(
        "DELETE FROM purchase_orders WHERE vendor_id IS NULL OR currency IS NULL "
        "OR total_minor_units IS NULL"
    )
    op.alter_column("purchase_orders", "vendor_id", nullable=False)
    op.alter_column("purchase_orders", "currency", nullable=False)
    op.alter_column("purchase_orders", "total_minor_units", nullable=False)


# ------------------------------------------------------------------- thresholds


def _create_thresholds() -> None:
    op.create_table(
        "purchase_order_thresholds",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("currency", sa.CHAR(length=3), nullable=False, unique=True),
        sa.Column("applies_above_minor_units", sa.BigInteger(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
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
        sa.CheckConstraint("applies_above_minor_units >= 0", name="threshold_not_negative"),
    )


# ------------------------------------------------------------------------ seeds


def _seed_order_matrix() -> None:
    """Give purchase orders their own bands, unless somebody already has.

    Guarded on the record type rather than on emptiness so that re-running this
    against a database whose matrix has since been edited leaves the edits alone.
    """
    bind = op.get_bind()
    already = bind.execute(
        sa.text("SELECT COUNT(*) FROM approval_rules WHERE record_type = 'purchase_order'")
    ).scalar_one()
    if already:
        return

    bind.execute(
        sa.text(
            "INSERT INTO approval_rules (id, name, record_type, level, "
            "min_amount_minor_units, max_amount_minor_units, currency, step_order, "
            "is_parallel, department, is_active, version) "
            "VALUES (:id, :name, 'purchase_order', :level, :minimum, NULL, 'JMD', "
            ":step, FALSE, NULL, TRUE, 1)"
        ),
        [
            {
                "id": uuid.uuid4(),
                "name": name,
                "level": level,
                "minimum": minimum,
                "step": step,
            }
            for step, level, minimum, name in _DEFAULT_MATRIX
        ],
    )


def _seed_threshold() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "INSERT INTO purchase_order_thresholds "
            "(id, currency, applies_above_minor_units, is_active) "
            "VALUES (:id, 'JMD', :above, TRUE) ON CONFLICT (currency) DO NOTHING"
        ),
        {"id": uuid.uuid4(), "above": _DEFAULT_THRESHOLD_MINOR_UNITS},
    )
