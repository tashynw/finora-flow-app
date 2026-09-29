"""Executive overview metrics.

One read-only endpoint behind the reporting permission. Everything it returns is
counted or summed from live records, so the home dashboard never shows a figure
that cannot be opened.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from finora.api.deps import CurrentUserDep, RequirePermission, SessionDep
from finora.application.overview import MoneyView, OverviewService
from finora.domain.roles import Permission

router = APIRouter(prefix="/overview", tags=["overview"])


class OverviewMoneyOut(BaseModel):
    minor_units: int
    currency: str
    formatted: str


class KpiOut(BaseModel):
    key: str
    label: str
    value: int
    hint: str
    tone: str
    money: OverviewMoneyOut | None = None


class SliceOut(BaseModel):
    label: str
    count: int
    tone: str


class TrendOut(BaseModel):
    label: str
    invoices: int
    estimates: int


class SpendCardOut(BaseModel):
    key: str
    label: str
    hint: str
    tone: str
    money: OverviewMoneyOut | None = None
    count: int | None = None
    delta_pct: float | None = None
    month_money: OverviewMoneyOut | None = None
    previous_money: OverviewMoneyOut | None = None
    series: list[int] = []


class MonthlySpendOut(BaseModel):
    label: str
    invoices: int
    purchase_orders: int
    credit_cards: int
    accruals: int


class VendorSpendOut(BaseModel):
    name: str
    money: OverviewMoneyOut
    share: float


class ActivityOut(BaseModel):
    kind: str
    kind_label: str
    reference: str
    title: str
    state_label: str
    tone: str
    when: datetime
    amount_formatted: str | None = None


class ApprovalPerformanceOut(BaseModel):
    decided: int
    avg_hours: float | None = None
    approval_rate: float | None = None


class OverviewOut(BaseModel):
    generated_at: datetime
    primary_currency: str
    kpis: list[KpiOut]
    spend_cards: list[SpendCardOut]
    top_vendors: list[VendorSpendOut]
    recent_activity: list[ActivityOut]
    approval_performance: ApprovalPerformanceOut
    invoice_states: list[SliceOut]
    aging: list[SliceOut]
    monthly_activity: list[TrendOut]
    monthly_spend: list[MonthlySpendOut]


def _money(view: MoneyView | None) -> OverviewMoneyOut | None:
    if view is None:
        return None
    return OverviewMoneyOut(
        minor_units=view.minor_units, currency=view.currency, formatted=view.formatted
    )


@router.get("/metrics", response_model=OverviewOut)
def read_metrics(
    session: SessionDep,
    user: CurrentUserDep,
    _: Annotated[object, Depends(RequirePermission(Permission.report_view))] = None,
    months: Annotated[int, Query(ge=3, le=12)] = 6,
) -> OverviewOut:
    """Counts, amounts, aging and recent activity for the home dashboard."""
    snapshot = OverviewService(session).snapshot(months=months)
    return OverviewOut(
        generated_at=snapshot.generated_at,
        primary_currency=snapshot.primary_currency,
        kpis=[
            KpiOut(
                key=kpi.key,
                label=kpi.label,
                value=kpi.value,
                hint=kpi.hint,
                tone=kpi.tone,
                money=(
                    OverviewMoneyOut(
                        minor_units=kpi.money.minor_units,
                        currency=kpi.money.currency,
                        formatted=kpi.money.formatted,
                    )
                    if kpi.money is not None
                    else None
                ),
            )
            for kpi in snapshot.kpis
        ],
        spend_cards=[
            SpendCardOut(
                key=card.key,
                label=card.label,
                hint=card.hint,
                tone=card.tone,
                money=(
                    OverviewMoneyOut(
                        minor_units=card.money.minor_units,
                        currency=card.money.currency,
                        formatted=card.money.formatted,
                    )
                    if card.money is not None
                    else None
                ),
                count=card.count,
                delta_pct=card.delta_pct,
                month_money=_money(card.month_money),
                previous_money=_money(card.previous_money),
                series=list(card.series),
            )
            for card in snapshot.spend_cards
        ],
        top_vendors=[
            VendorSpendOut(
                name=vendor.name,
                money=OverviewMoneyOut(
                    minor_units=vendor.money.minor_units,
                    currency=vendor.money.currency,
                    formatted=vendor.money.formatted,
                ),
                share=vendor.share,
            )
            for vendor in snapshot.top_vendors
        ],
        recent_activity=[
            ActivityOut(
                kind=entry.kind,
                kind_label=entry.kind_label,
                reference=entry.reference,
                title=entry.title,
                state_label=entry.state_label,
                tone=entry.tone,
                when=entry.when,
                amount_formatted=entry.amount_formatted,
            )
            for entry in snapshot.recent_activity
        ],
        approval_performance=ApprovalPerformanceOut(
            decided=snapshot.approval_performance.decided,
            avg_hours=snapshot.approval_performance.avg_hours,
            approval_rate=snapshot.approval_performance.approval_rate,
        ),
        invoice_states=[
            SliceOut(label=row.label, count=row.count, tone=row.tone)
            for row in snapshot.invoice_states
        ],
        aging=[SliceOut(label=row.label, count=row.count, tone=row.tone) for row in snapshot.aging],
        monthly_activity=[
            TrendOut(label=row.label, invoices=row.invoices, estimates=row.estimates)
            for row in snapshot.monthly_activity
        ],
        monthly_spend=[
            MonthlySpendOut(
                label=row.label,
                invoices=row.invoices,
                purchase_orders=row.purchase_orders,
                credit_cards=row.credit_cards,
                accruals=row.accruals,
            )
            for row in snapshot.monthly_spend
        ],
    )
