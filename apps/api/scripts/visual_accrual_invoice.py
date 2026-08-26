"""Plant one unpaid invoice for the accrual visual flow.

The accrual flow needs a candidate source: an unpaid invoice dated inside the
period it opens. Earlier flows leave invoices too, but theirs are dated in July
and the accrual period is May, so they are filtered out. Putting a May row in
`seed_dev` would show up on the empty invoice register the viewport projects
photograph before any flow runs.

So the invoice is created here, on demand, against the visual database only —
after those empty baselines are taken, and only when the accrual flow asks for
it. Outstanding rather than approved: approved invoices are offered to payment
packages, and a seed sitting there would break the payment visual's exact count
if it ever landed earlier in the suite.

Development only. Refuses any database but the visual one.
"""

from __future__ import annotations

import os
import sys
from datetime import date

from sqlalchemy import select

from finora.config import Environment, get_settings
from finora.domain.workflow import WorkflowState
from finora.infrastructure.db.models import CostCentre, Invoice, User, Vendor
from finora.infrastructure.db.session import session_scope

VISUAL_DB = "finora_visual"
DOMAIN = "finora.example"
REFERENCE = "INV-ACCRUAL-SEED"


def main() -> int:
    if os.environ.get("FINORA_DB_NAME") != VISUAL_DB:
        print(
            f"FINORA_DB_NAME must be '{VISUAL_DB}'. Nothing was created.",
            file=sys.stderr,
        )
        return 1

    settings = get_settings()
    if settings.environment is not Environment.development:
        print(f"Refusing to plant an invoice in {settings.environment}.", file=sys.stderr)
        return 1

    with session_scope() as session:
        clerk = session.execute(select(User).where(User.email == f"clerk@{DOMAIN}")).scalar_one()
        requester = session.execute(
            select(User).where(User.email == f"requester@{DOMAIN}")
        ).scalar_one()
        vendor = session.execute(select(Vendor).where(Vendor.code == "V-0001")).scalar_one()
        facilities = session.execute(
            select(CostCentre).where(CostCentre.code == "CC-100")
        ).scalar_one()

        invoice = session.execute(
            select(Invoice).where(Invoice.reference == REFERENCE)
        ).scalar_one_or_none()
        if invoice is None:
            invoice = Invoice(reference=REFERENCE)
            session.add(invoice)

        invoice.state = WorkflowState.outstanding
        invoice.created_by_id = clerk.id
        invoice.requester_id = requester.id
        invoice.vendor_id = vendor.id
        invoice.vendor_name = vendor.name
        invoice.invoice_number = "ACC-SEED-1"
        invoice.invoice_date = date(2026, 5, 14)
        invoice.currency = "JMD"
        invoice.total_minor_units = 18_500_00
        invoice.description = "May facilities maintenance still unpaid at period end"
        invoice.cost_centre_id = facilities.id
        invoice.department = facilities.department
        invoice.archived_at = None
        session.flush()

    print(REFERENCE)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
