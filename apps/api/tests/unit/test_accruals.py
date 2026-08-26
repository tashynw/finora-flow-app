"""Accrual domain rules: candidates, edit, finalize, lock, export."""

from __future__ import annotations

from datetime import UTC, date, datetime
from uuid import uuid4

from finora.domain.accruals import (
    CandidateStanding,
    CandidateView,
    EditDraft,
    InvoiceCandidateSource,
    PeriodStanding,
    PeriodView,
    edit_problems,
    export_problems,
    finalize_problems,
    is_candidate_source,
    lock_problems,
    open_period_problems,
    period_standing,
)
from finora.domain.money import Money
from finora.domain.workflow import WorkflowState


def _invoice(
    *,
    state: WorkflowState = WorkflowState.approved,
    invoice_date: date | None = date(2026, 5, 15),
    total: int | None = 10_000,
    currency: str | None = "JMD",
) -> InvoiceCandidateSource:
    return InvoiceCandidateSource(
        id=uuid4(),
        state=state,
        invoice_date=invoice_date,
        currency=currency,
        total_minor_units=total,
        vendor_name="Acme",
        invoice_number="INV-1",
        description="Widgets",
        gl_account_id=None,
        cost_centre_id=None,
        department="Facilities",
    )


class TestCandidateSource:
    def test_approved_invoice_in_period_is_a_candidate(self) -> None:
        assert is_candidate_source(_invoice(), period_end=date(2026, 5, 31))

    def test_paid_invoice_is_never_a_candidate(self) -> None:
        assert not is_candidate_source(
            _invoice(state=WorkflowState.paid), period_end=date(2026, 5, 31)
        )

    def test_invoice_after_period_end_is_skipped(self) -> None:
        assert not is_candidate_source(
            _invoice(invoice_date=date(2026, 6, 1)), period_end=date(2026, 5, 31)
        )

    def test_undated_invoice_is_skipped_rather_than_guessed(self) -> None:
        assert not is_candidate_source(_invoice(invoice_date=None), period_end=date(2026, 5, 31))


class TestEditAndFinalize:
    def test_edit_requires_a_reason(self) -> None:
        problems = edit_problems(
            EditDraft(
                amount=Money(5_000, "JMD"),
                standing=CandidateStanding.adjusted,
                reason="",
            ),
            locked_at=None,
            current=CandidateStanding.proposed,
        )
        assert any(item.code.value == "reason_required" for item in problems)

    def test_edit_refuses_a_locked_period(self) -> None:
        problems = edit_problems(
            EditDraft(
                amount=Money(5_000, "JMD"),
                standing=CandidateStanding.adjusted,
                reason="Corrected to the delivery note.",
            ),
            locked_at=datetime.now(UTC),
            current=CandidateStanding.proposed,
        )
        assert any(item.code.value == "period_locked" for item in problems)

    def test_finalize_refuses_an_excluded_line(self) -> None:
        problems = finalize_problems(locked_at=None, standing=CandidateStanding.excluded)
        assert any(item.code.value == "already_excluded" for item in problems)


class TestLockAndExport:
    def test_lock_refuses_open_candidates(self) -> None:
        period = PeriodView(
            locked_at=None,
            candidates=(
                CandidateView(
                    standing=CandidateStanding.proposed,
                    amount=Money(1_000, "JMD"),
                    edit_reason=None,
                ),
            ),
        )
        problems = lock_problems(period, reason="Month-end complete.")
        assert any(item.code.value == "open_candidates" for item in problems)

    def test_lock_accepts_when_everything_is_settled(self) -> None:
        period = PeriodView(
            locked_at=None,
            candidates=(
                CandidateView(
                    standing=CandidateStanding.finalized,
                    amount=Money(1_000, "JMD"),
                    edit_reason=None,
                ),
                CandidateView(
                    standing=CandidateStanding.excluded,
                    amount=Money(500, "JMD"),
                    edit_reason="Duplicate of May accrual.",
                ),
            ),
        )
        assert lock_problems(period, reason="Month-end complete.") == ()

    def test_official_export_requires_a_lock(self) -> None:
        problems = export_problems(locked_at=None, official=True)
        assert any(item.code.value == "not_locked" for item in problems)

    def test_draft_export_does_not(self) -> None:
        assert export_problems(locked_at=None, official=False) == ()

    def test_standing_follows_locked_at(self) -> None:
        assert period_standing(locked_at=None) is PeriodStanding.open
        assert period_standing(locked_at=datetime.now(UTC)) is PeriodStanding.locked

    def test_open_period_dates_must_be_ordered(self) -> None:
        problems = open_period_problems(period_start=date(2026, 5, 31), period_end=date(2026, 5, 1))
        assert any(item.code.value == "dates_unordered" for item in problems)
