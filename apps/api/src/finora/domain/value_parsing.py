"""Reading amounts, dates and currencies off a document.

Every function here reports what it could not decide instead of deciding it. That
is the whole point of the module.

A vendor writes `1,234.56` and a European vendor writes `1.234,56`, and both
appear in the same mailbox. `03/04/2026` is 3 April to most of the world and
4 March in the United States, and an invoice carries nothing that settles which.
A bare `$` in Kingston means Jamaican dollars about as often as it means United
States dollars, and the difference is a factor of roughly one hundred and fifty.

Guessing any of these produces a number that looks right, passes review because it
looks right, and is wrong. So each reading carries its own ambiguity, and the
extraction layer turns that into lower confidence and a question for a person.
"""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Final

from finora.domain.money import CURRENCY_EXPONENTS

# ------------------------------------------------------------------- amounts

#: Accounting conventions for a negative amount. A trailing minus, a wrapping pair
#: of brackets and a trailing `CR` all mean the same thing on a printed ledger, and
#: a credit note that loses its sign becomes an invoice.
#:
#: `CR` is matched against the original text, before currency symbols and codes are
#: stripped, because stripping removes every letter and would take the marker with
#: them.
#:
#: It must end the text, so `CREDIT NOTE 500` keeps its sign, and it must not follow
#: a letter, so a currency code ending in those letters is not read as a sign. A
#: word boundary will not do either job: there is none between the `6` and the `C`
#: of `1,234.56CR`, which is exactly how a printed ledger writes it.
_BRACKETED = re.compile(r"^\((?P<body>.+)\)$")
_TRAILING_MINUS = re.compile(r"^(?P<body>.+?)\s*-$")
_TRAILING_CREDIT = re.compile(r"(?<![A-Za-z])cr\.?\s*$", re.IGNORECASE)

_AMOUNT_BODY = re.compile(r"^\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,4})?$|^\d+(?:[.,]\d{1,4})?$")

#: Anything that is not part of a number: currency symbols, codes and spacing.
#: Removed before parsing so `JMD 1,234.56` and `J$1,234.56` reach the same code.
_NON_NUMERIC = re.compile(r"[^\d.,()\-]")


@dataclass(frozen=True, slots=True)
class AmountReading:
    value: Decimal
    #: True when the separators could be read two ways and the interpretation
    #: below was chosen by convention rather than by evidence.
    is_ambiguous: bool = False
    note: str | None = None


def parse_amount(text: str) -> AmountReading | None:
    """Read a printed amount, or return None if the text is not one."""
    if not text:
        return None

    # Read off the original text first, then strip the symbols. The other two
    # markers survive stripping and are read afterwards, because a leading currency
    # code would otherwise stop a bracketed body from being recognised as one.
    credit = _TRAILING_CREDIT.search(text)
    if credit:
        text = text[: credit.start()]

    cleaned = _NON_NUMERIC.sub("", text).strip()
    if not cleaned:
        return None

    negative = credit is not None
    bracketed = _BRACKETED.match(cleaned)
    if bracketed:
        negative = True
        cleaned = bracketed.group("body")
    else:
        trailing = _TRAILING_MINUS.match(cleaned)
        if trailing:
            negative = True
            cleaned = trailing.group("body")
        elif cleaned.startswith("-"):
            negative = True
            cleaned = cleaned[1:]

    cleaned = cleaned.strip()
    if not _AMOUNT_BODY.match(cleaned):
        return None

    digits, ambiguous, note = _split_separators(cleaned)
    if digits is None:
        return None

    try:
        value = Decimal(digits)
    except InvalidOperation:
        return None

    return AmountReading(value=-value if negative else value, is_ambiguous=ambiguous, note=note)


