"""Amounts, dates and currencies report what they could not decide.

Every function in `value_parsing` is written to refuse to guess. `1,500` could be
fifteen hundred or one and a half, `03/04/2026` is two different dates depending
on who printed it, and a bare `$` in Kingston is either JMD or USD with a
hundredfold between them. A silent choice in any of these produces a number that
looks right, passes review because it looks right, and is wrong.

These tests are therefore mostly about the ambiguity flags and notes. A
regression that quietly resolves one of these cases would not fail an
arithmetic assertion, so it has to fail one of these.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from finora.domain.value_parsing import (
    detect_currency,
    parse_amount,
    parse_date,
)


class TestParseAmountRejections:
    def test_empty_text_is_not_an_amount(self) -> None:
        assert parse_amount("") is None

    @pytest.mark.parametrize("text", ["N/A", "not stated", "-", "()", "see attached"])
    def test_text_without_a_number_is_not_an_amount(self, text: str) -> None:
        assert parse_amount(text) is None

    def test_a_lone_separator_with_five_trailing_digits_is_unreadable(self) -> None:
        # Neither a decimal fraction nor a thousands group has five digits, so
        # there is no reading to choose from and none is invented.
        assert parse_amount("1.23456") is None
        assert parse_amount("1,23456") is None


class TestParseAmountCurrencyDecoration:
    @pytest.mark.parametrize(
        "text",
        ["1,234.56", "JMD 1,234.56", "J$1,234.56", "US$1,234.56", "$ 1,234.56", "1,234.56 JMD"],
    )
    def test_currency_symbols_and_codes_do_not_change_the_number(self, text: str) -> None:
        reading = parse_amount(text)
        assert reading is not None
        assert reading.value == Decimal("1234.56")


class TestParseAmountSeparators:
    @pytest.mark.parametrize("text", ["1,234.56", "1.234,56"])
    def test_when_both_separators_appear_the_rightmost_is_the_decimal_point(
        self, text: str
    ) -> None:
        reading = parse_amount(text)
        assert reading is not None
        assert reading.value == Decimal("1234.56")

    @pytest.mark.parametrize("text", ["1,234.56", "1.234,56"])
    def test_two_different_separators_are_never_ambiguous(self, text: str) -> None:
        # No convention uses the same character for both roles and none puts a
        # grouping mark to the right of the decimal point, so this is decidable.
        reading = parse_amount(text)
        assert reading is not None
        assert reading.is_ambiguous is False
        assert reading.note is None

    @pytest.mark.parametrize("text", ["1.234.567", "1,234,567"])
    def test_a_repeated_separator_groups_thousands(self, text: str) -> None:
        reading = parse_amount(text)
        assert reading is not None
        assert reading.value == Decimal("1234567")
        assert reading.is_ambiguous is False

    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("1,5", Decimal("1.5")),
            ("1.5", Decimal("1.5")),
            ("1,56", Decimal("1.56")),
            ("1.56", Decimal("1.56")),
            ("1,5678", Decimal("1.5678")),
            ("1.5678", Decimal("1.5678")),
        ],
    )
    def test_one_two_or_four_digits_after_a_lone_separator_are_decimals(
        self, text: str, expected: Decimal
    ) -> None:
        reading = parse_amount(text)
        assert reading is not None
        assert reading.value == expected
        assert reading.is_ambiguous is False


class TestParseAmountAmbiguity:
    @pytest.mark.parametrize("text", ["1,500", "1.500"])
    def test_a_lone_separator_with_three_digits_is_read_as_thousands(self, text: str) -> None:
        reading = parse_amount(text)
        assert reading is not None
        assert reading.value == Decimal("1500")

    @pytest.mark.parametrize("text", ["1,500", "1.500"])
    def test_a_lone_separator_with_three_digits_is_reported_as_ambiguous(self, text: str) -> None:
        # `1,500` is fifteen hundred to most writers and `1.500` is the same
        # number to a European one, but either can legitimately mean one and a
        # half. Grouping is chosen because it is overwhelmingly the intent on an
        # invoice, and the choice is flagged so nothing depends on it silently.
        reading = parse_amount(text)
        assert reading is not None
        assert reading.is_ambiguous is True
        assert reading.note
        assert "thousands" in reading.note

    def test_the_ambiguity_note_quotes_the_text_and_the_chosen_reading(self) -> None:
        reading = parse_amount("1,500")
        assert reading is not None
        assert reading.note is not None
        assert "1,500" in reading.note
        assert "1500" in reading.note


class TestParseAmountNegatives:
    @pytest.mark.parametrize(
        "text",
        [
            "-1,234.56",
            "1,234.56-",
            "(1,234.56)",
            # A printed ledger writes a credit either way, and the unspaced form is
            # the common one. Neither can be read by looking for a word boundary,
            # because there is none between the `6` and the `C`.
            "1,234.56 CR",
            "1,234.56CR",
            "1,234.56 cr",
            # The marker has to survive the stripping of currency symbols and codes,
            # which removes every letter in the text including these two.
            "JMD 1,234.56 CR",
            "J$1,234.56 CR",
            # Abbreviated with a full stop, and written in European separators.
            "1,234.56 CR.",
            "1.234,56 CR",
        ],
    )
    def test_every_printed_negative_convention_produces_a_negative_amount(self, text: str) -> None:
        # A credit note that loses its sign becomes an invoice, which is the whole
        # reason each of these conventions is read rather than one canonical form.
        reading = parse_amount(text)
        assert reading is not None
        assert reading.value == Decimal("-1234.56")

    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            # `CR` only means credit at the end of the amount. In front of it, or as
            # the start of a longer word, it is prose.
            ("500 CREDIT", "500"),
            ("CREDIT NOTE 500", "500"),
            ("CR 500", "500"),
            # A currency code that happens to end in those letters is a code. The
            # Seychellois rupee is `SCR`, and reading it as a sign would flip a
            # payable into a receivable.
            ("500 SCR", "500"),
            ("SCR 500", "500"),
        ],
    )
    def test_the_letters_cr_elsewhere_are_not_read_as_a_sign(
        self, text: str, expected: str
    ) -> None:
        reading = parse_amount(text)
        assert reading is not None
        assert reading.value == Decimal(expected)

    def test_a_credit_marker_with_no_amount_is_not_an_amount(self) -> None:
        # Taking the marker off must not leave the parser treating what remains as
        # a figure of its own.
        assert parse_amount("CR") is None

    def test_a_negative_keeps_its_ambiguity_reporting(self) -> None:
        reading = parse_amount("(1,500)")
        assert reading is not None
        assert reading.value == Decimal("-1500")
        assert reading.is_ambiguous is True

    def test_a_credit_marker_keeps_its_ambiguity_reporting(self) -> None:
        # The sign and the separator reading are decided independently, so removing
        # the marker must not take the ambiguity report with it.
        reading = parse_amount("1,500 CR")
        assert reading is not None
        assert reading.value == Decimal("-1500")
        assert reading.is_ambiguous is True


class TestParseDateIso:
    def test_an_iso_date_is_read_exactly(self) -> None:
        reading = parse_date("2026-04-03")
        assert reading is not None
        assert reading.value == date(2026, 4, 3)
        assert reading.is_ambiguous is False
        assert reading.alternative is None

    def test_an_iso_date_is_found_inside_surrounding_text(self) -> None:
        reading = parse_date("Document date: 2026-04-03 (net 30)")
        assert reading is not None
        assert reading.value == date(2026, 4, 3)


class TestParseDateNamedMonths:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("3 April 2026", date(2026, 4, 3)),
            ("3rd Apr 2026", date(2026, 4, 3)),
            ("21st December 2026", date(2026, 12, 21)),
            ("3 Sept 2026", date(2026, 9, 3)),
        ],
    )
    def test_a_named_month_after_the_day_is_read_day_first(self, text: str, expected: date) -> None:
        reading = parse_date(text)
        assert reading is not None
        assert reading.value == expected
        assert reading.is_ambiguous is False

    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("April 3, 2026", date(2026, 4, 3)),
            ("Apr 3 2026", date(2026, 4, 3)),
            ("Sept 3, 2026", date(2026, 9, 3)),
            ("December 21, 2026", date(2026, 12, 21)),
        ],
    )
    def test_a_named_month_before_the_day_is_read_month_first(
        self, text: str, expected: date
    ) -> None:
        reading = parse_date(text)
        assert reading is not None
        assert reading.value == expected
        assert reading.is_ambiguous is False

    def test_a_named_month_removes_the_ambiguity_a_numeric_date_would_have(self) -> None:
        reading = parse_date("3 April 2026")
        assert reading is not None
        assert reading.alternative is None
        assert reading.note is None


class TestParseDateTwoDigitYears:
    def test_a_year_below_the_pivot_is_read_as_this_century(self) -> None:
        reading = parse_date("3 April 69")
        assert reading is not None
        assert reading.value == date(2069, 4, 3)

    def test_a_year_at_the_pivot_is_read_as_last_century(self) -> None:
        reading = parse_date("3 April 70")
        assert reading is not None
        assert reading.value == date(1970, 4, 3)

    @pytest.mark.parametrize(("text", "expanded"), [("3 April 69", "2069"), ("3 April 70", "1970")])
    def test_the_expansion_is_recorded_rather_than_applied_silently(
        self, text: str, expanded: str
    ) -> None:
        # A wrongly expanded year in a due-date calculation is a real defect, so
        # the convention that was applied is carried with the reading.
        reading = parse_date(text)
        assert reading is not None
        assert reading.note is not None
        assert "two digits" in reading.note
        assert expanded in reading.note

    def test_a_four_digit_year_carries_no_expansion_note(self) -> None:
        reading = parse_date("3 April 2026")
        assert reading is not None
        assert reading.note is None


class TestParseDateNumericAmbiguity:
    def test_a_numeric_date_that_reads_two_ways_reports_both(self) -> None:
        # Nothing on an invoice says whether 03/04 was written by someone who
        # puts the day first or the month first, so both readings are surfaced
        # instead of one being picked by a configured locale.
        reading = parse_date("03/04/2026")
        assert reading is not None
        assert reading.value == date(2026, 4, 3)
        assert reading.alternative == date(2026, 3, 4)
        assert reading.is_ambiguous is True

    def test_the_ambiguity_note_names_both_dates(self) -> None:
        reading = parse_date("03/04/2026")
        assert reading is not None
        assert reading.note is not None
        assert "2026-04-03" in reading.note
        assert "2026-03-04" in reading.note

    @pytest.mark.parametrize("separator", ["/", ".", "-"])
    def test_the_ambiguity_does_not_depend_on_which_separator_was_printed(
        self, separator: str
    ) -> None:
        reading = parse_date(f"03{separator}04{separator}2026")
        assert reading is not None
        assert reading.is_ambiguous is True

    def test_a_numeric_date_with_only_one_valid_reading_resolves(self) -> None:
        reading = parse_date("25/12/2026")
        assert reading is not None
        assert reading.value == date(2026, 12, 25)
        assert reading.alternative is None
        assert reading.is_ambiguous is False


class TestParseDateRejections:
    def test_empty_text_is_not_a_date(self) -> None:
        assert parse_date("") is None

    @pytest.mark.parametrize("text", ["32/13/2026", "2026-02-30", "2026-13-01", "no date here"])
    def test_an_impossible_date_is_not_read_as_a_nearby_possible_one(self, text: str) -> None:
        assert parse_date(text) is None


class TestDetectCurrencyResolved:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("J$1,234.56", "JMD"),
            ("JA$1,234.56", "JMD"),
            ("US$1,234.56", "USD"),
            ("CA$1,234.56", "CAD"),
            ("\u00a31,234.56", "GBP"),
            ("\u20ac1,234.56", "EUR"),
            ("\u00a5123", "JPY"),
        ],
    )
    def test_an_unambiguous_symbol_resolves_to_its_iso_code(self, text: str, expected: str) -> None:
        reading = detect_currency(text)
        assert reading.code == expected
        assert reading.is_ambiguous is False

    @pytest.mark.parametrize("code", ["JMD", "USD", "CAD", "GBP", "EUR", "JPY", "KWD"])
    def test_a_spelled_out_iso_code_resolves(self, code: str) -> None:
        reading = detect_currency(f"Total due {code} 1,234.56")
        assert reading.code == code
        assert reading.is_ambiguous is False

    def test_a_resolved_reading_needs_no_note(self) -> None:
        assert detect_currency("Total due JMD 1,234.56").note is None


class TestDetectCurrencyBareDollar:
    def test_a_bare_dollar_sign_is_never_resolved_to_a_currency(self) -> None:
        # In this region `$` means Jamaican or United States dollars roughly
        # interchangeably. Defaulting to the base currency would turn a
        # US$4,000 invoice into a JMD 4,000 one that passes every threshold.
        reading = detect_currency("Total due $4,000.00")
        assert reading.code is None
        assert reading.is_ambiguous is True

    def test_the_bare_dollar_note_names_both_candidates(self) -> None:
        reading = detect_currency("Total due $4,000.00")
        assert reading.note is not None
        assert "JMD" in reading.note
        assert "USD" in reading.note

    def test_a_bare_dollar_reports_no_currency_as_found(self) -> None:
        assert detect_currency("$4,000.00").found == ()


class TestDetectCurrencyConflict:
    def test_two_currencies_on_one_document_resolve_to_neither(self) -> None:
        reading = detect_currency("Subtotal USD 100.00 converted at JMD 15,500.00")
        assert reading.code is None
        assert reading.is_ambiguous is True

    def test_both_currencies_are_reported_so_a_reviewer_can_choose(self) -> None:
        reading = detect_currency("Subtotal USD 100.00 converted at JMD 15,500.00")
        assert set(reading.found) == {"USD", "JMD"}
        assert reading.note is not None
        assert "USD" in reading.note
        assert "JMD" in reading.note

    def test_the_same_currency_named_twice_is_not_a_conflict(self) -> None:
        reading = detect_currency("JMD 100.00 plus JMD 15.00")
        assert reading.code == "JMD"
        assert reading.is_ambiguous is False


class TestDetectCurrencyAbsent:
    def test_empty_text_states_no_currency(self) -> None:
        reading = detect_currency("")
        assert reading.code is None
        assert reading.note == "No currency was found."

    def test_text_that_mentions_no_currency_says_so(self) -> None:
        reading = detect_currency("Total due 4,000.00")
        assert reading.code is None
        assert reading.found == ()
        assert reading.note is not None
        assert "does not state a currency" in reading.note

    def test_an_unresolved_reading_is_always_ambiguous(self) -> None:
        assert detect_currency("Total due 4,000.00").is_ambiguous is True
