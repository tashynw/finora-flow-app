"""Who has to approve a spend, in what order, and what stops them.

The approval matrix is data, not code. An organisation's bands change, and a
change to them is a configuration decision with an audit entry rather than a
release. This module is the part that cannot be configuration: how a set of
bands becomes an ordered route, when a route is finished, and the reasons a
particular person is not allowed to decide a particular step.

Three rules shape it.

*A route is planned once and then fixed.* The steps are resolved from the matrix
at the moment of submission and written down. A band edited next week does not
retroactively change who approved what, and an amount that changes invalidates
the route rather than quietly re-planning it.

*Silence is never approval.* A step with no eligible approver is a blocked
route, not a skipped one. A currency with no bands configured refuses submission
and says so. Every way of failing to resolve a route leads to a refusal naming
what is missing, because the alternative is a payment approved by a gap in
configuration.

*Nobody approves their own request.* Enforced here against the requester on the
record, and again in the roles module against the permissions a user has already
exercised on it. Two checks for one rule, because it is the rule the whole
module exists for.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Final
from uuid import UUID

from finora.domain.money import Money
from finora.domain.roles import ApprovalLevel

LEVEL_LABELS: Final[dict[ApprovalLevel, str]] = {
    ApprovalLevel.unit_head: "Unit Head",
    ApprovalLevel.manager: "Manager",
    ApprovalLevel.hod: "Head of Department",
    ApprovalLevel.coo: "Chief Operating Officer",
}


class ApprovalOutcome(StrEnum):
    """What an approver decided. There is no third option.

    Abstention is deliberately not available. A step that can be neither
    approved nor rejected is a step that stalls indefinitely with nobody
    accountable; an approver who should not decide is handled by reassignment,
    which is a recorded act by a named person.
    """

    approved = "approved"
    rejected = "rejected"


class StepState(StrEnum):
    #: An earlier step has not finished, so this one cannot be decided yet.
    waiting = "waiting"
    #: Open for a decision now.
    ready = "ready"
    approved = "approved"
    rejected = "rejected"
    #: The route ended before this step was reached.
    withdrawn = "withdrawn"


DECIDED_STATES: Final[frozenset[StepState]] = frozenset({StepState.approved, StepState.rejected})


class RouteState(StrEnum):
    open = "open"
    approved = "approved"
    rejected = "rejected"
    #: The record went back to draft or was cancelled, so the route ended
    #: without a verdict. Kept rather than deleted: that a route was opened and
    #: abandoned is part of the record's history.
    withdrawn = "withdrawn"


ROUTE_STATE_LABELS: Final[dict[RouteState, str]] = {
    RouteState.open: "Awaiting approval",
    RouteState.approved: "Approved",
    RouteState.rejected: "Rejected",
    RouteState.withdrawn: "Withdrawn",
}


# ------------------------------------------------------------------- planning


@dataclass(frozen=True, slots=True)
class MatrixRule:
    """One row of the configured approval matrix.

    A plain value object rather than the ORM row, so route planning can be
    tested and reasoned about without a database and without the domain layer
    importing infrastructure.
    """

    level: ApprovalLevel
    step_order: int
    min_amount_minor_units: int
    max_amount_minor_units: int | None
    currency: str
    department: str | None
    is_parallel: bool

    def covers(self, amount: Money) -> bool:
        """Whether this band contains the amount.

        Currency is compared, never converted. A JMD band says nothing about a
        USD amount, and quietly treating the numbers as comparable would put a
        five-figure US invoice through a Unit Head because the digits looked
        small.
        """
        if self.currency.upper() != amount.currency:
            return False
        if amount.minor_units < self.min_amount_minor_units:
            return False
        return (
            self.max_amount_minor_units is None or amount.minor_units <= self.max_amount_minor_units
        )

    def applies_in(self, department: str | None) -> bool:
        """Whether this rule is in scope for a department.

        A rule with no department is the organisation-wide default. A rule
        naming one applies only there, and takes precedence over the default
        for the same step and level.
        """
        return self.department is None or (
            department is not None and self.department.casefold() == department.casefold()
        )


@dataclass(frozen=True, slots=True)
class PlannedStep:
    """One approval this record needs, as resolved at submission."""

    step_order: int
    level: ApprovalLevel

    @property
    def level_label(self) -> str:
        return LEVEL_LABELS[self.level]


class RouteNotAvailableError(Exception):
    """No route could be planned, with the reason in the message.

    Raised rather than returning an empty route, because an empty route is
    indistinguishable from "no approval needed" at the call site, and that is
    the one interpretation that must never happen by accident.
    """


class AmountNotCoveredError(RouteNotAvailableError):
    """No band in the matrix contains this amount, in this currency or department.

    Separated from its parent so that the administration screens can tell the two
    failures apart without reading the message. Everything that merely needs to
    refuse a submission still catches `RouteNotAvailableError` and is unaffected.
    """


class ParallelismNotDeclaredError(RouteNotAvailableError):
    """Two levels share a step order without being marked as deciding together."""


def plan_route(
    rules: list[MatrixRule] | tuple[MatrixRule, ...],
    *,
    amount: Money,
    department: str | None = None,
) -> tuple[PlannedStep, ...]:
    """Resolve the ordered approvals an amount requires.

    Steps sharing a `step_order` are decided concurrently and all of them must
    approve. A higher `step_order` cannot be decided until every step below it
    has. Bands are written so that a larger amount matches more rules, which is
    how a route grows a Head of Department above a threshold without the smaller
    approvals dropping off.
    """
    in_band = [rule for rule in rules if rule.covers(amount)]
    if not in_band:
        raise AmountNotCoveredError(
            f"No approval levels are configured for an amount of {amount.format()}. "
            "An administrator must set the approval bands for this currency before "
            "this can be submitted."
        )

    applicable = [rule for rule in in_band if rule.applies_in(department)]
    if not applicable:
        raise AmountNotCoveredError(
            f"No approval levels are configured for {department or 'this department'} "
            f"at {amount.format()}. An administrator must set the approval bands."
        )

    chosen = _resolve_overrides(applicable)
    _assert_parallelism_is_declared(chosen)

    return tuple(
        PlannedStep(step_order=rule.step_order, level=rule.level)
        for rule in sorted(chosen, key=lambda rule: (rule.step_order, rule.level.value))
    )


def _resolve_overrides(rules: list[MatrixRule]) -> list[MatrixRule]:
    """Keep one rule per step and level, preferring a department-specific one.

    Both a default and a departmental rule matching the same step and level is
    the normal way to express a local exception. Applying both would demand the
    same approval twice.
    """
    best: dict[tuple[int, ApprovalLevel], MatrixRule] = {}
    for rule in rules:
        key = (rule.step_order, rule.level)
        incumbent = best.get(key)
        if incumbent is None or (incumbent.department is None and rule.department is not None):
            best[key] = rule
    return list(best.values())


def _assert_parallelism_is_declared(rules: list[MatrixRule]) -> None:
    """Refuse a matrix whose step numbering and parallel flags disagree.

    Two levels sharing a step order means they decide together. If whoever
    configured them did not mark them parallel, the likeliest explanation is a
    mis-numbered step that was meant to be sequential, and running it as
    concurrent would remove an approval nobody intended to remove.
    """
    by_order: dict[int, list[MatrixRule]] = {}
    for rule in rules:
        by_order.setdefault(rule.step_order, []).append(rule)

    for step_order, group in sorted(by_order.items()):
        if len(group) > 1 and not all(rule.is_parallel for rule in group):
            levels = ", ".join(sorted(LEVEL_LABELS[rule.level] for rule in group))
            raise ParallelismNotDeclaredError(
                f"The approval matrix places {levels} at step {step_order} without "
                "marking them as parallel. An administrator must either number them "
                "as separate steps or mark them parallel."
            )


# ------------------------------------------------------------------- progress


@dataclass(frozen=True, slots=True)
class StepProgress:
    """A step as it currently stands, for deciding what happens next.

    Mirrors the persisted row without being it, so route arithmetic stays in the
    domain and can be tested against a handful of literals.
    """

    step_order: int
    level: ApprovalLevel
    state: StepState

    @property
    def is_decided(self) -> bool:
        return self.state in DECIDED_STATES


def route_state(steps: list[StepProgress] | tuple[StepProgress, ...]) -> RouteState:
    """What the route as a whole amounts to.

    One rejection ends it. An approval only counts when every step has one,
    which is what makes a parallel step genuinely require all of its levels.

    The order of these checks is the precedence between them. A withdrawal marks
    every step that had not been decided, so a route with one approval and one
    withdrawn step is withdrawn, not still waiting; but a rejection that arrived
    before the withdrawal is still the reason the route ended.
    """
    if not steps:
        return RouteState.withdrawn
    if any(step.state is StepState.rejected for step in steps):
        return RouteState.rejected
    if all(step.state is StepState.approved for step in steps):
        return RouteState.approved
    if any(step.state is StepState.withdrawn for step in steps):
        return RouteState.withdrawn
    return RouteState.open


def open_step_order(steps: list[StepProgress] | tuple[StepProgress, ...]) -> int | None:
    """The step order that is open for decisions, or None if the route is over.

    A single number rather than a set: every step at that order is open, and
    nothing above it is, which is the whole of the sequencing rule.
    """
    if route_state(steps) is not RouteState.open:
        return None
    outstanding = [step.step_order for step in steps if step.state is not StepState.approved]
    return min(outstanding) if outstanding else None


def with_states(
    steps: list[StepProgress] | tuple[StepProgress, ...],
) -> tuple[StepProgress, ...]:
    """Recompute `waiting` versus `ready` from the decisions so far.

    Persisted steps store their decision, not their readiness: readiness is a
    function of every other step and would go stale the moment a sibling was
    decided. Computing it on read means a route can never display two different
    ideas of whose turn it is.
    """
    open_at = open_step_order(steps)
    return tuple(
        step
        if step.is_decided
        else StepProgress(
            step_order=step.step_order,
            level=step.level,
            state=(
                StepState.ready
                if open_at is not None and step.step_order == open_at
                else StepState.waiting
                if open_at is not None
                else StepState.withdrawn
            ),
        )
        for step in steps
    )


# ------------------------------------------------------------------ decisions


class ApprovalError(Exception):
    """Base class for a refused approval action."""


class StepNotReadyError(ApprovalError):
    def __init__(self, level: ApprovalLevel, waiting_for: list[ApprovalLevel]) -> None:
        self.level = level
        self.waiting_for = waiting_for
        if waiting_for:
            outstanding = ", ".join(sorted(LEVEL_LABELS[item] for item in waiting_for))
            detail = f"{LEVEL_LABELS[level]} approval is not due yet. Waiting on: {outstanding}."
        else:
            detail = f"{LEVEL_LABELS[level]} approval is not open for a decision."
        super().__init__(detail)


class AlreadyDecidedError(ApprovalError):
    def __init__(self, level: ApprovalLevel, outcome: ApprovalOutcome) -> None:
        self.level = level
        self.outcome = outcome
        super().__init__(
            f"{LEVEL_LABELS[level]} has already {outcome.value} this. "
            "Reload to see the current position."
        )


class NotAnApproverError(ApprovalError):
    def __init__(self, level: ApprovalLevel) -> None:
        self.level = level
        super().__init__(
            f"You are not assigned as {LEVEL_LABELS[level]} for this record, so you "
            "cannot decide this step."
        )


class SelfApprovalError(ApprovalError):
    """The person who raised a request cannot approve it.

    Separate from the segregation-of-duties check in the roles module, which
    catches the same thing through the permissions a user has exercised. This
    one holds even if that record was never written, because the requester is
    on the record itself.
    """

    def __init__(self) -> None:
        super().__init__(
            "You raised this request, so you cannot approve it. "
            "Another authorised approver must decide."
        )


class DecisionCommentRequiredError(ApprovalError):
    def __init__(self) -> None:
        super().__init__("A reason is required when rejecting.")


class RouteClosedError(ApprovalError):
    def __init__(self, state: RouteState) -> None:
        self.state = state
        super().__init__(
            f"This request is {ROUTE_STATE_LABELS[state].lower()} and is no longer "
            "open for approval decisions."
        )


@dataclass(frozen=True, slots=True)
class StepDecision:
    """A validated decision, ready to be persisted."""

    step_order: int
    level: ApprovalLevel
    outcome: ApprovalOutcome
    actor_id: UUID
    actor_label: str
    comment: str | None
    decided_at: datetime
    #: Set when the deciding user is standing in for the assigned approver.
    on_behalf_of_id: UUID | None = None


def decide(
    *,
    steps: list[StepProgress] | tuple[StepProgress, ...],
    step_order: int,
    level: ApprovalLevel,
    outcome: ApprovalOutcome,
    actor_id: UUID,
    actor_label: str,
    requester_id: UUID | None,
    actor_is_assigned: bool,
    comment: str | None = None,
    on_behalf_of_id: UUID | None = None,
) -> StepDecision:
    """Validate one approval decision and describe it for persistence.

    Checks run from the most fundamental refusal to the most specific, so an
    approver who is both the requester and out of turn is told the thing that
    would still be true after the other was fixed.
    """
    current = with_states(steps)
    state = route_state(current)
    if state is not RouteState.open:
        raise RouteClosedError(state)

    target = next(
        (step for step in current if step.step_order == step_order and step.level is level),
        None,
    )
    if target is None:
        raise NotAnApproverError(level)

    if target.is_decided:
        raise AlreadyDecidedError(
            level,
            ApprovalOutcome.approved
            if target.state is StepState.approved
            else ApprovalOutcome.rejected,
        )

    if requester_id is not None and actor_id == requester_id:
        raise SelfApprovalError()

    if not actor_is_assigned:
        raise NotAnApproverError(level)

    if target.state is not StepState.ready:
        raise StepNotReadyError(
            level,
            [
                step.level
                for step in current
                if not step.is_decided and step.step_order < step_order
            ],
        )

    cleaned = (comment or "").strip()
    if outcome is ApprovalOutcome.rejected and not cleaned:
        raise DecisionCommentRequiredError()

    return StepDecision(
        step_order=step_order,
        level=level,
        outcome=outcome,
        actor_id=actor_id,
        actor_label=actor_label,
        comment=cleaned or None,
        decided_at=datetime.now(UTC),
        on_behalf_of_id=on_behalf_of_id,
    )


def summarise(steps: list[StepProgress] | tuple[StepProgress, ...]) -> str:
    """One line saying where a route stands, in the words a queue should use."""
    current = with_states(steps)
    state = route_state(current)
    if state is RouteState.approved:
        return "Fully approved."
    if state is RouteState.rejected:
        rejected = next(step for step in current if step.state is StepState.rejected)
        return f"Rejected by {LEVEL_LABELS[rejected.level]}."
    if state is RouteState.withdrawn:
        return "Withdrawn before a decision."

    waiting = sorted(LEVEL_LABELS[step.level] for step in current if step.state is StepState.ready)
    done = sum(1 for step in current if step.state is StepState.approved)
    of = len(current)
    return f"Waiting on {' and '.join(waiting)}. {done} of {of} approvals given."
