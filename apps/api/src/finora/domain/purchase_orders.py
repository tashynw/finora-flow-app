"""A commitment to buy, made before the money is owed.

An estimate says a spend is worth making. An invoice says it is now owed. A
purchase order sits between them and says something neither does: *we have told
this supplier to go ahead, for this much*. That is why an order is the control
above the threshold — once it is placed, the organisation is committed whether or
not anybody later likes the invoice, so the moment to scrutinise it is now.

An order therefore has two lifecycles running at once, and conflating them is the
mistake this module is written to avoid. There is an approval lifecycle, which
ends the moment somebody with authority agrees to commit: draft, awaiting
approval, and then live. And there is a commercial lifecycle, which runs for as
long as the supplier might still invoice against it, and ends when the order is
closed. An order that is approved is not finished; it is only then that it starts
doing its job.

## Open and closed are labels, not states

An order runs on the platform's one state machine, the same as an estimate and an
invoice, so it gets the same declared transitions, the same history table and the
same refusal of any move nobody wrote down.

That machine has no `open` and no `closed`, and it does not need them. An order
that has been agreed to is `approved`; whether it is still taking invoices is a
different fact, recorded as `closed_at`. The words a finance office uses are
produced by `state_label` at the edge, so the screens read "Open" and "Closed"
without a second lifecycle existing underneath them to say so.

Keeping `closed_at` separate rather than making closure a state is what lets the
row say *when* it stopped taking invoices and *why*, which "it is closed" cannot.
An order that ran out and an order somebody shut early are the same state and
very different situations.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Final

from finora.domain.money import Money
from finora.domain.workflow import WorkflowState

#: The states an order can hold. A narrow slice of the machine: an order is never
#: signed off for receipt, never submitted for payment and never accrued, because
#: it is a commitment rather than a debt.
PURCHASE_ORDER_STATES: Final[frozenset[WorkflowState]] = frozenset(
    {
        WorkflowState.draft,
        WorkflowState.pending_approval,
        WorkflowState.approved,
        WorkflowState.rejected,
        WorkflowState.cancelled,
    }
)

#: What the order may still be edited in. A rejected order is included: an
#: approver turning one down is asking for it to be changed, and the alternative
#: is retyping the whole thing into a new record that loses the rejection.
EDITABLE_STATES: Final[frozenset[WorkflowState]] = frozenset(
    {WorkflowState.draft, WorkflowState.rejected}
)

_OTHER_LABELS: Final[dict[WorkflowState, str]] = {
    WorkflowState.draft: "Draft",
    WorkflowState.pending_approval: "Awaiting approval",
    WorkflowState.rejected: "Not approved",
    WorkflowState.cancelled: "Cancelled",
}

MIN_DESCRIPTION_LENGTH: Final[int] = 10


def state_label(state: WorkflowState, *, closed_at: datetime | None = None) -> str:
    """How an order in this state is described to a person.

    The only state with two names is `approved`, which is the whole working life
    of an order: live and taking invoices, or finished and taking none.
    """
    if state is WorkflowState.approved:
        return "Closed" if closed_at is not None else "Open"
    return _OTHER_LABELS.get(state, WorkflowState(state).value.replace("_", " ").capitalize())


def is_receiving(state: WorkflowState, closed_at: datetime | None = None) -> bool:
    """Whether an invoice may still be billed against this order.

    A draft commits nobody, an order still being approved is not yet a commitment
    to bill against, a rejected or cancelled one should never be billed, and a
    closed one has been finished.
    """
    return state is WorkflowState.approved and closed_at is None


class PurchaseOrderProblem(StrEnum):
    """Why an order cannot be sent for approval as it stands."""

    vendor_missing = "vendor_missing"
    description_missing = "description_missing"
    amount_missing = "amount_missing"
    amount_not_positive = "amount_not_positive"
    cost_centre_missing = "cost_centre_missing"
    #: An amendment that would put the order below what suppliers have already
    #: billed against it.
    below_what_is_billed = "below_what_is_billed"
    estimate_not_approved = "estimate_not_approved"
    estimate_vendor_mismatch = "estimate_vendor_mismatch"
    estimate_currency_mismatch = "estimate_currency_mismatch"
    exceeds_estimate = "exceeds_estimate"


PROBLEM_EXPLANATIONS: Final[dict[PurchaseOrderProblem, str]] = {
    PurchaseOrderProblem.vendor_missing: (
        "Name the supplier this order goes to. An order is an instruction to a "
        "particular company, and payment only ever goes to a recorded one."
    ),
    PurchaseOrderProblem.description_missing: (
        "Say what is being ordered, in a line the approver can judge without opening anything else."
    ),
    PurchaseOrderProblem.amount_missing: "Enter the value being committed, and its currency.",
    PurchaseOrderProblem.amount_not_positive: (
        "The value must be more than zero. An order for nothing commits nothing."
    ),
    PurchaseOrderProblem.cost_centre_missing: (
        "Choose the cost centre this commitment belongs to. It decides who has to approve it."
    ),
    PurchaseOrderProblem.below_what_is_billed: (
        "Suppliers have already invoiced more against this order than the new "
        "figure allows. Reducing it below what is billed would put invoices that "
        "were correct when they arrived into breach of an order changed afterwards."
    ),
    PurchaseOrderProblem.estimate_not_approved: (
        "The linked estimate has not been approved. Approve the spend before "
        "committing to a supplier for it, or unlink it."
    ),
    PurchaseOrderProblem.estimate_vendor_mismatch: (
        "The linked estimate is for a different supplier. An order can only draw "
        "on an approval granted for the company it is placed with."
    ),
    PurchaseOrderProblem.estimate_currency_mismatch: (
        "The order and the linked estimate are in different currencies, so no "
        "comparison between them means anything."
    ),
    PurchaseOrderProblem.exceeds_estimate: (
        "This order commits more than the approved estimate allows. The approval "
        "covers the smaller figure, so this needs approving again at the new one."
    ),
}

PROBLEM_FIELDS: Final[dict[PurchaseOrderProblem, str]] = {
    PurchaseOrderProblem.vendor_missing: "vendor_id",
    PurchaseOrderProblem.description_missing: "description",
    PurchaseOrderProblem.amount_missing: "total",
    PurchaseOrderProblem.amount_not_positive: "total",
    PurchaseOrderProblem.cost_centre_missing: "cost_centre_id",
    PurchaseOrderProblem.below_what_is_billed: "total",
    PurchaseOrderProblem.estimate_not_approved: "estimate_id",
    PurchaseOrderProblem.estimate_vendor_mismatch: "estimate_id",
    PurchaseOrderProblem.estimate_currency_mismatch: "estimate_id",
    PurchaseOrderProblem.exceeds_estimate: "total",
}

#: Problems that are a control firing rather than a form half-filled. Shown in
#: red and counted separately, on the same reasoning as invoices.
BLOCKING_PROBLEMS: Final[frozenset[PurchaseOrderProblem]] = frozenset(
    {
        PurchaseOrderProblem.below_what_is_billed,
        PurchaseOrderProblem.estimate_not_approved,
        PurchaseOrderProblem.estimate_vendor_mismatch,
        PurchaseOrderProblem.estimate_currency_mismatch,
        PurchaseOrderProblem.exceeds_estimate,
    }
)


@dataclass(frozen=True, slots=True)
class LinkedEstimate:
    """The approved spend an order draws on, when it draws on one."""

    state_is_approved: bool
    vendor_id: object | None
    approved_total: Money | None


@dataclass(frozen=True, slots=True)
class OrderDetails:
    """An order as it currently stands, for validation."""

    vendor_id: object | None
    description: str | None
    total: Money | None
    cost_centre_id: object | None
    #: Everything suppliers have already invoiced against this order. Zero for one
    #: that has never been billed.
    billed: Money | None = None
    estimate: LinkedEstimate | None = None


def problems(details: OrderDetails) -> tuple[PurchaseOrderProblem, ...]:
    """Everything standing between this order and an approver."""
    found: list[PurchaseOrderProblem] = []

    if details.vendor_id is None:
        found.append(PurchaseOrderProblem.vendor_missing)

    if len((details.description or "").strip()) < MIN_DESCRIPTION_LENGTH:
        found.append(PurchaseOrderProblem.description_missing)

    total = details.total
    if total is None:
        found.append(PurchaseOrderProblem.amount_missing)
    elif total.minor_units <= 0:
        found.append(PurchaseOrderProblem.amount_not_positive)
    elif details.billed is not None and details.billed.currency == total.currency:
        if total.minor_units < details.billed.minor_units:
            found.append(PurchaseOrderProblem.below_what_is_billed)

    if details.cost_centre_id is None:
        found.append(PurchaseOrderProblem.cost_centre_missing)

    found.extend(_against_estimate(details))

    return tuple(found)


def _against_estimate(details: OrderDetails) -> list[PurchaseOrderProblem]:
    estimate = details.estimate
    if estimate is None:
        return []

    found: list[PurchaseOrderProblem] = []

    if not estimate.state_is_approved:
        found.append(PurchaseOrderProblem.estimate_not_approved)

    if (
        estimate.vendor_id is not None
        and details.vendor_id is not None
        and estimate.vendor_id != details.vendor_id
    ):
        found.append(PurchaseOrderProblem.estimate_vendor_mismatch)

    approved = estimate.approved_total
    total = details.total
    if approved is not None and total is not None:
        if approved.currency != total.currency:
            # Compared, never converted, for the same reason bands are: a figure
            # in another currency is not a smaller or larger version of this one.
            found.append(PurchaseOrderProblem.estimate_currency_mismatch)
        elif total.minor_units > approved.minor_units:
            found.append(PurchaseOrderProblem.exceeds_estimate)

    return found


def needs_its_own_approval(details: OrderDetails) -> bool:
    """Whether committing this order asks for authority nobody has granted yet.

    An order drawing entirely on an approved estimate — same supplier, same
    currency, no more money — asks for nothing new. Somebody with authority has
    already looked at that spend, for that vendor, at that figure, and said yes;
    sending it round again is a second signature on one decision, and a control
    that fires on everything teaches approvers to clear the queue without reading.
    Such an order opens immediately, and the record says which approval it stands
    on, so the authority behind it is still a named decision by a named person.

    Everything else is approved on its own account: no estimate behind it, a
    bigger figure than was approved, a different supplier, a different currency.
    Each of those is a commitment nobody has yet agreed to make.

    Callers must have checked `problems` first. An order that contradicts its
    estimate is refused outright rather than routed anywhere, so the comparisons
    here are only ever reached once they are known to be meaningful.
    """
    estimate = details.estimate
    if estimate is None or not estimate.state_is_approved:
        return True

    approved = estimate.approved_total
    total = details.total
    if approved is None or total is None:
        return True
    if approved.currency != total.currency:
        return True
    if total.minor_units > approved.minor_units:
        return True

    return estimate.vendor_id is None or estimate.vendor_id != details.vendor_id


def blocking(found: tuple[PurchaseOrderProblem, ...]) -> tuple[PurchaseOrderProblem, ...]:
    return tuple(problem for problem in found if problem in BLOCKING_PROBLEMS)


def is_ready(details: OrderDetails) -> bool:
    return not problems(details)


def may_edit(state: WorkflowState) -> bool:
    return state in EDITABLE_STATES


def remaining(total: Money, billed: Money) -> Money:
    """What is left on an order.

    Negative when suppliers have billed more than the order allows, which is a
    real state of affairs — the overrun tolerance on invoices permits it — and is
    reported rather than clamped to zero, because a reader needs to see that the
    order is over rather than merely exhausted.
    """
    return total - billed


def is_fully_billed(total: Money, billed: Money) -> bool:
    return billed.minor_units >= total.minor_units


def explain(problem: PurchaseOrderProblem) -> str:
    return PROBLEM_EXPLANATIONS[problem]


def field_for(problem: PurchaseOrderProblem) -> str:
    return PROBLEM_FIELDS[problem]
