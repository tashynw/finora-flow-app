"""Many approved invoices, sent to the bank as one instruction.

An invoice that has been approved is owed. Nothing about that decides *when* it
leaves the account, and paying each one the moment it is approved is how an
office ends up with two hundred separate transfers a month, no single moment at
which somebody looked at the outgoing total, and no way to answer "what did we
pay on the fourteenth" without reading two hundred rows.

A package is that missing moment. It gathers approved invoices, states what they
come to, and is submitted once, against one reference the bank gives back.

## A package is a container, not a financial record

Estimates, invoices and purchase orders run on the platform's state machine
because each of them is a claim about money that somebody has to agree to. A
package agrees to nothing. Every invoice in it was already approved before it
could be added, and putting a hundred approved invoices in one envelope does not
create a hundred-and-first decision for anybody to make.

So a package has no state of its own. Whether it is still being assembled, has
gone to the bank, or was abandoned is read from `submitted_at` and
`cancelled_at`, and `standing` turns that into the word a person uses. This is
the same reasoning that keeps `closed_at` off the purchase order's state
machine, and it matters more here: `draft -> ready_for_submission` is not a legal
move for any record, and inventing it so a container could hold a status would
have handed every invoice a route from draft to the bank that skips approval
entirely.

The money's state does run on the machine, on each invoice. Adding one to a
package moves it from `approved` to `ready_for_submission`; taking it out moves
it back; submitting the package moves every one of them to `submitted`. That is
where the control belongs, because that is where the money is.

## What is submitted is what is kept

The manifest is generated from the package, hashed, and stored on it at the
moment of submission. A manifest produced later from the same rows would be the
same file, but that is a claim about this code rather than evidence about that
submission. The digest recorded at the time is evidence: it says what the bank
was given, and it says so in a way that a later edit to anything cannot forge.

Nothing in a submitted package can change afterwards, for the same reason.
"""

from __future__ import annotations

import csv
import hashlib
import io
from dataclasses import dataclass
from datetime import date, datetime
from enum import StrEnum
from typing import Final

from finora.domain.money import Money, group_by_currency
from finora.domain.workflow import WorkflowState

#: The one state an invoice may be in when it is added to a package. Approved and
#: nothing else: a package is an envelope for decisions already taken, and an
#: invoice still waiting on one is not in it because somebody forgot.
JOINABLE_STATE: Final[WorkflowState] = WorkflowState.approved

#: Where an invoice sits while it is in a package that has not gone yet.
IN_PACKAGE_STATE: Final[WorkflowState] = WorkflowState.ready_for_submission

MIN_REFERENCE_LENGTH: Final[int] = 3
MAX_REFERENCE_LENGTH: Final[int] = 120


class PaymentMethod(StrEnum):
    """How the money leaves.

    Named rather than free text because it changes what the bank needs and what
    the manifest has to carry, and because "how do we pay this supplier" is a
    question a report should be able to group by.
    """

    bank_transfer = "bank_transfer"
    cheque = "cheque"
    wire = "wire"
    direct_debit = "direct_debit"


PAYMENT_METHOD_LABELS: Final[dict[PaymentMethod, str]] = {
    PaymentMethod.bank_transfer: "Bank transfer",
    PaymentMethod.cheque: "Cheque",
    PaymentMethod.wire: "Wire",
    PaymentMethod.direct_debit: "Direct debit",
}


class PackageStanding(StrEnum):
    """Where a package is in its short life, derived rather than stored."""

    open = "open"
    submitted = "submitted"
    cancelled = "cancelled"


#: "Abandoned" rather than "Cancelled" for the last of them, because that is the
#: word on the button that produces it and in the panel that explains it, and
#: three names for one act is how a reader ends up wondering whether a cancelled
#: package is a different thing from an abandoned one. The enum member keeps the
#: workflow's own vocabulary; only what a person reads changes.
STANDING_LABELS: Final[dict[PackageStanding, str]] = {
    PackageStanding.open: "Open",
    PackageStanding.submitted: "Submitted",
    PackageStanding.cancelled: "Abandoned",
}

STANDING_DESCRIPTIONS: Final[dict[PackageStanding, str]] = {
    PackageStanding.open: "Still being put together. Nothing has left the account.",
    PackageStanding.submitted: "Sent to the bank. What it contained can no longer change.",
    PackageStanding.cancelled: (
        "Abandoned. Everything in it went back to being approved and unpaid."
    ),
}


