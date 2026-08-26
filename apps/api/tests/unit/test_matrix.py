"""What the matrix checker refuses, what it merely reports, and why the line is there.

The distinction these tests are really about is *incoherent* against *incomplete*.
A matrix that contradicts itself has no correct reading and is refused. A matrix
with a hole in it reads perfectly well — it means those amounts cannot be
submitted — and is saved with the hole named, because a matrix is incomplete from
the first rule until the last and refusing that would make it unbuildable.
"""

from __future__ import annotations

import pytest

from finora.domain.approvals import MatrixRule
from finora.domain.matrix import (
    MATRIX_RECORD_TYPES,
    RULE_PROBLEM_EXPLANATIONS,
    RULE_PROBLEM_FIELDS,
    MatrixFault,
    MatrixGap,
    RuleDraft,
    RuleProblem,
    audit_matrix,
    check_rule,
    probe_amounts,
)
from finora.domain.roles import ApprovalLevel

JMD = "JMD"
USD = "USD"

EVERY_LEVEL = frozenset(ApprovalLevel)


def rule(
    *,
    level: ApprovalLevel = ApprovalLevel.manager,
    step_order: int = 1,
    minimum: int = 0,
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


def draft(
    *,
    name: str = "Manager, everything",
    record_type: str = "invoice",
    level: ApprovalLevel = ApprovalLevel.manager,
    step_order: int = 1,
    minimum: int = 0,
    maximum: int | None = None,
    currency: str = JMD,
    department: str | None = None,
    is_parallel: bool = False,
) -> RuleDraft:
    return RuleDraft(
        name=name,
        record_type=record_type,
        level=level,
        step_order=step_order,
        min_amount_minor_units=minimum,
        max_amount_minor_units=maximum,
        currency=currency,
        department=department,
        is_parallel=is_parallel,
    )


class TestOneRuleOnItsOwnTerms:
    def test_a_reasonable_rule_has_nothing_wrong_with_it(self) -> None:
        assert check_rule(draft()) == ()

    def test_a_rule_with_no_name_is_refused(self) -> None:
        # The name is what an approver is shown when they ask why a request
        # reached them, so an unnamed rule cannot explain itself.
        assert RuleProblem.name_missing in check_rule(draft(name="   "))

    def test_a_rule_governing_nothing_is_refused(self) -> None:
        assert RuleProblem.record_type_unknown in check_rule(draft(record_type="widget"))

    def test_a_currency_the_platform_cannot_count_in_is_refused(self) -> None:
        assert RuleProblem.currency_unknown in check_rule(draft(currency="ZZZ"))

    def test_steps_are_numbered_from_one(self) -> None:
        assert RuleProblem.step_order_not_positive in check_rule(draft(step_order=0))

    def test_a_band_cannot_start_below_zero(self) -> None:
        assert RuleProblem.band_negative in check_rule(draft(minimum=-1))

    def test_a_band_whose_ceiling_is_under_its_floor_is_refused(self) -> None:
        # No amount could fall inside it, so the rule is unreachable rather than
        # merely odd.
        assert RuleProblem.band_inverted in check_rule(draft(minimum=5_000, maximum=4_999))

    def test_a_band_of_exactly_one_amount_is_allowed(self) -> None:
        assert check_rule(draft(minimum=5_000, maximum=5_000)) == ()


class TestClashingWithWhatIsAlreadyLive:
    def test_the_same_level_at_the_same_step_over_the_same_amounts_is_refused(self) -> None:
        live = (rule(minimum=0, maximum=10_000),)

        assert RuleProblem.duplicate_of_live_rule in check_rule(
            draft(minimum=5_000, maximum=20_000), against=live
        )

    def test_adjacent_bands_do_not_clash(self) -> None:
        live = (rule(minimum=0, maximum=10_000),)

        assert check_rule(draft(minimum=10_001, maximum=None), against=live) == ()

    def test_the_same_band_at_a_different_step_is_not_a_clash_here(self) -> None:
        # It may well be a fault, but it is one about the route as a whole, and
        # `audit_matrix` is what reports it.
        live = (rule(step_order=1),)

        assert check_rule(draft(step_order=2), against=live) == ()

    def test_the_same_band_in_another_department_is_not_a_clash(self) -> None:
        live = (rule(department="Facilities"),)

        assert check_rule(draft(department="IT"), against=live) == ()

    def test_departments_are_compared_without_regard_to_case_or_padding(self) -> None:
        live = (rule(department="Facilities"),)

        assert RuleProblem.duplicate_of_live_rule in check_rule(
            draft(department="  facilities "), against=live
        )

    def test_the_same_band_in_another_currency_is_not_a_clash(self) -> None:
        live = (rule(currency=JMD),)

        assert check_rule(draft(currency=USD), against=live) == ()


class TestProbeAmounts:
    def test_zero_is_always_probed(self) -> None:
        assert 0 in probe_amounts((rule(minimum=5_000),), JMD)

    def test_every_floor_is_probed(self) -> None:
        rules = (rule(minimum=0, maximum=4_999), rule(step_order=2, minimum=5_000))

        assert 5_000 in probe_amounts(rules, JMD)

    def test_one_unit_above_every_ceiling_is_probed(self) -> None:
        # The first amount a band does not cover is where a hole would begin.
        assert 5_000 in probe_amounts((rule(maximum=4_999),), JMD)

    def test_bands_in_another_currency_contribute_no_boundaries(self) -> None:
        assert probe_amounts((rule(currency=USD, minimum=777),), JMD) == (0,)


class TestAMatrixThatContradictsItself:
    def test_two_levels_sharing_a_step_without_saying_so_is_a_fault(self) -> None:
        rules = (
            rule(level=ApprovalLevel.manager, step_order=1, is_parallel=False),
            rule(level=ApprovalLevel.hod, step_order=1, is_parallel=False),
        )

        verdict = audit_matrix(rules, staffed_levels=EVERY_LEVEL)

        assert not verdict.is_coherent
        assert MatrixFault.parallelism_not_declared in {kind for kind, _ in verdict.faults}

    def test_two_levels_sharing_a_step_and_saying_so_is_fine(self) -> None:
        rules = (
            rule(level=ApprovalLevel.manager, step_order=1, is_parallel=True),
            rule(level=ApprovalLevel.hod, step_order=1, is_parallel=True),
        )

        assert audit_matrix(rules, staffed_levels=EVERY_LEVEL).is_coherent

    def test_one_level_asked_to_approve_at_two_steps_is_a_fault(self) -> None:
        rules = (
            rule(level=ApprovalLevel.manager, step_order=1),
            rule(level=ApprovalLevel.manager, step_order=2),
        )

        verdict = audit_matrix(rules, staffed_levels=EVERY_LEVEL)

        assert not verdict.is_coherent
        assert MatrixFault.level_approves_twice in {kind for kind, _ in verdict.faults}

    def test_a_fault_is_reported_once_however_many_amounts_find_it(self) -> None:
        # The same contradiction is found at every probe amount by construction,
        # and eight copies of one sentence tell an administrator nothing the
        # first did not.
        rules = (
            rule(level=ApprovalLevel.manager, step_order=1, maximum=1_000),
            rule(level=ApprovalLevel.manager, step_order=2, maximum=1_000),
            rule(level=ApprovalLevel.hod, step_order=1, minimum=1_001),
        )

        verdict = audit_matrix(rules, staffed_levels=EVERY_LEVEL)

        assert len(verdict.faults) == 1


class TestAMatrixWithHolesInIt:
    def test_nothing_configured_is_reported_and_not_refused(self) -> None:
        verdict = audit_matrix((), staffed_levels=EVERY_LEVEL)

        assert verdict.is_coherent
        assert {kind for kind, _ in verdict.gaps} == {MatrixGap.nothing_configured}

    def test_an_amount_no_band_covers_is_reported(self) -> None:
        verdict = audit_matrix((rule(maximum=10_000),), staffed_levels=EVERY_LEVEL)

        assert verdict.is_coherent
        assert MatrixGap.amounts_with_no_route in {kind for kind, _ in verdict.gaps}

    def test_a_band_open_at_the_top_leaves_no_hole(self) -> None:
        verdict = audit_matrix((rule(maximum=None),), staffed_levels=EVERY_LEVEL)

        assert {kind for kind, _ in verdict.gaps} == set()

    def test_a_level_nobody_holds_is_reported(self) -> None:
        verdict = audit_matrix((rule(level=ApprovalLevel.coo),), staffed_levels=frozenset())

        assert verdict.is_coherent
        assert MatrixGap.level_unstaffed in {kind for kind, _ in verdict.gaps}

    def test_a_gap_does_not_stop_the_matrix_being_saved(self) -> None:
        # Otherwise the first rule of a new currency could never be added: a
        # matrix is incomplete right up until the moment it is finished.
        verdict = audit_matrix((rule(maximum=10_000),), staffed_levels=frozenset())

        assert verdict.is_coherent


class TestTheReadingsAreEvidence:
    def test_every_probe_amount_produces_a_reading(self) -> None:
        rules = (rule(maximum=10_000), rule(level=ApprovalLevel.hod, step_order=2, minimum=10_001))

        verdict = audit_matrix(rules, staffed_levels=EVERY_LEVEL)
        probed = probe_amounts(rules, JMD)

        assert len(verdict.readings) == len(probed)

    def test_an_uncovered_amount_says_why_it_is_unreachable(self) -> None:
        verdict = audit_matrix((rule(maximum=10_000),), staffed_levels=EVERY_LEVEL)

        above = next(
            reading for reading in verdict.readings if reading.amount_minor_units == 10_001
        )
        assert above.unreachable is not None
        assert above.steps == ()

    def test_a_department_with_its_own_rule_is_read_separately(self) -> None:
        rules = (rule(), rule(level=ApprovalLevel.hod, department="Facilities"))

        verdict = audit_matrix(rules, staffed_levels=EVERY_LEVEL)

        assert {reading.department for reading in verdict.readings} == {None, "Facilities"}

    def test_each_currency_is_read_separately(self) -> None:
        rules = (rule(currency=JMD), rule(currency=USD))

        verdict = audit_matrix(rules, staffed_levels=EVERY_LEVEL)

        assert {reading.currency for reading in verdict.readings} == {JMD, USD}


class TestEveryProblemCanBeExplainedAndPointedAt:
    @pytest.mark.parametrize("problem", list(RuleProblem))
    def test_each_problem_has_an_explanation(self, problem: RuleProblem) -> None:
        assert RULE_PROBLEM_EXPLANATIONS[problem].strip()

    @pytest.mark.parametrize("problem", list(RuleProblem))
    def test_each_problem_names_a_field(self, problem: RuleProblem) -> None:
        assert RULE_PROBLEM_FIELDS[problem].strip()

    def test_the_record_types_are_the_ones_the_platform_routes(self) -> None:
        assert MATRIX_RECORD_TYPES == {"estimate", "invoice", "purchase_order"}
