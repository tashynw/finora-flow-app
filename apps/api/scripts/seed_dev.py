"""Create the development data the local stack and the visual suite depend on.

Three things, in order: the accounts that sign in, the coded references an
estimate cannot be completed without, and the approval assignments without which
no route can be opened.

The reference data is here rather than in a migration on purpose. A cost centre
is somebody's real budget line and a vendor is a real company, so shipping
invented ones as part of the schema would put them in production. A migration
seeds the approval *matrix*, which is policy the requirements state; who occupies
each level, and which cost centres exist, are configuration for a deployment to
enter.

Refuses to run outside development. These accounts have no password, because the
local sign-in path they use has none, and a passwordless account reachable in
production would be a straightforward account takeover.

Idempotent: running it twice updates rather than failing, so it is safe to call
from a task runner or from the visual suite's database reset.
"""

from __future__ import annotations

import sys
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from finora.config import Environment, get_settings
from finora.domain.roles import ApprovalLevel, Role
from finora.domain.workflow import WorkflowState
from finora.infrastructure.db.models import (
    ApprovalAssignment,
    CostCentre,
    GlAccount,
    PurchaseOrder,
    User,
    UserRole,
    Vendor,
)
from finora.infrastructure.db.session import session_scope

#: One account per role that owns a screen, so a reviewer can see each screen as
#: the person who actually uses it rather than as a superuser who sees everything.
#:
#: `.example` rather than `.test`: both are reserved, but the email validator the
#: API uses rejects `.test` outright, so an account on it could be created here
#: and then never be able to sign in.
DOMAIN = "finora.example"

ACCOUNTS: tuple[tuple[str, str, str, list[Role]], ...] = (
    (f"clerk@{DOMAIN}", "Casey Clerk", "Accounts Payable", [Role.finance]),
    # Codes credit-card statements. Separate from the clerk only so the visual
    # suite can exercise segregation of duties on a period: the person who codes
    # the lines must not be the person who closes them, and one finance account
    # holding both actions on the same period would make that impossible to check.
    (f"closer@{DOMAIN}", "Chris Closer", "Accounts Payable", [Role.finance]),
    (f"ops@{DOMAIN}", "Omar Operations", "Platform", [Role.operations]),
    (f"approver@{DOMAIN}", "Ana Approver", "Operations", [Role.approver]),
    (f"manager@{DOMAIN}", "Marcus Manager", "Operations", [Role.approver]),
    (f"requester@{DOMAIN}", "Rina Requester", "Facilities", [Role.requester]),
    (f"auditor@{DOMAIN}", "Ada Auditor", "Internal Audit", [Role.auditor]),
    # Assembles payment packages and sends them. Separate from finance, which
    # holds the right to declare a payment received: sending the money and
    # confirming it arrived are the pair segregation of duties most exists to
    # keep apart, and one account holding both would make the payment screens
    # impossible to check for it.
    (
        f"payments@{DOMAIN}",
        "Paula Payments",
        "Treasury",
        [Role.payment_coordinator],
    ),
    # Configures the approval matrix and approves nothing. Deliberately not also
    # an approver: an account that could both write the rules and satisfy them
    # would make every administration screen impossible to check for the one
    # thing that matters, which is that the two rights are held by two people.
    (f"admin@{DOMAIN}", "Alex Administrator", "Finance", [Role.administrator]),
)

#: Who sits at each level of the matrix. Left department-wide (None) so a route
#: planned for any department finds an approver: a development stack with a
#: department-scoped matrix and one requester is a stack where nothing can be
#: submitted, which teaches the wrong lesson about a real refusal.
ASSIGNMENTS: tuple[tuple[str, ApprovalLevel], ...] = (
    (f"approver@{DOMAIN}", ApprovalLevel.unit_head),
    (f"manager@{DOMAIN}", ApprovalLevel.manager),
    (f"manager@{DOMAIN}", ApprovalLevel.hod),
    (f"manager@{DOMAIN}", ApprovalLevel.coo),
)

#: (code, name, department)
COST_CENTRES: tuple[tuple[str, str, str], ...] = (
    ("CC-100", "Facilities", "Facilities"),
    ("CC-200", "Information Technology", "Technology"),
    ("CC-300", "Marketing", "Marketing"),
)

#: (code, name)
GL_ACCOUNTS: tuple[tuple[str, str], ...] = (
    ("6100", "Repairs and maintenance"),
    ("6200", "Computer equipment"),
    ("6300", "Advertising and promotion"),
    ("6400", "Professional fees"),
)

#: (code, name, accounts email or None)
#:
#: "Kingston Supplies Limited" matches the supplier on the PDF the review tests
#: build, so raising an estimate from that reading links to a supplier record
#: rather than leaving a typed-in name. That link is part of what those tests are
#: checking, so the two names have to agree.
#:
#: One supplier deliberately has no address. Asking whether a payment arrived is
#: done by email, and a master where every record has one would let the screens
#: for the supplier who can only be telephoned go unbuilt and unseen. `.example`
#: throughout, which is reserved and cannot resolve, so a misconfigured
#: development mailer cannot write to a real company.
VENDORS: tuple[tuple[str, str, str | None], ...] = (
    ("V-0001", "Kingston Supplies Limited", "accounts@kingston-supplies.example"),
    ("V-0002", "Caribbean Facilities Services", "ar@caribbean-facilities.example"),
    ("V-0003", "Island Technology Partners", None),
)

