"""An estimate is not ready until an approver could actually decide it.

The completeness rules exist to stop a request reaching an approver who cannot
answer it: no amount, no cost centre, no stated reason. These tests check each
rule on its own and check that all of them are reported together, because a
requester discovering the remaining work one refusal at a time is the failure the
list return type was chosen to avoid.
"""

from __future__ import annotations

from datetime import date

from finora.domain.estimates import (
    EDITABLE_STATES,
    ESTIMATE_STATES,
    MIN_JUSTIFICATION_LENGTH,
    PROBLEM_EXPLANATIONS,
    PROBLEM_FIELDS,
    EstimateDetails,
    EstimateProblem,
    is_ready_to_submit,
    problems,
)
from finora.domain.money import Money
from finora.domain.workflow import ALLOWED_TRANSITIONS, WorkflowState

TODAY = date(2026, 8, 5)
JMD = "JMD"
QUOTED_DATE = date(2026, 8, 1)
QUOTED_TOTAL = Money(4_500_000, JMD)
NEEDED_BY = date(2026, 9, 1)


def _details(
    *,
    vendor_name: str = "Kingston Supplies Limited",
    description: str = "Replacement air handling unit for the third floor",
    total: Money | None = QUOTED_TOTAL,
    estimate_date: date | None = QUOTED_DATE,
    cost_centre_id: object | None = "cc-facilities",
    justification: str = "The existing unit has failed and cannot be repaired.",
    needed_by: date | None = NEEDED_BY,
) -> EstimateDetails:
    """A complete estimate, with one thing at a time taken away by each test."""
    return EstimateDetails(
        vendor_name=vendor_name,
        description=description,
        total=total,
        estimate_date=estimate_date,
        cost_centre_id=cost_centre_id,
        justification=justification,
        needed_by=needed_by,
    )


class TestACompleteEstimate:
    def test_is_ready_to_submit(self) -> None:
        assert is_ready_to_submit(_details(), today=TODAY)
        assert problems(_details(), today=TODAY) == ()

    def test_does_not_need_a_needed_by_date(self) -> None:
        """Optional on purpose. Plenty of purchases have no deadline, and demanding
        an invented one teaches requesters to invent them."""
        assert is_ready_to_submit(_details(needed_by=None), today=TODAY)

    def test_may_be_dated_today(self) -> None:
        assert is_ready_to_submit(_details(estimate_date=TODAY), today=TODAY)


class TestEachRuleSeparately:
    def test_a_missing_vendor_is_reported(self) -> None:
        assert EstimateProblem.vendor_missing in problems(_details(vendor_name="  "), today=TODAY)

    def test_a_missing_description_is_reported(self) -> None:
        assert EstimateProblem.description_missing in problems(
            _details(description=""), today=TODAY
        )

    def test_a_missing_amount_is_reported(self) -> None:
        assert EstimateProblem.amount_missing in problems(_details(total=None), today=TODAY)

    def test_a_zero_amount_is_reported_as_not_positive(self) -> None:
        """Distinguished from a missing one. "You have not entered an amount" and
        "nought is not something to seek approval for" are different mistakes."""
        found = problems(_details(total=Money(0, JMD)), today=TODAY)

        assert EstimateProblem.amount_not_positive in found
        assert EstimateProblem.amount_missing not in found

    def test_a_negative_amount_is_reported_as_not_positive(self) -> None:
        assert EstimateProblem.amount_not_positive in problems(
            _details(total=Money(-100, JMD)), today=TODAY
        )

    def test_a_missing_estimate_date_is_reported(self) -> None:
        assert EstimateProblem.estimate_date_missing in problems(
            _details(estimate_date=None), today=TODAY
        )

    def test_a_future_estimate_date_is_reported(self) -> None:
        assert EstimateProblem.estimate_date_in_future in problems(
            _details(estimate_date=date(2026, 12, 1)), today=TODAY
        )

    def test_a_missing_cost_centre_is_reported(self) -> None:
        assert EstimateProblem.cost_centre_missing in problems(
            _details(cost_centre_id=None), today=TODAY
        )

    def test_a_justification_too_short_to_be_one_is_reported(self) -> None:
        assert EstimateProblem.justification_missing in problems(
            _details(justification="x"), today=TODAY
        )

    def test_a_justification_of_only_whitespace_is_reported(self) -> None:
        padded = " " * (MIN_JUSTIFICATION_LENGTH + 10)

        assert EstimateProblem.justification_missing in problems(
            _details(justification=padded), today=TODAY
        )

    def test_a_needed_by_date_before_the_quotation_is_reported(self) -> None:
        assert EstimateProblem.needed_by_before_estimate_date in problems(
            _details(estimate_date=date(2026, 8, 1), needed_by=date(2026, 7, 1)), today=TODAY
        )


class TestReportingAllOfThemAtOnce:
    def test_an_empty_estimate_reports_every_gap(self) -> None:
        found = problems(
            EstimateDetails(
                vendor_name="",
                description="",
                total=None,
                estimate_date=None,
                cost_centre_id=None,
                justification="",
            ),
            today=TODAY,
        )

        assert set(found) == {
            EstimateProblem.vendor_missing,
            EstimateProblem.description_missing,
            EstimateProblem.amount_missing,
            EstimateProblem.estimate_date_missing,
            EstimateProblem.cost_centre_missing,
            EstimateProblem.justification_missing,
        }

    def test_no_problem_is_reported_twice(self) -> None:
        found = problems(_details(vendor_name="", description=""), today=TODAY)

        assert len(found) == len(set(found))


class TestEveryProblemCanBeExplainedAndPointedAt:
    def test_each_problem_has_an_explanation(self) -> None:
        """A gap with no words is a screen that says something is wrong and not what."""
        assert set(PROBLEM_EXPLANATIONS) == set(EstimateProblem)

    def test_each_problem_names_the_field_to_send_the_user_to(self) -> None:
        assert set(PROBLEM_FIELDS) == set(EstimateProblem)

    def test_no_explanation_is_empty(self) -> None:
        assert all(text.strip() for text in PROBLEM_EXPLANATIONS.values())


class TestTheStatesAnEstimateUses:
    def test_an_estimate_never_reaches_a_payment_state(self) -> None:
        """An estimate earns permission to spend. It is not itself paid."""
        assert WorkflowState.submitted not in ESTIMATE_STATES
        assert WorkflowState.paid not in ESTIMATE_STATES
        assert WorkflowState.ready_for_submission not in ESTIMATE_STATES

    def test_only_a_draft_may_be_edited(self) -> None:
        assert EDITABLE_STATES == frozenset({WorkflowState.draft})

    def test_every_estimate_state_is_reachable_through_the_state_machine(self) -> None:
        """The subset has to be a connected part of the platform-wide machine, or
        an estimate could be put into a state the transition rules cannot leave."""
        reachable = {WorkflowState.draft}
        frontier = [WorkflowState.draft]
        while frontier:
            for target in ALLOWED_TRANSITIONS[frontier.pop()]:
                if target in ESTIMATE_STATES and target not in reachable:
                    reachable.add(target)
                    frontier.append(target)

        assert reachable == set(ESTIMATE_STATES)
