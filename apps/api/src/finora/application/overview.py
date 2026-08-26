"""Read-only aggregates for the executive overview.

Every number here is counted or summed from records that already exist. Nothing
is projected, smoothed or invented: an empty deployment returns zeros, and a
figure on the dashboard can always be reached by opening the register behind it.

Amounts are kept in their own currency and summed per currency, then the
currency carrying the most invoices is reported as the primary one. A deployment
that pays in one currency sees one honest total; a mixed one is not silently
added together across currencies, which would be meaningless money.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Final

from sqlalchemy import select
from sqlalchemy.orm import Session

from finora.domain.money import Money
from finora.domain.workflow import WorkflowState
from finora.infrastructure.db.models import (
    AccrualPeriod,
    CreditCardPeriod,
    Estimate,
    Invoice,
    PaymentPackage,
    PurchaseOrder,
)

#: Invoice states that still owe somebody money — approved through to sitting
#: outstanding. Draft, rejected, cancelled and paid are deliberately excluded.
_PAYABLE_STATES: Final[frozenset[WorkflowState]] = frozenset(
    {
        WorkflowState.approved,
        WorkflowState.ready_for_submission,
        WorkflowState.submitted,
        WorkflowState.outstanding,
        WorkflowState.accrual_needed,
    }
)

_AWAITING_STATES: Final[frozenset[WorkflowState]] = frozenset(
    {WorkflowState.pending_sign_off, WorkflowState.pending_approval}
)

_MONTHS_OF_HISTORY: Final[int] = 6


@dataclass(frozen=True, slots=True)
class MoneyView:
    minor_units: int
    currency: str
    formatted: str


@dataclass(frozen=True, slots=True)
class Kpi:
    key: str
    label: str
    value: int
    hint: str
    tone: str
    money: MoneyView | None = None


@dataclass(frozen=True, slots=True)
class Slice:
    label: str
    count: int
    tone: str


@dataclass(frozen=True, slots=True)
class TrendPoint:
    label: str
    invoices: int
    estimates: int


@dataclass(frozen=True, slots=True)
class OverviewSnapshot:
    generated_at: datetime
    primary_currency: str
    kpis: list[Kpi]
    invoice_states: list[Slice]
    aging: list[Slice]
    monthly_activity: list[TrendPoint]


def _money_view(totals: dict[str, int], preferred: str) -> MoneyView:
    """Format a per-currency total, favouring the preferred currency."""
    currency = preferred if preferred in totals else (next(iter(totals), preferred))
    minor = totals.get(currency, 0)
    return MoneyView(
        minor_units=minor,
        currency=currency,
        formatted=Money(minor, currency).format(with_currency=True),
    )


def _month_key(value: date) -> str:
    return value.strftime("%Y-%m")


def _month_label(value: date) -> str:
    return value.strftime("%b %Y")


class OverviewService:
    """Aggregate figures for the home dashboard, all traceable to a register."""

    def __init__(self, session: Session) -> None:
        self._session = session

    def snapshot(self, *, today: date | None = None) -> OverviewSnapshot:
        now = datetime.now(UTC)
        today = today or now.date()

        invoices = list(
            self._session.execute(select(Invoice).where(Invoice.archived_at.is_(None))).scalars()
        )
        estimates = list(
            self._session.execute(select(Estimate).where(Estimate.archived_at.is_(None))).scalars()
        )
        orders = list(
            self._session.execute(
                select(PurchaseOrder).where(PurchaseOrder.archived_at.is_(None))
            ).scalars()
        )
        packages = list(self._session.execute(select(PaymentPackage)).scalars())
        accrual_periods = list(self._session.execute(select(AccrualPeriod)).scalars())
        card_periods = list(self._session.execute(select(CreditCardPeriod)).scalars())

        primary_currency = self._primary_currency(invoices)

        return OverviewSnapshot(
            generated_at=now,
            primary_currency=primary_currency,
            kpis=self._kpis(
                invoices=invoices,
                estimates=estimates,
                orders=orders,
                packages=packages,
                accrual_periods=accrual_periods,
                card_periods=card_periods,
                primary_currency=primary_currency,
            ),
            invoice_states=self._invoice_states(invoices),
            aging=self._aging(invoices, today=today),
            monthly_activity=self._monthly_activity(invoices, estimates, today=today),
        )

    def _primary_currency(self, invoices: list[Invoice]) -> str:
        counter = Counter(invoice.currency for invoice in invoices if invoice.currency)
        if counter:
            return counter.most_common(1)[0][0]
        return "JMD"

    @staticmethod
    def _totals(rows: list[tuple[int | None, str | None]]) -> dict[str, int]:
        totals: dict[str, int] = {}
        for minor, currency in rows:
            if minor is None or not currency:
                continue
            totals[currency] = totals.get(currency, 0) + minor
        return totals

    def _kpis(
        self,
        *,
        invoices: list[Invoice],
        estimates: list[Estimate],
        orders: list[PurchaseOrder],
        packages: list[PaymentPackage],
        accrual_periods: list[AccrualPeriod],
        card_periods: list[CreditCardPeriod],
        primary_currency: str,
    ) -> list[Kpi]:
        awaiting = sum(
            1 for invoice in invoices if invoice.state in _AWAITING_STATES
        ) + sum(1 for estimate in estimates if estimate.state in _AWAITING_STATES)

        payable = [invoice for invoice in invoices if invoice.state in _PAYABLE_STATES]
        payable_totals = self._totals(
            [(invoice.total_minor_units, invoice.currency) for invoice in payable]
        )

        paid = [invoice for invoice in invoices if invoice.state is WorkflowState.paid]
        paid_totals = self._totals(
            [(invoice.total_minor_units, invoice.currency) for invoice in paid]
        )

        open_orders = [
            order
            for order in orders
            if order.state is WorkflowState.approved and order.closed_at is None
        ]
        order_totals = self._totals(
            [(order.total_minor_units, order.currency) for order in open_orders]
        )

        open_packages = [
            package
            for package in packages
            if package.submitted_at is None and package.cancelled_at is None
        ]
        open_accruals = [period for period in accrual_periods if period.locked_at is None]
        open_card_periods = [period for period in card_periods if period.closed_at is None]

        return [
            Kpi(
                key="awaiting_decision",
                label="Awaiting a decision",
                value=awaiting,
                hint="Estimates and invoices in sign-off or approval.",
                tone="primary",
            ),
            Kpi(
                key="payable",
                label="Outstanding to pay",
                value=len(payable),
                hint="Approved through to outstanding, not yet paid.",
                tone="warning",
                money=_money_view(payable_totals, primary_currency),
            ),
            Kpi(
                key="settled",
                label="Settled",
                value=len(paid),
                hint="Invoices marked paid.",
                tone="success",
                money=_money_view(paid_totals, primary_currency),
            ),
            Kpi(
                key="open_commitments",
                label="Open PO commitments",
                value=len(open_orders),
                hint="Approved purchase orders still taking invoices.",
                tone="neutral",
                money=_money_view(order_totals, primary_currency),
            ),
            Kpi(
                key="open_packages",
                label="Open payment packages",
                value=len(open_packages),
                hint="Assembled, not yet submitted to the bank.",
                tone="neutral",
            ),
            Kpi(
                key="open_periods",
                label="Open periods",
                value=len(open_accruals) + len(open_card_periods),
                hint="Accrual and credit-card periods still open.",
                tone="neutral",
            ),
        ]

    def _invoice_states(self, invoices: list[Invoice]) -> list[Slice]:
        counts = Counter(invoice.state for invoice in invoices)

        def total(*states: WorkflowState) -> int:
            return sum(counts.get(state, 0) for state in states)

        return [
            Slice(label="Draft", count=total(WorkflowState.draft), tone="neutral"),
            Slice(
                label="In approval",
                count=total(WorkflowState.pending_sign_off, WorkflowState.pending_approval),
                tone="primary",
            ),
            Slice(
                label="In flight",
                count=total(
                    WorkflowState.approved,
                    WorkflowState.ready_for_submission,
                    WorkflowState.submitted,
                ),
                tone="info",
            ),
            Slice(
                label="Outstanding",
                count=total(WorkflowState.outstanding, WorkflowState.accrual_needed),
                tone="warning",
            ),
            Slice(label="Paid", count=total(WorkflowState.paid), tone="success"),
            Slice(
                label="Exception",
                count=total(WorkflowState.exception),
                tone="danger",
            ),
        ]

    def _aging(self, invoices: list[Invoice], *, today: date) -> list[Slice]:
        overdue = due_soon = due_later = undated = 0
        for invoice in invoices:
            if invoice.state not in _PAYABLE_STATES:
                continue
            due = invoice.due_date
            if due is None:
                undated += 1
            elif due < today:
                overdue += 1
            elif (due - today).days <= 7:
                due_soon += 1
            else:
                due_later += 1
        return [
            Slice(label="Overdue", count=overdue, tone="danger"),
            Slice(label="Due within 7 days", count=due_soon, tone="warning"),
            Slice(label="Due later", count=due_later, tone="info"),
            Slice(label="No due date", count=undated, tone="neutral"),
        ]

    def _monthly_activity(
        self,
        invoices: list[Invoice],
        estimates: list[Estimate],
        *,
        today: date,
    ) -> list[TrendPoint]:
        months: list[tuple[str, str]] = []
        year, month = today.year, today.month
        for _ in range(_MONTHS_OF_HISTORY):
            anchor = date(year, month, 1)
            months.append((_month_key(anchor), _month_label(anchor)))
            month -= 1
            if month == 0:
                month = 12
                year -= 1
        months.reverse()
        window = {key for key, _ in months}

        invoice_counts: Counter[str] = Counter()
        for invoice in invoices:
            when = invoice.invoice_date or invoice.created_at.date()
            key = _month_key(when)
            if key in window:
                invoice_counts[key] += 1

        estimate_counts: Counter[str] = Counter()
        for estimate in estimates:
            when = estimate.estimate_date or estimate.created_at.date()
            key = _month_key(when)
            if key in window:
                estimate_counts[key] += 1

        return [
            TrendPoint(
                label=label,
                invoices=invoice_counts.get(key, 0),
                estimates=estimate_counts.get(key, 0),
            )
            for key, label in months
        ]
