"""Fixed-precision money.

Amounts are held as integer minor units with an explicit ISO 4217 currency.
Floating point never participates in a monetary calculation, and arithmetic
between different currencies raises rather than silently coercing.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Final, Self

# Exponent per ISO 4217. Currencies absent from this table are rejected rather
# than assumed to have two decimal places, because guessing the exponent
# corrupts totals.
CURRENCY_EXPONENTS: Final[dict[str, int]] = {
    "JMD": 2,
    "USD": 2,
    "CAD": 2,
    "GBP": 2,
    "EUR": 2,
    "JPY": 0,
    "KWD": 3,
}


class CurrencyError(ValueError):
    """Raised for an unknown currency or a mismatched pair of operands."""


def exponent_for(currency: str) -> int:
    code = currency.upper()
    try:
        return CURRENCY_EXPONENTS[code]
    except KeyError as exc:
        raise CurrencyError(
            f"Unsupported currency {currency!r}. Add it to CURRENCY_EXPONENTS "
            "with the correct ISO 4217 exponent before use."
        ) from exc


@dataclass(frozen=True, slots=True, order=False)
class Money:
    minor_units: int
    currency: str

    def __post_init__(self) -> None:
        if not isinstance(self.minor_units, int) or isinstance(self.minor_units, bool):
            raise TypeError("minor_units must be an int")
        object.__setattr__(self, "currency", self.currency.upper())
        exponent_for(self.currency)

    # ---------------------------------------------------------- constructors

    @classmethod
    def zero(cls, currency: str) -> Self:
        return cls(0, currency)

    @classmethod
    def from_decimal(cls, amount: Decimal | int | str, currency: str) -> Self:
        """Build from a major-unit value, half-up rounded to the currency scale.

        Half-up is the convention finance staff expect on an invoice; banker's
        rounding would disagree with vendor documents.
        """
        exponent = exponent_for(currency)
        quantum = Decimal(1).scaleb(-exponent)
        value = Decimal(str(amount)).quantize(quantum, rounding=ROUND_HALF_UP)
        return cls(int(value.scaleb(exponent)), currency)

    # ------------------------------------------------------------ conversion

    @property
    def exponent(self) -> int:
        return exponent_for(self.currency)

    def to_decimal(self) -> Decimal:
        return Decimal(self.minor_units).scaleb(-self.exponent)

    def format(self, *, with_currency: bool = True) -> str:
        value = self.to_decimal()
        formatted = f"{value:,.{self.exponent}f}"
        return f"{self.currency} {formatted}" if with_currency else formatted

    # ------------------------------------------------------------ arithmetic

    def _assert_same_currency(self, other: Money) -> None:
        if self.currency != other.currency:
            raise CurrencyError(
                f"Cannot combine {self.currency} with {other.currency}. "
                "Convert explicitly with a recorded rate instead."
            )

    def __add__(self, other: Money) -> Money:
        self._assert_same_currency(other)
        return Money(self.minor_units + other.minor_units, self.currency)

    def __sub__(self, other: Money) -> Money:
        self._assert_same_currency(other)
        return Money(self.minor_units - other.minor_units, self.currency)

    def __neg__(self) -> Money:
        return Money(-self.minor_units, self.currency)

    def __abs__(self) -> Money:
        return Money(abs(self.minor_units), self.currency)

    def multiply(self, factor: Decimal | int | str) -> Money:
        """Scale by a quantity or rate, half-up rounded back to minor units."""
        product = Decimal(self.minor_units) * Decimal(str(factor))
        return Money(int(product.quantize(Decimal(1), rounding=ROUND_HALF_UP)), self.currency)

    def allocate(self, weights: list[int]) -> list[Money]:
        """Split without losing or inventing a minor unit.

        Remainder is distributed one unit at a time across the largest weights,
        so the parts always sum back to the original.
        """
        if not weights or any(w < 0 for w in weights):
            raise ValueError("weights must be a non-empty list of non-negative ints")
        total_weight = sum(weights)
        if total_weight == 0:
            raise ValueError("weights must not sum to zero")

        shares = [self.minor_units * w // total_weight for w in weights]
        remainder = self.minor_units - sum(shares)
        order = sorted(range(len(weights)), key=lambda i: weights[i], reverse=True)
        step = 1 if remainder >= 0 else -1
        for i in range(abs(remainder)):
            shares[order[i % len(order)]] += step
        return [Money(s, self.currency) for s in shares]

    # ------------------------------------------------------------ comparison

    def __lt__(self, other: Money) -> bool:
        self._assert_same_currency(other)
        return self.minor_units < other.minor_units

    def __le__(self, other: Money) -> bool:
        self._assert_same_currency(other)
        return self.minor_units <= other.minor_units

    def __gt__(self, other: Money) -> bool:
        self._assert_same_currency(other)
        return self.minor_units > other.minor_units

    def __ge__(self, other: Money) -> bool:
        self._assert_same_currency(other)
        return self.minor_units >= other.minor_units

    @property
    def is_zero(self) -> bool:
        return self.minor_units == 0

    @property
    def is_negative(self) -> bool:
        return self.minor_units < 0

    def __str__(self) -> str:
        return self.format()


def sum_money(items: list[Money], currency: str) -> Money:
    """Total a list, requiring an explicit currency so an empty list still
    produces a correctly denominated zero."""
    total = Money.zero(currency)
    for item in items:
        total = total + item
    return total


def group_by_currency(items: list[Money]) -> dict[str, Money]:
    """Total per currency. Mixed-currency payment packages must present a
    per-currency breakdown rather than one meaningless number."""
    totals: dict[str, Money] = {}
    for item in items:
        existing = totals.get(item.currency)
        totals[item.currency] = item if existing is None else existing + item
    return dict(sorted(totals.items()))
