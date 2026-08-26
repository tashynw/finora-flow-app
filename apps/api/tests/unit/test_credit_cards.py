"""Credit-card domain: standing, coding, close guards and statement parsing.

A period has no workflow state — open and closed are read from a timestamp — and
a model's suggestion never participates in close. The tests below pin both.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from uuid import uuid4

import pytest

from finora.domain.credit_cards import (
    CODING_STANDING_LABELS,
    PERIOD_STANDING_LABELS,
    RECEIPT_STATUS_LABELS,
    CardTransactionView,
    CodingDraft,
    CodingProblem,
    CodingStanding,
    ParseProblem,
    PeriodProblem,
    PeriodStanding,
    PeriodView,
    ReceiptStatus,
    close_problems,
    coding_problems,
    coding_standing,
    may_change,
    may_close,
    parse_statement_csv,
    period_standing,
    receipt_status,
    uncoded_count,
    validate_card_last_four,
)
from finora.domain.money import Money

JMD = "JMD"
CLOSED_AT = datetime(2026, 6, 1, 12, 0, tzinfo=UTC)
GL = uuid4()
CC = uuid4()
DOC = uuid4()


def txn(
    *,
    amount: Money | None = None,
    gl: object | None = None,
    cost_centre: object | None = None,
    exception: str | None = None,
    receipt: object | None = None,
    waived: bool = False,
) -> CardTransactionView:
    return CardTransactionView(
        amount=amount or Money(1_500, JMD),
        gl_account_id=gl,  # type: ignore[arg-type]
        cost_centre_id=cost_centre,  # type: ignore[arg-type]
        exception_reason=exception,
        receipt_document_id=receipt,  # type: ignore[arg-type]
        receipt_waived=waived,
    )


def period(
    *transactions: CardTransactionView,
    closed_at: datetime | None = None,
) -> PeriodView:
    return PeriodView(closed_at=closed_at, transactions=transactions)


class TestStanding:
    def test_a_period_with_no_close_timestamp_is_open(self) -> None:
        assert period_standing(closed_at=None) is PeriodStanding.open

    def test_a_period_with_a_close_timestamp_is_closed(self) -> None:
        assert period_standing(closed_at=CLOSED_AT) is PeriodStanding.closed

    def test_labels_exist_for_every_standing(self) -> None:
        assert set(PERIOD_STANDING_LABELS) == set(PeriodStanding)
        assert set(CODING_STANDING_LABELS) == set(CodingStanding)
        assert set(RECEIPT_STATUS_LABELS) == set(ReceiptStatus)

    def test_coding_needs_both_gl_and_cost_centre(self) -> None:
        assert (
            coding_standing(gl_account_id=GL, cost_centre_id=None, exception_reason=None)
            is CodingStanding.uncoded
        )
        assert (
            coding_standing(gl_account_id=GL, cost_centre_id=CC, exception_reason=None)
            is CodingStanding.coded
        )

    def test_an_exception_reason_marks_the_line_explained(self) -> None:
        assert (
            coding_standing(
                gl_account_id=None,
                cost_centre_id=None,
                exception_reason="Personal charge, reimbursed outside the card.",
            )
            is CodingStanding.excepted
        )

    def test_receipt_status_prefers_a_matched_document_over_a_waiver(self) -> None:
        assert receipt_status(document_id=DOC, waived=True) is ReceiptStatus.matched
        assert receipt_status(document_id=None, waived=True) is ReceiptStatus.waived
        assert receipt_status(document_id=None, waived=False) is ReceiptStatus.missing

    def test_a_closed_period_may_not_change(self) -> None:
        assert may_change(closed_at=None) is True
        assert may_change(closed_at=CLOSED_AT) is False


class TestClose:
    def test_an_open_fully_coded_period_may_close(self) -> None:
        view = period(txn(gl=GL, cost_centre=CC))
        assert may_close(view, reason="Month-end review complete.")
        assert close_problems(view, reason="Month-end review complete.") == ()

    def test_uncoded_lines_block_close_before_a_missing_reason(self) -> None:
        view = period(txn(), txn(gl=GL, cost_centre=CC))
        problems = close_problems(view, reason=None)
        assert [item.code for item in problems] == [
            PeriodProblem.uncoded_transactions,
            PeriodProblem.reason_required,
        ]
        assert uncoded_count(view.transactions) == 1

    def test_an_excepted_line_counts_as_explained(self) -> None:
        view = period(txn(exception="Disputed with the issuer."))
        assert may_close(view, reason="All lines explained.")

    def test_already_closed_is_the_only_problem_reported(self) -> None:
        view = period(txn(), closed_at=CLOSED_AT)
        problems = close_problems(view, reason=None)
        assert [item.code for item in problems] == [PeriodProblem.already_closed]

    def test_an_empty_period_cannot_close(self) -> None:
        problems = close_problems(period(), reason="Nothing to do.")
        assert PeriodProblem.no_transactions in {item.code for item in problems}

    def test_a_reason_that_is_too_short_is_refused(self) -> None:
        view = period(txn(gl=GL, cost_centre=CC))
        problems = close_problems(view, reason="ok")
        assert PeriodProblem.reason_too_short in {item.code for item in problems}


class TestCoding:
    def test_coding_requires_gl_and_cost_centre(self) -> None:
        problems = coding_problems(
            CodingDraft(
                gl_account_id=None,
                cost_centre_id=None,
                category=None,
                exception_reason=None,
            ),
            closed_at=None,
        )
        assert {item.code for item in problems} == {
            CodingProblem.gl_required,
            CodingProblem.cost_centre_required,
        }

    def test_coding_and_exception_together_are_refused(self) -> None:
        problems = coding_problems(
            CodingDraft(
                gl_account_id=GL,
                cost_centre_id=CC,
                category="Travel",
                exception_reason="Also excepted",
            ),
            closed_at=None,
        )
        assert [item.code for item in problems] == [CodingProblem.both_code_and_exception]

    def test_a_closed_period_refuses_any_coding_change(self) -> None:
        problems = coding_problems(
            CodingDraft(
                gl_account_id=GL,
                cost_centre_id=CC,
                category=None,
                exception_reason=None,
            ),
            closed_at=CLOSED_AT,
        )
        assert [item.code for item in problems] == [CodingProblem.period_closed]

    def test_an_exception_alone_is_enough(self) -> None:
        problems = coding_problems(
            CodingDraft(
                gl_account_id=None,
                cost_centre_id=None,
                category=None,
                exception_reason="Duplicate charge, credit pending.",
            ),
            closed_at=None,
        )
        assert problems == ()


class TestParse:
    SAMPLE = """date,merchant,amount,cardholder,category,reference
