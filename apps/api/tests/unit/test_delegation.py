"""Cover that would look arranged and do nothing.

Every case here is a way of setting up delegation that the screen would accept
and the approval engine would ignore. The person who set it up is on a plane; the
person waiting for the approval finds out instead, three working hours at a time.
So each one is refused at the moment it is arranged, with the reason.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest

from finora.domain.delegation import (
    MAX_COVER_DAYS,
    PROBLEM_EXPLANATIONS,
    PROBLEM_FIELDS,
    Cover,
    DelegationProblem,
    is_covered,
    problems,
)

NOW = datetime(2026, 3, 4, 9, 0, tzinfo=UTC)
NEXT_WEEK = NOW + timedelta(days=7)


@dataclass(frozen=True, slots=True)
class Person:
    id: UUID
    display_name: str
    is_active: bool = True
    out_of_office_until: datetime | None = None
    delegate_to_id: UUID | None = None


def person(
    *,
    name: str = "Ayanna Brown",
    is_active: bool = True,
    away_until: datetime | None = None,
    delegate_to_id: UUID | None = None,
) -> Person:
    return Person(
        id=uuid4(),
        display_name=name,
        is_active=is_active,
        out_of_office_until=away_until,
        delegate_to_id=delegate_to_id,
    )


class TestCoverThatWorks:
    def test_a_named_delegate_who_can_decide_with_a_future_date_is_accepted(self) -> None:
        cover = Cover(
            delegate=person(name="Marcus Reid"), until=NEXT_WEEK, delegate_may_decide=True
        )

        assert problems(cover, by=person(), now=NOW) == ()

    def test_cover_up_to_the_limit_is_accepted(self) -> None:
        cover = Cover(
            delegate=person(),
            until=NOW + timedelta(days=MAX_COVER_DAYS),
            delegate_may_decide=True,
        )

        assert problems(cover, by=person(), now=NOW) == ()


class TestComingBack:
    def test_clearing_both_fields_is_always_allowed(self) -> None:
        # Coming back early is an ordinary act. Refusing it because the person is
        # currently marked away would be absurd.
        assert problems(Cover(delegate=None, until=None), by=person(), now=NOW) == ()

    def test_clearing_is_allowed_even_for_somebody_currently_away(self) -> None:
        away = person(away_until=NEXT_WEEK, delegate_to_id=uuid4())

        assert problems(Cover(delegate=None, until=None), by=away, now=NOW) == ()


class TestCoverThatWouldDoNothing:
    def test_a_delegate_with_no_return_date_is_refused(self) -> None:
        # The commonest one. The engine only honours cover while the assignee is
        # marked away, so a name with no dates against it never receives anything.
        cover = Cover(delegate=person(), until=None, delegate_may_decide=True)

        assert DelegationProblem.no_return_date in problems(cover, by=person(), now=NOW)

    def test_a_return_date_with_no_delegate_is_refused(self) -> None:
        cover = Cover(delegate=None, until=NEXT_WEEK)

        assert DelegationProblem.no_delegate_named in problems(cover, by=person(), now=NOW)

    def test_a_date_that_has_already_passed_is_refused(self) -> None:
        cover = Cover(delegate=person(), until=NOW - timedelta(days=1), delegate_may_decide=True)

        assert DelegationProblem.return_date_in_the_past in problems(cover, by=person(), now=NOW)

    def test_a_date_of_exactly_now_is_refused(self) -> None:
        cover = Cover(delegate=person(), until=NOW, delegate_may_decide=True)

        assert DelegationProblem.return_date_in_the_past in problems(cover, by=person(), now=NOW)

    def test_cover_running_longer_than_the_limit_is_refused(self) -> None:
        # Beyond this it is not somebody standing in, it is the authority having
        # moved, and that belongs on the assignments screen.
        cover = Cover(
            delegate=person(),
            until=NOW + timedelta(days=MAX_COVER_DAYS + 1),
            delegate_may_decide=True,
        )

        assert DelegationProblem.cover_too_long in problems(cover, by=person(), now=NOW)


class TestWhoTheDelegateIs:
    def test_delegating_to_yourself_is_refused(self) -> None:
        me = person()
        cover = Cover(delegate=me, until=NEXT_WEEK, delegate_may_decide=True)

        assert DelegationProblem.delegate_is_self in problems(cover, by=me, now=NOW)

    def test_delegating_to_yourself_says_nothing_further(self) -> None:
        # Every other check would be a statement about the person reading it.
        me = person()
        cover = Cover(delegate=me, until=NEXT_WEEK, delegate_may_decide=False)

        assert problems(cover, by=me, now=NOW) == (DelegationProblem.delegate_is_self,)

    def test_delegating_to_somebody_who_is_themselves_away_is_refused(self) -> None:
        # Cover does not chain, deliberately: a chain is impossible to reason
        # about when the question is who is accountable for the decision.
        cover = Cover(
            delegate=person(away_until=NEXT_WEEK), until=NEXT_WEEK, delegate_may_decide=True
        )

        assert DelegationProblem.delegate_is_away in problems(cover, by=person(), now=NOW)

    def test_a_delegate_whose_absence_has_expired_is_accepted(self) -> None:
        back = person(away_until=NOW - timedelta(days=1))
        cover = Cover(delegate=back, until=NEXT_WEEK, delegate_may_decide=True)

        assert problems(cover, by=person(), now=NOW) == ()

    def test_delegating_to_a_closed_account_is_refused(self) -> None:
        cover = Cover(delegate=person(is_active=False), until=NEXT_WEEK, delegate_may_decide=True)

        assert DelegationProblem.delegate_is_inactive in problems(cover, by=person(), now=NOW)

    def test_delegating_to_somebody_who_cannot_approve_is_refused(self) -> None:
        # They would inherit the queue and be refused at every decision, which
        # from outside looks like the platform being broken.
        cover = Cover(delegate=person(), until=NEXT_WEEK, delegate_may_decide=False)

        assert DelegationProblem.delegate_cannot_approve in problems(cover, by=person(), now=NOW)

    def test_several_faults_are_all_reported(self) -> None:
        cover = Cover(delegate=person(is_active=False), until=None, delegate_may_decide=False)

        found = set(problems(cover, by=person(), now=NOW))

        assert found == {
            DelegationProblem.no_return_date,
            DelegationProblem.delegate_is_inactive,
            DelegationProblem.delegate_cannot_approve,
        }


class TestWhetherCoverIsInEffect:
    def test_away_with_a_delegate_is_in_effect(self) -> None:
        assert is_covered(person(away_until=NEXT_WEEK, delegate_to_id=uuid4()), now=NOW)

    def test_away_with_no_delegate_is_not(self) -> None:
        assert not is_covered(person(away_until=NEXT_WEEK), now=NOW)

    def test_a_delegate_with_no_absence_is_not(self) -> None:
        assert not is_covered(person(delegate_to_id=uuid4()), now=NOW)

    def test_an_expired_absence_is_not(self) -> None:
        # The commonest reason a queue has silently stopped moving.
        expired = person(away_until=NOW - timedelta(days=1), delegate_to_id=uuid4())

        assert not is_covered(expired, now=NOW)


class TestEveryProblemCanBeExplainedAndPointedAt:
    @pytest.mark.parametrize("problem", list(DelegationProblem))
    def test_each_problem_has_an_explanation(self, problem: DelegationProblem) -> None:
        assert PROBLEM_EXPLANATIONS[problem].strip()

    @pytest.mark.parametrize("problem", list(DelegationProblem))
    def test_each_problem_names_a_field(self, problem: DelegationProblem) -> None:
        assert PROBLEM_FIELDS[problem] in {"delegate_to_id", "out_of_office_until"}