def standing(*, submitted_at: datetime | None, cancelled_at: datetime | None) -> PackageStanding:
    """Which of the three a package is in.

    Submitted wins over cancelled if both are somehow set. A package that went to
    the bank was submitted whatever anybody recorded afterwards, and reading it
    the other way would describe money that has moved as money that never did.
    """
    if submitted_at is not None:
        return PackageStanding.submitted
    if cancelled_at is not None:
        return PackageStanding.cancelled
    return PackageStanding.open


def may_change(current: PackageStanding) -> bool:
    """Whether lines can still be added to or taken out of this package."""
    return current is PackageStanding.open


class JoinRefusal(StrEnum):
    """Why a particular invoice cannot go into a package."""

    not_approved = "not_approved"
    already_in_a_package = "already_in_a_package"
    package_is_closed = "package_is_closed"
    no_amount = "no_amount"


JOIN_REFUSAL_EXPLANATIONS: Final[dict[JoinRefusal, str]] = {
    JoinRefusal.not_approved: (
        "Only approved invoices can be paid. This one has not finished going round, "
        "so nobody has yet agreed that it is owed."
    ),
    JoinRefusal.already_in_a_package: (
        "This invoice is already in another package. Paying it from two would pay it twice."
    ),
    JoinRefusal.package_is_closed: (
        "This package has already been submitted or cancelled, so what it contains is settled."
    ),
    JoinRefusal.no_amount: (
        "This invoice has no amount on it, so there is nothing to instruct the bank to send."
    ),
}


def why_not_joinable(
    *,
    invoice_state: WorkflowState,
    total: Money | None,
    in_another_package: bool,
    package_standing: PackageStanding,
) -> JoinRefusal | None:
    """The single reason this invoice cannot join, or None if it can.

    One reason rather than a list: unlike the problems on a draft, these are not
    a checklist somebody works through. Each is final on its own, and the second
    of them tells the reader nothing they can act on.
    """
    if not may_change(package_standing):
        return JoinRefusal.package_is_closed
    if in_another_package:
        return JoinRefusal.already_in_a_package
    if invoice_state is not JOINABLE_STATE:
        return JoinRefusal.not_approved
    if total is None or total.minor_units <= 0:
        return JoinRefusal.no_amount
    return None


def explain_refusal(refusal: JoinRefusal) -> str:
    return JOIN_REFUSAL_EXPLANATIONS[refusal]


class PackageProblem(StrEnum):
    """Why a package cannot be submitted as it stands."""

    nothing_in_it = "nothing_in_it"
    payment_method_missing = "payment_method_missing"
    payment_date_missing = "payment_date_missing"
    payment_date_in_the_past = "payment_date_in_the_past"
    #: An invoice in the package stopped being payable after it was added: sent
    #: back for a correction, cancelled, or otherwise moved on by somebody else.
    line_no_longer_payable = "line_no_longer_payable"
    #: A supplier appears twice with the same invoice number. Not necessarily
    #: wrong, and never assumed to be right.
    repeated_invoice_number = "repeated_invoice_number"


PROBLEM_EXPLANATIONS: Final[dict[PackageProblem, str]] = {
    PackageProblem.nothing_in_it: (
        "There is nothing in this package. Add the approved invoices it is meant to pay."
    ),
    PackageProblem.payment_method_missing: (
        "Say how the money leaves. The bank needs it, and it decides what the manifest carries."
    ),
    PackageProblem.payment_date_missing: (
        "Give the date the money is meant to leave, so a supplier chasing payment "
        "can be told when rather than soon."
    ),
    PackageProblem.payment_date_in_the_past: (
        "The intended payment date has gone by. Move it forward, or this package "
        "goes to the bank already saying it is late."
    ),
    PackageProblem.line_no_longer_payable: (
        "Something in this package is no longer payable. It was approved when it "
        "was added and has moved on since, so it has to come out before the rest can go."
    ),
    PackageProblem.repeated_invoice_number: (
        "The same supplier appears twice with the same invoice number. That is how "
        "one invoice gets paid twice, so it needs looking at even if both are right."
    ),
}

PROBLEM_FIELDS: Final[dict[PackageProblem, str]] = {
    PackageProblem.nothing_in_it: "lines",
    PackageProblem.payment_method_missing: "payment_method",
    PackageProblem.payment_date_missing: "intended_payment_date",
    PackageProblem.payment_date_in_the_past: "intended_payment_date",
    PackageProblem.line_no_longer_payable: "lines",
    PackageProblem.repeated_invoice_number: "lines",
}