2026-05-02,Kingston Office Depot,125.50,A. Reid,Supplies,TX-1
2026-05-03,Caribbean Airlines,450.00,A. Reid,Travel,TX-2
"""

    def test_a_well_formed_statement_parses(self) -> None:
        result = parse_statement_csv(self.SAMPLE, currency=JMD)
        assert result.ok
        assert result.statement is not None
        assert len(result.statement.transactions) == 2
        assert result.statement.transactions[0].posted_on == date(2026, 5, 2)
        assert result.statement.transactions[0].amount == Money.from_decimal("125.50", JMD)
        assert result.statement.total == Money.from_decimal("575.50", JMD)

    def test_missing_columns_refuse_the_file(self) -> None:
        result = parse_statement_csv("date,merchant\n2026-05-02,Shop\n", currency=JMD)
        assert not result.ok
        assert result.problems[0].code is ParseProblem.missing_columns

    def test_a_bad_date_refuses_the_whole_file(self) -> None:
        text = "date,merchant,amount,cardholder\n05/02/2026,Shop,10.00,A. Reid\n"
        result = parse_statement_csv(text, currency=JMD)
        assert result.problems[0].code is ParseProblem.bad_date

    def test_a_blank_merchant_refuses_the_whole_file(self) -> None:
        text = "date,merchant,amount,cardholder\n2026-05-02,,10.00,A. Reid\n"
        result = parse_statement_csv(text, currency=JMD)
        assert result.problems[0].code is ParseProblem.blank_merchant

    def test_an_empty_file_is_refused(self) -> None:
        result = parse_statement_csv("   ", currency=JMD)
        assert result.problems[0].code is ParseProblem.empty

    def test_header_only_is_refused(self) -> None:
        result = parse_statement_csv(
            "date,merchant,amount,cardholder\n",
            currency=JMD,
        )
        assert result.problems[0].code is ParseProblem.no_rows

    def test_unsupported_currency_is_refused_before_rows_are_read(self) -> None:
        result = parse_statement_csv(self.SAMPLE, currency="XYZ")
        assert result.problems[0].code is ParseProblem.unsupported_currency


class TestCardLastFour:
    def test_four_digits_are_accepted(self) -> None:
        assert validate_card_last_four(" 4412 ") == "4412"

    @pytest.mark.parametrize("value", ["441", "44123", "abcd", ""])
    def test_anything_else_is_refused(self, value: str) -> None:
        assert validate_card_last_four(value) is None
