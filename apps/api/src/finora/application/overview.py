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

from finora.domain.approvals import RouteState
from finora.domain.money import Money
from finora.domain.workflow import STATE_LABELS, WorkflowState
from finora.infrastructure.db.models import (
    AccrualCandidate,
    AccrualPeriod,
    ApprovalRequest,
    CreditCardPeriod,
    CreditCardTransaction,
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

#: Invoice states that represent money the organisation has committed to — from
#: the moment an invoice is approved right through to when it is paid. Used for
#: the "approved amount" headline, which is every dollar past the approval gate.
_APPROVED_STATES: Final[frozenset[WorkflowState]] = _PAYABLE_STATES | {WorkflowState.paid}

#: Semantic tone per workflow state, so a status pill on the activity feed reads
#: the same colour language as the rest of the app.
_STATE_TONE: Final[dict[WorkflowState, str]] = {
    WorkflowState.draft: "neutral",
    WorkflowState.pending_sign_off: "primary",
    WorkflowState.pending_approval: "primary",
    WorkflowState.approved: "info",
    WorkflowState.ready_for_submission: "info",
    WorkflowState.submitted: "info",
    WorkflowState.paid: "success",
    WorkflowState.outstanding: "warning",
    WorkflowState.accrual_needed: "warning",
    WorkflowState.exception: "danger",
    WorkflowState.rejected: "danger",
    WorkflowState.cancelled: "neutral",
}


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
class SpendCard:
    """A headline money figure with an optional honest month-over-month delta.

    ``delta_pct`` is only populated where a *flow* reading exists — money that
    moved in the current calendar month against the previous one. Stock figures
    (what is owed right now) carry no delta, because "vs last month" has no
    truthful meaning without period snapshots we do not keep.
    """

    key: str
    label: str
    hint: str
    tone: str
    money: MoneyView | None = None
    count: int | None = None
    delta_pct: float | None = None
    #: The same flow for the current and the previous calendar month, and one
    #: total per month over the history window (oldest first) for a sparkline.
    #: Empty for stock figures, which have no history we can honestly draw.
    month_money: MoneyView | None = None
    previous_money: MoneyView | None = None
    series: tuple[int, ...] = ()


@dataclass(frozen=True, slots=True)
class VendorSpend:
    name: str
    money: MoneyView
    share: float


@dataclass(frozen=True, slots=True)
class ActivityEntry:
    kind: str
    kind_label: str
    reference: str
    title: str
    state_label: str
    tone: str
    when: datetime
    amount_formatted: str | None = None


@dataclass(frozen=True, slots=True)
class MonthlySpend:
    """Money committed in one calendar month, split by where it came from.

    All in the primary currency, in minor units. Invoices count once they are
    approved (dated by invoice date); purchase orders once opened; card lines by
    posting date; accruals once finalized.
    """

    label: str
    invoices: int
    purchase_orders: int
    credit_cards: int
    accruals: int


@dataclass(frozen=True, slots=True)
class ApprovalPerformance:
    decided: int
    avg_hours: float | None
    approval_rate: float | None


@dataclass(frozen=True, slots=True)
class OverviewSnapshot:
    generated_at: datetime
    primary_currency: str
    kpis: list[Kpi]
    spend_cards: list[SpendCard]
    top_vendors: list[VendorSpend]
    recent_activity: list[ActivityEntry]
    approval_performance: ApprovalPerformance
    invoice_states: list[Slice]
    aging: list[Slice]
    monthly_activity: list[TrendPoint]
    monthly_spend: list[MonthlySpend]


def _money_view(totals: dict[str, int], preferred: str) -> MoneyView:
    """Format a per-currency total, favouring the preferred currency."""
    currency = preferred if preferred in totals else (next(iter(totals), preferred))
    minor = totals.get(currency, 0)
    return MoneyView(
        minor_units=minor,
        currency=currency,
        formatted=Money(minor, currency).format(with_currency=True),
    )


def _formatted(minor: int | None, currency: str | None) -> str | None:
    if minor is None or not currency:
        return None
    return Money(minor, currency).format(with_currency=True)


def _month_key(value: date) -> str:
    return value.strftime("%Y-%m")


def _month_label(value: date) -> str:
    return value.strftime("%b %Y")


class OverviewService:
    """Aggregate figures for the home dashboard, all traceable to a register."""

    def __init__(self, session: Session) -> None:
        self._session = session

    def snapshot(
        self, *, today: date | None = None, months: int = _MONTHS_OF_HISTORY
    ) -> OverviewSnapshot:
        now = datetime.now(UTC)
        today = today or now.date()
        window = self._month_window(today, months)

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
        routes = list(self._session.execute(select(ApprovalRequest)).scalars())
        card_lines = list(self._session.execute(select(CreditCardTransaction)).scalars())
        accruals = list(
            self._session.execute(
                select(AccrualCandidate).where(AccrualCandidate.finalized_at.is_not(None))
            ).scalars()
        )

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
            spend_cards=self._spend_cards(
                invoices=invoices,
                estimates=estimates,
                primary_currency=primary_currency,
                today=today,
                window=window,
            ),
            top_vendors=self._top_vendors(invoices, primary_currency=primary_currency),
            recent_activity=self._recent_activity(invoices, estimates),
            approval_performance=self._approval_performance(routes),
            invoice_states=self._invoice_states(invoices),
            aging=self._aging(invoices, today=today),
            monthly_activity=self._monthly_activity(invoices, estimates, window=window),
            monthly_spend=self._monthly_spend(
                invoices=invoices,
                orders=orders,
                card_lines=card_lines,
                accruals=accruals,
                primary_currency=primary_currency,
                window=window,
            ),
        )

    @staticmethod
    def _month_window(today: date, months: int) -> list[tuple[str, str]]:
        """(key, label) for the last ``months`` calendar months, oldest first."""
        window: list[tuple[str, str]] = []
        year, month = today.year, today.month
        for _ in range(months):
            anchor = date(year, month, 1)
            window.append((_month_key(anchor), _month_label(anchor)))
            month -= 1
            if month == 0:
                month = 12
                year -= 1
        window.reverse()
        return window

    def _monthly_spend(
        self,
        *,
        invoices: list[Invoice],
        orders: list[PurchaseOrder],
        card_lines: list[CreditCardTransaction],
        accruals: list[AccrualCandidate],
        primary_currency: str,
        window: list[tuple[str, str]],
    ) -> list[MonthlySpend]:
        keys = {key for key, _ in window}
        buckets: dict[str, Counter[str]] = {key: Counter() for key in keys}

        def add(source: str, when: date | None, minor: int | None, currency: str | None) -> None:
            if when is None or not minor or currency != primary_currency:
                return
            key = _month_key(when)
            if key in keys:
                buckets[key][source] += minor

        for invoice in invoices:
            if invoice.state in _APPROVED_STATES:
                add(
                    "invoices",
                    invoice.invoice_date or invoice.created_at.date(),
                    invoice.total_minor_units,
                    invoice.currency,
                )
        for order in orders:
            if order.opened_at is not None:
                add("purchase_orders", order.opened_at.date(), order.total_minor_units, order.currency)
        for line in card_lines:
            add("credit_cards", line.posted_on, line.amount_minor_units, line.currency)
        for candidate in accruals:
            finalized = candidate.finalized_at.date() if candidate.finalized_at else None
            add("accruals", finalized, candidate.amount_minor_units, candidate.currency)

        return [
            MonthlySpend(
                label=label,
                invoices=buckets[key]["invoices"],
                purchase_orders=buckets[key]["purchase_orders"],
                credit_cards=buckets[key]["credit_cards"],
                accruals=buckets[key]["accruals"],
            )
            for key, label in window
        ]

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

    @staticmethod
    def _month_bounds(today: date) -> tuple[date, date, date]:
        """(this_month_start, last_month_start, next_month_start)."""
        this_start = today.replace(day=1)
        if this_start.month == 1:
            last_start = this_start.replace(year=this_start.year - 1, month=12)
        else:
            last_start = this_start.replace(month=this_start.month - 1)
        if this_start.month == 12:
            next_start = this_start.replace(year=this_start.year + 1, month=1)
        else:
            next_start = this_start.replace(month=this_start.month + 1)
        return this_start, last_start, next_start

    @staticmethod
    def _delta_pct(current: int, previous: int) -> float | None:
        """Percentage change of a flow this month against last, or None.

        Returns ``None`` when last month is zero, because a change "from nothing"
        is not a percentage anyone can act on — the UI simply omits the chip.
        """
        if previous <= 0:
            return None
        return round((current - previous) / previous * 100, 1)

    def _spend_cards(
        self,
        *,
        invoices: list[Invoice],
        estimates: list[Estimate],
        primary_currency: str,
        today: date,
        window: list[tuple[str, str]],
    ) -> list[SpendCard]:
        this_start, last_start, next_start = self._month_bounds(today)

        def view(minor: int) -> MoneyView:
            return MoneyView(
                minor_units=minor,
                currency=primary_currency,
                formatted=Money(minor, primary_currency).format(with_currency=True),
            )

        def invoice_when(invoice: Invoice) -> date:
            if invoice.decided_at is not None:
                return invoice.decided_at.date()
            return invoice.invoice_date or invoice.created_at.date()

        def flow(states: frozenset[WorkflowState], start: date, end: date) -> int:
            total = 0
            for invoice in invoices:
                if invoice.state not in states or invoice.currency != primary_currency:
                    continue
                when = invoice_when(invoice)
                if start <= when < end and invoice.total_minor_units:
                    total += invoice.total_minor_units
            return total

        paid_total = sum(
            invoice.total_minor_units or 0
            for invoice in invoices
            if invoice.state is WorkflowState.paid and invoice.currency == primary_currency
        )
        approved_total = sum(
            invoice.total_minor_units or 0
            for invoice in invoices
            if invoice.state in _APPROVED_STATES and invoice.currency == primary_currency
        )

        paid_states = frozenset({WorkflowState.paid})
        paid_now = flow(paid_states, this_start, next_start)
        paid_before = flow(paid_states, last_start, this_start)
        approved_now = flow(_APPROVED_STATES, this_start, next_start)
        approved_before = flow(_APPROVED_STATES, last_start, this_start)
        paid_delta = self._delta_pct(paid_now, paid_before)
        approved_delta = self._delta_pct(approved_now, approved_before)

        def monthly(states: frozenset[WorkflowState]) -> tuple[int, ...]:
            totals: Counter[str] = Counter()
            for invoice in invoices:
                if invoice.state in states and invoice.currency == primary_currency:
                    totals[_month_key(invoice_when(invoice))] += invoice.total_minor_units or 0
            return tuple(totals.get(key, 0) for key, _ in window)

        pending_totals = self._totals(
            [
                (invoice.total_minor_units, invoice.currency)
                for invoice in invoices
                if invoice.state in _AWAITING_STATES
            ]
            + [
                (estimate.total_minor_units, estimate.currency)
                for estimate in estimates
                if estimate.state in _AWAITING_STATES
            ]
        )
        open_items = sum(1 for i in invoices if i.state in _AWAITING_STATES) + sum(
            1 for e in estimates if e.state in _AWAITING_STATES
        )

        return [
            SpendCard(
                key="total_spend",
                label="Total spend",
                hint="Invoices marked paid, all time.",
                tone="primary",
                money=MoneyView(
                    minor_units=paid_total,
                    currency=primary_currency,
                    formatted=Money(paid_total, primary_currency).format(with_currency=True),
                ),
                delta_pct=paid_delta,
                month_money=view(paid_now),
                previous_money=view(paid_before),
                series=monthly(paid_states),
            ),
            SpendCard(
                key="approved_amount",
                label="Approved amount",
                hint="Every invoice past the approval gate.",
                tone="info",
                money=MoneyView(
                    minor_units=approved_total,
                    currency=primary_currency,
                    formatted=Money(approved_total, primary_currency).format(with_currency=True),
                ),
                delta_pct=approved_delta,
                month_money=view(approved_now),
                previous_money=view(approved_before),
                series=monthly(_APPROVED_STATES),
            ),
            SpendCard(
                key="pending_approvals",
                label="Pending approvals",
                hint="Estimates and invoices awaiting a decision.",
                tone="warning",
                money=_money_view(pending_totals, primary_currency),
            ),
            SpendCard(
                key="open_items",
                label="Open items",
                hint="Records sitting in sign-off or approval.",
                tone="neutral",
                count=open_items,
            ),
        ]

    def _top_vendors(
        self, invoices: list[Invoice], *, primary_currency: str, limit: int = 5
    ) -> list[VendorSpend]:
        totals: Counter[str] = Counter()
        for invoice in invoices:
            if invoice.state not in _APPROVED_STATES or invoice.currency != primary_currency:
                continue
            name = invoice.vendor_name or "Unnamed vendor"
            totals[name] += invoice.total_minor_units or 0
        ranked = [(name, minor) for name, minor in totals.most_common(limit) if minor > 0]
        if not ranked:
            return []
        top = ranked[0][1]
        return [
            VendorSpend(
                name=name,
                money=MoneyView(
                    minor_units=minor,
                    currency=primary_currency,
                    formatted=Money(minor, primary_currency).format(with_currency=True),
                ),
                share=round(minor / top, 4) if top else 0.0,
            )
            for name, minor in ranked
        ]

    def _recent_activity(
        self, invoices: list[Invoice], estimates: list[Estimate], *, limit: int = 6
    ) -> list[ActivityEntry]:
        entries: list[ActivityEntry] = []
        for invoice in invoices:
            entries.append(
                ActivityEntry(
                    kind="invoice",
                    kind_label="Invoice",
                    reference=invoice.reference,
                    title=invoice.vendor_name or invoice.description or "Invoice",
                    state_label=STATE_LABELS.get(invoice.state, invoice.state.value),
                    tone=_STATE_TONE.get(invoice.state, "neutral"),
                    when=invoice.updated_at or invoice.created_at,
                    amount_formatted=_formatted(invoice.total_minor_units, invoice.currency),
                )
            )
        for estimate in estimates:
            entries.append(
                ActivityEntry(
                    kind="estimate",
                    kind_label="Estimate",
                    reference=estimate.reference,
                    title=estimate.vendor_name or estimate.description or "Estimate",
                    state_label=STATE_LABELS.get(estimate.state, estimate.state.value),
                    tone=_STATE_TONE.get(estimate.state, "neutral"),
                    when=estimate.updated_at or estimate.created_at,
                    amount_formatted=_formatted(estimate.total_minor_units, estimate.currency),
                )
            )
        entries.sort(key=lambda entry: entry.when, reverse=True)
        return entries[:limit]

    def _approval_performance(self, routes: list[ApprovalRequest]) -> ApprovalPerformance:
        decided = [r for r in routes if r.state in {RouteState.approved, RouteState.rejected}]
        approved = sum(1 for r in decided if r.state is RouteState.approved)
        durations = [
            (r.closed_at - r.opened_at).total_seconds() / 3600
            for r in decided
            if r.closed_at is not None and r.opened_at is not None
        ]
        avg_hours = round(sum(durations) / len(durations), 1) if durations else None
        approval_rate = round(approved / len(decided), 4) if decided else None
        return ApprovalPerformance(
            decided=len(decided), avg_hours=avg_hours, approval_rate=approval_rate
        )

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
        window: list[tuple[str, str]],
    ) -> list[TrendPoint]:
        months = window
        keys = {key for key, _ in months}

        invoice_counts: Counter[str] = Counter()
        for invoice in invoices:
            when = invoice.invoice_date or invoice.created_at.date()
            key = _month_key(when)
            if key in keys:
                invoice_counts[key] += 1

        estimate_counts: Counter[str] = Counter()
        for estimate in estimates:
            when = estimate.estimate_date or estimate.created_at.date()
            key = _month_key(when)
            if key in keys:
                estimate_counts[key] += 1

        return [
            TrendPoint(
                label=label,
                invoices=invoice_counts.get(key, 0),
                estimates=estimate_counts.get(key, 0),
            )
            for key, label in months
        ]