#: (number, vendor code, currency, total in minor units, is closed, description)
#:
#: Enough to exercise every purchase-order control an invoice can fail: one open
#: order with room in it, one open order too small for the invoice a tester would
#: naturally put against it, and one closed. Without a closed order to hand,
#: "nothing further should be billed against this" is a rule nobody sees working
#: until it refuses somebody in production.
#:
#: Closed is a flag rather than a state, because closing does not undo approval:
#: a closed order is still an approved commitment that was honoured, and what
#: changed is that nobody expects any more against it.
PURCHASE_ORDERS: tuple[tuple[str, str, str, int, bool, str], ...] = (
    ("PO-2026-0001", "V-0001", "JMD", 60_000_00, False, "Air-conditioning units"),
    ("PO-2026-0002", "V-0002", "JMD", 45_000_00, False, "Quarterly cleaning"),
    ("PO-2026-0003", "V-0003", "JMD", 80_000_00, True, "Laptop refresh, completed"),
)


def _accounts(session: Session) -> None:
    for email, display_name, department, roles in ACCOUNTS:
        user = session.execute(select(User).where(User.email == email)).scalar_one_or_none()
        if user is None:
            user = User(email=email, display_name=display_name)
            session.add(user)
        user.display_name = display_name
        user.department = department
        user.is_active = True
        user.archived_at = None

        # Replaced rather than added to, so removing a role from this script
        # actually removes it and a re-run cannot silently accumulate grants.
        # The delete is flushed before the insert, because the unique constraint
        # on (user_id, role) would otherwise reject re-granting a role the user
        # already has.
        user.role_assignments.clear()
        session.flush()
        user.role_assignments.extend(UserRole(role=role) for role in roles)
        session.flush()
        print(f"{email:28} {', '.join(str(r) for r in roles)}")


def _references(session: Session) -> None:
    for code, name, department in COST_CENTRES:
        row = session.execute(
            select(CostCentre).where(CostCentre.code == code)
        ).scalar_one_or_none()
        if row is None:
            row = CostCentre(code=code)
            session.add(row)
        row.name = name
        row.department = department
        row.is_active = True
        row.archived_at = None

    for code, name in GL_ACCOUNTS:
        account = session.execute(
            select(GlAccount).where(GlAccount.code == code)
        ).scalar_one_or_none()
        if account is None:
            account = GlAccount(code=code)
            session.add(account)
        account.name = name
        account.is_active = True
        account.archived_at = None

    for code, name, email in VENDORS:
        vendor = session.execute(select(Vendor).where(Vendor.code == code)).scalar_one_or_none()
        if vendor is None:
            vendor = Vendor(code=code)
            session.add(vendor)
        vendor.name = name
        vendor.email = email
        vendor.is_active = True
        vendor.archived_at = None

    session.flush()

    buyer = session.execute(select(User).where(User.email == f"clerk@{DOMAIN}")).scalar_one()
    facilities = session.execute(select(CostCentre).where(CostCentre.code == "CC-100")).scalar_one()
    now = datetime.now(UTC)

    for number, vendor_code, currency, total, is_closed, description in PURCHASE_ORDERS:
        vendor = session.execute(select(Vendor).where(Vendor.code == vendor_code)).scalar_one()
        order = session.execute(
            select(PurchaseOrder).where(PurchaseOrder.number == number)
        ).scalar_one_or_none()
        if order is None:
            order = PurchaseOrder(number=number)
            session.add(order)
        order.raised_by_id = buyer.id
        order.vendor_id = vendor.id
        order.currency = currency
        order.total_minor_units = total
        order.cost_centre_id = facilities.id
        order.department = facilities.department
        order.state = WorkflowState.approved
        order.submitted_at = now
        order.submitted_by_id = buyer.id
        order.opened_at = now
        order.closed_at = now if is_closed else None
        order.closed_by_id = buyer.id if is_closed else None
        order.closed_reason = "Delivered in full" if is_closed else None
        order.description = description
        order.archived_at = None

    session.flush()
    print(
        f"\n{len(COST_CENTRES)} cost centres, {len(GL_ACCOUNTS)} GL accounts, "
        f"{len(VENDORS)} vendors, {len(PURCHASE_ORDERS)} purchase orders ready."
    )


def _assignments(session: Session) -> None:
    for email, level in ASSIGNMENTS:
        user = session.execute(select(User).where(User.email == email)).scalar_one()
        existing = session.execute(
            select(ApprovalAssignment).where(
                ApprovalAssignment.user_id == user.id,
                ApprovalAssignment.level == level,
                ApprovalAssignment.department.is_(None),
            )
        ).scalar_one_or_none()
        if existing is None:
            session.add(ApprovalAssignment(user_id=user.id, level=level, department=None))
        print(f"{email:28} approves as {level}")
    session.flush()


def main() -> int:
    settings = get_settings()
    if settings.environment is not Environment.development:
        print(
            f"Refusing to seed in {settings.environment}. "
            "These accounts sign in without a password."
        )
        return 1
    if not settings.auth.allow_local_accounts:
        print("Local accounts are disabled, so these users could not sign in. Nothing was created.")
        return 1

    with session_scope() as session:
        _accounts(session)
        _references(session)
        print()
        _assignments(session)

    print(f"\n{len(ACCOUNTS)} development accounts ready.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
