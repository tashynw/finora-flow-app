"""Executive overview metrics.

One read-only endpoint behind the reporting permission. Everything it returns is
counted or summed from live records, so the home dashboard never shows a figure
that cannot be opened.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from finora.api.deps import CurrentUserDep, RequirePermission, SessionDep
from finora.application.overview import OverviewService
from finora.domain.roles import Permission

router = APIRouter(prefix="/overview", tags=["overview"])


class MoneyOut(BaseModel):
    minor_units: int
    currency: str
    formatted: str


class KpiOut(BaseModel):
    key: str
    label: str
    value: int
    hint: str
    tone: str
    money: MoneyOut | None = None


class SliceOut(BaseModel):
    label: str
    count: int
    tone: str


class TrendOut(BaseModel):
    label: str
    invoices: int
    estimates: int


class OverviewOut(BaseModel):
    generated_at: datetime
    primary_currency: str
    kpis: list[KpiOut]
    invoice_states: list[SliceOut]
    aging: list[SliceOut]
    monthly_activity: list[TrendOut]


@router.get("/metrics", response_model=OverviewOut)
def read_metrics(
    session: SessionDep,
    user: CurrentUserDep,
    _: Annotated[object, Depends(RequirePermission(Permission.report_view))] = None,
) -> OverviewOut:
    """Counts, amounts, aging and recent activity for the home dashboard."""
    snapshot = OverviewService(session).snapshot()
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
                    MoneyOut(
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
        invoice_states=[
            SliceOut(label=row.label, count=row.count, tone=row.tone)
            for row in snapshot.invoice_states
        ],
        aging=[SliceOut(label=row.label, count=row.count, tone=row.tone) for row in snapshot.aging],
        monthly_activity=[
            TrendOut(label=row.label, invoices=row.invoices, estimates=row.estimates)
            for row in snapshot.monthly_activity
        ],
    )
