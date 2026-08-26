"""Money must never lose or invent a minor unit."""

from __future__ import annotations

from decimal import Decimal

import pytest

from finora.domain.money import (
    CurrencyError,
    Money,
    group_by_currency,
    sum_money,
)


class TestConstruction:
    def test_from_decimal_scales_to_minor_units(self) -> None:
        assert Money.from_decimal("1234.56", "JMD").minor_units == 123456

    def test_zero_decimal_currency_has_no_fraction(self) -> None:
        assert Money.from_decimal("1500", "JPY").minor_units == 1500

    def test_three_decimal_currency(self) -> None:
        assert Money.from_decimal("12.345", "KWD").minor_units == 12345

    def test_rounds_half_up_not_bankers(self) -> None:
        # Banker's rounding would give 1234.56; vendor documents expect .57
        assert Money.from_decimal("1234.565", "JMD").minor_units == 123457

    def test_unknown_currency_is_rejected(self) -> None:
        with pytest.raises(CurrencyError, match="Unsupported currency"):
            Money(100, "XYZ")

    def test_currency_is_normalised_to_upper_case(self) -> None:
        assert Money(100, "jmd").currency == "JMD"

    def test_bool_is_not_accepted_as_minor_units(self) -> None:
        with pytest.raises(TypeError):
            Money(True, "JMD")  # type: ignore[arg-type]


class TestArithmetic:
    def test_addition(self) -> None:
        total = Money(50_000_00, "JMD") + Money(25_000_00, "JMD")
        assert total.minor_units == 75_000_00

    def test_subtraction_may_go_negative(self) -> None:
        result = Money(100, "JMD") - Money(250, "JMD")
        assert result.minor_units == -150
        assert result.is_negative

    def test_mixed_currency_addition_raises(self) -> None:
        with pytest.raises(CurrencyError, match="Convert explicitly"):
            Money(100, "JMD") + Money(100, "USD")

    def test_mixed_currency_comparison_raises(self) -> None:
        with pytest.raises(CurrencyError):
            _ = Money(100, "JMD") < Money(100, "USD")

    def test_multiply_by_quantity(self) -> None:
        assert Money(1_50, "JMD").multiply(3).minor_units == 450

    def test_multiply_by_tax_rate_rounds_half_up(self) -> None:
        # 100.00 * 0.165 = 16.50 exactly
        assert Money(100_00, "JMD").multiply(Decimal("0.165")).minor_units == 1650


class TestAllocate:
    def test_split_without_losing_units(self) -> None:
        parts = Money(100, "JMD").allocate([1, 1, 1])
        assert [p.minor_units for p in parts] == [34, 33, 33]
        assert sum(p.minor_units for p in parts) == 100

    def test_weighted_split_sums_back_to_original(self) -> None:
        original = Money(10_000_01, "JMD")
        parts = original.allocate([70, 20, 10])
        assert sum_money(parts, "JMD") == original

    def test_negative_amount_allocates_and_sums_back(self) -> None:
        original = Money(-100, "JMD")
        parts = original.allocate([1, 1, 1])
        assert sum(p.minor_units for p in parts) == -100

    def test_zero_weights_rejected(self) -> None:
        with pytest.raises(ValueError, match="must not sum to zero"):
            Money(100, "JMD").allocate([0, 0])

    def test_empty_weights_rejected(self) -> None:
        with pytest.raises(ValueError):
            Money(100, "JMD").allocate([])


class TestTotals:
    def test_empty_sum_is_denominated_zero(self) -> None:
        assert sum_money([], "JMD") == Money(0, "JMD")

    def test_group_by_currency_keeps_currencies_separate(self) -> None:
        grouped = group_by_currency(
            [
                Money(100_00, "JMD"),
                Money(50_00, "USD"),
                Money(25_00, "JMD"),
            ]
        )
        assert grouped == {"JMD": Money(125_00, "JMD"), "USD": Money(50_00, "USD")}


class TestFormatting:
    def test_format_includes_currency_and_thousands(self) -> None:
        assert Money(1_234_567_89, "JMD").format() == "JMD 1,234,567.89"

    def test_format_respects_zero_decimal_currency(self) -> None:
        assert Money(1500, "JPY").format() == "JPY 1,500"

    def test_round_trip_through_decimal(self) -> None:
        assert Money(123456, "JMD").to_decimal() == Decimal("1234.56")


class TestThreshold:
    def test_po_threshold_boundary_is_exclusive_above(self) -> None:
        """The master prompt sets PO control above JMD 50,000, so exactly
        50,000 must not trigger it."""
        threshold = Money(50_000_00, "JMD")
        assert not Money(50_000_00, "JMD") > threshold
        assert Money(50_000_01, "JMD") > threshold
