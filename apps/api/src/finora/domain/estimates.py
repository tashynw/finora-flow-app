"""What an estimate is, and when it is fit to be sent for approval.

An estimate is a vendor's quotation that somebody wants permission to spend
against. It is the first record in the platform that commits the organisation to
anything, so this module is mostly about the difference between a form that has
been filled in and a request an approver can actually act on.

The completeness rules are here rather than in the API schema for a reason. A
required field is a business rule about what an approver needs in order to
decide, not a validation detail of one HTTP endpoint, and the same rules have to
hold whether the estimate arrived through the review workspace, a manual form or
a later import path.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from enum import StrEnum
from typing import Final

from finora.domain.money import Money
from finora.domain.workflow import WorkflowState

#: The states an estimate can occupy. A subset of the platform-wide workflow,
#: because an estimate is never submitted for payment or marked paid: it either
#: earns approval to proceed or it does not.
ESTIMATE_STATES: Final[frozenset[WorkflowState]] = frozenset(
    {
        WorkflowState.draft,
        WorkflowState.pending_approval,
        WorkflowState.approved,
        WorkflowState.rejected,
        WorkflowState.cancelled,
        WorkflowState.exception,
    }
)

#: States in which the estimate's own details may still be edited. Once it is
#: with approvers, changing the amount would invalidate the route that was
#: planned from it, so an edit means withdrawing it back to draft first. That is
#: a visible act with an audit entry rather than a silent re-plan.
EDITABLE_STATES: Final[frozenset[WorkflowState]] = frozenset({WorkflowState.draft})


class EstimateProblem(StrEnum):
    """Why an estimate is not ready to be sent for approval.

    Enumerated rather than assembled as free text so the same gap always reads
    the same way, the screen can point at the field responsible, and "how often
    do estimates arrive without a cost centre" is a question the data can answer.
    """

    vendor_missing = "vendor_missing"
    description_missing = "description_missing"
    amount_missing = "amount_missing"
    amount_not_positive = "amount_not_positive"
    estimate_date_missing = "estimate_date_missing"
    estimate_date_in_future = "estimate_date_in_future"
    cost_centre_missing = "cost_centre_missing"
    justification_missing = "justification_missing"
    needed_by_before_estimate_date = "needed_by_before_estimate_date"


PROBLEM_EXPLANATIONS: Final[dict[EstimateProblem, str]] = {
    EstimateProblem.vendor_missing: (
        "Name the vendor this estimate is from. An approver cannot judge a spend "
        "without knowing who it goes to."
    ),
    EstimateProblem.description_missing: (
        "Describe what is being bought, in a line an approver who has not seen the "
        "quotation can understand."
    ),
    EstimateProblem.amount_missing: "Enter the total amount and its currency.",
    EstimateProblem.amount_not_positive: (
        "The total must be more than zero. A credit or a nil quotation is not "
        "something to seek spending approval for."
    ),
    EstimateProblem.estimate_date_missing: "Enter the date on the vendor's quotation.",
    EstimateProblem.estimate_date_in_future: (
        "The quotation date is in the future. Check it against the document."
    ),
    EstimateProblem.cost_centre_missing: (
        "Choose the cost centre this spend belongs to. Approval routing and the "
        "month-end position both depend on it."
    ),
    EstimateProblem.justification_missing: (
        "Say why this spend is needed. This is what an approver reads first."
    ),
    EstimateProblem.needed_by_before_estimate_date: (
        "The date this is needed by is earlier than the quotation itself. One of the two is wrong."
    ),
}

#: Fields whose absence the screen should mark, keyed by the problem it causes.
#: Kept beside the explanations so a new rule cannot be added without deciding
#: which control a reviewer is being sent to.
PROBLEM_FIELDS: Final[dict[EstimateProblem, str]] = {
    EstimateProblem.vendor_missing: "vendor_name",
    EstimateProblem.description_missing: "description",
    EstimateProblem.amount_missing: "total",
    EstimateProblem.amount_not_positive: "total",
    EstimateProblem.estimate_date_missing: "estimate_date",
    EstimateProblem.estimate_date_in_future: "estimate_date",
    EstimateProblem.cost_centre_missing: "cost_centre_id",
    EstimateProblem.justification_missing: "justification",
    EstimateProblem.needed_by_before_estimate_date: "needed_by",
}

#: Shortest justification that could plausibly be one. Not a real measure of
#: quality, and not pretending to be: it exists so a single character cannot
#: satisfy a mandatory field, and the number is low enough that a genuinely terse
#: reason is still accepted.
MIN_JUSTIFICATION_LENGTH: Final[int] = 12


@dataclass(frozen=True, slots=True)
class EstimateDetails:
    """The details completeness is judged against.

    A value object rather than the ORM row, so the rules can be exercised
    directly and so the same check runs against a draft being edited and a row
    being read back.
    """

    vendor_name: str
    description: str
    total: Money | None
    estimate_date: date | None
    cost_centre_id: object | None
    justification: str
    needed_by: date | None = None


def problems(details: EstimateDetails, *, today: date) -> tuple[EstimateProblem, ...]:
    """Everything standing between this estimate and an approver.

    All of them, rather than the first: a requester should see the whole
    remaining task on one screen instead of discovering it one refusal at a time.
    """
    found: list[EstimateProblem] = []

    if not details.vendor_name.strip():
        found.append(EstimateProblem.vendor_missing)
    if not details.description.strip():
        found.append(EstimateProblem.description_missing)

    if details.total is None:
        found.append(EstimateProblem.amount_missing)
    elif details.total.minor_units <= 0:
        found.append(EstimateProblem.amount_not_positive)

    if details.estimate_date is None:
        found.append(EstimateProblem.estimate_date_missing)
    elif details.estimate_date > today:
        found.append(EstimateProblem.estimate_date_in_future)

    if details.cost_centre_id is None:
        found.append(EstimateProblem.cost_centre_missing)
    if len(details.justification.strip()) < MIN_JUSTIFICATION_LENGTH:
        found.append(EstimateProblem.justification_missing)

    if (
        details.needed_by is not None
        and details.estimate_date is not None
        and details.needed_by < details.estimate_date
    ):
        found.append(EstimateProblem.needed_by_before_estimate_date)

    return tuple(found)


def is_ready_to_submit(details: EstimateDetails, *, today: date) -> bool:
    return not problems(details, today=today)


def explain(problem: EstimateProblem) -> str:
    return PROBLEM_EXPLANATIONS[problem]