def _split_separators(body: str) -> tuple[str | None, bool, str | None]:
    """Work out which separator is the decimal point.

    The rule is positional rather than locale-based, because the document does not
    say which locale wrote it and a configured default would be wrong for every
    vendor that does not share it.
    """
    last_dot = body.rfind(".")
    last_comma = body.rfind(",")

    if last_dot >= 0 and last_comma >= 0:
        # Both present, so the rightmost is the decimal separator and the other is
        # grouping. This is unambiguous: no convention uses the same character for
        # both, and no convention puts grouping to the right of the decimal.
        decimal_at = max(last_dot, last_comma)
        grouping = "," if decimal_at == last_dot else "."
        integer = body[:decimal_at].replace(grouping, "")
        fraction = body[decimal_at + 1 :]
        return f"{integer}.{fraction}", False, None

    separator = "." if last_dot >= 0 else "," if last_comma >= 0 else None
    if separator is None:
        return body, False, None

    parts = body.split(separator)
    if len(parts) > 2:
        # Repeated, so it groups thousands: 1.234.567 or 1,234,567.
        return "".join(parts), False, None

    tail = parts[1]
    if len(tail) == 3:
        # One separator with exactly three digits after it. `1,500` is fifteen
        # hundred and `1.500` is almost always the same number written by someone
        # else, but both can legitimately be one and a half. Grouping is the
        # overwhelmingly more common intent on an invoice, so it is chosen, and the
        # reading is marked ambiguous so nothing depends on that choice silently.
        return (
            "".join(parts),
            True,
            (
                f"'{body}' was read as {''.join(parts)}, treating the separator as "
                "thousands. Confirm against the document."
            ),
        )
    if len(tail) in {1, 2, 4}:
        return f"{parts[0]}.{tail}", False, None
    return None, False, None


# --------------------------------------------------------------------- dates

_MONTHS: Final[dict[str, int]] = (
    {name.casefold(): number for number, name in enumerate(calendar.month_name) if name}
    | {name.casefold(): number for number, name in enumerate(calendar.month_abbr) if name}
    | {"sept": 9}
)

_MONTH_ALTERNATION = "|".join(sorted(_MONTHS, key=len, reverse=True))

_ISO = re.compile(r"\b(?P<y>\d{4})-(?P<m>\d{1,2})-(?P<d>\d{1,2})\b")
_NUMERIC = re.compile(r"\b(?P<a>\d{1,2})[/.\-](?P<b>\d{1,2})[/.\-](?P<y>\d{2,4})\b")
_DAY_FIRST = re.compile(
    rf"\b(?P<d>\d{{1,2}})(?:st|nd|rd|th)?[ \-]+(?P<m>{_MONTH_ALTERNATION})"
    rf"\.?,?[ \-]+(?P<y>\d{{2,4}})\b",
    re.IGNORECASE,
)
_MONTH_FIRST = re.compile(
    rf"\b(?P<m>{_MONTH_ALTERNATION})\.?[ \-]+(?P<d>\d{{1,2}})(?:st|nd|rd|th)?"
    rf",?[ \-]+(?P<y>\d{{2,4}})\b",
    re.IGNORECASE,
)

#: Two-digit years. The pivot is a convention, so it is recorded in the reading
#: rather than applied silently: an invoice dated '69 is not a plausible document
#: but a wrongly expanded year in a due-date calculation is a real defect.
_CENTURY_PIVOT: Final[int] = 70


@dataclass(frozen=True, slots=True)
class DateReading:
    value: date
    #: The other equally valid reading, when the numbers could be swapped.
    alternative: date | None = None
    note: str | None = None

    @property
    def is_ambiguous(self) -> bool:
        return self.alternative is not None


def _expand_year(raw: str) -> tuple[int, str | None]:
    year = int(raw)
    if len(raw) == 4:
        return year, None
    century = 1900 if year >= _CENTURY_PIVOT else 2000
    return century + year, (
        f"The year was written as two digits ('{raw}') and was read as {century + year}."
    )


def _make(year: int, month: int, day: int) -> date | None:
    try:
        return date(year, month, day)
    except ValueError:
        return None


