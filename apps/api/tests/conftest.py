"""Shared fixtures.

These tests run against the real PostgreSQL from the compose stack rather than
SQLite, because the schema relies on PostgreSQL enums, JSONB and advisory locks.
Testing against a different engine would not exercise the constraints that
actually protect production data.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, text, update
from sqlalchemy.orm import Session

from finora.api.app import create_app
from finora.config import get_settings
from finora.domain.roles import ApprovalLevel, Role
from finora.domain.workflow import WorkflowState
from finora.infrastructure.db.models import (
    AccrualCandidate,
    AccrualExport,
    AccrualPeriod,
    ApprovalAssignment,
    ApprovalRequest,
    ApprovalRule,
    ApprovalStep,
    AuditEntryRow,
    BusinessCalendarDay,
    CostCentre,
    CreditCardAccount,
    CreditCardPeriod,
    CreditCardTransaction,
    Document,
    DocumentExtraction,
    Estimate,
    ExtractionField,
    GlAccount,
    InboundMessage,
    Invoice,
    MailboxCheckpointRow,
    MessageAttachment,
    OutboxMessage,
    PaymentPackage,
    PaymentPackageLine,
    PurchaseOrder,
    PurchaseOrderThreshold,
    RecordActionRow,
    ReminderSchedule,
    RetentionPolicy,
    SavedView,
    SignedLink,
    StateTransitionRow,
    SystemSetting,
    User,
    UserRole,
    Vendor,
    VendorCheckIn,
)
from finora.infrastructure.db.session import get_session_factory

#: The purchase order control the migration seeds: JMD 50,000, above which an
#: invoice must name an order. Mirrored here so a test can assert against the
#: figure the platform actually ships with.
PO_THRESHOLD_CURRENCY = "JMD"
PO_THRESHOLD_MINOR_UNITS = 5_000_000

#: Provisional retention defaults the migration seeds. Restored after each test
#: so a deactivated or edited policy does not leak into the next run.
DEFAULT_RETENTION_POLICIES: tuple[tuple[str, int, str], ...] = (
    ("inbound_messages", 2555, "Inbound mail and attachments"),
    ("documents", 2555, "Accepted document readings"),
    ("estimates", 2555, "Estimates and approval history"),
    ("invoices", 2555, "Invoices and payment history"),
    ("payment_packages", 2555, "Payment packages and manifests"),
    ("audit_entries", 3650, "Immutable audit trail"),
    ("credit_card_periods", 2555, "Credit-card statement periods"),
    ("accrual_periods", 2555, "Month-end accrual periods"),
)


def _database_available() -> bool:
    try:
        with get_session_factory()() as session:
            session.execute(text("SELECT 1"))
        return True
    except Exception:
        return False


requires_db = pytest.mark.skipif(
    not _database_available(),
    reason="PostgreSQL is not reachable. Run `pnpm stack:up` first.",
)


@pytest.fixture
def db_session() -> Iterator[Session]:
    session = get_session_factory()()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture(autouse=True)
def clean_tables() -> Iterator[None]:
    """Remove rows this test suite creates, before and after each test.

    Ordering respects foreign keys. The audit table is truncated so each test
    starts from a known chain position.
    """

    def _wipe() -> None:
        with get_session_factory()() as session:
            # Deleted explicitly rather than left to the cascade, so a test that
            # fails here says which table it choked on.
            # Estimates first: they reference the document they were raised from.
            session.execute(delete(ApprovalStep))
            session.execute(delete(ApprovalRequest))
            # Check-ins before the packages they ask about, for the same reason
            # the lines go before the invoices: RESTRICT, because a conversation
            # with a supplier about a payment must not outlive the record of the
            # payment itself.
            session.execute(delete(VendorCheckIn))
            # Package lines before the invoices they hold: the foreign key is
            # RESTRICT rather than CASCADE, because an invoice must not be
            # deletable out from under a package that claims to have paid it.
            session.execute(delete(PaymentPackageLine))
            session.execute(delete(PaymentPackage))
            # Card transactions before periods and cards, and before the GL,
            # cost centres and documents they may name.
            session.execute(delete(CreditCardTransaction))
            session.execute(delete(CreditCardPeriod))
            session.execute(delete(CreditCardAccount))
            # Accrual candidates name invoices, so the pack goes before them.
            session.execute(delete(AccrualExport))
            session.execute(delete(AccrualCandidate))
            session.execute(delete(AccrualPeriod))
            # Invoices before the estimates, orders and documents they point at.
            session.execute(delete(Invoice))
            session.execute(delete(PurchaseOrder))
            session.execute(delete(SignedLink))
            session.execute(delete(ReminderSchedule))
            session.execute(delete(OutboxMessage))
            session.execute(delete(Estimate))
            session.execute(delete(ExtractionField))
            session.execute(delete(DocumentExtraction))
            session.execute(delete(Document))
            session.execute(delete(MessageAttachment))
            session.execute(delete(InboundMessage))
            session.execute(delete(MailboxCheckpointRow))
            session.execute(delete(BusinessCalendarDay))
            session.execute(delete(CostCentre))
            session.execute(delete(GlAccount))
            session.execute(delete(Vendor))
            session.execute(delete(RecordActionRow))
            session.execute(delete(StateTransitionRow))
            session.execute(delete(AuditEntryRow))
            session.execute(delete(ApprovalAssignment))

            # Approval rules before the users they name. A rule is never edited
            # or deleted in production, so nothing else clears them: a test that
            # writes or retires one leaves a row pointing at an actor about to
            # be deleted, and every later test dies on the foreign key rather
            # than on anything to do with itself.
            session.execute(delete(ApprovalRule).where(ApprovalRule.created_by_id.is_not(None)))
            session.execute(
                update(ApprovalRule)
                .where(ApprovalRule.retired_by_id.is_not(None))
                .values(is_active=True, retired_at=None, retired_by_id=None)
            )

            session.execute(delete(UserRole))
            session.execute(delete(SavedView))
            # Settings may name an updater; clear before users.
            session.execute(delete(SystemSetting))
            session.execute(delete(User))

            # Reference data the migration seeds, restored rather than merely
            # wiped: a test that switches the purchase order control off must
            # not leave it off for everything that runs afterwards.
            session.execute(delete(PurchaseOrderThreshold))
            session.add(
                PurchaseOrderThreshold(
                    currency=PO_THRESHOLD_CURRENCY,
                    applies_above_minor_units=PO_THRESHOLD_MINOR_UNITS,
                    is_active=True,
                )
            )
            # No user FK; restore seeded defaults like thresholds so a test that
            # edits or deactivates a policy cannot poison the next run.
            session.execute(delete(RetentionPolicy))
            for record_class, days, description in DEFAULT_RETENTION_POLICIES:
                session.add(
                    RetentionPolicy(
                        record_class=record_class,
                        retention_days=days,
                        description=description,
                        is_active=True,
                    )
                )
            session.commit()

    from finora.infrastructure.ai_gateway import set_runtime_kill_switch

    set_runtime_kill_switch(None)
    _wipe()
    yield
    set_runtime_kill_switch(None)
    _wipe()


def make_user(
    session: Session,
    *,
    email: str,
    display_name: str,
    roles: list[Role],
    department: str | None = "Finance",
    is_active: bool = True,
) -> User:
    user = User(
        id=uuid.uuid4(),
        subject=f"local|{email}",
        email=email.lower(),
        display_name=display_name,
        department=department,
        is_active=is_active,
    )
    session.add(user)
    session.flush()
    for role in roles:
        session.add(UserRole(user_id=user.id, role=role))
    session.commit()
    session.refresh(user)
    return user


def make_cost_centre(
    session: Session,
    *,
    code: str = "CC-100",
    name: str = "Facilities",
    department: str | None = "Facilities",
) -> CostCentre:
    row = CostCentre(id=uuid.uuid4(), code=code, name=name, department=department)
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def make_vendor(
    session: Session,
    *,
    code: str = "V-100",
    name: str = "Kingston Supplies Limited",
    email: str | None = "accounts@kingston-supplies.example",
) -> Vendor:
    """A supplier on the master. Invoices refuse to pay anybody who is not on it.

    An address by default, because most suppliers have one and the ones that do
    not are the interesting case rather than the baseline. Pass `email=None` to
    get a supplier who can only be reached by telephone.
    """
    row = Vendor(id=uuid.uuid4(), code=code, name=name, email=email)
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def make_purchase_order(
    session: Session,
    *,
    vendor: Vendor,
    number: str = "PO-1000",
    total_minor_units: int = 10_000_000,
    currency: str = "JMD",
    state: WorkflowState = WorkflowState.approved,
    is_closed: bool = False,
    raised_by: User | None = None,
    cost_centre: CostCentre | None = None,
    estimate_id: uuid.UUID | None = None,
) -> PurchaseOrder:
    """An order that is live and taking invoices unless told otherwise.

    `is_closed` rather than a closed state, because closing is not a state: a
    closed order is still approved, and what changed is that nobody expects any
    more against it.
    """
    raiser = raised_by or make_user(
        session,
        email=f"raiser-{uuid.uuid4().hex[:8]}@example.test",
        display_name="Order Raiser",
        roles=[Role.requester],
    )
    centre = cost_centre or make_cost_centre(
        session, code=f"CC-{uuid.uuid4().hex[:4].upper()}", name="Facilities"
    )
    committed = state is not WorkflowState.draft
    now = datetime.now(UTC)

    row = PurchaseOrder(
        id=uuid.uuid4(),
        number=number,
        state=state,
        raised_by_id=raiser.id,
        vendor_id=vendor.id,
        currency=currency,
        total_minor_units=total_minor_units,
        description="Air handling units for the third floor",
        cost_centre_id=centre.id,
        department=centre.department,
        estimate_id=estimate_id,
        submitted_at=now if committed else None,
        submitted_by_id=raiser.id if committed else None,
        opened_at=now if state is WorkflowState.approved else None,
        closed_at=now if is_closed else None,
        closed_by_id=raiser.id if is_closed else None,
        closed_reason="Delivered in full" if is_closed else None,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def make_estimate(
    session: Session,
    *,
    requester: User,
    vendor: Vendor,
    cost_centre: CostCentre | None = None,
    reference: str | None = None,
    total_minor_units: int = 4_000_000,
    currency: str = "JMD",
    state: WorkflowState = WorkflowState.approved,
) -> Estimate:
    """An estimate complete enough to satisfy the past-draft constraints."""
    centre = cost_centre or make_cost_centre(
        session, code=f"CC-{uuid.uuid4().hex[:4].upper()}", name="Facilities"
    )
    committed = state is not WorkflowState.draft
    now = datetime.now(UTC)

    row = Estimate(
        id=uuid.uuid4(),
        reference=reference or f"EST-{uuid.uuid4().hex[:6].upper()}",
        state=state,
        requester_id=requester.id,
        vendor_id=vendor.id,
        vendor_name=vendor.name,
        estimate_number="Q-1001",
        estimate_date=now.date(),
        description="Air handling units for the third floor",
        justification="The existing units failed inspection.",
        total_minor_units=total_minor_units,
        currency=currency,
        cost_centre_id=centre.id,
        department=requester.department,
        submitted_at=now if committed else None,
        submitted_by_id=requester.id if committed else None,
        decided_at=now if state is WorkflowState.approved else None,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def make_invoice(
    session: Session,
    *,
    recorded_by: User,
    vendor: Vendor,
    purchase_order: PurchaseOrder | None = None,
    cost_centre: CostCentre | None = None,
    total_minor_units: int = 1_000_000,
    currency: str = "JMD",
    invoice_number: str | None = None,
    state: WorkflowState = WorkflowState.approved,
) -> Invoice:
    """An invoice billed against an order, for capacity and overrun tests."""
    centre = cost_centre or make_cost_centre(
        session, code=f"CC-{uuid.uuid4().hex[:4].upper()}", name="Facilities"
    )
    row = Invoice(
        id=uuid.uuid4(),
        reference=f"INV-{uuid.uuid4().hex[:6].upper()}",
        state=state,
        created_by_id=recorded_by.id,
        requester_id=recorded_by.id,
        vendor_id=vendor.id,
        vendor_name=vendor.name,
        invoice_number=invoice_number or f"S-{uuid.uuid4().hex[:6].upper()}",
        invoice_date=datetime.now(UTC).date(),
        description="Part delivery against the order",
        total_minor_units=total_minor_units,
        currency=currency,
        cost_centre_id=centre.id,
        purchase_order_id=purchase_order.id if purchase_order is not None else None,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def assign_approver(
    session: Session,
    *,
    user: User,
    level: ApprovalLevel,
    department: str | None = None,
) -> ApprovalAssignment:
    """Put a user on the approval matrix at one level.

    `department` left as None means organisation-wide, which is what most tests
    want: a route planned for any department will find this approver.
    """
    row = ApprovalAssignment(id=uuid.uuid4(), user_id=user.id, level=level, department=department)
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


@pytest.fixture
def client() -> Iterator[TestClient]:
    get_settings.cache_clear()
    app = create_app()
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def api_prefix() -> str:
    return get_settings().api_prefix


def sign_in(client: TestClient, email: str, api_prefix: str) -> None:
    response = client.post(f"{api_prefix}/auth/local/sign-in", json={"email": email})
    assert response.status_code == 200, response.text
