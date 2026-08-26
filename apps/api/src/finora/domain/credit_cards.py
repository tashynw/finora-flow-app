"""Credit-card statements: reading them, coding them, and closing the period.

A statement from the card issuer is a list of charges somebody in the organisation
must explain. Explaining one means naming a GL account and a cost centre, and
usually attaching a receipt. Closing the period means every line on that list has
been explained, by a person, and somebody else has looked at the whole and said
it is done.

## Two authorities, not one

Coding a line and closing its period are different permissions on purpose.
`credit_card:code` writes GL and cost centre onto a transaction;
`credit_card:close_period` freezes the period. Segregation of duties forbids the
same person from exercising both against the same period: the person who put the
codes on is the last person who should be allowed to declare the coding finished.

## A suggestion is never a close

An assistive reader may propose a GL, a cost centre or a receipt match. Those
proposals carry evidence and sit beside the line until a person accepts, edits or
rejects them. Nothing a model says can close a period. The design standard states
that outright, and the close path here takes no suggestion as input — only a
named person, a reason, and a period whose every line is already coded.

## Standing is derived

A period is open or closed. That is read from `closed_at`, the same way a payment
package is open or submitted. Inventing a workflow state for "being coded" would
put a container on the machine that governs claims about money, and a statement
is not one of those: the charges on it already happened at the bank.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from enum import StrEnum
from typing import Final
from uuid import UUID

from finora.domain.money import CurrencyError, Money, group_by_currency

MAX_MERCHANT_LENGTH: Final[int] = 300
MAX_CARDHOLDER_LENGTH: Final[int] = 120
MAX_CATEGORY_LENGTH: Final[int] = 120
MAX_EXCEPTION_LENGTH: Final[int] = 2000
MAX_CLOSE_REASON_LENGTH: Final[int] = 2000
MAX_REFERENCE_LENGTH: Final[int] = 80
MIN_CLOSE_REASON_LENGTH: Final[int] = 3

#: Last four digits of a card number, the only fragment we keep.
CARD_LAST_FOUR: Final[re.Pattern[str]] = re.compile(r"^\d{4}$")

#: Columns a statement CSV must carry. Extra columns are ignored; missing ones
#: refuse the file rather than inventing values.
STATEMENT_COLUMNS: Final[tuple[str, ...]] = (
    "date",
    "merchant",
    "amount",
    "cardholder",
)

OPTIONAL_STATEMENT_COLUMNS: Final[tuple[str, ...]] = (
    "category",
    "reference",
    "description",
)


class PeriodStanding(StrEnum):
    """Where a statement period is, derived from `closed_at`."""

    open = "open"
    closed = "closed"


PERIOD_STANDING_LABELS: Final[dict[PeriodStanding, str]] = {
    PeriodStanding.open: "Open",
    PeriodStanding.closed: "Closed",
}

PERIOD_STANDING_DESCRIPTIONS: Final[dict[PeriodStanding, str]] = {
    PeriodStanding.open: "Still being coded. Lines can change; nothing is locked.",
    PeriodStanding.closed: (
        "Closed. Coding and matches are fixed, and the period cannot be reopened from here."
    ),
}


class CodingStanding(StrEnum):
    """Whether a transaction has been explained."""

    uncoded = "uncoded"
    coded = "coded"
    excepted = "excepted"


CODING_STANDING_LABELS: Final[dict[CodingStanding, str]] = {
    CodingStanding.uncoded: "Needs coding",
    CodingStanding.coded: "Coded",
    CodingStanding.excepted: "Excepted",
}


class ReceiptStatus(StrEnum):
    """Whether a receipt is on the line."""

    missing = "missing"
    matched = "matched"
    waived = "waived"


RECEIPT_STATUS_LABELS: Final[dict[ReceiptStatus, str]] = {
    ReceiptStatus.missing: "No receipt",
    ReceiptStatus.matched: "Receipt matched",
    ReceiptStatus.waived: "Receipt waived",
}


class SuggestionDisposition(StrEnum):
    """What a person did with an assistive proposal."""

    pending = "pending"
    accepted = "accepted"
    edited = "edited"
    rejected = "rejected"


SUGGESTION_DISPOSITION_LABELS: Final[dict[SuggestionDisposition, str]] = {
    SuggestionDisposition.pending: "Waiting on a person",
    SuggestionDisposition.accepted: "Accepted as proposed",
    SuggestionDisposition.edited: "Accepted after editing",
    SuggestionDisposition.rejected: "Rejected",
}


class PeriodProblem(StrEnum):
    """Why a period cannot be closed as it stands."""

    already_closed = "already_closed"
    no_transactions = "no_transactions"
    uncoded_transactions = "uncoded_transactions"
    reason_required = "reason_required"
    reason_too_short = "reason_too_short"
    reason_too_long = "reason_too_long"


PROBLEM_FIELDS: Final[dict[PeriodProblem, str]] = {
    PeriodProblem.already_closed: "period",
    PeriodProblem.no_transactions: "transactions",
    PeriodProblem.uncoded_transactions: "transactions",
    PeriodProblem.reason_required: "reason",
    PeriodProblem.reason_too_short: "reason",
    PeriodProblem.reason_too_long: "reason",
}

PROBLEM_EXPLANATIONS: Final[dict[PeriodProblem, str]] = {
    PeriodProblem.already_closed: "This period is already closed.",
    PeriodProblem.no_transactions: (
        "A period with no transactions cannot be closed. Import the statement first."
    ),
    PeriodProblem.uncoded_transactions: (
        "Every transaction must be coded or excepted before the period can close."
    ),
    PeriodProblem.reason_required: "Closing a period needs a short reason on the record.",
    PeriodProblem.reason_too_short: (
        f"Give at least {MIN_CLOSE_REASON_LENGTH} characters so the reason can be read later."
    ),
    PeriodProblem.reason_too_long: (f"Keep the reason under {MAX_CLOSE_REASON_LENGTH} characters."),
}

#: Order matters: the first problem is the one a person acts on.
CLOSE_PROBLEM_ORDER: Final[tuple[PeriodProblem, ...]] = (
    PeriodProblem.already_closed,
    PeriodProblem.no_transactions,
    PeriodProblem.uncoded_transactions,
    PeriodProblem.reason_required,
    PeriodProblem.reason_too_short,
    PeriodProblem.reason_too_long,
)


class CodingProblem(StrEnum):
    """Why a coding change cannot be saved."""

    period_closed = "period_closed"
    gl_required = "gl_required"
    cost_centre_required = "cost_centre_required"
    exception_required = "exception_required"
    exception_too_long = "exception_too_long"
    category_too_long = "category_too_long"
    both_code_and_exception = "both_code_and_exception"


CODING_PROBLEM_FIELDS: Final[dict[CodingProblem, str]] = {
    CodingProblem.period_closed: "period",
    CodingProblem.gl_required: "gl_account_id",
    CodingProblem.cost_centre_required: "cost_centre_id",
    CodingProblem.exception_required: "exception_reason",
    CodingProblem.exception_too_long: "exception_reason",
    CodingProblem.category_too_long: "category",
    CodingProblem.both_code_and_exception: "exception_reason",
}

CODING_PROBLEM_EXPLANATIONS: Final[dict[CodingProblem, str]] = {
    CodingProblem.period_closed: "A closed period cannot be coded further.",
    CodingProblem.gl_required: "Choose a GL account, or mark the line as excepted instead.",
    CodingProblem.cost_centre_required: (
        "Choose a cost centre, or mark the line as excepted instead."
    ),
    CodingProblem.exception_required: (
        "An exception needs a reason saying why this line is not being coded."
    ),
    CodingProblem.exception_too_long: (
        f"Keep the exception under {MAX_EXCEPTION_LENGTH} characters."
    ),
    CodingProblem.category_too_long: (f"Keep the category under {MAX_CATEGORY_LENGTH} characters."),
    CodingProblem.both_code_and_exception: (
        "Code the line or except it, not both. Clear one before saving the other."
    ),
}


class ParseProblem(StrEnum):
    """Why a statement file cannot be read."""

    empty = "empty"
    missing_columns = "missing_columns"
    no_rows = "no_rows"
    bad_date = "bad_date"
    bad_amount = "bad_amount"
    blank_merchant = "blank_merchant"
    blank_cardholder = "blank_cardholder"
    merchant_too_long = "merchant_too_long"
    cardholder_too_long = "cardholder_too_long"
    mixed_currency = "mixed_currency"
    unsupported_currency = "unsupported_currency"


PARSE_PROBLEM_EXPLANATIONS: Final[dict[ParseProblem, str]] = {
    ParseProblem.empty: "The file is empty.",
    ParseProblem.missing_columns: (
        "The file needs columns named date, merchant, amount and cardholder."
    ),
    ParseProblem.no_rows: "The file has a header but no transactions.",
    ParseProblem.bad_date: "A date could not be read. Use YYYY-MM-DD.",
    ParseProblem.bad_amount: "An amount could not be read as a number.",
    ParseProblem.blank_merchant: "A row is missing its merchant.",
    ParseProblem.blank_cardholder: "A row is missing its cardholder.",
    ParseProblem.merchant_too_long: (
        f"A merchant name is longer than {MAX_MERCHANT_LENGTH} characters."
    ),
    ParseProblem.cardholder_too_long: (
        f"A cardholder name is longer than {MAX_CARDHOLDER_LENGTH} characters."
    ),
    ParseProblem.mixed_currency: ("Every amount on one statement must be in the same currency."),
    ParseProblem.unsupported_currency: "That currency is not supported.",
}


@dataclass(frozen=True, slots=True)
class FieldProblem:
    """One refusal, named against the field a person can fix."""

    code: PeriodProblem | CodingProblem | ParseProblem
    field: str
    message: str


@dataclass(frozen=True, slots=True)
class CardTransactionView:
    """What the domain needs to know about one line when deciding."""

    amount: Money
    gl_account_id: UUID | None
    cost_centre_id: UUID | None
    exception_reason: str | None
    receipt_document_id: UUID | None
    receipt_waived: bool


@dataclass(frozen=True, slots=True)
class PeriodView:
    """A period as the close rules see it."""

    closed_at: datetime | None
    transactions: tuple[CardTransactionView, ...]


@dataclass(frozen=True, slots=True)
class CodingDraft:
    """What a person is trying to write onto a transaction."""

    gl_account_id: UUID | None
    cost_centre_id: UUID | None
    category: str | None
    exception_reason: str | None


@dataclass(frozen=True, slots=True)
class ParsedTransaction:
    """One row read from a statement file, before it is stored."""

    posted_on: date
    merchant: str
    amount: Money
    cardholder: str
    category: str | None
    reference: str | None
    description: str | None
    source_row: int


@dataclass(frozen=True, slots=True)
class ParsedStatement:
    """A whole statement file that parsed cleanly."""

    currency: str
    transactions: tuple[ParsedTransaction, ...]

    @property
    def total(self) -> Money:
        amounts = [row.amount for row in self.transactions]
        by_currency = group_by_currency(amounts)
        assert len(by_currency) == 1
        return next(iter(by_currency.values()))


@dataclass(frozen=True, slots=True)
class ParseResult:
    """Either a usable statement or the reasons it is not."""

    statement: ParsedStatement | None
    problems: tuple[FieldProblem, ...]

    @property
    def ok(self) -> bool:
        return self.statement is not None and not self.problems


def period_standing(*, closed_at: datetime | None) -> PeriodStanding:
    return PeriodStanding.closed if closed_at is not None else PeriodStanding.open


def coding_standing(
    *,
    gl_account_id: UUID | None,
    cost_centre_id: UUID | None,
    exception_reason: str | None,
) -> CodingStanding:
    if exception_reason and exception_reason.strip():
        return CodingStanding.excepted
    if gl_account_id is not None and cost_centre_id is not None:
        return CodingStanding.coded
    return CodingStanding.uncoded


def receipt_status(
    *,
    document_id: UUID | None,
    waived: bool,
) -> ReceiptStatus:
    if document_id is not None:
        return ReceiptStatus.matched
    if waived:
        return ReceiptStatus.waived
    return ReceiptStatus.missing


def may_change(*, closed_at: datetime | None) -> bool:
    return closed_at is None


def is_explained(transaction: CardTransactionView) -> bool:
    return (
        coding_standing(
            gl_account_id=transaction.gl_account_id,
            cost_centre_id=transaction.cost_centre_id,
            exception_reason=transaction.exception_reason,
        )
        is not CodingStanding.uncoded
    )


def uncoded_count(transactions: tuple[CardTransactionView, ...]) -> int:
    return sum(1 for row in transactions if not is_explained(row))


def close_problems(
    period: PeriodView,
    *,
    reason: str | None,
) -> tuple[FieldProblem, ...]:
    """Everything that stops this period from closing, in the order to act on."""

    found: list[FieldProblem] = []

    def add(code: PeriodProblem) -> None:
        found.append(
            FieldProblem(
                code=code,
                field=PROBLEM_FIELDS[code],
                message=PROBLEM_EXPLANATIONS[code],
            )
        )

    if period.closed_at is not None:
        add(PeriodProblem.already_closed)
        return tuple(found)

    if not period.transactions:
        add(PeriodProblem.no_transactions)

    if uncoded_count(period.transactions) > 0:
        add(PeriodProblem.uncoded_transactions)

    cleaned = (reason or "").strip()
    if not cleaned:
        add(PeriodProblem.reason_required)
    elif len(cleaned) < MIN_CLOSE_REASON_LENGTH:
        add(PeriodProblem.reason_too_short)
    elif len(cleaned) > MAX_CLOSE_REASON_LENGTH:
        add(PeriodProblem.reason_too_long)

    # Keep the declared order so the first problem a caller surfaces is the one
    # a person can usefully fix first.
    order = {code: index for index, code in enumerate(CLOSE_PROBLEM_ORDER)}
    found.sort(key=lambda item: order[item.code])  # type: ignore[index]
    return tuple(found)


def may_close(period: PeriodView, *, reason: str | None) -> bool:
    return not close_problems(period, reason=reason)


def coding_problems(
    draft: CodingDraft,
    *,
    closed_at: datetime | None,
) -> tuple[FieldProblem, ...]:
    """Everything wrong with a proposed coding change."""

    found: list[FieldProblem] = []

    def add(code: CodingProblem) -> None:
        found.append(
            FieldProblem(
                code=code,
                field=CODING_PROBLEM_FIELDS[code],
                message=CODING_PROBLEM_EXPLANATIONS[code],
            )
        )

    if closed_at is not None:
        add(CodingProblem.period_closed)
        return tuple(found)

    exception = (draft.exception_reason or "").strip()
    category = (draft.category or "").strip()
    coding = draft.gl_account_id is not None or draft.cost_centre_id is not None

    if exception and coding:
        add(CodingProblem.both_code_and_exception)
        return tuple(found)

    if exception:
        if len(exception) > MAX_EXCEPTION_LENGTH:
            add(CodingProblem.exception_too_long)
        return tuple(found)

    if draft.gl_account_id is None:
        add(CodingProblem.gl_required)
    if draft.cost_centre_id is None:
        add(CodingProblem.cost_centre_required)
    if not exception and not coding:
        # Already covered by the two required fields; nothing further.
        pass
    if category and len(category) > MAX_CATEGORY_LENGTH:
        add(CodingProblem.category_too_long)
    if not coding and not exception:
        # gl_required and cost_centre_required already speak for this case.
        # A pure "you must do something" would duplicate them.
        pass

    return tuple(found)


def validate_card_last_four(value: str) -> str | None:
    """Return the cleaned last four, or None when the value is not four digits."""

    cleaned = value.strip()
    if not CARD_LAST_FOUR.match(cleaned):
        return None
    return cleaned


def parse_statement_csv(text: str, *, currency: str) -> ParseResult:
    """Read a statement CSV into transactions, or say why it cannot.

    Deterministic and strict. A missing column, a bad date or a blank merchant
    refuses the whole file rather than dropping the bad row: a statement that
    silently lost a charge is worse than one that will not import.
    """

    def fail(*codes: ParseProblem, detail: str | None = None) -> ParseResult:
        problems = tuple(
            FieldProblem(
                code=code,
                field="file",
                message=detail or PARSE_PROBLEM_EXPLANATIONS[code],
            )
            for code in codes
        )
        return ParseResult(statement=None, problems=problems)

    if not text or not text.strip():
        return fail(ParseProblem.empty)

    try:
        Money.zero(currency)
    except CurrencyError:
        return fail(ParseProblem.unsupported_currency)

    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None:
        return fail(ParseProblem.missing_columns)

    headers = {_normalise_header(name): name for name in reader.fieldnames if name}
    missing = [column for column in STATEMENT_COLUMNS if column not in headers]
    if missing:
        return fail(
            ParseProblem.missing_columns,
            detail=(
                PARSE_PROBLEM_EXPLANATIONS[ParseProblem.missing_columns]
                + f" Missing: {', '.join(missing)}."
            ),
        )

    rows: list[ParsedTransaction] = []
    for index, raw in enumerate(reader, start=2):
        problem = _parse_row(raw, headers=headers, currency=currency, source_row=index)
        if isinstance(problem, FieldProblem):
            return ParseResult(statement=None, problems=(problem,))
        rows.append(problem)

    if not rows:
        return fail(ParseProblem.no_rows)

    return ParseResult(
        statement=ParsedStatement(currency=currency.upper(), transactions=tuple(rows)),
        problems=(),
    )


def _normalise_header(name: str) -> str:
    return re.sub(r"[\s\-]+", "_", name.strip().lower())


def _parse_row(
    raw: dict[str, str | None],
    *,
    headers: dict[str, str],
    currency: str,
    source_row: int,
) -> ParsedTransaction | FieldProblem:
    def cell(column: str) -> str:
        key = headers[column]
        value = raw.get(key)
        return (value or "").strip()

    def optional(column: str) -> str | None:
        if column not in headers:
            return None
        value = cell(column)
        return value or None

    def problem(code: ParseProblem, message: str | None = None) -> FieldProblem:
        return FieldProblem(
            code=code,
            field="file",
            message=(f"Row {source_row}: " + (message or PARSE_PROBLEM_EXPLANATIONS[code])),
        )

    posted_raw = cell("date")
    try:
        posted_on = date.fromisoformat(posted_raw)
    except ValueError:
        return problem(ParseProblem.bad_date)

    merchant = cell("merchant")
    if not merchant:
        return problem(ParseProblem.blank_merchant)
    if len(merchant) > MAX_MERCHANT_LENGTH:
        return problem(ParseProblem.merchant_too_long)

    cardholder = cell("cardholder")
    if not cardholder:
        return problem(ParseProblem.blank_cardholder)
    if len(cardholder) > MAX_CARDHOLDER_LENGTH:
        return problem(ParseProblem.cardholder_too_long)

    amount_raw = cell("amount").replace(",", "")
    try:
        amount = Money.from_decimal(Decimal(amount_raw), currency)
    except (InvalidOperation, CurrencyError, TypeError, ValueError):
        return problem(ParseProblem.bad_amount)

    category = optional("category")
    if category and len(category) > MAX_CATEGORY_LENGTH:
        category = category[:MAX_CATEGORY_LENGTH]

    reference = optional("reference")
    if reference and len(reference) > MAX_REFERENCE_LENGTH:
        reference = reference[:MAX_REFERENCE_LENGTH]

    description = optional("description")

    return ParsedTransaction(
        posted_on=posted_on,
        merchant=merchant,
        amount=amount,
        cardholder=cardholder,
        category=category,
        reference=reference,
        description=description,
        source_row=source_row,
    )