def parse_date(text: str) -> DateReading | None:
    """Read a printed date, reporting when the numbers could be swapped."""
    if not text:
        return None

    iso = _ISO.search(text)
    if iso:
        value = _make(int(iso.group("y")), int(iso.group("m")), int(iso.group("d")))
        return DateReading(value=value) if value else None

    for pattern in (_DAY_FIRST, _MONTH_FIRST):
        named = pattern.search(text)
        if named:
            year, note = _expand_year(named.group("y"))
            month = _MONTHS[named.group("m").casefold()]
            value = _make(year, month, int(named.group("d")))
            if value:
                return DateReading(value=value, note=note)

    numeric = _NUMERIC.search(text)
    if numeric:
        year, note = _expand_year(numeric.group("y"))
        first, second = int(numeric.group("a")), int(numeric.group("b"))

        day_first = _make(year, second, first)
        month_first = _make(year, first, second)

        if day_first and month_first and day_first != month_first:
            # Both readings are valid dates. Day-first is reported because it is
            # the convention in the region this platform serves, and the other
            # reading is carried alongside so the reviewer can pick it in one
            # click rather than retyping.
            return DateReading(
                value=day_first,
                alternative=month_first,
                note=(
                    f"'{numeric.group(0)}' could be "
                    f"{day_first.isoformat()} or {month_first.isoformat()}."
                ),
            )
        chosen = day_first or month_first
        if chosen:
            return DateReading(value=chosen, note=note)

    return None


# ----------------------------------------------------------------- currencies

#: Symbols that name exactly one currency. `$` is deliberately not here.
_UNAMBIGUOUS_SYMBOLS: Final[dict[str, str]] = {
    "J$": "JMD",
    "JA$": "JMD",
    "US$": "USD",
    "USD$": "USD",
    "CA$": "CAD",
    "\u00a3": "GBP",
    "\u20ac": "EUR",
    "\u00a5": "JPY",
}

_BARE_DOLLAR = re.compile(r"(?<![A-Za-z$])\$")

_ISO_CODE = re.compile(r"\b(" + "|".join(sorted(CURRENCY_EXPONENTS)) + r")\b")


@dataclass(frozen=True, slots=True)
class CurrencyReading:
    #: None when the document does not say, or says two things at once.
    code: str | None
    #: Every currency the document mentions, in the order found.
    found: tuple[str, ...] = ()
    note: str | None = None

    @property
    def is_ambiguous(self) -> bool:
        return self.code is None or len(set(self.found)) > 1


def detect_currency(text: str) -> CurrencyReading:
    """Work out which currency a document is denominated in.

    A bare `$` is never resolved by assumption. In this region it means Jamaican
    or United States dollars roughly interchangeably, the two differ by more than
    a hundredfold, and picking the configured base currency would turn a
    US$4,000 invoice into a JMD 4,000 one that sails through every threshold
    check in the platform.
    """
    if not text:
        return CurrencyReading(code=None, note="No currency was found.")

    found: list[str] = []

    upper = text.upper()
    for symbol, code in _UNAMBIGUOUS_SYMBOLS.items():
        if symbol.upper() in upper:
            found.append(code)

    found.extend(_ISO_CODE.findall(upper))

    distinct = list(dict.fromkeys(found))

    if len(distinct) == 1:
        return CurrencyReading(code=distinct[0], found=tuple(found))

    if len(distinct) > 1:
        return CurrencyReading(
            code=None,
            found=tuple(found),
            note=(
                "This document mentions " + ", ".join(distinct) + ". Confirm which "
                "one the amounts are in."
            ),
        )

    if _BARE_DOLLAR.search(text):
        return CurrencyReading(
            code=None,
            found=(),
            note=(
                "Amounts are written with '$' without saying which dollar. "
                "Confirm whether this is JMD or USD before using the figures."
            ),
        )

    return CurrencyReading(code=None, note="The document does not state a currency.")
