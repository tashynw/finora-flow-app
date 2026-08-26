"""What an invoice is, and when it is fit to be paid.

An estimate asks for permission to spend. An invoice is the demand for money that
follows, and the difference matters throughout this module: an estimate that is
wrong wastes an approver's time, whereas an invoice that is wrong moves money to
the wrong place, twice, or for goods nobody received. So the rules here are less
forgiving than the ones in `domain.estimates`, and three of them exist purely to
stop a payment rather than to improve a record.

The three are worth naming, because they are the reason this module is not simply
the estimate rules with different field names:

*Duplicate control.* A vendor sending the same invoice twice is not an anomaly, it
is ordinary: they chase, they re-send, the same PDF arrives by two routes. Paying
it twice is the single most common way an accounts payable function loses money,
so the same vendor's same invoice number is refused rather than flagged.

*Overrun control.* An approved estimate is a spending limit, not a suggestion. An
invoice that exceeds it has not been approved, whatever the estimate says, so it
is stopped and sent back for a decision rather than let through on the strength of
an approval given for a smaller figure.

*Receipt control.* Nothing here can tell whether the goods arrived. Only the person
who asked for them knows, which is why sign-off is a state in the workflow rather
than a checkbox on this form.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date
from enum import StrEnum
from types import MappingProxyType
from typing import Final
from uuid import UUID

from finora.domain.money import Money
from finora.domain.workflow import WorkflowState

#: The states an invoice can occupy: the whole workflow. Unlike an estimate, an
#: invoice runs the full distance from a draft to money leaving the organisation,
#: which is why every state in the machine is reachable from here.
INVOICE_STATES: Final[frozenset[WorkflowState]] = frozenset(
    {
        WorkflowState.draft,
        WorkflowState.pending_sign_off,
        WorkflowState.pending_approval,
        WorkflowState.approved,
        WorkflowState.ready_for_submission,
        WorkflowState.submitted,
        WorkflowState.paid,
        WorkflowState.outstanding,
        WorkflowState.exception,
        WorkflowState.accrual_needed,
        WorkflowState.rejected,
        WorkflowState.cancelled,
    }
)

#: States in which the invoice's own details may still be edited. As with an
#: estimate, an amount that changes under an open route means approvers are
#: deciding on a figure that is no longer there. Unlike an estimate, sign-off is
#: also a decision about a specific figure, so editing stops before it, not after.
EDITABLE_STATES: Final[frozenset[WorkflowState]] = frozenset(
    {WorkflowState.draft, WorkflowState.exception}
)

#: States in which the invoice is waiting on a person to confirm receipt.
AWAITING_SIGN_OFF_STATES: Final[frozenset[WorkflowState]] = frozenset(
    {WorkflowState.pending_sign_off}
)


class InvoiceProblem(StrEnum):
    """Why an invoice cannot proceed.

    Enumerated for the same reasons as `EstimateProblem`: one wording per gap, a
    field for the screen to point at, and a countable reason so "how many invoices
    are held up waiting for a purchase order" is a question the data can answer.
    """

    vendor_missing = "vendor_missing"
    vendor_not_on_master = "vendor_not_on_master"
    invoice_number_missing = "invoice_number_missing"
    invoice_date_missing = "invoice_date_missing"
    invoice_date_in_future = "invoice_date_in_future"
    amount_missing = "amount_missing"
    amount_not_positive = "amount_not_positive"
    due_date_before_invoice_date = "due_date_before_invoice_date"
    description_missing = "description_missing"
    cost_centre_missing = "cost_centre_missing"
    requester_missing = "requester_missing"
    duplicate_invoice_number = "duplicate_invoice_number"
    estimate_not_approved = "estimate_not_approved"
    estimate_vendor_mismatch = "estimate_vendor_mismatch"
    estimate_currency_mismatch = "estimate_currency_mismatch"
    exceeds_estimate = "exceeds_estimate"
    purchase_order_required = "purchase_order_required"
    purchase_order_not_open = "purchase_order_not_open"
    purchase_order_vendor_mismatch = "purchase_order_vendor_mismatch"
    purchase_order_currency_mismatch = "purchase_order_currency_mismatch"
    exceeds_purchase_order = "exceeds_purchase_order"


PROBLEM_EXPLANATIONS: Final[dict[InvoiceProblem, str]] = {
    InvoiceProblem.vendor_missing: (
        "Name the vendor this invoice is from. Nothing can be paid to a supplier "
        "nobody has identified."
    ),
    InvoiceProblem.vendor_not_on_master: (
        "Link this invoice to a vendor on the supplier master. An estimate may name "
        "a supplier in free text, but payment only ever goes to a recorded one."
    ),
    InvoiceProblem.invoice_number_missing: (
        "Enter the vendor's own invoice number. It is how they will refer to it, "
        "and it is what stops the same invoice being paid twice."
    ),
    InvoiceProblem.invoice_date_missing: "Enter the date printed on the invoice.",
    InvoiceProblem.invoice_date_in_future: (
        "The invoice date is in the future. Check it against the document."
    ),
    InvoiceProblem.amount_missing: "Enter the invoice total and its currency.",
    InvoiceProblem.amount_not_positive: (
        "The total must be more than zero. A credit note is recorded against the "
        "invoice it credits, not as an invoice of its own."
    ),
    InvoiceProblem.due_date_before_invoice_date: (
        "The payment due date is earlier than the invoice date. One of the two is wrong."
    ),
    InvoiceProblem.description_missing: (
        "Describe what was supplied, in a line the person confirming receipt can "
        "recognise without opening the document."
    ),
    InvoiceProblem.cost_centre_missing: (
        "Choose the cost centre this belongs to. Approval routing and the month-end "
        "position both depend on it."
    ),
    InvoiceProblem.requester_missing: (
        "Name the person who will confirm the goods or services were received. "
        "Nothing reaches an approver until somebody outside finance says it arrived, "
        "so an invoice with nobody to ask cannot move."
    ),
    InvoiceProblem.duplicate_invoice_number: (
        "This vendor has already sent an invoice with this number, and it is still "
        "live. Paying the same invoice twice is the most expensive mistake this "
        "platform exists to prevent, so open the existing one instead."
    ),
    InvoiceProblem.estimate_not_approved: (
        "The linked estimate has not been approved. Approve the spend before "
        "recording the invoice against it, or unlink it."
    ),
    InvoiceProblem.estimate_vendor_mismatch: (
        "The linked estimate is for a different vendor. An invoice can only draw on "
        "an approval granted for the supplier it came from."
    ),
    InvoiceProblem.estimate_currency_mismatch: (
        "The invoice and the linked estimate are in different currencies, so no "
        "comparison between them means anything. Correct whichever is wrong."
    ),
    InvoiceProblem.exceeds_estimate: (
        "This invoice is for more than the approved estimate allows. The approval "
        "covers the smaller figure, so this needs approving again at the new amount."
    ),
    InvoiceProblem.purchase_order_required: (
        "Spend of this size needs a purchase order. Link the order this invoice is "
        "against, or raise one before recording it."
    ),
    InvoiceProblem.purchase_order_not_open: (
        "The linked purchase order is closed or cancelled and cannot take further invoices."
    ),
    InvoiceProblem.purchase_order_vendor_mismatch: (
        "The linked purchase order was raised for a different vendor."
    ),
    InvoiceProblem.purchase_order_currency_mismatch: (
        "The invoice and the linked purchase order are in different currencies, so "
        "no comparison between them means anything."
    ),
    InvoiceProblem.exceeds_purchase_order: (
        "This invoice, with everything already billed against the order, comes to "
        "more than the order allows."
    ),
}

#: Which control on the screen each problem belongs to.
PROBLEM_FIELDS: Final[dict[InvoiceProblem, str]] = {
    InvoiceProblem.vendor_missing: "vendor_name",
    InvoiceProblem.vendor_not_on_master: "vendor_id",
    InvoiceProblem.invoice_number_missing: "invoice_number",
    InvoiceProblem.invoice_date_missing: "invoice_date",
    InvoiceProblem.invoice_date_in_future: "invoice_date",
    InvoiceProblem.amount_missing: "total",
    InvoiceProblem.amount_not_positive: "total",
    InvoiceProblem.due_date_before_invoice_date: "due_date",
    InvoiceProblem.description_missing: "description",
    InvoiceProblem.cost_centre_missing: "cost_centre_id",
    InvoiceProblem.requester_missing: "requester_id",
    InvoiceProblem.duplicate_invoice_number: "invoice_number",
    InvoiceProblem.estimate_not_approved: "estimate_id",
    InvoiceProblem.estimate_vendor_mismatch: "estimate_id",
    InvoiceProblem.estimate_currency_mismatch: "estimate_id",
    InvoiceProblem.exceeds_estimate: "total",
    InvoiceProblem.purchase_order_required: "purchase_order_id",
    InvoiceProblem.purchase_order_not_open: "purchase_order_id",
    InvoiceProblem.purchase_order_vendor_mismatch: "purchase_order_id",
    InvoiceProblem.purchase_order_currency_mismatch: "purchase_order_id",
    InvoiceProblem.exceeds_purchase_order: "total",
}

#: Problems that stop an invoice being paid rather than merely being incomplete.
#: Separated because the register shows them differently: an incomplete draft is
#: the requester's ordinary work in progress, whereas a duplicate or an overrun is
#: a control that has fired and somebody needs to look at it.
#:
#: `vendor_not_on_master` is deliberately outside the set, which reads oddly for
#: the one problem that names a supplier nobody has recorded. The answer to it is
#: always the same and always ordinary — link a recorded supplier, or onboard the
#: one on the document — whereas every problem below states a contradiction
#: between two things that are already recorded. Making it blocking would put the
#: red banner on every invoice raised from a document whose letterhead did not
#: match the master, which is common enough that the banner would stop meaning
#: anything. Nothing can move on such an invoice either way: it is not ready while
#: any problem stands.
BLOCKING_PROBLEMS: Final[frozenset[InvoiceProblem]] = frozenset(
    {
        InvoiceProblem.duplicate_invoice_number,
        InvoiceProblem.estimate_not_approved,
        InvoiceProblem.estimate_vendor_mismatch,
        InvoiceProblem.estimate_currency_mismatch,
        InvoiceProblem.exceeds_estimate,
        InvoiceProblem.purchase_order_required,
        InvoiceProblem.purchase_order_not_open,
        InvoiceProblem.purchase_order_vendor_mismatch,
        InvoiceProblem.purchase_order_currency_mismatch,
        InvoiceProblem.exceeds_purchase_order,
    }
)

#: Shortest description that could plausibly identify a supply. As with the
#: estimate justification, this is a floor against a single character rather than
#: a judgement about quality.
MIN_DESCRIPTION_LENGTH: Final[int] = 6


@dataclass(frozen=True, slots=True)
class LinkedEstimate:
    """The approved spend an invoice is drawing against.

    Only the parts the invoice rules need. Passing the whole estimate row would
    tie this module to the database and let a rule quietly start depending on a
    field nobody meant it to see.
    """

    estimate_id: UUID
    state: WorkflowState
    vendor_id: UUID | None
    vendor_name: str
    approved_total: Money | None


@dataclass(frozen=True, slots=True)
class LinkedPurchaseOrder:
    """The order an invoice is billed against, and what is left on it."""

    purchase_order_id: UUID
    is_open: bool
    vendor_id: UUID
    total: Money
    #: Already billed by other live invoices against this order. The invoice being
    #: checked is never included, so re-checking a saved invoice does not count it
    #: against itself.
    billed_by_others: Money


@dataclass(frozen=True, slots=True)
class InvoiceDetails:
    """The details an invoice is judged against.

    A value object rather than the ORM row, so the rules can be exercised directly
    and the same check runs against a draft being edited and a row being read back.
    """

    vendor_name: str
    description: str
    invoice_number: str | None
    invoice_date: date | None
    total: Money | None
    cost_centre_id: object | None
    #: Who will be asked to confirm the goods arrived. Untyped for the same reason
    #: as the cost centre: which identifier the store uses is not the domain's
    #: business, and only its presence is a rule.
    requester_id: object | None = None
    vendor_id: UUID | None = None
    due_date: date | None = None
    estimate: LinkedEstimate | None = None
    purchase_order: LinkedPurchaseOrder | None = None
    #: True when another live invoice already carries this vendor and number.
    #: Resolved by the caller because it is a question about the register, not
    #: about this invoice on its own.
    is_duplicate: bool = False


@dataclass(frozen=True, slots=True)
class TolerancePolicy:
    """How far above an approved figure an invoice may still go.

    Two allowances rather than one, and the larger of the two applies. A
    percentage alone is useless on a small invoice, where a rounding difference of
    a few cents is a larger proportion than any sane percentage; an absolute
    allowance alone is either meaningless on a large invoice or reckless on a
    small one. Both are configuration, because the authoritative requirements
    document that would set them is not available.
    """

    percent: int = 0
    minor_units: int = 0

    def ceiling(self, approved: Money) -> Money:
        """The most an invoice may come to against this approved figure."""
        by_percent = approved.minor_units * self.percent // 100
        return Money(approved.minor_units + max(by_percent, self.minor_units), approved.currency)


NO_TOLERANCE: Final[TolerancePolicy] = TolerancePolicy()


#: Shared empty default. A `MappingProxyType` rather than a dict so a caller
#: cannot reach into the default and give every policy in the process a threshold.
_NO_THRESHOLDS: Final[Mapping[str, Money]] = MappingProxyType({})


@dataclass(frozen=True, slots=True)
class PurchaseOrderPolicy:
    """Where the line is above which an invoice must name a purchase order.

    One figure per currency, and never a conversion between them, on the same
    reasoning as the approval bands: a threshold stated in JMD is a statement
    about JMD spending and says nothing about a US dollar invoice.

    Two absences mean different things, and the distinction is the point.

    *No thresholds at all* means the control is not in use. This is what a fresh
    installation looks like before anybody has configured anything, and requiring
    a purchase order for every invoice in that state would make the platform
    unusable on day one for a reason nobody could find.

    *Thresholds configured, but not for this currency*, means somebody has adopted
    the control and has not said what it should be here. The order is required.
    That direction is deliberately the awkward one: the opposite would let a
    currency nobody had got round to configuring quietly have its purchase-order
    requirement switched off, with nothing on any screen looking wrong. This way
    the gap is loud and the administration screen names the currencies in it.
    """

    thresholds: Mapping[str, Money] = _NO_THRESHOLDS

    @property
    def is_in_use(self) -> bool:
        return bool(self.thresholds)

    def threshold_for(self, currency: str) -> Money | None:
        return self.thresholds.get(currency.upper())

    def requires_order(self, total: Money | None) -> bool:
        if total is None or not self.thresholds:
            return False
        threshold = self.threshold_for(total.currency)
        if threshold is None:
            return True
        # Exclusive: the control is stated as applying *above* the figure, so an
        # invoice for exactly the figure does not need an order. Deliberately
        # unlike the approval bands, whose minimum is inclusive, which is why the
        # column is named for what it means rather than for a minimum.
        return total > threshold


NO_PURCHASE_ORDER_POLICY: Final[PurchaseOrderPolicy] = PurchaseOrderPolicy()


def problems(
    details: InvoiceDetails,
    *,
    today: date,
    purchase_orders: PurchaseOrderPolicy = NO_PURCHASE_ORDER_POLICY,
    tolerance: TolerancePolicy = NO_TOLERANCE,
) -> tuple[InvoiceProblem, ...]:
    """Everything standing between this invoice and a payment.

    All of them, rather than the first, so the whole remaining task is visible on
    one screen instead of being discovered one refusal at a time.
    """
    found: list[InvoiceProblem] = []

    found.extend(_own_details(details, today=today))
    found.extend(_against_estimate(details))
    found.extend(_against_purchase_order(details, policy=purchase_orders))

    # Applied last, and to both comparisons, because a tolerance is a decision
    # about which overruns are worth a person's attention rather than a property
    # of either the estimate or the order.
    return tuple(_within_tolerance(found, details, tolerance=tolerance))


def _own_details(details: InvoiceDetails, *, today: date) -> list[InvoiceProblem]:
    """What is wrong with the invoice considered by itself."""
    found: list[InvoiceProblem] = []

    if not details.vendor_name.strip():
        found.append(InvoiceProblem.vendor_missing)
    elif details.vendor_id is None:
        # Deliberately stricter than an estimate, which may name a supplier who is
        # not yet on the master. Money only ever moves to a recorded vendor, and
        # the invoice is where that stops being a future problem.
        found.append(InvoiceProblem.vendor_not_on_master)

    if not (details.invoice_number or "").strip():
        found.append(InvoiceProblem.invoice_number_missing)
    elif details.is_duplicate:
        found.append(InvoiceProblem.duplicate_invoice_number)

    if details.invoice_date is None:
        found.append(InvoiceProblem.invoice_date_missing)
    elif details.invoice_date > today:
        found.append(InvoiceProblem.invoice_date_in_future)

    if details.total is None:
        found.append(InvoiceProblem.amount_missing)
    elif details.total.minor_units <= 0:
        found.append(InvoiceProblem.amount_not_positive)

    if (
        details.due_date is not None
        and details.invoice_date is not None
        and details.due_date < details.invoice_date
    ):
        found.append(InvoiceProblem.due_date_before_invoice_date)

    if len(details.description.strip()) < MIN_DESCRIPTION_LENGTH:
        found.append(InvoiceProblem.description_missing)
    if details.cost_centre_id is None:
        found.append(InvoiceProblem.cost_centre_missing)
    if details.requester_id is None:
        # A gap like any other, and listed with them, because the alternative is
        # what it replaced: a complete-looking draft whose send button was
        # disabled with nothing on the screen saying why.
        found.append(InvoiceProblem.requester_missing)

    return found


def _against_estimate(details: InvoiceDetails) -> list[InvoiceProblem]:
    """What is wrong with the invoice against the spend that was approved."""
    estimate = details.estimate
    if estimate is None:
        return []

    found: list[InvoiceProblem] = []

    if estimate.state is not WorkflowState.approved:
        found.append(InvoiceProblem.estimate_not_approved)

    # Compared by identity when both sides have one, and by name only when the
    # estimate predates the vendor being added to the master. Comparing names
    # when identifiers exist would let a renamed vendor break a valid link.
    if estimate.vendor_id is not None and details.vendor_id is not None:
        if estimate.vendor_id != details.vendor_id:
            found.append(InvoiceProblem.estimate_vendor_mismatch)
    elif estimate.vendor_name.strip() and details.vendor_name.strip():
        if estimate.vendor_name.strip().casefold() != details.vendor_name.strip().casefold():
            found.append(InvoiceProblem.estimate_vendor_mismatch)

    approved = estimate.approved_total
    if approved is not None and details.total is not None:
        if approved.currency != details.total.currency:
            found.append(InvoiceProblem.estimate_currency_mismatch)
        elif details.total > approved:
            found.append(InvoiceProblem.exceeds_estimate)

    return found


def _against_purchase_order(
    details: InvoiceDetails, *, policy: PurchaseOrderPolicy
) -> list[InvoiceProblem]:
    """What is wrong with the invoice against the order it is billed to."""
    order = details.purchase_order
    total = details.total

    if order is None:
        if policy.requires_order(total):
            return [InvoiceProblem.purchase_order_required]
        return []

    found: list[InvoiceProblem] = []

    if not order.is_open:
        found.append(InvoiceProblem.purchase_order_not_open)
    # Only asked when the invoice names a recorded vendor. With no identifier
    # there is nothing to compare: a purchase order carries an identifier and no
    # name, so unlike the estimate above there is no second-best comparison to
    # fall back on, and claiming a mismatch nobody has established would be worse
    # than reporting none. Such an invoice is held by `vendor_not_on_master`
    # regardless, so the gap cannot let one through.
    if details.vendor_id is not None and order.vendor_id != details.vendor_id:
        found.append(InvoiceProblem.purchase_order_vendor_mismatch)

    if total is not None:
        if order.total.currency != total.currency:
            found.append(InvoiceProblem.purchase_order_currency_mismatch)
        elif order.billed_by_others.currency != total.currency:
            found.append(InvoiceProblem.purchase_order_currency_mismatch)
        elif order.billed_by_others + total > order.total:
            # Cumulative rather than per-invoice: an order for 100 cannot absorb
            # four invoices of 40 simply because none of them exceeds it alone.
            found.append(InvoiceProblem.exceeds_purchase_order)

    return found


def _within_tolerance(
    found: list[InvoiceProblem],
    details: InvoiceDetails,
    *,
    tolerance: TolerancePolicy,
) -> list[InvoiceProblem]:
    """Drop overruns that fall inside the configured allowance."""
    total = details.total
    if total is None:
        return found

    kept: list[InvoiceProblem] = []
    for problem in found:
        allowed = _tolerated_ceiling(problem, details, tolerance=tolerance)
        if allowed is not None and total <= allowed:
            continue
        kept.append(problem)
    return kept


def _tolerated_ceiling(
    problem: InvoiceProblem,
    details: InvoiceDetails,
    *,
    tolerance: TolerancePolicy,
) -> Money | None:
    """The most this invoice may come to and still clear `problem`, if tolerated."""
    if problem is InvoiceProblem.exceeds_estimate:
        estimate = details.estimate
        approved = estimate.approved_total if estimate else None
        return tolerance.ceiling(approved) if approved is not None else None

    if problem is InvoiceProblem.exceeds_purchase_order:
        order = details.purchase_order
        if order is None:
            return None
        # Expressed as a ceiling on this invoice, so the same comparison serves
        # both controls: what is left on the order, plus what may be exceeded.
        remaining = order.total.minor_units - order.billed_by_others.minor_units
        headroom = tolerance.ceiling(order.total).minor_units - order.total.minor_units
        return Money(remaining + headroom, order.total.currency)

    return None


def is_ready(
    details: InvoiceDetails,
    *,
    today: date,
    purchase_orders: PurchaseOrderPolicy = NO_PURCHASE_ORDER_POLICY,
    tolerance: TolerancePolicy = NO_TOLERANCE,
) -> bool:
    return not problems(details, today=today, purchase_orders=purchase_orders, tolerance=tolerance)


def blocking(found: tuple[InvoiceProblem, ...]) -> tuple[InvoiceProblem, ...]:
    """Only the problems that represent a control firing."""
    return tuple(problem for problem in found if problem in BLOCKING_PROBLEMS)


def explain(problem: InvoiceProblem) -> str:
    return PROBLEM_EXPLANATIONS[problem]
