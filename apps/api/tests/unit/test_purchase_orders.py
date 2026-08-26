"""The rules an order has to satisfy, and the two words people actually use.

Two things are worth stating about what is tested here. The first is that "Open"
and "Closed" are labels rather than states: an order runs on the shared workflow
states so its history and its route work like everything else, and the label is
derived from `approved` plus whether anybody has closed it.

The second is `needs_its_own_approval`, which is the only place the platform
declines to ask for a signature. An order drawing entirely on an approved
estimate asks for authority somebody already gave, and every one of the tests
below is a way of that not being true.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest

from finora.domain.money import Money
from finora.domain.purchase_orders import (
    BLOCKING_PROBLEMS,
    EDITABLE_STATES,
    MIN_DESCRIPTION_LENGTH,
    PROBLEM_EXPLANATIONS,
    PROBLEM_FIELDS,
    PURCHASE_ORDER_STATES,
    LinkedEstimate,
    OrderDetails,
    PurchaseOrderProblem,
    blocking,
    is_fully_billed,
    is_ready,
    is_receiving,
    may_edit,
    needs_its_own_approval,
    problems,
    remaining,
    state_label,
)
from finora.domain.workflow import WorkflowState

JMD = "JMD"
USD = "USD"

VENDOR = uuid4()
OTHER_VENDOR = uuid4()
COST_CENTRE = uuid4()

ONE_HUNDRED = Money(10_000, JMD)
CLOSED_AT = datetime(2026, 3, 4, 9, 0, tzinfo=UTC)


def details(
    *,
    vendor_id: UUID | None = VENDOR,
    description: str = "Air handling units for the third floor",
    total: Money | None = ONE_HUNDRED,
    cost_centre_id: UUID | None = COST_CENTRE,
    billed: Money | None = None,
    estimate: LinkedEstimate | None = None,
) -> OrderDetails:
    return OrderDetails(
        vendor_id=vendor_id,
        description=description,
        total=total,
        cost_centre_id=cost_centre_id,
        billed=billed,
        estimate=estimate,
    )


def estimate(
    *,
    approved: bool = True,
    vendor_id: UUID | None = VENDOR,
    total: Money | None = ONE_HUNDRED,
) -> LinkedEstimate:
    return LinkedEstimate(state_is_approved=approved, vendor_id=vendor_id, approved_total=total)


class TestOpenAndClosedAreLabelsNotStates:
    def test_an_approved_order_nobody_has_closed_reads_as_open(self) -> None:
        assert state_label(WorkflowState.approved) == "Open"

    def test_an_approved_order_somebody_closed_reads_as_closed(self) -> None:
        assert state_label(WorkflowState.approved, closed_at=CLOSED_AT) == "Closed"

    def test_the_other_states_read_as_themselves(self) -> None:
        assert state_label(WorkflowState.draft) == "Draft"
        assert state_label(WorkflowState.pending_approval) == "Awaiting approval"
        assert state_label(WorkflowState.rejected) == "Not approved"
        assert state_label(WorkflowState.cancelled) == "Cancelled"

    def test_every_state_an_order_can_hold_has_a_label(self) -> None:
        for state in PURCHASE_ORDER_STATES:
            assert state_label(state).strip()


class TestWhetherAnOrderTakesInvoices:
    def test_a_live_order_takes_them(self) -> None:
        assert is_receiving(WorkflowState.approved) is True

    def test_a_closed_order_does_not(self) -> None:
        assert is_receiving(WorkflowState.approved, CLOSED_AT) is False

    @pytest.mark.parametrize(
        "state",
        [
            WorkflowState.draft,
            WorkflowState.pending_approval,
            WorkflowState.rejected,
            WorkflowState.cancelled,
        ],
    )
    def test_nothing_else_does(self, state: WorkflowState) -> None:
        assert is_receiving(state) is False


class TestWhenAnOrderIsIncomplete:
    def test_a_complete_order_has_nothing_outstanding(self) -> None:
        assert problems(details()) == ()

    def test_an_order_with_no_supplier_is_reported(self) -> None:
        assert PurchaseOrderProblem.vendor_missing in problems(details(vendor_id=None))

    def test_a_description_too_short_to_judge_is_reported(self) -> None:
        assert PurchaseOrderProblem.description_missing in problems(
            details(description="x" * (MIN_DESCRIPTION_LENGTH - 1))
        )

    def test_an_order_with_no_amount_is_reported(self) -> None:
        assert PurchaseOrderProblem.amount_missing in problems(details(total=None))

    def test_an_order_for_nothing_is_reported(self) -> None:
        assert PurchaseOrderProblem.amount_not_positive in problems(details(total=Money.zero(JMD)))

    def test_an_order_with_no_cost_centre_is_reported(self) -> None:
        # The cost centre decides who has to approve it, so an order without one
        # cannot be routed.
        assert PurchaseOrderProblem.cost_centre_missing in problems(details(cost_centre_id=None))

    def test_an_incomplete_order_is_not_ready(self) -> None:
        assert is_ready(details(vendor_id=None)) is False


class TestAgainstWhatIsAlreadyBilled:
    def test_reducing_below_what_suppliers_billed_is_reported(self) -> None:
        found = problems(details(total=Money(5_000, JMD), billed=Money(8_000, JMD)))

        assert PurchaseOrderProblem.below_what_is_billed in found

    def test_reducing_to_exactly_what_is_billed_is_allowed(self) -> None:
        assert problems(details(total=Money(8_000, JMD), billed=Money(8_000, JMD))) == ()

    def test_a_billed_figure_in_another_currency_is_not_compared(self) -> None:
        # Comparing across currencies would decide a control by an exchange rate
        # nobody recorded.
        assert PurchaseOrderProblem.below_what_is_billed not in problems(
            details(total=Money(5_000, JMD), billed=Money(8_000, USD))
        )

    def test_being_over_the_order_is_a_blocking_problem(self) -> None:
        found = problems(details(total=Money(5_000, JMD), billed=Money(8_000, JMD)))

        assert PurchaseOrderProblem.below_what_is_billed in blocking(found)


class TestAgainstTheEstimate:
    def test_an_unapproved_estimate_is_reported(self) -> None:
        assert PurchaseOrderProblem.estimate_not_approved in problems(
            details(estimate=estimate(approved=False))
        )

    def test_an_estimate_for_another_supplier_is_reported(self) -> None:
        assert PurchaseOrderProblem.estimate_vendor_mismatch in problems(
            details(estimate=estimate(vendor_id=OTHER_VENDOR))
        )

    def test_an_estimate_in_another_currency_is_reported(self) -> None:
        assert PurchaseOrderProblem.estimate_currency_mismatch in problems(
            details(estimate=estimate(total=Money(10_000, USD)))
        )

    def test_committing_more_than_the_estimate_approved_is_reported(self) -> None:
        assert PurchaseOrderProblem.exceeds_estimate in problems(
            details(total=Money(20_000, JMD), estimate=estimate(total=ONE_HUNDRED))
        )

    def test_committing_exactly_what_was_approved_is_allowed(self) -> None:
        assert problems(details(total=ONE_HUNDRED, estimate=estimate(total=ONE_HUNDRED))) == ()

    def test_every_estimate_problem_is_blocking(self) -> None:
        # These are controls firing, not a form half-filled.
        for problem in (
            PurchaseOrderProblem.estimate_not_approved,
            PurchaseOrderProblem.estimate_vendor_mismatch,
            PurchaseOrderProblem.estimate_currency_mismatch,
            PurchaseOrderProblem.exceeds_estimate,
        ):
            assert problem in BLOCKING_PROBLEMS


class TestWhetherAnOrderNeedsApprovingOnItsOwnAccount:
    def test_an_order_covered_by_an_approved_estimate_needs_none(self) -> None:
        # Somebody with authority has already looked at this spend, for this
        # supplier, at this figure or more, and said yes.
        assert needs_its_own_approval(details(estimate=estimate())) is False

    def test_an_order_for_less_than_the_estimate_approved_needs_none(self) -> None:
        covered = details(total=Money(5_000, JMD), estimate=estimate(total=ONE_HUNDRED))

        assert needs_its_own_approval(covered) is False

    def test_an_order_with_no_estimate_behind_it_needs_approval(self) -> None:
        assert needs_its_own_approval(details()) is True

    def test_an_unapproved_estimate_covers_nothing(self) -> None:
        assert needs_its_own_approval(details(estimate=estimate(approved=False))) is True

    def test_an_estimate_for_another_supplier_covers_nothing(self) -> None:
        assert needs_its_own_approval(details(estimate=estimate(vendor_id=OTHER_VENDOR))) is True

    def test_an_estimate_in_another_currency_covers_nothing(self) -> None:
        assert needs_its_own_approval(details(estimate=estimate(total=Money(10_000, USD)))) is True

    def test_an_order_larger_than_the_estimate_needs_approval(self) -> None:
        bigger = details(total=Money(20_000, JMD), estimate=estimate(total=ONE_HUNDRED))

        assert needs_its_own_approval(bigger) is True

    def test_an_estimate_naming_no_supplier_covers_nothing(self) -> None:
        # An approval that does not say who the money goes to is not an approval
        # to commit to this company.
        assert needs_its_own_approval(details(estimate=estimate(vendor_id=None))) is True


class TestRemainingCapacity:
    def test_what_is_left_is_the_total_less_what_is_billed(self) -> None:
        assert remaining(Money(10_000, JMD), Money(4_000, JMD)) == Money(6_000, JMD)

    def test_an_overrun_is_reported_as_negative_rather_than_clamped(self) -> None:
        # A reader needs to see that the order is over, not merely exhausted.
        assert remaining(Money(10_000, JMD), Money(12_000, JMD)).minor_units == -2_000

    def test_an_order_billed_to_its_ceiling_is_fully_billed(self) -> None:
        assert is_fully_billed(Money(10_000, JMD), Money(10_000, JMD)) is True

    def test_an_order_with_room_left_is_not(self) -> None:
        assert is_fully_billed(Money(10_000, JMD), Money(9_999, JMD)) is False


class TestWhatCanStillBeEdited:
    def test_a_draft_can_be_edited(self) -> None:
        assert may_edit(WorkflowState.draft) is True

    def test_a_rejected_order_can_be_corrected_and_resubmitted(self) -> None:
        # The alternative is retyping the whole thing into a new record, which
        # loses the rejection and the reason for it.
        assert may_edit(WorkflowState.rejected) is True

    def test_an_order_with_approvers_cannot_be_edited(self) -> None:
        assert may_edit(WorkflowState.pending_approval) is False

    def test_a_live_order_cannot_be_edited_freely(self) -> None:
        # Changing what it commits goes through `amend`, which re-approves an
        # increase rather than carrying a signature nobody gave.
        assert may_edit(WorkflowState.approved) is False

    def test_the_editable_states_are_a_subset_of_the_order_states(self) -> None:
        assert EDITABLE_STATES <= PURCHASE_ORDER_STATES


class TestEveryProblemCanBeExplainedAndPointedAt:
    @pytest.mark.parametrize("problem", list(PurchaseOrderProblem))
    def test_each_problem_has_an_explanation(self, problem: PurchaseOrderProblem) -> None:
        assert PROBLEM_EXPLANATIONS[problem].strip()

    @pytest.mark.parametrize("problem", list(PurchaseOrderProblem))
    def test_each_problem_names_a_field(self, problem: PurchaseOrderProblem) -> None:
        assert PROBLEM_FIELDS[problem].strip()