#: Problems that are a control firing rather than a form half-filled. Shown in
#: red and counted separately, on the same reasoning as invoices and orders: an
#: empty field is the reader's own unfinished work, and a repeated invoice number
#: is the system refusing to let them do something.
BLOCKING_PROBLEMS: Final[frozenset[PackageProblem]] = frozenset(
    {
        PackageProblem.line_no_longer_payable,
        PackageProblem.repeated_invoice_number,
    }
)


@dataclass(frozen=True, slots=True)
class PackageLine:
    """One invoice as it sits in a package."""

    invoice_id: object
    #: Ours. Stable, and what the audit trail refers to.
    reference: str
    #: The supplier's. Absent on an invoice recorded from a document that never
    #: carried one, which is why the duplicate check tolerates None.
    invoice_number: str | None
    vendor_id: object | None
    vendor_name: str
    total: Money
    due_date: date | None
    #: The invoice's state right now, which is not necessarily the state it was
    #: in when it was added.
    state: WorkflowState


@dataclass(frozen=True, slots=True)
class PackageDetails:
    """A package as it currently stands, for validation."""

    lines: tuple[PackageLine, ...]
    payment_method: PaymentMethod | None
    intended_payment_date: date | None
    #: Today, passed in rather than read, so the same package validates the same
    #: way in a test as it does at half past eleven at night.
    today: date
    #: Where the package stands. Defaulted, because everything else here is about
    #: a package still being assembled and that is what almost every caller has.
    standing: PackageStanding = PackageStanding.open


def problems(details: PackageDetails) -> tuple[PackageProblem, ...]:
    """Everything standing between this package and the bank.

    Nothing at all once the package has gone or been abandoned. Every problem
    below asks for a change to the package, and neither state can take one: on a
    submitted package the invoices have deliberately moved past `approved`, which
    would otherwise report the consequence of sending it as a fault, and tell the
    reader to remove a line from a package that can no longer be edited.
    """
    if not may_change(details.standing):
        return ()

    found: list[PackageProblem] = []

    if not details.lines:
        found.append(PackageProblem.nothing_in_it)

    if details.payment_method is None:
        found.append(PackageProblem.payment_method_missing)

    if details.intended_payment_date is None:
        found.append(PackageProblem.payment_date_missing)
    elif details.intended_payment_date < details.today:
        found.append(PackageProblem.payment_date_in_the_past)

    if any(line.state is not IN_PACKAGE_STATE for line in details.lines):
        found.append(PackageProblem.line_no_longer_payable)

    if _has_repeat(details.lines):
        found.append(PackageProblem.repeated_invoice_number)

    return tuple(found)


def _has_repeat(lines: tuple[PackageLine, ...]) -> bool:
    """Whether one supplier appears twice under one invoice number.

    Keyed on the supplier as well as the number because invoice numbering is each
    supplier's own business, and two companies both numbering from 1 is ordinary
    rather than suspicious. Lines with no number are skipped: absence is not a
    match, and treating it as one would flag every package holding two invoices
    that arrived without numbers on them.

    Not redundant with the partial unique index on invoices, which forbids two
    *live* rows sharing a supplier and a number. A line carries the number copied
    when it was added, and the case this catches is the one that index cannot
    see: an invoice goes into a package, is cancelled — freeing its number — and
    a replacement carrying the same number is added beside the line still
    quoting it. Both are legitimate rows; paying both is not.
    """
    seen: set[tuple[object, str]] = set()
    for line in lines:
        number = (line.invoice_number or "").strip().upper()
        if not number or line.vendor_id is None:
            continue
        key = (line.vendor_id, number)
        if key in seen:
            return True
        seen.add(key)
    return False


def blocking(found: tuple[PackageProblem, ...]) -> tuple[PackageProblem, ...]:
    return tuple(problem for problem in found if problem in BLOCKING_PROBLEMS)


def is_ready(details: PackageDetails) -> bool:
    return not problems(details)


def explain(problem: PackageProblem) -> str:
    return PROBLEM_EXPLANATIONS[problem]


def field_for(problem: PackageProblem) -> str:
    return PROBLEM_FIELDS[problem]


def totals(lines: tuple[PackageLine, ...]) -> dict[str, Money]:
    """What the package comes to, per currency.

    Never one number. A package holding JMD and USD has two totals, and adding
    them would produce a figure denominated in nothing that somebody would
    eventually put in front of a bank.
    """
    return group_by_currency([line.total for line in lines])


