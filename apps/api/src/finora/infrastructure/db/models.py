"""ORM models.

Constraints live in the database, not only in application code, so a defect or
a direct connection cannot write a state the business rules forbid.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    CHAR,
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import (
    ENUM as PgEnum,  # noqa: N811  dialect type, not a constant
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import (
    UUID as PgUUID,  # noqa: N811  dialect type, not a constant
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from finora.domain.accruals import CandidateStanding
from finora.domain.approvals import RouteState, StepState
from finora.domain.audit import ActorType, AuditAction
from finora.domain.credit_cards import SuggestionDisposition
from finora.domain.estimates import ESTIMATE_STATES
from finora.domain.extraction import (
    DocumentKind,
    ExtractionStatus,
    FieldName,
    FieldOrigin,
    FieldReview,
)
from finora.domain.intake import IntakeSource, IntakeStatus, ScanVerdict
from finora.domain.invoices import INVOICE_STATES
from finora.domain.mail_correlation import AutomaticKind, CorrelationBasis
from finora.domain.notifications import MessageKind, OutboxState
from finora.domain.payment_packages import PaymentMethod
from finora.domain.purchase_orders import PURCHASE_ORDER_STATES
from finora.domain.reminders import ReminderPurpose
from finora.domain.roles import ApprovalLevel, Permission, Role
from finora.domain.text_layout import TextSource
from finora.domain.vendor_confirmation import ClaimChannel, ClaimOutcome, ReviewOutcome
from finora.domain.workflow import TransitionSource, WorkflowState
from finora.infrastructure.db.base import (
    Base,
    Sha256Hex,
    SoftDeleteMixin,
    TimestampMixin,
    UuidPrimaryKey,
    VersionMixin,
)

# Enums are created once and reused, so Alembic does not attempt to recreate a
# type that already exists.
workflow_state_enum = PgEnum(
    WorkflowState,
    name="workflow_state",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
transition_source_enum = PgEnum(
    TransitionSource,
    name="transition_source",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
role_enum = PgEnum(
    Role, name="role", create_type=True, values_callable=lambda e: [m.value for m in e]
)
permission_enum = PgEnum(
    Permission,
    name="permission",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
approval_level_enum = PgEnum(
    ApprovalLevel,
    name="approval_level",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
audit_action_enum = PgEnum(
    AuditAction,
    name="audit_action",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
actor_type_enum = PgEnum(
    ActorType,
    name="actor_type",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
intake_source_enum = PgEnum(
    IntakeSource,
    name="intake_source",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
intake_status_enum = PgEnum(
    IntakeStatus,
    name="intake_status",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
document_kind_enum = PgEnum(
    DocumentKind,
    name="document_kind",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
extraction_status_enum = PgEnum(
    ExtractionStatus,
    name="extraction_status",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
text_source_enum = PgEnum(
    TextSource,
    name="text_source",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
field_name_enum = PgEnum(
    FieldName,
    name="extraction_field_name",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
field_origin_enum = PgEnum(
    FieldOrigin,
    name="extraction_field_origin",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
field_review_enum = PgEnum(
    FieldReview,
    name="extraction_field_review",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
scan_verdict_enum = PgEnum(
    ScanVerdict,
    name="scan_verdict",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
route_state_enum = PgEnum(
    RouteState,
    name="approval_route_state",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
step_state_enum = PgEnum(
    StepState,
    name="approval_step_state",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
reminder_purpose_enum = PgEnum(
    ReminderPurpose,
    name="reminder_purpose",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
message_kind_enum = PgEnum(
    MessageKind,
    name="message_kind",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
payment_method_enum = PgEnum(
    PaymentMethod,
    name="payment_method",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
outbox_state_enum = PgEnum(
    OutboxState,
    name="outbox_state",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
claim_outcome_enum = PgEnum(
    ClaimOutcome,
    name="vendor_claim_outcome",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
claim_channel_enum = PgEnum(
    ClaimChannel,
    name="vendor_claim_channel",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
review_outcome_enum = PgEnum(
    ReviewOutcome,
    name="vendor_review_outcome",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
correlation_basis_enum = PgEnum(
    CorrelationBasis,
    name="mail_correlation_basis",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
automatic_kind_enum = PgEnum(
    AutomaticKind,
    name="automatic_mail_kind",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
suggestion_disposition_enum = PgEnum(
    SuggestionDisposition,
    name="suggestion_disposition",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)
candidate_standing_enum = PgEnum(
    CandidateStanding,
    name="accrual_candidate_standing",
    create_type=True,
    values_callable=lambda e: [m.value for m in e],
)

#: SQL fragment listing the workflow states an estimate may hold, for the check
#: constraint below. Built from the domain set so adding a state there cannot
#: leave the database permitting one the business rules do not.
_ESTIMATE_STATES_SQL = ", ".join(
    f"'{state.value}'" for state in sorted(ESTIMATE_STATES, key=lambda s: s.value)
)

#: The same, for invoices, which may hold any state in the machine.
_INVOICE_STATES_SQL = ", ".join(
    f"'{state.value}'" for state in sorted(INVOICE_STATES, key=lambda s: s.value)
)

#: And for purchase orders, which hold a narrow slice of it: a commitment is
#: never signed off for receipt, submitted for payment or accrued.
_PURCHASE_ORDER_STATES_SQL = ", ".join(
    f"'{state.value}'" for state in sorted(PURCHASE_ORDER_STATES, key=lambda s: s.value)
)


# --------------------------------------------------------------------- identity


class User(Base, UuidPrimaryKey, TimestampMixin, SoftDeleteMixin):
    __tablename__ = "users"

    # Stable identifier from the OIDC provider. Email can change; `subject`
    # cannot, so authorization is keyed on it.
    subject: Mapped[str | None] = mapped_column(String(255), unique=True, index=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False, index=True)
    display_name: Mapped[str] = mapped_column(String(200), nullable=False)
    department: Mapped[str | None] = mapped_column(String(200))
    job_title: Mapped[str | None] = mapped_column(String(200))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    last_sign_in_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Out-of-office reassignment for approvals.
    out_of_office_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    delegate_to_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )

    # `user_roles` references `users` twice (the holder and the granter), so the
    # join column has to be named explicitly.
    role_assignments: Mapped[list[UserRole]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
        lazy="selectin",
        foreign_keys="UserRole.user_id",
    )

    __table_args__ = (
        CheckConstraint(
            "delegate_to_id IS NULL OR delegate_to_id <> id",
            name="no_self_delegation",
        ),
    )

    @property
    def roles(self) -> frozenset[Role]:
        return frozenset(a.role for a in self.role_assignments)


class UserRole(Base, UuidPrimaryKey, TimestampMixin):
    __tablename__ = "user_roles"

    user_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[Role] = mapped_column(role_enum, nullable=False)
    granted_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )
    granted_reason: Mapped[str | None] = mapped_column(String(500))

    user: Mapped[User] = relationship(back_populates="role_assignments", foreign_keys=[user_id])

    __table_args__ = (UniqueConstraint("user_id", "role", name="uq_user_roles_user_id_role"),)


# ------------------------------------------------------------------------ audit


class AuditEntryRow(Base, UuidPrimaryKey):
    """Append-only hash-chained audit trail.

    There is deliberately no update or delete path in the application. The
    `sequence` column is unique and gapless, so a removed row is detectable
    even before hash verification runs.
    """

    __tablename__ = "audit_entries"

    sequence: Mapped[int] = mapped_column(BigInteger, unique=True, nullable=False, index=True)
    previous_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    entry_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)

    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    action: Mapped[AuditAction] = mapped_column(audit_action_enum, nullable=False, index=True)
    actor_type: Mapped[ActorType] = mapped_column(actor_type_enum, nullable=False)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True), index=True)
    actor_label: Mapped[str] = mapped_column(String(300), nullable=False)

    subject_type: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    subject_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True), index=True)
    correlation_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True), index=True)

    detail: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)

    # Request context, useful when investigating a compromise.
    source_ip: Mapped[str | None] = mapped_column(String(45))
    user_agent: Mapped[str | None] = mapped_column(String(500))

    __table_args__ = (
        Index("ix_audit_entries_subject", "subject_type", "subject_id"),
        CheckConstraint("sequence > 0", name="sequence_positive"),
    )


class StateTransitionRow(Base, UuidPrimaryKey):
    """Every workflow state change, with full provenance."""

    __tablename__ = "state_transitions"

    record_type: Mapped[str] = mapped_column(String(80), nullable=False)
    record_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False, index=True)

    from_state: Mapped[WorkflowState] = mapped_column(workflow_state_enum, nullable=False)
    to_state: Mapped[WorkflowState] = mapped_column(workflow_state_enum, nullable=False)
    source: Mapped[TransitionSource] = mapped_column(transition_source_enum, nullable=False)

    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )
    actor_label: Mapped[str] = mapped_column(String(300), nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)
    correlation_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    context: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)

    __table_args__ = (
        Index("ix_state_transitions_record", "record_type", "record_id", "occurred_at"),
        CheckConstraint("from_state <> to_state", name="state_actually_changed"),
    )


class RecordActionRow(Base, UuidPrimaryKey):
    """Which permissions a user has already exercised on a specific record.

    Segregation of duties needs this: holding both the requester and approver
    roles is legitimate, but using both on one invoice is not.
    """

    __tablename__ = "record_actions"

    record_type: Mapped[str] = mapped_column(String(80), nullable=False)
    record_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    permission: Mapped[Permission] = mapped_column(permission_enum, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint(
            "record_type",
            "record_id",
            "user_id",
            "permission",
            name="uq_record_actions_unique_action",
        ),
        Index("ix_record_actions_lookup", "record_type", "record_id", "user_id"),
    )


# -------------------------------------------------------------- reference data


class Vendor(Base, UuidPrimaryKey, TimestampMixin, VersionMixin, SoftDeleteMixin):
    __tablename__ = "vendors"

    code: Mapped[str] = mapped_column(String(50), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(300), nullable=False, index=True)
    email: Mapped[str | None] = mapped_column(String(320))
    phone: Mapped[str | None] = mapped_column(String(50))
    tax_registration_number: Mapped[str | None] = mapped_column(String(100))
    default_currency: Mapped[str] = mapped_column(String(3), default="JMD", nullable=False)
    payment_terms_days: Mapped[int | None] = mapped_column(Integer)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # Bank details are the authority for payment, never the invoice document.
    # A change here requires its own approval, tracked via audit.
    bank_name: Mapped[str | None] = mapped_column(String(200))
    bank_account_masked: Mapped[str | None] = mapped_column(String(50))
    bank_details_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class GlAccount(Base, UuidPrimaryKey, TimestampMixin, SoftDeleteMixin):
    __tablename__ = "gl_accounts"

    code: Mapped[str] = mapped_column(String(50), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(300), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class CostCentre(Base, UuidPrimaryKey, TimestampMixin, SoftDeleteMixin):
    __tablename__ = "cost_centres"

    code: Mapped[str] = mapped_column(String(50), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(300), nullable=False)
    department: Mapped[str | None] = mapped_column(String(200))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


# ------------------------------------------------------------- approval matrix


class ApprovalRule(Base, UuidPrimaryKey, TimestampMixin, VersionMixin):
    """Configurable approval matrix.

    Amount bands are data rather than constants because the authoritative
    requirements document that defines them is not yet available.
    """

    __tablename__ = "approval_rules"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    record_type: Mapped[str] = mapped_column(String(80), nullable=False)
    level: Mapped[ApprovalLevel] = mapped_column(approval_level_enum, nullable=False)

    min_amount_minor_units: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    max_amount_minor_units: Mapped[int | None] = mapped_column(BigInteger)
    currency: Mapped[str] = mapped_column(String(3), default="JMD", nullable=False)

    # Sequential steps share nothing; parallel steps share a step_order.
    step_order: Mapped[int] = mapped_column(Integer, nullable=False)
    is_parallel: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    department: Mapped[str | None] = mapped_column(String(200))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    #: A rule is never edited and never deleted. Changing what a rule does retires
    #: it and writes a new one pointing back at it, so an approval given last
    #: quarter can still be explained against the matrix that was in force when it
    #: was given. Editing in place would leave the route recorded on an old
    #: request unexplainable by anything now readable.
    retired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    retired_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )
    supersedes_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("approval_rules.id", ondelete="RESTRICT")
    )
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )

    __table_args__ = (
        CheckConstraint(
            "max_amount_minor_units IS NULL OR max_amount_minor_units >= min_amount_minor_units",
            name="band_is_ordered",
        ),
        CheckConstraint(
            "(retired_at IS NULL) = (retired_by_id IS NULL)", name="retirement_names_its_actor"
        ),
        CheckConstraint("is_active = (retired_at IS NULL)", name="retired_rules_are_inactive"),
        CheckConstraint("min_amount_minor_units >= 0", name="band_not_negative"),
        CheckConstraint("step_order > 0", name="step_order_positive"),
        Index("ix_approval_rules_lookup", "record_type", "is_active", "step_order"),
    )


class ApprovalAssignment(Base, UuidPrimaryKey, TimestampMixin):
    """Which users satisfy a given approval level, optionally per department."""

    __tablename__ = "approval_assignments"

    level: Mapped[ApprovalLevel] = mapped_column(approval_level_enum, nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    department: Mapped[str | None] = mapped_column(String(200))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    __table_args__ = (
        UniqueConstraint("level", "user_id", "department", name="uq_approval_assignments_unique"),
    )


# ----------------------------------------------------------------- system state


class SystemSetting(Base, UuidPrimaryKey, TimestampMixin, VersionMixin):
    """Runtime-adjustable configuration, such as the AI kill switch.

    Secrets never live here; they come from the secret store. Values are
    audited on change.
    """

    __tablename__ = "system_settings"

    key: Mapped[str] = mapped_column(String(120), unique=True, nullable=False, index=True)
    value: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    description: Mapped[str | None] = mapped_column(String(500))
    updated_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )
    change_reason: Mapped[str | None] = mapped_column(String(500))


class BusinessCalendarDay(Base, UuidPrimaryKey, TimestampMixin):
    """Non-working days, so the three-hour reminder clock does not run through
    a public holiday."""

    __tablename__ = "business_calendar_days"

    # A calendar day, not an instant. The column has always been `Date`; the
    # annotation said `datetime`, which would have had the first code to read it
    # comparing a `date` from the driver against a `datetime` it was promised.
    calendar_date: Mapped[date] = mapped_column(Date, unique=True, nullable=False)
    description: Mapped[str] = mapped_column(String(200), nullable=False)
    is_working_day: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


# ------------------------------------------------------------------------ intake


class MailboxCheckpointRow(Base, UuidPrimaryKey, TimestampMixin):
    """Where the IMAP worker has reached in one folder.

    `uid_validity` is stored alongside `last_seen_uid` because a UID means
    nothing without it. When the server reports a different UIDVALIDITY, the
    stored UID refers to a different message and the checkpoint must be reset
    rather than resumed.
    """

    __tablename__ = "mailbox_checkpoints"

    folder: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    uid_validity: Mapped[int] = mapped_column(BigInteger, nullable=False)
    last_seen_uid: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    last_polled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_reset_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_reset_reason: Mapped[str | None] = mapped_column(String(60))

    __table_args__ = (
        CheckConstraint("last_seen_uid >= 0", name="uid_not_negative"),
        CheckConstraint("uid_validity > 0", name="uid_validity_positive"),
    )


class InboundMessage(Base, UuidPrimaryKey, TimestampMixin, VersionMixin):
    """One message that entered the platform, by mailbox or by upload.

    The derived header fields are a convenience for the workspace. The raw object
    in storage is the evidence, and `raw_sha256` ties this row to it, so a
    disagreement between the two is detectable.
    """

    __tablename__ = "inbound_messages"

    source: Mapped[IntakeSource] = mapped_column(intake_source_enum, nullable=False)
    status: Mapped[IntakeStatus] = mapped_column(
        intake_status_enum, nullable=False, default=IntakeStatus.received, index=True
    )

    # Duplicate detection. Unique, so a concurrent second delivery of the same
    # message is refused by the database rather than by a racing check.
    idempotency_key: Mapped[str] = mapped_column(
        String(255), unique=True, nullable=False, index=True
    )
    raw_sha256: Mapped[Sha256Hex] = mapped_column(nullable=False, index=True)
    raw_object_key: Mapped[str] = mapped_column(String(500), nullable=False)
    raw_size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)

    # Mailbox provenance, absent for a manual upload.
    imap_folder: Mapped[str | None] = mapped_column(String(255))
    imap_uid: Mapped[int | None] = mapped_column(BigInteger)
    imap_uid_validity: Mapped[int | None] = mapped_column(BigInteger)

    uploaded_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )

    message_id: Mapped[str | None] = mapped_column(String(500), index=True)
    subject: Mapped[str] = mapped_column(String(1000), nullable=False, default="")
    from_address: Mapped[str | None] = mapped_column(String(320), index=True)
    from_display_name: Mapped[str | None] = mapped_column(String(320))
    # A Reply-To that disagrees with From is a payment-redirection signal, so it
    # is stored separately rather than collapsed into the sender.
    reply_to_address: Mapped[str | None] = mapped_column(String(320))
    to_addresses: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    cc_addresses: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    #: `Delivered-To` and `X-Original-To`, which are where a sub-addressed
    #: recipient survives when a relay has rewritten `To`. Kept apart from
    #: `to_addresses` because they mean something different: this is where the
    #: message was actually delivered, not where the sender addressed it.
    delivered_to_addresses: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    forwarded_from_address: Mapped[str | None] = mapped_column(String(320))
    forwarded_shape: Mapped[str | None] = mapped_column(String(40))

    # Threading headers, kept so a reply can be tied back to the message it
    # answers. Stored raw rather than resolved, because the resolution is a
    # judgement the correlation rules make and this is the evidence it made it
    # from.
    in_reply_to: Mapped[str | None] = mapped_column(String(500), index=True)
    references: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)

    # What this turned out to be a reply to, once correlation ran. Generic on
    # purpose: the first use is a vendor payment check-in, and nothing about the
    # matching is specific to that.
    correlated_record_type: Mapped[str | None] = mapped_column(String(50))
    correlated_record_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    #: Which of the four rules matched, so a reviewer can weigh a surprising
    #: reply by how firmly it was tied to the conversation.
    correlation_basis: Mapped[CorrelationBasis | None] = mapped_column(correlation_basis_enum)

    #: Set when a machine rather than a person sent this. Such a message is filed
    #: and shown, and never read as anybody saying anything.
    automatic_kind: Mapped[AutomaticKind | None] = mapped_column(automatic_kind_enum, index=True)

    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )

    body_text: Mapped[str] = mapped_column(Text, nullable=False, default="")

    # Parse warnings and refusal reasons, so a partially understood message is
    # visibly partial in the workspace.
    parse_warnings: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    failure_reason: Mapped[str | None] = mapped_column(String(1000))

    attachments: Mapped[list[MessageAttachment]] = relationship(
        back_populates="message",
        cascade="all, delete-orphan",
        lazy="selectin",
        order_by="MessageAttachment.position",
    )

    __table_args__ = (
        Index("ix_inbound_messages_triage", "status", "received_at"),
        Index(
            "ix_inbound_messages_correlated",
            "correlated_record_type",
            "correlated_record_id",
            "received_at",
        ),
        CheckConstraint(
            "(correlated_record_type IS NULL) = (correlated_record_id IS NULL)",
            name="correlation_names_a_record",
        ),
        CheckConstraint(
            "(correlated_record_id IS NULL) = (correlation_basis IS NULL)",
            name="correlation_says_how_it_matched",
        ),
        CheckConstraint("raw_size_bytes > 0", name="raw_size_positive"),
        CheckConstraint(
            "(source <> 'imap') OR (imap_folder IS NOT NULL AND imap_uid IS NOT NULL)",
            name="imap_provenance_required",
        ),
        CheckConstraint(
            "(source <> 'manual_upload') OR (uploaded_by_id IS NOT NULL)",
            name="upload_attribution_required",
        ),
    )


class MessageAttachment(Base, UuidPrimaryKey, TimestampMixin):
    """One attachment, with its scan verdict.

    `scan_verdict` is nullable only while a scan is in flight. Nothing may be
    opened until it is set, and only `clean` releases the file.
    """

    __tablename__ = "message_attachments"

    message_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("inbound_messages.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    message: Mapped[InboundMessage] = relationship(back_populates="attachments")

    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # Sanitised for display and storage; the sender's version is kept beside it
    # because the original name is itself evidence.
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    original_filename: Mapped[str] = mapped_column(String(500), nullable=False)
    content_type: Mapped[str] = mapped_column(String(160), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[Sha256Hex] = mapped_column(nullable=False, index=True)

    # Null when the attachment was refused before storage.
    object_key: Mapped[str | None] = mapped_column(String(500))
    is_quarantined: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    inline: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    scan_verdict: Mapped[ScanVerdict | None] = mapped_column(scan_verdict_enum, index=True)
    scan_detail: Mapped[str | None] = mapped_column(String(500))
    scan_engine: Mapped[str | None] = mapped_column(String(120))
    scanned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    rejection_reason: Mapped[str | None] = mapped_column(String(60))
    rejection_detail: Mapped[str | None] = mapped_column(String(500))

    __table_args__ = (
        # The same file attached twice to one message is one stored object.
        UniqueConstraint("message_id", "sha256", name="uq_message_attachments_content"),
        CheckConstraint("size_bytes > 0", name="attachment_size_positive"),
        # A file that is stored must have been judged, and a quarantined file
        # must never be recorded as clean.
        CheckConstraint(
            "object_key IS NULL OR scan_verdict IS NOT NULL",
            name="stored_requires_verdict",
        ),
        CheckConstraint(
            "NOT (is_quarantined AND scan_verdict = 'clean')",
            name="quarantine_excludes_clean",
        ),
    )


class Document(Base, UuidPrimaryKey, TimestampMixin, VersionMixin):
    """An attachment that is being read for values.

    Separate from `MessageAttachment` because the two answer different questions.
    An attachment is a fact about a message: this file arrived, it was this size,
    it scanned clean. A document is a thing the business works on: it has a kind,
    it has a reading, it is reviewed and accepted. Only clean, stored, readable
    attachments become documents, which is why `object_key` is not nullable here
    while it is there.
    """

    __tablename__ = "documents"

    attachment_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("message_attachments.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    attachment: Mapped[MessageAttachment] = relationship()

    # Carried alongside the attachment's own link so the review queue can be
    # filtered and sorted without joining through to the message every time.
    message_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("inbound_messages.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(160), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[Sha256Hex] = mapped_column(nullable=False, index=True)
    object_key: Mapped[str] = mapped_column(String(500), nullable=False)

    # Denormalised from the current extraction so the queue is one cheap query.
    # Kept in step by the pipeline, which writes both in the same transaction.
    kind: Mapped[DocumentKind] = mapped_column(
        document_kind_enum, nullable=False, default=DocumentKind.unknown, index=True
    )
    status: Mapped[ExtractionStatus] = mapped_column(
        extraction_status_enum, nullable=False, default=ExtractionStatus.pending, index=True
    )

    extractions: Mapped[list[DocumentExtraction]] = relationship(
        back_populates="document",
        cascade="all, delete-orphan",
        lazy="selectin",
        order_by="DocumentExtraction.attempt",
    )

    __table_args__ = (
        CheckConstraint("size_bytes > 0", name="document_size_positive"),
        Index("ix_documents_review_queue", "status", "created_at"),
    )


class DocumentExtraction(Base, UuidPrimaryKey, TimestampMixin):
    """One attempt at reading a document.

    Attempts accumulate and are never overwritten, because re-running extraction
    after a model or prompt change must not silently replace what a person already
    accepted. `is_current` names the attempt the workspace shows, and the accepted
    one stays readable underneath it.

    The model and prompt that produced an attempt are recorded on it, including
    the hash of the exact prompt and schema. That is what lets an accepted value
    from six months ago be traced to what proposed it, and what makes a model
    upgrade an auditable event rather than an invisible change in behaviour.
    """

    __tablename__ = "document_extractions"

    document_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    document: Mapped[Document] = relationship(back_populates="extractions")

    attempt: Mapped[int] = mapped_column(Integer, nullable=False)
    is_current: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    status: Mapped[ExtractionStatus] = mapped_column(extraction_status_enum, nullable=False)
    kind: Mapped[DocumentKind] = mapped_column(document_kind_enum, nullable=False)
    kind_confidence: Mapped[float] = mapped_column(nullable=False, default=0.0)
    kind_evidence: Mapped[dict[str, Any] | None] = mapped_column(JSONB)

    text_source: Mapped[TextSource] = mapped_column(text_source_enum, nullable=False)
    page_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # The thresholds in force when this ran. Stored rather than read from current
    # configuration, so lowering a threshold later does not retrospectively
    # reclassify a document as having needed no review, and a confidence shown
    # today as "low" is still shown as low when the screen is reopened next year.
    review_threshold: Mapped[float] = mapped_column(nullable=False)
    low_threshold: Mapped[float] = mapped_column(nullable=False)

    signals: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, default=list)
    notes: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, default=list)
    injection_findings: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, default=list)

    # Signals a reviewer has explicitly seen and answered for, such as bank
    # details on the page having been checked against the vendor master. Only the
    # signal names are here; who acknowledged each one and when is in the audit
    # trail, which is where a question about an acknowledgement belongs anyway.
    acknowledged_signals: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, default=list)

    # Null throughout when no model was involved, which is the normal case for a
    # document every rule could read.
    gateway_outcome: Mapped[str | None] = mapped_column(String(40))
    model_name: Mapped[str | None] = mapped_column(String(160))
    prompt_id: Mapped[str | None] = mapped_column(String(80))
    prompt_version: Mapped[int | None] = mapped_column(Integer)
    prompt_sha256: Mapped[str | None] = mapped_column(String(64))
    model_latency_ms: Mapped[int | None] = mapped_column(Integer)
    suggestions_discarded: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failure_reason: Mapped[str | None] = mapped_column(String(500))

    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    accepted_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )
    accepted_note: Mapped[str | None] = mapped_column(String(1000))

    fields: Mapped[list[ExtractionField]] = relationship(
        back_populates="extraction",
        cascade="all, delete-orphan",
        lazy="selectin",
        order_by="ExtractionField.name",
    )

    __table_args__ = (
        UniqueConstraint("document_id", "attempt", name="uq_document_extractions_attempt"),
        # Exactly one current attempt per document, enforced in the database. A
        # second current row would make the workspace show one reading and the
        # queue count another.
        Index(
            "uq_document_extractions_current",
            "document_id",
            unique=True,
            postgresql_where=text("is_current"),
        ),
        CheckConstraint("attempt > 0", name="attempt_positive"),
        CheckConstraint(
            "kind_confidence >= 0 AND kind_confidence <= 1", name="kind_confidence_is_a_fraction"
        ),
        CheckConstraint(
            "review_threshold > 0 AND review_threshold <= 1",
            name="review_threshold_is_a_fraction",
        ),
        CheckConstraint(
            "low_threshold > 0 AND low_threshold <= review_threshold",
            name="low_threshold_below_review",
        ),
        # Acceptance is an act by a person, so it cannot be recorded without one.
        CheckConstraint(
            "(accepted_at IS NULL) = (accepted_by_id IS NULL)",
            name="acceptance_names_its_actor",
        ),
        # A prompt hash without a model, or the reverse, is a partial record of
        # something that has to be reproducible in full.
        CheckConstraint(
            "(model_name IS NULL) = (prompt_sha256 IS NULL)",
            name="model_provenance_is_complete",
        ),
    )


class ExtractionField(Base, UuidPrimaryKey, TimestampMixin):
    """One field read from a document, and everything needed to defend it.

    A row exists even when the value was not found, because "looked for and not
    present" is a result a reviewer needs to see. `origin` distinguishes that from
    a value nobody has looked for yet.

    When a person changes a value, the reader's original is kept beside it rather
    than replaced. The workspace can then show "the reader found this, a person
    changed it to that", which is the question an approver actually asks. The full
    history of every change is in the hash-chained audit trail; this pair of
    columns exists so the common case does not require reading it.
    """

    __tablename__ = "extraction_fields"

    extraction_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("document_extractions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    extraction: Mapped[DocumentExtraction] = relationship(back_populates="fields")

    name: Mapped[FieldName] = mapped_column(field_name_enum, nullable=False)

    # Verbatim as it appears on the document, or as the person typed it. Empty
    # only when the value is absent.
    text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    origin: Mapped[FieldOrigin] = mapped_column(field_origin_enum, nullable=False)
    confidence: Mapped[float] = mapped_column(nullable=False, default=0.0)
    review: Mapped[FieldReview] = mapped_column(
        field_review_enum, nullable=False, default=FieldReview.unreviewed
    )

    amount_minor_units: Mapped[int | None] = mapped_column(BigInteger)
    currency: Mapped[str | None] = mapped_column(CHAR(3))
    value_date: Mapped[date | None] = mapped_column(Date)

    evidence_page: Mapped[int | None] = mapped_column(Integer)
    evidence_snippet: Mapped[str | None] = mapped_column(Text)
    evidence_boxes: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, default=list)

    adjustments: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, default=list)
    notes: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, default=list)

    # What the reader said, kept when a person overrides it.
    reader_text: Mapped[str | None] = mapped_column(Text)
    reader_confidence: Mapped[float | None] = mapped_column()

    corrected_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )
    corrected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    correction_reason: Mapped[str | None] = mapped_column(String(1000))

    __table_args__ = (
        UniqueConstraint("extraction_id", "name", name="uq_extraction_fields_name"),
        CheckConstraint("confidence >= 0 AND confidence <= 1", name="confidence_is_a_fraction"),
        # An amount with no currency is a number whose scale nothing knows, and
        # the master prompt forbids exactly that.
        CheckConstraint(
            "amount_minor_units IS NULL OR currency IS NOT NULL",
            name="amount_states_its_currency",
        ),
        # A value attributed to a person must name the person and when.
        CheckConstraint(
            "origin <> 'human' OR (corrected_by_id IS NOT NULL AND corrected_at IS NOT NULL)",
            name="human_value_names_its_author",
        ),
        # An absent value has nothing to be confident about.
        CheckConstraint(
            "origin <> 'absent' OR (confidence = 0 AND text = '')",
            name="absent_value_carries_nothing",
        ),
    )


# -------------------------------------------------------------------- estimates


class Estimate(Base, UuidPrimaryKey, TimestampMixin, VersionMixin, SoftDeleteMixin):
    """A vendor quotation somebody wants permission to spend against.

    The first record in the platform that commits the organisation to anything,
    which is why so much of it is nullable while the state is `draft` and so
    little of it may be null afterwards. The check constraints below are the
    domain's completeness rules restated where a defect or a direct connection
    cannot get around them.

    `vendor_name` is stored as text beside the optional `vendor_id`. A quotation
    frequently arrives from a vendor who is not yet on the master, and refusing
    to record the estimate until somebody has created one would stall the work
    the platform exists to speed up. Payment, by contrast, is only ever made to
    a vendor on the master, and that is enforced where payment happens.
    """

    __tablename__ = "estimates"

    #: Human-readable and stable, from a database sequence rather than a count,
    #: so two requesters submitting at once cannot be given the same one.
    reference: Mapped[str] = mapped_column(String(30), unique=True, nullable=False, index=True)

    state: Mapped[WorkflowState] = mapped_column(
        workflow_state_enum, nullable=False, default=WorkflowState.draft, index=True
    )

    requester_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    requester: Mapped[User] = relationship(foreign_keys=[requester_id])

    #: The reading this estimate was raised from, when it came through the review
    #: workspace. Unique, so one accepted document cannot quietly become two
    #: requests for the same spend.
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("documents.id", ondelete="RESTRICT"), unique=True
    )
    document: Mapped[Document | None] = relationship()

    vendor_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("vendors.id", ondelete="RESTRICT")
    )
    vendor: Mapped[Vendor | None] = relationship()
    vendor_name: Mapped[str] = mapped_column(String(300), nullable=False, default="")

    #: The vendor's own number for the quotation, which is how they will refer to
    #: it. Not unique: two vendors may both call theirs "Q-1001".
    estimate_number: Mapped[str | None] = mapped_column(String(120), index=True)
    estimate_date: Mapped[date | None] = mapped_column(Date)
    needed_by: Mapped[date | None] = mapped_column(Date)

    currency: Mapped[str | None] = mapped_column(CHAR(3))
    total_minor_units: Mapped[int | None] = mapped_column(BigInteger)

    description: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    justification: Mapped[str] = mapped_column(Text, nullable=False, default="")

    cost_centre_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("cost_centres.id", ondelete="RESTRICT")
    )
    cost_centre: Mapped[CostCentre | None] = relationship()
    gl_account_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("gl_accounts.id", ondelete="RESTRICT")
    )
    gl_account: Mapped[GlAccount | None] = relationship()

    #: The department the route was planned for, captured at submission. Read
    #: from the requester at that moment rather than joined at display time,
    #: because a requester who moves department later must not change which
    #: approvals an already-approved estimate is recorded as having needed.
    department: Mapped[str | None] = mapped_column(String(200))

    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    submitted_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(f"state IN ({_ESTIMATE_STATES_SQL})", name="state_is_valid_for_estimate"),
        CheckConstraint(
            "total_minor_units IS NULL OR currency IS NOT NULL",
            name="total_states_its_currency",
        ),
        CheckConstraint(
            "total_minor_units IS NULL OR total_minor_units > 0",
            name="total_is_positive",
        ),
        CheckConstraint(
            "(submitted_at IS NULL) = (submitted_by_id IS NULL)",
            name="submission_names_its_actor",
        ),
        # Anything past draft has been through the completeness rules, so the
        # columns an approver decides on cannot be empty. A draft may be as
        # empty as the requester likes.
        CheckConstraint(
            "state = 'draft' OR ("
            "vendor_name <> '' AND description <> '' AND justification <> '' "
            "AND estimate_date IS NOT NULL AND total_minor_units IS NOT NULL "
            "AND cost_centre_id IS NOT NULL AND submitted_at IS NOT NULL)",
            name="submitted_estimate_is_complete",
        ),
        Index("ix_estimates_queue", "state", "created_at"),
        Index("ix_estimates_requester_queue", "requester_id", "state"),
    )


# ------------------------------------------------------- purchase orders


class PurchaseOrder(Base, UuidPrimaryKey, TimestampMixin, VersionMixin, SoftDeleteMixin):
    """A commitment to a supplier, and the ceiling their invoices are measured against.

    The number is generated here rather than typed. A purchase order number is
    quoted back by the supplier and used to match their invoice to this row, so a
    second order carrying the same number makes that match ambiguous. Taking the
    number out of the user's hands removes the only way that happens.

    `closed_at` is separate from `state` on purpose even though a closed order
    also holds `state = closed`. The state says whether more invoices may be
    billed; the timestamp and reason say when somebody decided that and why, and
    a closing that cannot explain itself is indistinguishable from an order that
    ran out.
    """

    __tablename__ = "purchase_orders"

    number: Mapped[str] = mapped_column(String(60), unique=True, nullable=False, index=True)
    state: Mapped[WorkflowState] = mapped_column(
        workflow_state_enum,
        nullable=False,
        default=WorkflowState.draft,
        index=True,
    )

    raised_by_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    raised_by: Mapped[User] = relationship(foreign_keys=[raised_by_id])

    vendor_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("vendors.id", ondelete="RESTRICT")
    )
    vendor: Mapped[Vendor | None] = relationship()

    currency: Mapped[str | None] = mapped_column(CHAR(3))
    total_minor_units: Mapped[int | None] = mapped_column(BigInteger)

    description: Mapped[str] = mapped_column(String(500), nullable=False, default="")

    cost_centre_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("cost_centres.id", ondelete="RESTRICT")
    )
    cost_centre: Mapped[CostCentre | None] = relationship()
    gl_account_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("gl_accounts.id", ondelete="RESTRICT")
    )
    gl_account: Mapped[GlAccount | None] = relationship()

    #: Captured when the order is committed, for the same reason estimates
    #: capture it: whoever raised it may move department afterwards, and that
    #: must not change which approvals the commitment is recorded as needing.
    department: Mapped[str | None] = mapped_column(String(200))

    #: The approved spend this order was raised against, when there was one.
    estimate_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("estimates.id", ondelete="RESTRICT")
    )
    estimate: Mapped[Estimate | None] = relationship()

    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    submitted_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )
    #: When it became live, whether by approval or by drawing on an approved
    #: estimate that already covered it.
    opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )
    closed_reason: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        CheckConstraint(
            f"state IN ({_PURCHASE_ORDER_STATES_SQL})", name="state_is_valid_for_purchase_order"
        ),
        CheckConstraint(
            "total_minor_units IS NULL OR total_minor_units > 0", name="total_is_positive"
        ),
        CheckConstraint(
            "total_minor_units IS NULL OR currency IS NOT NULL",
            name="total_states_its_currency",
        ),
        CheckConstraint(
            "(submitted_at IS NULL) = (submitted_by_id IS NULL)",
            name="submission_names_its_actor",
        ),
        CheckConstraint(
            "(closed_at IS NULL) = (closed_by_id IS NULL)", name="closing_names_its_actor"
        ),
        # Only a live commitment can be finished. Closing anything else would be
        # recording an end to something that never started.
        CheckConstraint("closed_at IS NULL OR state = 'approved'", name="only_a_live_order_closes"),
        # A commitment past draft has been through the completeness rules, so the
        # figures a supplier will be held to cannot be empty. A draft may be as
        # empty as whoever is writing it likes.
        CheckConstraint(
            "state = 'draft' OR ("
            "vendor_id IS NOT NULL AND description <> '' "
            "AND total_minor_units IS NOT NULL AND cost_centre_id IS NOT NULL "
            "AND submitted_at IS NOT NULL)",
            name="committed_order_is_complete",
        ),
        Index("ix_purchase_orders_vendor", "vendor_id", "state"),
        Index("ix_purchase_orders_queue", "state", "created_at"),
    )


class PurchaseOrderThreshold(Base, UuidPrimaryKey, TimestampMixin, VersionMixin):
    """The amount at or above which an invoice must name a purchase order.

    One row per currency, and no conversion between them, on the same reasoning
    as the approval bands: JMD 50,000 says nothing about what a USD invoice
    should need.

    A currency with no row requires an order for every invoice in it. That is
    deliberately the awkward direction. The alternative — no row meaning no
    control — would mean a currency nobody had got round to configuring silently
    had its purchase-order requirement switched off, and nothing on any screen
    would look wrong. This way the gap is loud, and the administration screen
    names the currencies in it.
    """

    __tablename__ = "purchase_order_thresholds"

    currency: Mapped[str] = mapped_column(CHAR(3), nullable=False, unique=True)

    #: Named for what it means rather than for a minimum, because the control is
    #: stated as applying *above* the figure: an invoice for exactly this amount
    #: needs no order. The approval bands next door are inclusive at their
    #: minimum, and a column called `min_` in both places would hide that.
    applies_above_minor_units: Mapped[int] = mapped_column(BigInteger, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    __table_args__ = (
        CheckConstraint("applies_above_minor_units >= 0", name="threshold_not_negative"),
    )


# --------------------------------------------------------------------- invoices


class Invoice(Base, UuidPrimaryKey, TimestampMixin, VersionMixin, SoftDeleteMixin):
    """A demand for money, and everything needed to refuse it.

    Structurally close to `Estimate`, and deliberately stricter in three places.
    `vendor_id` is mandatory once the invoice leaves draft, because money only
    moves to a supplier on the master. `invoice_number` is likewise mandatory and
    carries a partial unique index against the vendor, so the same invoice cannot
    be live twice. And `signed_off_at` records a fact no amount of extraction can
    supply: that somebody confirmed the goods arrived.
    """

    __tablename__ = "invoices"

    reference: Mapped[str] = mapped_column(String(30), unique=True, nullable=False, index=True)

    state: Mapped[WorkflowState] = mapped_column(
        workflow_state_enum, nullable=False, default=WorkflowState.draft, index=True
    )

    #: Who is accountable for confirming receipt. Copied from the linked estimate
    #: when there is one, and named explicitly otherwise, because an invoice with
    #: nobody to sign it off is an invoice that waits forever.
    requester_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), index=True
    )
    requester: Mapped[User | None] = relationship(foreign_keys=[requester_id])

    #: Who recorded it, which is finance rather than the requester.
    created_by_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    created_by: Mapped[User] = relationship(foreign_keys=[created_by_id])

    document_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("documents.id", ondelete="RESTRICT"), unique=True
    )
    document: Mapped[Document | None] = relationship()

    vendor_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("vendors.id", ondelete="RESTRICT"), index=True
    )
    vendor: Mapped[Vendor | None] = relationship()
    vendor_name: Mapped[str] = mapped_column(String(300), nullable=False, default="")

    invoice_number: Mapped[str | None] = mapped_column(String(120), index=True)
    invoice_date: Mapped[date | None] = mapped_column(Date)
    due_date: Mapped[date | None] = mapped_column(Date)

    currency: Mapped[str | None] = mapped_column(CHAR(3))
    total_minor_units: Mapped[int | None] = mapped_column(BigInteger)

    description: Mapped[str] = mapped_column(String(500), nullable=False, default="")

    estimate_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("estimates.id", ondelete="RESTRICT"), index=True
    )
    estimate: Mapped[Estimate | None] = relationship()

    purchase_order_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("purchase_orders.id", ondelete="RESTRICT"), index=True
    )
    purchase_order: Mapped[PurchaseOrder | None] = relationship()

    cost_centre_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("cost_centres.id", ondelete="RESTRICT")
    )
    cost_centre: Mapped[CostCentre | None] = relationship()
    gl_account_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("gl_accounts.id", ondelete="RESTRICT")
    )
    gl_account: Mapped[GlAccount | None] = relationship()

    department: Mapped[str | None] = mapped_column(String(200))

    #: Receipt of goods or services. The three columns move together and the
    #: check constraint below says so, because a sign-off without an actor is
    #: not evidence of anything.
    signed_off_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    signed_off_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )
    signed_off_by: Mapped[User | None] = relationship(foreign_keys=[signed_off_by_id])
    #: What the signer confirmed, in their words. Kept because "I confirmed part
    #: delivery on the 14th" is the note that settles a later dispute.
    sign_off_note: Mapped[str | None] = mapped_column(Text)

    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    submitted_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(f"state IN ({_INVOICE_STATES_SQL})", name="state_is_valid_for_invoice"),
        CheckConstraint(
            "total_minor_units IS NULL OR currency IS NOT NULL",
            name="total_states_its_currency",
        ),
        CheckConstraint(
            "total_minor_units IS NULL OR total_minor_units > 0",
            name="total_is_positive",
        ),
        CheckConstraint(
            "(signed_off_at IS NULL) = (signed_off_by_id IS NULL)",
            name="sign_off_names_its_actor",
        ),
        CheckConstraint(
            "(submitted_at IS NULL) = (submitted_by_id IS NULL)",
            name="submission_names_its_actor",
        ),
        # Anything past draft has been through the completeness rules. The vendor
        # identifier is in here rather than merely the name, because this is the
        # record money is paid against.
        CheckConstraint(
            "state IN ('draft', 'cancelled') OR ("
            "vendor_id IS NOT NULL AND vendor_name <> '' AND description <> '' "
            "AND invoice_number IS NOT NULL AND invoice_date IS NOT NULL "
            "AND total_minor_units IS NOT NULL AND cost_centre_id IS NOT NULL "
            "AND requester_id IS NOT NULL)",
            name="live_invoice_is_complete",
        ),
        # A live duplicate is refused by the database as well as by the rules,
        # because paying twice is the failure this platform most has to prevent
        # and a defect in the application layer must not be enough to cause it.
        # Cancelled and rejected rows are excluded: those numbers are free again.
        # The last line of defence against paying one invoice twice, and
        # deliberately narrower than the rule the screen enforces. Drafts are
        # excluded so that recording a suspected duplicate is possible at all: the
        # person who notices it needs to see both records side by side to work out
        # which is real, and a database error on save would deny them that while
        # telling them nothing. The application refuses to move either one forward
        # until one is cancelled; this index catches only the case the application
        # cannot see, which is two of them being submitted in the same instant.
        Index(
            "uq_invoices_live_vendor_number",
            "vendor_id",
            "invoice_number",
            unique=True,
            postgresql_where=text(
                "state NOT IN ('draft', 'cancelled', 'rejected') AND archived_at IS NULL"
            ),
        ),
        Index("ix_invoices_queue", "state", "created_at"),
        Index("ix_invoices_requester_queue", "requester_id", "state"),
        Index("ix_invoices_due", "state", "due_date"),
    )


# -------------------------------------------------------------------- approvals


class ApprovalRequest(Base, UuidPrimaryKey, TimestampMixin, VersionMixin):
    """One journey through the approval matrix for one record.

    Keyed by `record_type` and `record_id` rather than by a foreign key to
    estimates, because invoices and requisitions route through the same matrix
    and a separate table per record type would mean a separate implementation of
    the sequencing rules per record type.

    Requests accumulate. Withdrawing an estimate to correct it closes the route
    and a resubmission opens attempt 2, so the fact that an earlier route existed
    and what it had already approved stays readable. The partial unique index
    below is what guarantees only one is open at a time.

    The amount is copied onto the request. The route was planned from that figure,
    so a later edit is detectable rather than leaving a route whose steps no
    longer correspond to what is being approved.
    """

    __tablename__ = "approval_requests"

    record_type: Mapped[str] = mapped_column(String(80), nullable=False)
    record_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False, index=True)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    state: Mapped[RouteState] = mapped_column(
        route_state_enum, nullable=False, default=RouteState.open, index=True
    )

    #: The step order currently open for decisions, or null once the route has
    #: closed. Derived from the steps and written in the same transaction as every
    #: decision, following the same reasoning as `documents.status`: an approver's
    #: queue is a query that runs on every page load, and recomputing whose turn
    #: it is across every open route to answer it does not scale past a pilot.
    current_step_order: Mapped[int | None] = mapped_column(Integer, index=True)

    amount_minor_units: Mapped[int] = mapped_column(BigInteger, nullable=False)
    currency: Mapped[str] = mapped_column(CHAR(3), nullable=False)
    department: Mapped[str | None] = mapped_column(String(200))

    requester_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )

    opened_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    steps: Mapped[list[ApprovalStep]] = relationship(
        back_populates="request",
        cascade="all, delete-orphan",
        lazy="selectin",
        order_by="ApprovalStep.step_order, ApprovalStep.level",
    )

    __table_args__ = (
        UniqueConstraint(
            "record_type", "record_id", "attempt", name="uq_approval_requests_attempt"
        ),
        Index(
            "uq_approval_requests_one_open",
            "record_type",
            "record_id",
            unique=True,
            postgresql_where=text("state = 'open'"),
        ),
        Index("ix_approval_requests_record", "record_type", "record_id", "attempt"),
        CheckConstraint("attempt > 0", name="attempt_positive"),
        CheckConstraint("amount_minor_units > 0", name="amount_is_positive"),
        CheckConstraint(
            "(state = 'open') = (closed_at IS NULL)",
            name="closed_route_records_when",
        ),
        # An open route always has a step waiting for somebody, and a closed one
        # never does. Without this a route could sit open with nothing on anyone's
        # queue, which is the failure nobody notices.
        CheckConstraint(
            "(state = 'open') = (current_step_order IS NOT NULL)",
            name="open_route_has_an_open_step",
        ),
    )


class ApprovalStep(Base, UuidPrimaryKey, TimestampMixin):
    """One approval a route requires, and the decision made on it.

    There is no separate decisions table. A step is decided once, and the full
    sequence of everything that happened to a record, including a withdrawal that
    ended a step before anyone reached it, is in the hash-chained audit trail.
    A second table would be a less complete copy of that.

    `state` carries the decision rather than a separate outcome column, so a step
    cannot be recorded as approved and rejected at the same time. `waiting` and
    `ready` are computed from the route on read, never stored, because readiness
    depends on sibling steps and a stored copy would go stale the moment one of
    them was decided.
    """

    __tablename__ = "approval_steps"

    request_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("approval_requests.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    request: Mapped[ApprovalRequest] = relationship(back_populates="steps")

    step_order: Mapped[int] = mapped_column(Integer, nullable=False)
    level: Mapped[ApprovalLevel] = mapped_column(approval_level_enum, nullable=False)

    state: Mapped[StepState] = mapped_column(
        step_state_enum, nullable=False, default=StepState.waiting
    )

    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decided_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )
    decided_by_label: Mapped[str | None] = mapped_column(String(300))
    comment: Mapped[str | None] = mapped_column(Text)

    #: Set when a delegate decided in place of the assigned approver, naming who
    #: they stood in for. An approval given under delegation is still an approval,
    #: and an auditor needs to see whose authority it was exercised under.
    on_behalf_of_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )

    __table_args__ = (
        UniqueConstraint("request_id", "step_order", "level", name="uq_approval_steps_step"),
        CheckConstraint("step_order > 0", name="step_order_positive"),
        # A decision names its author and its moment, and anything undecided has
        # neither. Both directions, so a half-written decision cannot exist.
        CheckConstraint(
            "(state IN ('approved', 'rejected')) = (decided_at IS NOT NULL)",
            name="decision_records_when",
        ),
        CheckConstraint(
            "(decided_at IS NULL) = (decided_by_id IS NULL)",
            name="decision_names_its_actor",
        ),
        # Rejection has to be explained. The domain requires it of the actor and
        # the database requires it of the row.
        CheckConstraint(
            "state <> 'rejected' OR (comment IS NOT NULL AND comment <> '')",
            name="rejection_is_explained",
        ),
    )


# -------------------------------------------------------------- payment packages


class PaymentPackage(Base, UuidPrimaryKey, TimestampMixin, VersionMixin):
    """A batch of approved invoices, submitted to the bank as one instruction.

    There is no state column, and that is the design rather than an omission. A
    package agrees to nothing — every invoice in it was approved before it could
    be added — so it has no place on the workflow state machine, and giving it
    one would have meant inventing a `draft -> ready_for_submission` transition
    that every record in the system could then have used to reach the bank
    without approval. Open, submitted and cancelled are read from the two
    timestamps below, the way a purchase order's open and closed are.

    The manifest digest is written at submission and never recomputed. A
    manifest regenerated later would be the same file, but only if this code has
    not changed since; the digest taken at the time is evidence independent of
    that.
    """

    __tablename__ = "payment_packages"

    reference: Mapped[str] = mapped_column(String(30), unique=True, nullable=False, index=True)
    description: Mapped[str] = mapped_column(String(500), nullable=False, default="")

    #: Nullable while the package is being assembled, and required by the domain
    #: before it can be submitted. Not enforced null-together with `submitted_at`
    #: in a constraint, because a cancelled package may legitimately have neither.
    payment_method: Mapped[PaymentMethod | None] = mapped_column(payment_method_enum)
    intended_payment_date: Mapped[date | None] = mapped_column(Date)

    created_by_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    created_by: Mapped[User] = relationship(foreign_keys=[created_by_id])

    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    submitted_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )
    submitted_by: Mapped[User | None] = relationship(foreign_keys=[submitted_by_id])

    #: What the bank gave back. The only thing tying this package to the payment
    #: on their side, which is why the domain refuses a submission without it.
    submission_reference: Mapped[str | None] = mapped_column(String(120), index=True)

    #: SHA-256 of the manifest as submitted, hex, plus how many invoice rows it
    #: had. The row count is stored rather than counted from the lines so a
    #: manifest that went out with fewer rows than the package now holds is
    #: detectable at a glance.
    manifest_sha256: Mapped[Sha256Hex | None] = mapped_column()
    manifest_line_count: Mapped[int | None] = mapped_column(Integer)

    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )
    cancelled_reason: Mapped[str | None] = mapped_column(Text)

    lines: Mapped[list[PaymentPackageLine]] = relationship(
        back_populates="package",
        cascade="all, delete-orphan",
        lazy="selectin",
        order_by="PaymentPackageLine.vendor_name, PaymentPackageLine.invoice_reference",
    )

    __table_args__ = (
        # A submission names its moment, its author, the bank's reference and
        # what was sent. All four or none: a package recorded as submitted with
        # no evidence of what went is worse than one not recorded at all,
        # because it looks answered.
        CheckConstraint(
            "(submitted_at IS NULL) = (submitted_by_id IS NULL)",
            name="submission_names_its_actor",
        ),
        CheckConstraint(
            "(submitted_at IS NULL) = (submission_reference IS NULL)",
            name="submission_carries_its_reference",
        ),
        CheckConstraint(
            "(submitted_at IS NULL) = (manifest_sha256 IS NULL)",
            name="submission_keeps_its_manifest",
        ),
        CheckConstraint(
            "(manifest_sha256 IS NULL) = (manifest_line_count IS NULL)",
            name="manifest_states_its_size",
        ),
        CheckConstraint(
            "(cancelled_at IS NULL) = (cancelled_by_id IS NULL)",
            name="cancellation_names_its_actor",
        ),
        # A package that went to the bank cannot also have been abandoned. The
        # domain reads submitted first if both are somehow set; this makes sure
        # it never has to.
        CheckConstraint(
            "submitted_at IS NULL OR cancelled_at IS NULL",
            name="package_went_or_was_abandoned_not_both",
        ),
        # The register's default view: everything still open, newest first.
        Index(
            "ix_payment_packages_open",
            "created_at",
            postgresql_where=text("submitted_at IS NULL AND cancelled_at IS NULL"),
        ),
        Index("ix_payment_packages_submitted", "submitted_at", "intended_payment_date"),
    )


class PaymentPackageLine(Base, UuidPrimaryKey, TimestampMixin):
    """One invoice in one package, and what it was worth when it went in.

    The amount, supplier and invoice number are copied rather than read through
    the foreign key. The manifest is a statement about what was submitted, and
    regenerating it from invoices that have since been edited would quietly
    rewrite history; the copies are also what lets the stored digest be checked
    against a regenerated file at all.

    The unique index on `invoice_id` is the whole double-payment control: an
    invoice can be in one package, ever. Cancelling a package deletes its lines
    rather than tombstoning them, so the invoices in it are free to be paid by
    another one — what happened is in the audit trail, which is where a deleted
    row's story belongs.
    """

    __tablename__ = "payment_package_lines"

    package_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("payment_packages.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    package: Mapped[PaymentPackage] = relationship(back_populates="lines")

    invoice_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("invoices.id", ondelete="RESTRICT"),
        nullable=False,
        unique=True,
    )
    invoice: Mapped[Invoice] = relationship()

    #: Ours, copied so the manifest reads without a join.
    invoice_reference: Mapped[str] = mapped_column(String(30), nullable=False)
    #: Theirs. Absent on an invoice recorded from a document that never had one.
    invoice_number: Mapped[str | None] = mapped_column(String(120))

    vendor_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("vendors.id", ondelete="RESTRICT"), index=True
    )
    vendor_name: Mapped[str] = mapped_column(String(300), nullable=False)

    currency: Mapped[str] = mapped_column(CHAR(3), nullable=False)
    amount_minor_units: Mapped[int] = mapped_column(BigInteger, nullable=False)
    due_date: Mapped[date | None] = mapped_column(Date)

    added_by_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )

    __table_args__ = (
        CheckConstraint("amount_minor_units > 0", name="line_amount_is_positive"),
        Index("ix_payment_package_lines_vendor", "package_id", "vendor_name"),
    )


# ------------------------------------------------------- vendor payment check-in


class VendorCheckIn(Base, UuidPrimaryKey, TimestampMixin, VersionMixin):
    """One question put to one supplier about one payment, and what came back.

    There is no line table. A check-in concerns exactly the lines of its package
    that name this supplier, and a package can only be checked in on once it has
    been submitted, at which point its lines can no longer change. Copying them
    again would be a second frozen copy of a frozen thing, and the two would
    eventually disagree about something.

    One row per supplier per package rather than one per invoice. A bank pays a
    batch as a single credit, so the supplier sees one deposit; asking them
    invoice by invoice would be asking them to do our arithmetic and would
    collect confident wrong answers.

    Like a payment package this carries no workflow state. Not asked, waiting,
    answered and reviewed are read from the timestamps. The invoices are what
    move on the state machine, and only the review moves them.
    """

    __tablename__ = "vendor_check_ins"

    reference: Mapped[str] = mapped_column(String(30), unique=True, nullable=False, index=True)

    package_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("payment_packages.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    package: Mapped[PaymentPackage] = relationship()

    #: Null where the invoice carried only a supplier's name and no master
    #: record, which the rest of the platform tolerates and so must this.
    vendor_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("vendors.id", ondelete="RESTRICT"), index=True
    )
    vendor: Mapped[Vendor | None] = relationship()
    vendor_name: Mapped[str] = mapped_column(String(300), nullable=False)

    #: Snapshotted at creation. The address a question went to is part of the
    #: evidence, and a later edit to the supplier's record must not rewrite where
    #: we say we sent it. Null means there is nobody to ask, which the register
    #: reports rather than hides.
    vendor_email: Mapped[str | None] = mapped_column(String(320))

    #: Identifies this conversation in a reply. Not a secret and not a
    #: credential: it opens nothing, and the worst somebody who learns one can do
    #: is have an email of their choosing filed where a person will read it.
    correlation_tag: Mapped[str] = mapped_column(
        String(40), unique=True, nullable=False, index=True
    )

    created_by_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    created_by: Mapped[User] = relationship(foreign_keys=[created_by_id])

    #: When the supplier was first asked. Subsequent chasers live on the reminder
    #: schedule, which is the cursor for this conversation as it is for any other.
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)

    answered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    claim: Mapped[ClaimOutcome | None] = mapped_column(claim_outcome_enum)
    claim_channel: Mapped[ClaimChannel | None] = mapped_column(claim_channel_enum)
    #: What the supplier called themselves. Unverified, and kept anyway, because
    #: "Marcia in accounts said so on the 14th" is the sentence somebody needs a
    #: year later.
    respondent_name: Mapped[str | None] = mapped_column(String(120))
    respondent_note: Mapped[str | None] = mapped_column(Text)
    #: The correlated reply the claim was read from, where it came by email.
    answered_from_message_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("inbound_messages.id", ondelete="SET NULL")
    )

    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    reviewed_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )
    reviewed_by: Mapped[User | None] = relationship(foreign_keys=[reviewed_by_id])
    review_outcome: Mapped[ReviewOutcome | None] = mapped_column(review_outcome_enum, index=True)
    review_note: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        # One conversation per supplier per package. A second would ask the same
        # question twice and collect two answers with no rule for which wins.
        UniqueConstraint("package_id", "vendor_name", name="uq_vendor_check_in_per_package"),
        CheckConstraint(
            "(answered_at IS NULL) = (claim IS NULL)",
            name="an_answer_says_what_it_was",
        ),
        CheckConstraint(
            "(claim IS NULL) = (claim_channel IS NULL)",
            name="an_answer_says_how_it_arrived",
        ),
        CheckConstraint(
            "(reviewed_at IS NULL) = (review_outcome IS NULL)",
            name="a_review_reaches_a_conclusion",
        ),
        CheckConstraint(
            "(reviewed_at IS NULL) = (reviewed_by_id IS NULL)",
            name="a_review_names_its_reviewer",
        ),
        # Nothing is answered or reviewed before it was asked. Without this a
        # check-in could carry a supplier's answer to a question never put to
        # them, which is the shape a forged confirmation would take.
        CheckConstraint(
            "answered_at IS NULL OR sent_at IS NOT NULL",
            name="an_answer_follows_a_question",
        ),
        # The review queue: everything answered and not yet concluded.
        Index(
            "ix_vendor_check_ins_needing_review",
            "answered_at",
            postgresql_where=text("reviewed_at IS NULL"),
        ),
        Index(
            "ix_vendor_check_ins_awaiting",
            "sent_at",
            postgresql_where=text("answered_at IS NULL AND reviewed_at IS NULL"),
        ),
    )


# ------------------------------------------------------------- signed deep links


class SignedLink(Base, UuidPrimaryKey, TimestampMixin):
    """A link emailed to somebody, and the record it opens.

    The secret is never stored. Only its SHA-256 digest is, so a database read
    cannot be turned into a working link, exactly as a password would be handled.
    The row exists so a link can be expired, revoked and spent, none of which a
    self-contained signed token can offer on its own.

    A link identifies a destination. It does not identify a person and confers no
    authority: following one still requires signing in, and the action at the far
    end is authorised against that session. That is what keeps an intercepted or
    forwarded email from becoming a financial decision.

    A link issued to a supplier is the same row with the recipient in the other
    column, and it is the same claim about authority. What differs is only what
    is at the far end: a supplier has no session to check the link against, so
    the page it opens records a claim and cannot move anything. Sharing the row
    means expiry, revocation, single use and the audit of every refusal come for
    free rather than being written twice with one of them subtly weaker.
    """

    __tablename__ = "signed_links"

    token_sha256: Mapped[Sha256Hex] = mapped_column(unique=True, nullable=False, index=True)

    record_type: Mapped[str] = mapped_column(String(50), nullable=False)
    record_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False)
    purpose: Mapped[ReminderPurpose] = mapped_column(reminder_purpose_enum, nullable=False)

    #: Who it was sent to. Checked on use, so a link forwarded to a colleague
    #: opens nothing: the colleague may well be entitled to see the record, but
    #: not by way of somebody else's link.
    issued_to_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )

    #: The other kind of recipient: a supplier, who has no account here. Nothing
    #: is checked against a session for these, because there is no session; the
    #: page at the far end therefore records a claim and authorises nothing.
    issued_to_vendor_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("vendors.id", ondelete="CASCADE"), index=True
    )

    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    #: Set the first time it is followed. A link is single use because the second
    #: use of one is far more likely to be somebody who should not have it than
    #: the intended recipient clicking twice, and the intended recipient has the
    #: record open by then anyway.
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        # Exactly one recipient, never both and never neither. A link with no
        # recipient could not be refused to the wrong one, which is most of what
        # the row is for.
        CheckConstraint(
            "(issued_to_id IS NULL) <> (issued_to_vendor_id IS NULL)",
            name="link_has_exactly_one_recipient",
        ),
        Index("ix_signed_links_record", "record_type", "record_id", "purpose"),
        Index("ix_signed_links_expiry", "expires_at"),
    )


# ------------------------------------------------------- reminders and escalation


class ReminderSchedule(Base, UuidPrimaryKey, TimestampMixin, VersionMixin):
    """Where one record has reached in its chasing cycle.

    One row per record and purpose, not one per reminder sent. The individual
    sends are in the outbox and the audit trail; this is the cursor, and keeping
    it as a single row is what lets the scheduler find everything due with one
    indexed query instead of aggregating a history.

    `stopped_at` is set rather than the row deleted. "We stopped chasing this on
    Tuesday because it was signed off" is an answer somebody will want, and a
    deleted row cannot give it.
    """

    __tablename__ = "reminder_schedules"

    record_type: Mapped[str] = mapped_column(String(50), nullable=False)
    record_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False)
    purpose: Mapped[ReminderPurpose] = mapped_column(reminder_purpose_enum, nullable=False)

    #: Who is being chased. Null once the cycle has stopped.
    recipient_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), index=True
    )

    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    #: Null means nothing further is scheduled, which is either because the cycle
    #: has stopped or because the maximum has been reached.
    next_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    last_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    sent_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    escalation_level: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    stopped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    stopped_reason: Mapped[str | None] = mapped_column(String(200))

    __table_args__ = (
        # One live cycle per record and purpose. A second would double every
        # reminder, which is the specific failure that teaches people to ignore
        # them.
        Index(
            "uq_reminder_schedules_live",
            "record_type",
            "record_id",
            "purpose",
            unique=True,
            postgresql_where=text("stopped_at IS NULL"),
        ),
        CheckConstraint("sent_count >= 0", name="sent_count_not_negative"),
        CheckConstraint("escalation_level >= 0", name="escalation_level_not_negative"),
        CheckConstraint(
            "(stopped_at IS NULL) OR (next_due_at IS NULL)",
            name="stopped_schedule_has_nothing_due",
        ),
        Index("ix_reminder_schedules_due", "next_due_at", "stopped_at"),
    )


# ------------------------------------------------------------------ mail outbox


class OutboxMessage(Base, UuidPrimaryKey, TimestampMixin, VersionMixin):
    """One message waiting to be sent, or the record that it was.

    Written inside the business transaction that decided to send it, and sent
    afterwards by a worker. That ordering is the whole point: a rolled-back
    approval takes its notification with it, and a mail server that is down
    delays a message rather than an approval screen.
    """

    __tablename__ = "outbox_messages"

    kind: Mapped[MessageKind] = mapped_column(message_kind_enum, nullable=False, index=True)
    state: Mapped[OutboxState] = mapped_column(
        outbox_state_enum, nullable=False, default=OutboxState.pending, index=True
    )

    #: One row per thing-that-should-happen-once. The scheduler may run twice over
    #: the same due reminder; the unique index turns the second attempt into a
    #: no-op instead of a second email.
    idempotency_key: Mapped[str] = mapped_column(String(200), unique=True, nullable=False)

    record_type: Mapped[str] = mapped_column(String(50), nullable=False)
    record_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False)

    to_address: Mapped[str] = mapped_column(String(320), nullable=False)
    to_name: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    #: Copied recipients, as a JSON array. Escalation adds the next person up
    #: here rather than replacing `to_address`, so the original recipient is never
    #: quietly cut out of a task they still hold.
    cc_addresses: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)

    subject: Mapped[str] = mapped_column(String(400), nullable=False)
    body_text: Mapped[str] = mapped_column(Text, nullable=False)

    #: Threading headers, so a reply can be correlated back to this record
    #: without trusting the subject line.
    message_id: Mapped[str] = mapped_column(String(300), unique=True, nullable=False)
    in_reply_to: Mapped[str | None] = mapped_column(String(300))

    #: Where a reply should go, when that differs from the address the platform
    #: sends as. Used for mail leaving the organisation, where the address
    #: carries a tag identifying the conversation so a reply can be filed even if
    #: the sender's mail client threw the threading headers away.
    reply_to_address: Mapped[str | None] = mapped_column(String(320))

    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    #: When a worker may next try. Set into the future on failure to back off.
    available_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), index=True
    )
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)

    correlation_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))

    __table_args__ = (
        CheckConstraint("attempts >= 0", name="attempts_not_negative"),
        CheckConstraint(
            "(state = 'sent') = (sent_at IS NOT NULL)",
            name="sent_message_records_when",
        ),
        Index("ix_outbox_ready", "state", "available_at"),
        Index("ix_outbox_record", "record_type", "record_id"),
    )


# -------------------------------------------------------------- credit cards


class CreditCardAccount(Base, UuidPrimaryKey, TimestampMixin, VersionMixin, SoftDeleteMixin):
    """A company card that statements are imported against.

    Only the last four digits are kept. The full number never belongs in this
    system, and a display label plus a cardholder is what a coder needs to tell
    two cards apart.
    """

    __tablename__ = "credit_card_accounts"

    label: Mapped[str] = mapped_column(String(200), nullable=False)
    last_four: Mapped[str] = mapped_column(CHAR(4), nullable=False)
    cardholder_name: Mapped[str] = mapped_column(String(120), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="JMD")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    periods: Mapped[list[CreditCardPeriod]] = relationship(back_populates="card")

    __table_args__ = (
        UniqueConstraint("last_four", "cardholder_name", name="uq_credit_card_identity"),
        CheckConstraint("char_length(last_four) = 4", name="card_last_four_length"),
    )


class CreditCardPeriod(Base, UuidPrimaryKey, TimestampMixin, VersionMixin):
    """One billing period on one card, and whether it has been closed.

    No workflow state. Open and closed are read from `closed_at`, for the same
    reason a payment package has none: closing is an act on a container of
    charges that already happened, not a decision about money still owed.
    """

    __tablename__ = "credit_card_periods"

    reference: Mapped[str] = mapped_column(String(30), unique=True, nullable=False, index=True)

    card_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("credit_card_accounts.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    card: Mapped[CreditCardAccount] = relationship(back_populates="periods")

    period_start: Mapped[date] = mapped_column(Date, nullable=False)
    period_end: Mapped[date] = mapped_column(Date, nullable=False)
    statement_date: Mapped[date] = mapped_column(Date, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)

    #: SHA-256 of the imported file bytes, so the same statement imported twice
    #: is recognised rather than doubled.
    source_sha256: Mapped[Sha256Hex] = mapped_column(nullable=False)
    source_filename: Mapped[str] = mapped_column(String(255), nullable=False)

    imported_by_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    imported_by: Mapped[User] = relationship(foreign_keys=[imported_by_id])
    imported_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    closed_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )
    closed_by: Mapped[User | None] = relationship(foreign_keys=[closed_by_id])
    close_reason: Mapped[str | None] = mapped_column(Text)

    transactions: Mapped[list[CreditCardTransaction]] = relationship(
        back_populates="period",
        order_by="CreditCardTransaction.posted_on, CreditCardTransaction.source_row",
    )

    __table_args__ = (
        CheckConstraint("period_end >= period_start", name="period_dates_ordered"),
        CheckConstraint(
            "(closed_at IS NULL) = (closed_by_id IS NULL)",
            name="a_close_names_who_closed_it",
        ),
        CheckConstraint(
            "(closed_at IS NULL) = (close_reason IS NULL)",
            name="a_close_records_why",
        ),
        UniqueConstraint("card_id", "source_sha256", name="uq_credit_card_statement_once"),
        Index(
            "ix_credit_card_periods_open",
            "card_id",
            postgresql_where=text("closed_at IS NULL"),
        ),
    )


class CreditCardTransaction(Base, UuidPrimaryKey, TimestampMixin, VersionMixin):
    """One charge on a statement.

    Coding and receipt matching live on the row. A suggestion from the assistive
    reader sits beside the applied values rather than replacing them, so a person
    can accept, edit or reject without the proposal becoming the record.
    """

    __tablename__ = "credit_card_transactions"

    period_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("credit_card_periods.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    period: Mapped[CreditCardPeriod] = relationship(back_populates="transactions")

    source_row: Mapped[int] = mapped_column(Integer, nullable=False)
    posted_on: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    merchant: Mapped[str] = mapped_column(String(300), nullable=False)
    cardholder: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    external_reference: Mapped[str | None] = mapped_column(String(80))

    amount_minor_units: Mapped[int] = mapped_column(BigInteger, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)

    category: Mapped[str | None] = mapped_column(String(120))
    gl_account_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("gl_accounts.id", ondelete="RESTRICT"), index=True
    )
    gl_account: Mapped[GlAccount | None] = relationship(foreign_keys=[gl_account_id])
    cost_centre_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("cost_centres.id", ondelete="RESTRICT"), index=True
    )
    cost_centre: Mapped[CostCentre | None] = relationship(foreign_keys=[cost_centre_id])
    exception_reason: Mapped[str | None] = mapped_column(Text)

    coded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    coded_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )
    coded_by: Mapped[User | None] = relationship(foreign_keys=[coded_by_id])

    receipt_document_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("documents.id", ondelete="SET NULL"), index=True
    )
    receipt_document: Mapped[Document | None] = relationship(foreign_keys=[receipt_document_id])
    receipt_waived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    receipt_waiver_reason: Mapped[str | None] = mapped_column(Text)
    receipt_match_confidence: Mapped[float | None] = mapped_column()
    matched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    matched_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )
    matched_by: Mapped[User | None] = relationship(foreign_keys=[matched_by_id])

    #: Assistive proposals. Null until something has been suggested; disposition
    #: stays pending until a person acts. Closing a period never reads these.
    suggested_gl_account_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("gl_accounts.id", ondelete="SET NULL")
    )
    suggested_cost_centre_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("cost_centres.id", ondelete="SET NULL")
    )
    suggested_receipt_document_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("documents.id", ondelete="SET NULL")
    )
    suggestion_evidence: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    suggestion_disposition: Mapped[SuggestionDisposition | None] = mapped_column(
        suggestion_disposition_enum
    )

    __table_args__ = (
        UniqueConstraint("period_id", "source_row", name="uq_credit_card_txn_row"),
        CheckConstraint(
            "NOT (exception_reason IS NOT NULL AND gl_account_id IS NOT NULL)",
            name="exception_or_gl_not_both",
        ),
        CheckConstraint(
            "NOT (exception_reason IS NOT NULL AND cost_centre_id IS NOT NULL)",
            name="exception_or_cost_centre_not_both",
        ),
        CheckConstraint(
            "NOT (receipt_document_id IS NOT NULL AND receipt_waived)",
            name="receipt_matched_or_waived_not_both",
        ),
        Index(
            "ix_credit_card_transactions_uncoded",
            "period_id",
            postgresql_where=text(
                "gl_account_id IS NULL AND cost_centre_id IS NULL AND exception_reason IS NULL"
            ),
        ),
    )


class AccrualPeriod(Base, UuidPrimaryKey, TimestampMixin, VersionMixin):
    """One month-end accrual pack.

    No workflow state. Open and locked are read from `locked_at`, for the same
    reason a credit-card period has none: locking freezes a reporting set, it is
    not a decision about money still owed.
    """

    __tablename__ = "accrual_periods"

    reference: Mapped[str] = mapped_column(String(30), unique=True, nullable=False, index=True)

    period_start: Mapped[date] = mapped_column(Date, nullable=False)
    period_end: Mapped[date] = mapped_column(Date, nullable=False)
    label: Mapped[str] = mapped_column(String(200), nullable=False, default="")

    opened_by_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    opened_by: Mapped[User] = relationship(foreign_keys=[opened_by_id])
    opened_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    locked_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )
    locked_by: Mapped[User | None] = relationship(foreign_keys=[locked_by_id])
    lock_reason: Mapped[str | None] = mapped_column(Text)

    candidates: Mapped[list[AccrualCandidate]] = relationship(
        back_populates="period",
        order_by="AccrualCandidate.reference",
    )
    exports: Mapped[list[AccrualExport]] = relationship(
        back_populates="period",
        order_by="AccrualExport.version",
    )

    __table_args__ = (
        CheckConstraint("period_end >= period_start", name="accrual_period_dates_ordered"),
        CheckConstraint(
            "(locked_at IS NULL) = (locked_by_id IS NULL)",
            name="an_accrual_lock_names_who",
        ),
        CheckConstraint(
            "(locked_at IS NULL) = (lock_reason IS NULL)",
            name="an_accrual_lock_records_why",
        ),
    )


class AccrualCandidate(Base, UuidPrimaryKey, TimestampMixin, VersionMixin):
    """One proposed accrual line, usually drawn from an unpaid invoice."""

    __tablename__ = "accrual_candidates"

    period_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("accrual_periods.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    period: Mapped[AccrualPeriod] = relationship(back_populates="candidates")

    reference: Mapped[str] = mapped_column(String(30), nullable=False)

    invoice_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("invoices.id", ondelete="RESTRICT"), index=True
    )
    invoice: Mapped[Invoice | None] = relationship()

    standing: Mapped[CandidateStanding] = mapped_column(
        candidate_standing_enum, nullable=False, default=CandidateStanding.proposed
    )

    currency: Mapped[str] = mapped_column(CHAR(3), nullable=False)
    amount_minor_units: Mapped[int] = mapped_column(BigInteger, nullable=False)
    original_amount_minor_units: Mapped[int] = mapped_column(BigInteger, nullable=False)

    vendor_name: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    invoice_number: Mapped[str | None] = mapped_column(String(120))
    invoice_reference: Mapped[str | None] = mapped_column(String(30))
    description: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    department: Mapped[str | None] = mapped_column(String(200))

    gl_account_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("gl_accounts.id", ondelete="RESTRICT")
    )
    gl_account: Mapped[GlAccount | None] = relationship()
    cost_centre_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("cost_centres.id", ondelete="RESTRICT")
    )
    cost_centre: Mapped[CostCentre | None] = relationship()

    edit_reason: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)

    finalized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finalized_by_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT")
    )
    finalized_by: Mapped[User | None] = relationship(foreign_keys=[finalized_by_id])

    __table_args__ = (
        UniqueConstraint("period_id", "reference", name="uq_accrual_candidate_reference"),
        UniqueConstraint(
            "period_id",
            "invoice_id",
            name="uq_accrual_candidate_invoice_once",
        ),
        Index("ix_accrual_candidates_standing", "period_id", "standing"),
    )


class AccrualExport(Base, UuidPrimaryKey, TimestampMixin):
    """One generated file for a period, versioned so a later rebuild is checkable."""

    __tablename__ = "accrual_exports"

    period_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("accrual_periods.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    period: Mapped[AccrualPeriod] = relationship(back_populates="exports")

    version: Mapped[int] = mapped_column(Integer, nullable=False)
    format: Mapped[str] = mapped_column(String(10), nullable=False)
    official: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    byte_size: Mapped[int] = mapped_column(Integer, nullable=False)
    row_count: Mapped[int] = mapped_column(Integer, nullable=False)

    generated_by_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    generated_by: Mapped[User] = relationship(foreign_keys=[generated_by_id])
    generated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint("period_id", "version", name="uq_accrual_export_version"),
        CheckConstraint("format IN ('csv', 'xlsx')", name="accrual_export_format"),
        CheckConstraint("version >= 1", name="accrual_export_version_positive"),
    )


# ----------------------------------------------------------------- saved views


class SavedView(Base, UuidPrimaryKey, TimestampMixin):
    """A named filter belonging to one person on one screen.

    Sharing is deliberately absent in v1: a saved view is a personal shortcut,
    not a report definition. The `definition` JSON is owned by the client for
    that scope — for My work it is `{"kinds": ["approval", ...]}`.
    """

    __tablename__ = "saved_views"

    user_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user: Mapped[User] = relationship(foreign_keys=[user_id])

    scope: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    definition: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    __table_args__ = (
        UniqueConstraint("user_id", "scope", "name", name="uq_saved_views_user_scope_name"),
        CheckConstraint("char_length(trim(name)) >= 1", name="saved_view_name_present"),
        CheckConstraint(
            "scope IN ('work', 'estimates', 'invoices', 'purchase_orders', "
            "'payments', 'vendor_confirmations', 'credit_cards', 'accruals')",
            name="saved_view_known_scope",
        ),
    )


# ----------------------------------------------------------- retention policies


class RetentionPolicy(Base, UuidPrimaryKey, TimestampMixin, VersionMixin):
    """How long a class of records is kept before eligible for disposal.

    One row per `record_class`. Classes are seeded by migration — v1 does not
    invent new classes through the API. Defaults are provisional until the
    requirements document confirms them; an administrator can change the period
    and soft-deactivate a policy without losing the configured figure.
    """

    __tablename__ = "retention_policies"

    record_class: Mapped[str] = mapped_column(String(60), nullable=False, unique=True)
    retention_days: Mapped[int] = mapped_column(Integer, nullable=False)
    description: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    __table_args__ = (
        CheckConstraint("retention_days >= 1", name="retention_days_positive"),
        CheckConstraint(
            "char_length(trim(record_class)) >= 1", name="retention_record_class_present"
        ),
        CheckConstraint(
            "char_length(trim(description)) >= 1", name="retention_description_present"
        ),
    )
