"""Handing your approvals to somebody else while you are away.

Delegation is the feature most likely to be used once, in a hurry, by somebody
already halfway out of the door. That is the whole design constraint. Every rule
below exists because there is a way to set this up that looks completed and does
nothing, and the person who set it up will not find out — they are on a plane.
Whoever is waiting for the approval finds out instead, three working hours at a
time, and the record sits there being chased at somebody who cannot answer.

The engine honours a delegation in exactly one circumstance: the assignee is
marked out of office, the date has not passed, and the named delegate is the
person asking. Every silent failure follows from a way of not meeting that:

*A delegate with no out-of-office date.* The commonest one. The screen accepts a
name, the approver believes they have arranged cover, and the engine never looks
at it.

*A date that has already passed.* Same outcome, usually from last year's cover
being edited rather than replaced.

*Cover handed to somebody who is themselves away.* Delegation does not chain — it
is deliberately one hop, because a chain is impossible to reason about when the
question is "who is accountable for this decision" — so this quietly routes the
work to nobody.

*Cover handed to somebody who cannot approve anything.* They inherit the level,
reach the endpoint, and are refused by the permission check. From the outside it
looks like the platform is broken.

So all of these are refused when the delegation is set, with the reason, rather
than accepted and discovered later. The rule throughout the codebase is that
silence is never approval; here the rule is that silence is never cover either.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum
from typing import Final, Protocol
from uuid import UUID

#: The longest cover that reads as cover. Beyond this it is not somebody standing
#: in during an absence, it is the authority having moved, and moving authority
#: should be a change to who holds the level rather than an out-of-office note
#: nobody revisits. Pending the requirements document, like every other default.
MAX_COVER_DAYS: Final[int] = 90


class Delegable(Protocol):
    """The little of a person this module needs to know."""

    @property
    def id(self) -> UUID: ...

    @property
    def display_name(self) -> str: ...

    @property
    def is_active(self) -> bool: ...

    @property
    def out_of_office_until(self) -> datetime | None: ...

    @property
    def delegate_to_id(self) -> UUID | None: ...


class DelegationProblem(StrEnum):
    """Why a proposed delegation would not do what its author intends."""

    no_delegate_named = "no_delegate_named"
    no_return_date = "no_return_date"
    return_date_in_the_past = "return_date_in_the_past"
    cover_too_long = "cover_too_long"
    delegate_is_self = "delegate_is_self"
    delegate_is_away = "delegate_is_away"
    delegate_is_inactive = "delegate_is_inactive"
    delegate_cannot_approve = "delegate_cannot_approve"


PROBLEM_EXPLANATIONS: Final[dict[DelegationProblem, str]] = {
    DelegationProblem.no_delegate_named: (
        "Name the person covering for you. Marking yourself away without naming "
        "anybody stops nothing arriving; it only stops you being here to answer it."
    ),
    DelegationProblem.no_return_date: (
        "Say when you are back. Cover only applies while you are away, so a "
        "delegate with no dates against them never receives anything."
    ),
    DelegationProblem.return_date_in_the_past: (
        "That date has already passed, so this cover would never take effect. "
        "Set the day you are actually back."
    ),
    DelegationProblem.cover_too_long: (
        f"Cover cannot run for more than {MAX_COVER_DAYS} days. Beyond that this is "
        "not somebody standing in for you, it is the approval level having moved, "
        "and that should be recorded as a change to who holds it."
    ),
    DelegationProblem.delegate_is_self: (
        "You cannot cover for yourself. Name a colleague who can decide while you are away."
    ),
    DelegationProblem.delegate_is_away: (
        "The person you named is out of office themselves, and cover does not pass "
        "along a chain. Anything routed to you would reach nobody. Name somebody "
        "who is here."
    ),
    DelegationProblem.delegate_is_inactive: (
        "That account is closed, so nothing routed to it can be answered."
    ),
    DelegationProblem.delegate_cannot_approve: (
        "The person you named cannot record approvals, so they would inherit your "
        "queue and then be refused at every decision. Name somebody who approves."
    ),
}

PROBLEM_FIELDS: Final[dict[DelegationProblem, str]] = {
    DelegationProblem.no_delegate_named: "delegate_to_id",
    DelegationProblem.no_return_date: "out_of_office_until",
    DelegationProblem.return_date_in_the_past: "out_of_office_until",
    DelegationProblem.cover_too_long: "out_of_office_until",
    DelegationProblem.delegate_is_self: "delegate_to_id",
    DelegationProblem.delegate_is_away: "delegate_to_id",
    DelegationProblem.delegate_is_inactive: "delegate_to_id",
    DelegationProblem.delegate_cannot_approve: "delegate_to_id",
}


@dataclass(frozen=True, slots=True)
class Cover:
    """A proposed arrangement: away until a date, covered by a person."""

    delegate: Delegable | None
    until: datetime | None
    #: Whether the named delegate is allowed to record approvals at all. Passed
    #: in rather than derived, because permissions live in the roles module and
    #: the caller has already resolved them.
    delegate_may_decide: bool = False

    @property
    def is_cleared(self) -> bool:
        """Whether this is somebody cancelling their cover rather than setting it."""
        return self.delegate is None and self.until is None


def problems(cover: Cover, *, by: Delegable, now: datetime) -> tuple[DelegationProblem, ...]:
    """Every reason this arrangement would not work as intended.

    Clearing cover — both fields empty — is always allowed and returns nothing.
    Coming back early is an ordinary act, and refusing it because the person is
    currently marked away would be absurd.
    """
    if cover.is_cleared:
        return ()

    found: list[DelegationProblem] = []

    if cover.until is None:
        found.append(DelegationProblem.no_return_date)
    elif cover.until <= now:
        found.append(DelegationProblem.return_date_in_the_past)
    elif cover.until - now > timedelta(days=MAX_COVER_DAYS):
        found.append(DelegationProblem.cover_too_long)

    delegate = cover.delegate
    if delegate is None:
        found.append(DelegationProblem.no_delegate_named)
        return tuple(found)

    if delegate.id == by.id:
        # Nothing further is worth saying about a delegation to oneself: every
        # other check would be a statement about the person reading it.
        found.append(DelegationProblem.delegate_is_self)
        return tuple(found)

    if not delegate.is_active:
        found.append(DelegationProblem.delegate_is_inactive)
    if _is_away(delegate, now=now):
        found.append(DelegationProblem.delegate_is_away)
    if not cover.delegate_may_decide:
        found.append(DelegationProblem.delegate_cannot_approve)

    return tuple(found)


def _is_away(person: Delegable, *, now: datetime) -> bool:
    until = person.out_of_office_until
    return until is not None and until > now


def is_covered(person: Delegable, *, now: datetime) -> bool:
    """Whether this person's approvals are currently reaching somebody else."""
    return _is_away(person, now=now) and person.delegate_to_id is not None


def explain(problem: DelegationProblem) -> str:
    return PROBLEM_EXPLANATIONS[problem]


def field_for(problem: DelegationProblem) -> str:
    return PROBLEM_FIELDS[problem]
