"""Populate a development stack with representative transactional data.

`seed_dev.py` creates the accounts and reference data a stack cannot run without,
and deliberately stops there — a real cost centre and a real vendor are the only
records honest enough to ship. This script is different in kind: it exists so a
reviewer signing in sees the product working rather than a wall of empty states,
and every figure the dashboard then shows is counted from something real here.

It refuses to run outside development, the same as the account seed, because the
records it writes are invented and have no place in a real ledger. It is
idempotent by a marker reference: run twice and the second run does nothing.

The records are built directly rather than driven through the services, the way
`seed_dev` builds its purchase orders. Demonstration data needs to land in a
spread of end states — paid, outstanding, in approval — without replaying every
transition that reaches them, and the services (correctly) refuse the shortcuts
that would require. The approval routes are the exception: those are opened
through `ApprovalService` so the work queue shows genuine, decidable steps.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from finora.application.approvals import ApprovalService
from finora.config import Environment, get_settings
from finora.domain.money import Money
from finora.domain.workflow import WorkflowState
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import (
    AccrualCandidate,
    AccrualPeriod,
    CostCentre,
    Estimate,
    GlAccount,
    Invoice,
    PaymentPackage,
    PaymentPackageLine,
    User,
    Vendor,
)
from finora.infrastructure.db.session import session_scope

DOMAIN = "finora.example"

#: Any invoice carrying this prefix means the stack has already been demo-seeded.
MARKER = "INV-D-"


@dataclass(frozen=True, slots=True)
class _Actor:
    """Adapter so a seeded User satisfies ApprovalService's Actor protocol."""

    user_id: UUID
    display_name: str


def _months_ago(months: int) -> date:
    anchor = datetime.now(UTC).date().replace(day=15)
    year = anchor.year
    month = anchor.month - months
    while month <= 0:
        month += 12
        year -= 1
    return date(year, month, 15)


def _at(day: date) -> datetime:
    return datetime(day.year, day.month, day.day, 12, 0, tzinfo=UTC)


#: (suffix, vendor_code, cost_centre_code, gl_code, amount_minor, state,
#:  months_ago, due_offset_days, description)
#:
#: Spread across states and months so the KPI band, the state mix, the aging
#: buckets and the six-month trend all have something honest to show.
_INVOICES: tuple[tuple[str, str, str, str, int, WorkflowState, int, int | None, str], ...] = (
    (
        "0001",
        "V-0001",
        "CC-100",
        "6100",
        1_284_500,
        WorkflowState.paid,
        5,
        -20,
        "Chiller repair, east wing",
    ),
    (
        "0002",
        "V-0002",
        "CC-100",
        "6100",
        742_000,
        WorkflowState.paid,
        4,
        -15,
        "Quarterly deep clean",
    ),
    (
        "0003",
        "V-0003",
        "CC-200",
        "6200",
        3_950_000,
        WorkflowState.paid,
        3,
        -18,
        "Laptop refresh, batch one",
    ),
    (
        "0004",
        "V-0001",
        "CC-100",
        "6100",
        585_000,
        WorkflowState.outstanding,
        1,
        -6,
        "Emergency plumbing",
    ),
    (
        "0005",
        "V-0002",
        "CC-100",
        "6400",
        1_120_000,
        WorkflowState.outstanding,
        1,
        4,
        "Grounds maintenance, Q2",
    ),
    (
        "0006",
        "V-0003",
        "CC-200",
        "6200",
        2_460_000,
        WorkflowState.outstanding,
        0,
        21,
        "Network switches",
    ),
    (
        "0007",
        "V-0001",
        "CC-300",
        "6300",
        890_000,
        WorkflowState.approved,
        0,
        30,
        "Trade show stand",
    ),
    (
        "0008",
        "V-0002",
        "CC-100",
        "6100",
        430_000,
        WorkflowState.approved,
        0,
        25,
        "Pest control contract",
    ),
    (
        "0009",
        "V-0003",
        "CC-200",
        "6200",
        1_675_000,
        WorkflowState.ready_for_submission,
        0,
        12,
        "Monitors and docks",
    ),
    (
        "0010",
        "V-0001",
        "CC-300",
        "6300",
        615_000,
        WorkflowState.ready_for_submission,
        0,
        10,
        "Print and signage",
    ),
    (
        "0011",
        "V-0002",
        "CC-100",
        "6400",
        2_050_000,
        WorkflowState.submitted,
        0,
        8,
        "Annual audit fees",
    ),
    (
        "0012",
        "V-0003",
        "CC-200",
        "6200",
        4_380_000,
        WorkflowState.pending_approval,
        0,
        40,
        "Server room UPS",
    ),
    (
        "0013",
        "V-0001",
        "CC-100",
        "6100",
        268_000,
        WorkflowState.pending_approval,
        0,
        35,
        "Fire extinguisher service",
    ),
    (
        "0014",
        "V-0002",
        "CC-300",
        "6300",
        995_000,
        WorkflowState.pending_sign_off,
        0,
        28,
        "Campaign photography",
    ),
    (
        "0015",
        "V-0003",
        "CC-200",
        "6200",
        1_540_000,
        WorkflowState.exception,
        0,
        5,
        "Duplicate of S-0006?",
    ),
    (
        "0016",
        "V-0001",
        "CC-100",
        "6100",
        175_000,
        WorkflowState.draft,
        0,
        None,
        "Door hardware, unconfirmed",
    ),
)

