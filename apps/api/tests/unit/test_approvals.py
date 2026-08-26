"""Routes are planned once, silence is never approval, nobody approves their own.

`approvals` is the module a fraudulent payment would have to get past, so these
tests are written around the ways it could be got past rather than around its
functions. Each refusal is exercised on its own: one combined "this decision was
rejected" assertion would keep passing while three of the four reasons stopped
working, and the one that stopped working would be the one that mattered.

The cumulative band design is tested explicitly, because it is the part that is
easy to get wrong in configuration and impossible to notice afterwards. A matrix
where a larger amount matches *fewer* rules removes an approval, and the result
looks exactly like a correctly approved estimate.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest

from finora.domain.approvals import (
    LEVEL_LABELS,
    AlreadyDecidedError,
    ApprovalOutcome,
    DecisionCommentRequiredError,
    MatrixRule,
    NotAnApproverError,
    PlannedStep,
    RouteClosedError,
    RouteNotAvailableError,
    RouteState,
    SelfApprovalError,
    StepDecision,
    StepNotReadyError,
    StepProgress,
    StepState,
    decide,
    open_step_order,
    plan_route,
    route_state,
    summarise,
    with_states,
)
from finora.domain.money import Money
from finora.domain.roles import ApprovalLevel

JMD = "JMD"


def _band(
    level: ApprovalLevel,
    step_order: int,
    minimum: int,
    *,
    maximum: int | None = None,
    currency: str = JMD,
    department: str | None = None,
    is_parallel: bool = False,
) -> MatrixRule:
    return MatrixRule(
        level=level,
        step_order=step_order,
        min_amount_minor_units=minimum,
        max_amount_minor_units=maximum,
        currency=currency,
        department=department,
        is_parallel=is_parallel,
    )


#: The default matrix the platform ships with, as the migration seeds it.
DEFAULT_MATRIX = [
    _band(ApprovalLevel.unit_head, 1, 0),
    _band(ApprovalLevel.manager, 2, 5_000_000),
    _band(ApprovalLevel.hod, 3, 50_000_000),
    _band(ApprovalLevel.coo, 4, 500_000_000),
]


def _steps(*pairs: tuple[int, ApprovalLevel, StepState]) -> tuple[StepProgress, ...]:
    return tuple(
        StepProgress(step_order=order, level=level, state=state) for order, level, state in pairs
    )


class TestPlanningARoute:
    def test_a_small_amount_needs_only_the_first_level(self) -> None:
        route = plan_route(DEFAULT_MATRIX, amount=Money(4_000_000, JMD))

        assert route == (PlannedStep(step_order=1, level=ApprovalLevel.unit_head),)

    def test_bands_are_cumulative_so_a_larger_amount_needs_more_approvals(self) -> None:
        route = plan_route(DEFAULT_MATRIX, amount=Money(60_000_000, JMD))

        assert [step.level for step in route] == [
            ApprovalLevel.unit_head,
            ApprovalLevel.manager,
            ApprovalLevel.hod,
        ]

    def test_the_route_is_ordered_by_step(self) -> None:
        shuffled = [DEFAULT_MATRIX[2], DEFAULT_MATRIX[0], DEFAULT_MATRIX[1]]

        route = plan_route(shuffled, amount=Money(60_000_000, JMD))

        assert [step.step_order for step in route] == [1, 2, 3]

    def test_an_amount_exactly_on_a_threshold_is_inside_the_band(self) -> None:
        """JMD 50,000.00 is where the second approval begins, not just above it."""
        route = plan_route(DEFAULT_MATRIX, amount=Money(5_000_000, JMD))

        assert [step.level for step in route] == [ApprovalLevel.unit_head, ApprovalLevel.manager]

    def test_a_penny_below_a_threshold_stays_in_the_lower_band(self) -> None:
        route = plan_route(DEFAULT_MATRIX, amount=Money(4_999_999, JMD))

        assert [step.level for step in route] == [ApprovalLevel.unit_head]

    def test_an_upper_bound_excludes_larger_amounts(self) -> None:
        capped = [_band(ApprovalLevel.unit_head, 1, 0, maximum=1_000_000)]

        with pytest.raises(RouteNotAvailableError):
            plan_route(capped, amount=Money(1_000_001, JMD))


class TestCurrencyIsNeverConverted:
    def test_a_currency_with_no_bands_refuses_the_route(self) -> None:
        """The safe direction. Comparing USD digits against JMD bands would send a
        substantial foreign invoice to the lowest approver."""
        with pytest.raises(RouteNotAvailableError) as refusal:
            plan_route(DEFAULT_MATRIX, amount=Money(60_000_000, "USD"))

        assert "USD" in str(refusal.value)
        assert "administrator" in str(refusal.value)

    def test_bands_apply_only_to_their_own_currency(self) -> None:
        mixed = [
            _band(ApprovalLevel.unit_head, 1, 0, currency="JMD"),
            _band(ApprovalLevel.manager, 2, 0, currency="USD"),
        ]

        assert [step.level for step in plan_route(mixed, amount=Money(100, "USD"))] == [
            ApprovalLevel.manager
        ]


class TestDepartmentScope:
    def test_a_rule_with_no_department_applies_everywhere(self) -> None:
        route = plan_route(DEFAULT_MATRIX, amount=Money(100, JMD), department="Operations")

        assert [step.level for step in route] == [ApprovalLevel.unit_head]

    def test_a_departmental_rule_does_not_apply_elsewhere(self) -> None:
        local_only = [_band(ApprovalLevel.hod, 1, 0, department="Treasury")]

        with pytest.raises(RouteNotAvailableError):
            plan_route(local_only, amount=Money(100, JMD), department="Operations")

    def test_department_matching_ignores_case(self) -> None:
        local_only = [_band(ApprovalLevel.hod, 1, 0, department="Treasury")]

        route = plan_route(local_only, amount=Money(100, JMD), department="treasury")

        assert [step.level for step in route] == [ApprovalLevel.hod]

    def test_a_departmental_rule_replaces_the_default_rather_than_adding_to_it(self) -> None:
        """Both matching is the normal way to write a local exception. Applying
        both would demand the same approval twice."""
        with_exception = [
            _band(ApprovalLevel.unit_head, 1, 0),
            _band(ApprovalLevel.unit_head, 1, 0, department="Treasury"),
        ]

        route = plan_route(with_exception, amount=Money(100, JMD), department="Treasury")

        assert route == (PlannedStep(step_order=1, level=ApprovalLevel.unit_head),)


class TestParallelStepsMustBeDeclared:
    def test_two_levels_at_one_step_are_accepted_when_marked_parallel(self) -> None:
        together = [
            _band(ApprovalLevel.manager, 1, 0, is_parallel=True),
            _band(ApprovalLevel.hod, 1, 0, is_parallel=True),
        ]

        route = plan_route(together, amount=Money(100, JMD))

        assert {step.level for step in route} == {ApprovalLevel.manager, ApprovalLevel.hod}
        assert {step.step_order for step in route} == {1}

    def test_two_levels_at_one_step_are_refused_when_not_marked_parallel(self) -> None:
        """Almost certainly a mis-numbered step. Running it as concurrent would
        silently remove an approval nobody meant to remove."""
        mis_numbered = [
            _band(ApprovalLevel.manager, 1, 0),
            _band(ApprovalLevel.hod, 1, 0),
        ]

        with pytest.raises(RouteNotAvailableError) as refusal:
            plan_route(mis_numbered, amount=Money(100, JMD))

        assert "parallel" in str(refusal.value)


class TestWhoseTurnItIs:
    def test_only_the_lowest_undecided_step_is_ready(self) -> None:
        progress = with_states(
            _steps(
                (1, ApprovalLevel.unit_head, StepState.waiting),
                (2, ApprovalLevel.manager, StepState.waiting),
            )
        )

        assert [step.state for step in progress] == [StepState.ready, StepState.waiting]

    def test_the_next_step_opens_when_the_one_below_is_approved(self) -> None:
        progress = with_states(
            _steps(
                (1, ApprovalLevel.unit_head, StepState.approved),
                (2, ApprovalLevel.manager, StepState.waiting),
            )
        )

        assert [step.state for step in progress] == [StepState.approved, StepState.ready]

    def test_every_step_sharing_an_order_is_ready_at_once(self) -> None:
        progress = with_states(
            _steps(
                (1, ApprovalLevel.manager, StepState.waiting),
                (1, ApprovalLevel.hod, StepState.waiting),
                (2, ApprovalLevel.coo, StepState.waiting),
            )
        )

        assert [step.state for step in progress] == [
            StepState.ready,
            StepState.ready,
            StepState.waiting,
        ]

    def test_a_parallel_step_does_not_open_the_next_until_all_of_it_is_approved(self) -> None:
        progress = with_states(
            _steps(
                (1, ApprovalLevel.manager, StepState.approved),
                (1, ApprovalLevel.hod, StepState.waiting),
                (2, ApprovalLevel.coo, StepState.waiting),
            )
        )

        assert open_step_order(progress) == 1
        assert progress[2].state is StepState.waiting

    def test_nothing_is_open_once_the_route_has_closed(self) -> None:
        progress = _steps(
            (1, ApprovalLevel.unit_head, StepState.approved),
            (2, ApprovalLevel.manager, StepState.approved),
        )

        assert open_step_order(progress) is None


class TestWhatARouteAmountsTo:
    def test_all_approved_is_approved(self) -> None:
        assert (
            route_state(
                _steps(
                    (1, ApprovalLevel.unit_head, StepState.approved),
                    (2, ApprovalLevel.manager, StepState.approved),
                )
            )
            is RouteState.approved
        )

    def test_one_rejection_ends_the_route(self) -> None:
        assert (
            route_state(
                _steps(
                    (1, ApprovalLevel.unit_head, StepState.approved),
                    (2, ApprovalLevel.manager, StepState.rejected),
                )
            )
            is RouteState.rejected
        )

    def test_a_partly_approved_route_is_still_open(self) -> None:
        assert (
            route_state(
                _steps(
                    (1, ApprovalLevel.unit_head, StepState.approved),
                    (2, ApprovalLevel.manager, StepState.waiting),
                )
            )
            is RouteState.open
        )

    def test_a_withdrawal_ends_a_partly_approved_route(self) -> None:
        """The approval already given stays visible. A route with one approval and
        one withdrawn step is over, not still waiting for somebody."""
        assert (
            route_state(
                _steps(
                    (1, ApprovalLevel.unit_head, StepState.approved),
                    (2, ApprovalLevel.manager, StepState.withdrawn),
                )
            )
            is RouteState.withdrawn
        )

    def test_a_rejection_outranks_a_later_withdrawal(self) -> None:
        assert (
            route_state(
                _steps(
                    (1, ApprovalLevel.unit_head, StepState.rejected),
                    (2, ApprovalLevel.manager, StepState.withdrawn),
                )
            )
            is RouteState.rejected
        )

    def test_a_route_with_no_steps_is_never_approved(self) -> None:
        """The one interpretation that must not happen by accident."""
        assert route_state(()) is RouteState.withdrawn


class TestDeciding:
    def setup_method(self) -> None:
        self.requester = uuid4()
        self.approver = uuid4()
        self.progress = _steps(
            (1, ApprovalLevel.unit_head, StepState.waiting),
            (2, ApprovalLevel.manager, StepState.waiting),
        )

    def _decide(
        self,
        *,
        steps: tuple[StepProgress, ...] | None = None,
        step_order: int = 1,
        level: ApprovalLevel = ApprovalLevel.unit_head,
        outcome: ApprovalOutcome = ApprovalOutcome.approved,
        actor_id: UUID | None = None,
        requester_id: UUID | None = None,
        actor_is_assigned: bool = True,
        comment: str | None = None,
        on_behalf_of_id: UUID | None = None,
    ) -> StepDecision:
        return decide(
            steps=steps if steps is not None else self.progress,
            step_order=step_order,
            level=level,
            outcome=outcome,
            actor_id=actor_id or self.approver,
            actor_label="Ada Approver",
            requester_id=requester_id or self.requester,
            actor_is_assigned=actor_is_assigned,
            comment=comment,
            on_behalf_of_id=on_behalf_of_id,
        )

    def test_an_assigned_approver_can_approve_the_open_step(self) -> None:
        decision = self._decide()

        assert decision.outcome is ApprovalOutcome.approved
        assert decision.actor_id == self.approver

    def test_the_requester_cannot_approve_their_own_request(self) -> None:
        with pytest.raises(SelfApprovalError):
            self._decide(actor_id=self.requester)

    def test_somebody_not_assigned_at_that_level_cannot_decide(self) -> None:
        with pytest.raises(NotAnApproverError):
            self._decide(actor_is_assigned=False)

    def test_a_later_step_cannot_be_decided_before_the_one_below_it(self) -> None:
        with pytest.raises(StepNotReadyError) as refusal:
            self._decide(step_order=2, level=ApprovalLevel.manager)

        assert LEVEL_LABELS[ApprovalLevel.unit_head] in str(refusal.value)

    def test_a_step_that_is_not_on_the_route_cannot_be_decided(self) -> None:
        with pytest.raises(NotAnApproverError):
            self._decide(step_order=9, level=ApprovalLevel.coo)

    def test_a_decided_step_cannot_be_decided_again(self) -> None:
        with pytest.raises(AlreadyDecidedError):
            self._decide(
                steps=_steps(
                    (1, ApprovalLevel.unit_head, StepState.approved),
                    (2, ApprovalLevel.manager, StepState.waiting),
                )
            )

    def test_nothing_can_be_decided_on_a_closed_route(self) -> None:
        with pytest.raises(RouteClosedError):
            self._decide(
                steps=_steps(
                    (1, ApprovalLevel.unit_head, StepState.rejected),
                    (2, ApprovalLevel.manager, StepState.withdrawn),
                )
            )

    def test_rejection_requires_a_reason(self) -> None:
        with pytest.raises(DecisionCommentRequiredError):
            self._decide(outcome=ApprovalOutcome.rejected, comment="   ")

    def test_rejection_with_a_reason_is_accepted_and_the_reason_is_trimmed(self) -> None:
        decision = self._decide(
            outcome=ApprovalOutcome.rejected, comment="  Quote is above the agreed rate.  "
        )

        assert decision.comment == "Quote is above the agreed rate."

    def test_approval_does_not_require_a_reason(self) -> None:
        assert self._decide(comment=None) is not None

    def test_a_delegate_decision_records_who_it_was_made_for(self) -> None:
        absent_approver = uuid4()

        decision = self._decide(on_behalf_of_id=absent_approver)

        assert decision.on_behalf_of_id == absent_approver

    def test_being_the_requester_is_refused_before_being_out_of_turn(self) -> None:
        """A requester who is also the wrong approver is told the thing that would
        still be true after the other was fixed."""
        with pytest.raises(SelfApprovalError):
            self._decide(
                actor_id=self.requester,
                step_order=2,
                level=ApprovalLevel.manager,
                actor_is_assigned=False,
            )


class TestSummarising:
    def test_an_open_route_names_who_it_is_waiting_on_and_the_progress(self) -> None:
        summary = summarise(
            _steps(
                (1, ApprovalLevel.unit_head, StepState.approved),
                (2, ApprovalLevel.manager, StepState.waiting),
            )
        )

        assert summary == "Waiting on Manager. 1 of 2 approvals given."

    def test_a_parallel_route_names_both_outstanding_approvers(self) -> None:
        summary = summarise(
            _steps(
                (1, ApprovalLevel.manager, StepState.waiting),
                (1, ApprovalLevel.hod, StepState.waiting),
            )
        )

        assert "Head of Department and Manager" in summary

    def test_a_rejected_route_names_the_level_that_rejected_it(self) -> None:
        summary = summarise(
            _steps(
                (1, ApprovalLevel.unit_head, StepState.approved),
                (2, ApprovalLevel.manager, StepState.rejected),
            )
        )

        assert summary == "Rejected by Manager."

    def test_an_approved_route_says_so(self) -> None:
        assert summarise(_steps((1, ApprovalLevel.unit_head, StepState.approved))) == (
            "Fully approved."
        )