def vendor_count(lines: tuple[PackageLine, ...]) -> int:
    """How many suppliers are being paid, which is not how many invoices there are.

    Counted by identity where there is one and by name otherwise, so a supplier
    who is only a name on two documents is still one supplier.
    """
    return len(
        {line.vendor_id if line.vendor_id is not None else line.vendor_name for line in lines}
    )


def validate_submission_reference(reference: str) -> str:
    """The bank's own reference for the submission, cleaned and checked.

    Required, because it is the only thing that ties this package to what the
    bank did with it. Without it, "was this paid" has no answer on either side.
    """
    cleaned = " ".join(reference.split())
    if len(cleaned) < MIN_REFERENCE_LENGTH:
        raise ValueError(
            "Give the reference the bank returned for this submission. It is what "
            "ties this package to the payment, and there is no way back to it later."
        )
    if len(cleaned) > MAX_REFERENCE_LENGTH:
        raise ValueError(
            f"A submission reference cannot be longer than {MAX_REFERENCE_LENGTH} characters."
        )
    return cleaned


# ------------------------------------------------------------------- manifest

#: The columns, in order. Fixed here rather than built from whatever the rows
#: happen to have, so a manifest generated a year from now still opens in
#: whatever the bank loads it with.
MANIFEST_COLUMNS: Final[tuple[str, ...]] = (
    "Row",
    "Package",
    "Payment date",
    "Payment method",
    "Our reference",
    "Supplier",
    "Their invoice number",
    "Invoice date due",
    "Currency",
    "Amount",
)

#: What goes in the first column. A discriminator rather than a totals block
#: after a blank line, because a file that stops being a table halfway down is a
#: file that something eventually parses wrongly. With this, every line has the
#: same shape and the control totals are still in the file — which is the point
#: of putting them there, since a truncated manifest that carries its own total
#: is a truncated manifest somebody notices.
ROW_LINE: Final[str] = "Invoice"
ROW_TOTAL: Final[str] = "Total"


@dataclass(frozen=True, slots=True)
class Manifest:
    """The file that went to the bank, and the digest that proves it did."""

    content: str
    #: SHA-256 of the UTF-8 bytes, hex. Recorded on the package at submission.
    digest: str
    line_count: int


def render_manifest(
    *,
    package_reference: str,
    payment_method: PaymentMethod,
    intended_payment_date: date,
    lines: tuple[PackageLine, ...],
) -> Manifest:
    """Build the manifest for a package.

    Deterministic, and deliberately so. The same package renders byte for byte
    the same file every time, which is what lets the digest recorded at
    submission be checked against a manifest regenerated afterwards. Rows are
    ordered by supplier and then by our own reference rather than by whatever
    order somebody added them in, because two people assembling the same package
    should not produce two different files.

    Amounts are written in major units with no thousands separators and no
    currency symbol, with the currency in its own column. A grouping comma inside
    a CSV field is how a manifest turns into a payment for a hundredth of what
    was meant.
    """
    ordered = tuple(sorted(lines, key=lambda line: (line.vendor_name.casefold(), line.reference)))

    buffer = io.StringIO(newline="")
    # Explicit line terminator: the default is platform-dependent, and a digest
    # that changes with the operating system of whoever pressed submit is not
    # evidence of anything.
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(MANIFEST_COLUMNS)

    date_written = intended_payment_date.isoformat()
    method_written = PAYMENT_METHOD_LABELS[payment_method]

    for line in ordered:
        writer.writerow(
            (
                ROW_LINE,
                package_reference,
                date_written,
                method_written,
                line.reference,
                line.vendor_name,
                line.invoice_number or "",
                line.due_date.isoformat() if line.due_date else "",
                line.total.currency,
                line.total.format(with_currency=False).replace(",", ""),
            )
        )

    for currency, total in totals(ordered).items():
        writer.writerow(
            (
                ROW_TOTAL,
                package_reference,
                date_written,
                method_written,
                "",
                "",
                "",
                "",
                currency,
                total.format(with_currency=False).replace(",", ""),
            )
        )

    content = buffer.getvalue()
    return Manifest(
        content=content,
        digest=hashlib.sha256(content.encode("utf-8")).hexdigest(),
        line_count=len(ordered),
    )


def manifest_filename(package_reference: str) -> str:
    """What the download is called.

    The package reference is generated rather than typed, so it is safe in a
    filename without escaping, and it is what somebody looking at a folder of
    these needs to see.
    """
    return f"{package_reference}-manifest.csv"