#: (suffix, vendor_code, cost_centre_code, amount_minor, state, months_ago, description)
_ESTIMATES: tuple[tuple[str, str, str, int, WorkflowState, int, str], ...] = (
    (
        "0001",
        "V-0001",
        "CC-100",
        4_800_000,
        WorkflowState.approved,
        2,
        "Roof replacement, main block",
    ),
    ("0002", "V-0003", "CC-200", 6_250_000, WorkflowState.approved, 1, "Meeting-room AV upgrade"),
    (
        "0003",
        "V-0002",
        "CC-100",
        1_900_000,
        WorkflowState.pending_approval,
        0,
        "Car-park resurfacing",
    ),
    (
        "0004",
        "V-0003",
        "CC-200",
        3_100_000,
        WorkflowState.pending_approval,
        0,
        "Wi-Fi coverage extension",
    ),
    ("0005", "V-0001", "CC-300", 720_000, WorkflowState.draft, 0, "Booth refresh, unconfirmed"),
    (
        "0006",
        "V-0002",
        "CC-100",
        1_450_000,
        WorkflowState.rejected,
        1,
        "Landscaping, declined on budget",
    ),
)


def _lookup(
    session: Session,
) -> tuple[dict[str, User], dict[str, Vendor], dict[str, CostCentre], dict[str, GlAccount]]:
    users = {user.email: user for user in session.execute(select(User)).scalars()}
    vendors = {v.code: v for v in session.execute(select(Vendor)).scalars()}
    centres = {c.code: c for c in session.execute(select(CostCentre)).scalars()}
    accounts = {g.code: g for g in session.execute(select(GlAccount)).scalars()}
    return users, vendors, centres, accounts


def _seed(session: Session) -> None:
    users, vendors, centres, accounts = _lookup(session)

    clerk = users[f"clerk@{DOMAIN}"]
    requester = users[f"requester@{DOMAIN}"]
    payments = users[f"payments@{DOMAIN}"]

    invoices: dict[str, Invoice] = {}
    for (
        suffix,
        vendor_code,
        centre_code,
        gl_code,
        amount,
        state,
        months,
        due_offset,
        description,
    ) in _INVOICES:
        vendor = vendors[vendor_code]
        centre = centres[centre_code]
        booked = _months_ago(months)
        committed = state is not WorkflowState.draft
        invoice = Invoice(
            id=uuid4(),
            reference=f"{MARKER}{suffix}",
            state=state,
            created_by_id=clerk.id,
            requester_id=requester.id,
            vendor_id=vendor.id,
            vendor_name=vendor.name,
            invoice_number=f"SUP-{vendor_code[-1]}-{suffix}",
            invoice_date=booked,
            due_date=(booked + timedelta(days=due_offset)) if due_offset is not None else None,
            description=description,
            total_minor_units=amount,
            currency="JMD",
            cost_centre_id=centre.id,
            gl_account_id=accounts[gl_code].id,
            department=centre.department,
            created_at=_at(booked),
            submitted_at=_at(booked) if committed else None,
            submitted_by_id=clerk.id if committed else None,
        )
        session.add(invoice)
        invoices[suffix] = invoice
    session.flush()

    # An open payment package holding the two invoices ready for the bank.
    package = PaymentPackage(
        id=uuid4(),
        reference="PKG-D-0001",
        description="Weekly supplier run",
        created_by_id=payments.id,
        created_at=_at(_months_ago(0)),
    )
    session.add(package)
    session.flush()
    for suffix in ("0009", "0010"):
        invoice = invoices[suffix]
        session.add(
            PaymentPackageLine(
                id=uuid4(),
                package_id=package.id,
                invoice_id=invoice.id,
                invoice_reference=invoice.reference,
                invoice_number=invoice.invoice_number,
                vendor_id=invoice.vendor_id,
                vendor_name=invoice.vendor_name,
                currency=invoice.currency,
                amount_minor_units=invoice.total_minor_units or 0,
                due_date=invoice.due_date,
                added_by_id=payments.id,
            )
        )

    # An open accrual period drawn from the outstanding invoices.
    last_month_end = _months_ago(0).replace(day=1) - timedelta(days=1)
    period = AccrualPeriod(
        id=uuid4(),
        reference="ACR-D-0001",
        period_start=last_month_end.replace(day=1),
        period_end=last_month_end,
        label=last_month_end.strftime("%B %Y month-end"),
        opened_by_id=clerk.id,
    )
    session.add(period)
    session.flush()
    for index, suffix in enumerate(("0004", "0005", "0006"), start=1):
        invoice = invoices[suffix]
        session.add(
            AccrualCandidate(
                id=uuid4(),
                period_id=period.id,
                reference=f"AC-{index:04d}",
                invoice_id=invoice.id,
                currency=invoice.currency,
                amount_minor_units=invoice.total_minor_units or 0,
                original_amount_minor_units=invoice.total_minor_units or 0,
                vendor_name=invoice.vendor_name,
                invoice_number=invoice.invoice_number,
                invoice_reference=invoice.reference,
                description=invoice.description or "",
                department=invoice.department,
                gl_account_id=invoice.gl_account_id,
                cost_centre_id=invoice.cost_centre_id,
            )
        )

    estimates: dict[str, Estimate] = {}
    for suffix, vendor_code, centre_code, amount, state, months, description in _ESTIMATES:
        vendor = vendors[vendor_code]
        centre = centres[centre_code]
        booked = _months_ago(months)
        committed = state is not WorkflowState.draft
        estimate = Estimate(
            id=uuid4(),
            reference=f"EST-D-{suffix}",
            state=state,
            requester_id=requester.id,
            vendor_id=vendor.id,
            vendor_name=vendor.name,
            estimate_number=f"Q-{suffix}",
            estimate_date=booked,
            description=description,
            justification="Raised for the demonstration data set.",
            total_minor_units=amount,
            currency="JMD",
            cost_centre_id=centre.id,
            department=centre.department,
            created_at=_at(booked),
            submitted_at=_at(booked) if committed else None,
            submitted_by_id=requester.id if committed else None,
            decided_at=_at(booked)
            if state in {WorkflowState.approved, WorkflowState.rejected}
            else None,
        )
        session.add(estimate)
        estimates[suffix] = estimate
    session.flush()

    _open_routes(session, clerk, requester, invoices, estimates, centres)

    print(
        f"{len(_INVOICES)} invoices, {len(_ESTIMATES)} estimates, "
        "1 payment package, 1 accrual period seeded."
    )


def _open_routes(
    session: Session,
    clerk: User,
    requester: User,
    invoices: dict[str, Invoice],
    estimates: dict[str, Estimate],
    centres: dict[str, CostCentre],
) -> None:
    """Open genuine approval routes for the records left pending.

    Best-effort: if the matrix or assignments are not seeded the routes simply do
    not open, and the rest of the demonstration data still stands.
    """
    approvals = ApprovalService(session=session, audit=AuditRepository(session))

    def route(
        record_type: str,
        record_id: UUID,
        amount: int,
        currency: str,
        department: str | None,
        actor: User,
        requester_id: UUID,
    ) -> None:
        try:
            approvals.open_route(
                record_type=record_type,
                record_id=record_id,
                amount=Money(amount, currency),
                department=department,
                requester_id=requester_id,
                actor=_Actor(user_id=actor.id, display_name=actor.display_name),
                correlation_id=uuid4(),
            )
        except Exception as error:
            print(f"  route for {record_type} skipped: {error}")

    for suffix in ("0012", "0013"):
        invoice = invoices[suffix]
        route(
            "invoice",
            invoice.id,
            invoice.total_minor_units or 0,
            invoice.currency or "JMD",
            invoice.department,
            clerk,
            requester.id,
        )
    for suffix in ("0003", "0004"):
        estimate = estimates[suffix]
        route(
            "estimate",
            estimate.id,
            estimate.total_minor_units or 0,
            estimate.currency or "JMD",
            estimate.department,
            requester,
            requester.id,
        )


def main() -> int:
    settings = get_settings()
    if settings.environment is not Environment.development:
        print(f"Refusing to seed demonstration data in {settings.environment}.")
        return 1

    with session_scope() as session:
        existing = session.execute(
            select(Invoice).where(Invoice.reference.like(f"{MARKER}%")).limit(1)
        ).scalar_one_or_none()
        if existing is not None:
            print("Demonstration data already present. Nothing to do.")
            return 0
        _seed(session)

    print("\nDemonstration data ready.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
