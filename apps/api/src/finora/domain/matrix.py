"""Checking a proposed approval matrix before anybody's spend depends on it.

The matrix decides who has to approve what. It is configuration, which means a
person edits it, which means a person can break it — and the ways of breaking it
are quiet. A band deleted by mistake does not announce itself; it waits until
somebody submits an amount in the hole and is told, correctly but uselessly, that
no approval levels are configured. A level added at an existing step order turns
two sequential approvals into two concurrent ones, halving the scrutiny on the
largest payments, and looks in the table exactly like the thing that was meant.

So this module exists to answer one question in advance: *if I save this, what
happens to the next person who submits?*

It answers it by running the real planner rather than by re-describing what the
planner does. `plan_route` is called at every amount where the answer could
change — each band's floor, and one minor unit above each band's ceiling — for
every department the matrix mentions. Those are the only amounts that matter,
because between two adjacent boundaries the set of matching rules is by
definition constant, so a route that is sound at the boundaries is sound
everywhere.

The alternative, a second implementation of the rules written as validation, is
the usual way this goes wrong. Two descriptions of the same thing drift, and the
one that drifts is always the one that is not in the payment path, so the
administrator is reassured by a check that no longer reflects what will happen.

Refusals and warnings are kept separate, and the line between them is whether the
matrix is *incoherent* or merely *incomplete*. Two rules that contradict each
other have no correct interpretation and are refused. A currency nobody has
configured bands for is perfectly coherent — it means that currency cannot be
submitted — and might be exactly what was intended, so it is reported loudly and
saved anyway. Refusing it would make the first rule of a new currency impossible
to add, since a matrix is incomplete right up until the moment it is finished.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Final

from finora.domain.approvals import (
    LEVEL_LABELS,
    AmountNotCoveredError,
    MatrixRule,
    ParallelismNotDeclaredError,
    PlannedStep,
    RouteNotAvailableError,
    plan_route,
)
from finora.domain.money import CurrencyError, Money, exponent_for
from finora.domain.roles import ApprovalLevel

#: What a matrix may govern. A free-text record type would let a typo create a
#: matrix that is never consulted, which reads as "no approval configured" at
#: exactly the moment that matters.
MATRIX_RECORD_TYPES: Final[frozenset[str]] = frozenset({"estimate", "invoice", "purchase_order"})

RECORD_TYPE_LABELS: Final[dict[str, str]] = {
    "estimate": "Estimates",
    "invoice": "Invoices",
    "purchase_order": "Purchase orders",
}

#: How far above a band's ceiling to look when probing for a gap. One minor unit:
#: the smallest amount that can exist in the currency, and therefore the first
#: amount the band does not cover.
_ONE_MINOR_UNIT: Final[int] = 1


class RuleProblem(StrEnum):
    """Why one proposed rule cannot be saved as written."""

    name_missing = "name_missing"
    record_type_unknown = "record_type_unknown"
    currency_unknown = "currency_unknown"
    step_order_not_positive = "step_order_not_positive"
    band_negative = "band_negative"
    band_inverted = "band_inverted"
    #: Another live rule already covers the same levels, step and department over
    #: an overlapping range of amounts, so which of them applies is arbitrary.
    duplicate_of_live_rule = "duplicate_of_live_rule"


RULE_PROBLEM_EXPLANATIONS: Final[dict[RuleProblem, str]] = {
    RuleProblem.name_missing: (
        "Give the rule a name. It is what an approver sees when they are asked why "
        "a request reached them, so it should read as a sentence: "
        "'Manager, JMD 50,000 and above'."
    ),
    RuleProblem.record_type_unknown: (
        "Choose what this rule governs. A rule attached to nothing is never "
        "consulted, which looks identical to no approval being required."
    ),
    RuleProblem.currency_unknown: (
        "Choose a currency the platform knows how to count in. Amounts are never "
        "converted between currencies, so a band applies only to the one it names."
    ),
    RuleProblem.step_order_not_positive: "Steps are numbered from one upwards.",
    RuleProblem.band_negative: "A band cannot start below zero.",
    RuleProblem.band_inverted: (
        "The top of the band is below the bottom of it, so no amount could ever fall inside it."
    ),
    RuleProblem.duplicate_of_live_rule: (
        "A live rule already asks this level to approve at this step, for these "
        "amounts, in this department. Retire that one first, or narrow the band, "
        "because two rules covering one amount leave it undecided which applies."
    ),
}

RULE_PROBLEM_FIELDS: Final[dict[RuleProblem, str]] = {
    RuleProblem.name_missing: "name",
    RuleProblem.record_type_unknown: "record_type",
    RuleProblem.currency_unknown: "currency",
    RuleProblem.step_order_not_positive: "step_order",
    RuleProblem.band_negative: "min_amount_minor_units",
    RuleProblem.band_inverted: "max_amount_minor_units",
    RuleProblem.duplicate_of_live_rule: "level",
}


class MatrixFault(StrEnum):
    """A contradiction in the matrix as a whole, which no amount can resolve."""

    #: Two levels share a step order without being marked as deciding together.
    parallelism_not_declared = "parallelism_not_declared"
    #: One level is asked to approve twice in the same route, at two step orders.
    level_approves_twice = "level_approves_twice"


class MatrixGap(StrEnum):
    """Something missing rather than contradictory. Saved, but said out loud."""

    #: A range of amounts no rule covers. Submitting one is refused.
    amounts_with_no_route = "amounts_with_no_route"
    #: A level the matrix relies on that nobody currently holds.
    level_unstaffed = "level_unstaffed"
    #: A record type with no live rules at all.
    nothing_configured = "nothing_configured"


@dataclass(frozen=True, slots=True)
class RuleDraft:
    """A rule as an administrator proposes it, before it is anything.

    Separate from `MatrixRule` because a draft may be nonsense — that is what it
    is being checked for — whereas a `MatrixRule` is something route planning is
    entitled to trust.
    """

    name: str
    record_type: str
    level: ApprovalLevel
    step_order: int
    min_amount_minor_units: int
    max_amount_minor_units: int | None
    currency: str
    department: str | None
    is_parallel: bool

    def as_rule(self) -> MatrixRule:
        return MatrixRule(
            level=self.level,
            step_order=self.step_order,
            min_amount_minor_units=self.min_amount_minor_units,
            max_amount_minor_units=self.max_amount_minor_units,
            currency=self.currency,
            department=self.department,
            is_parallel=self.is_parallel,
        )

    def overlaps(self, other: MatrixRule) -> bool:
        """Whether both would match some amount, in the same scope.

        Scope is the whole of level, step and department: the same level at a
        different step is a separate question, handled by `level_approves_twice`,
        and the same level in another department is not a clash at all.
        """
        if self.level is not other.level or self.step_order != other.step_order:
            return False
        if _same_department(self.department, other.department) is False:
            return False
        if self.currency.upper() != other.currency.upper():
            return False

        our_ceiling = self.max_amount_minor_units
        their_ceiling = other.max_amount_minor_units
        below_them = our_ceiling is not None and our_ceiling < other.min_amount_minor_units
        above_them = their_ceiling is not None and their_ceiling < self.min_amount_minor_units
        return not (below_them or above_them)


@dataclass(frozen=True, slots=True)
class Reading:
    """What the matrix does at one amount, in one department."""

    currency: str
    department: str | None
    amount_minor_units: int
    steps: tuple[PlannedStep, ...] = ()
    #: Set when no route could be planned at this amount at all.
    unreachable: str | None = None

    @property
    def amount(self) -> Money:
        return Money(self.amount_minor_units, self.currency)


@dataclass(frozen=True, slots=True)
class MatrixAudit:
    """The verdict on a whole matrix, and the evidence for it."""

    faults: tuple[tuple[MatrixFault, str], ...] = ()
    gaps: tuple[tuple[MatrixGap, str], ...] = ()
    readings: tuple[Reading, ...] = field(default=())

    @property
    def is_coherent(self) -> bool:
        """Whether the matrix can be saved. Gaps do not stop it; faults do."""
        return not self.faults


def _same_department(left: str | None, right: str | None) -> bool:
    if left is None or right is None:
        return left is None and right is None
    return left.strip().casefold() == right.strip().casefold()


def check_rule(
    draft: RuleDraft, *, against: tuple[MatrixRule, ...] = ()
) -> tuple[RuleProblem, ...]:
    """Everything wrong with one proposed rule, considered on its own terms.

    `against` is the set of rules already live for the same record type. It is
    only used for the overlap check; the rest of the rule answers for itself.
    """
    found: list[RuleProblem] = []

    if not draft.name.strip():
        found.append(RuleProblem.name_missing)
    if draft.record_type not in MATRIX_RECORD_TYPES:
        found.append(RuleProblem.record_type_unknown)

    try:
        exponent_for(draft.currency)
    except CurrencyError:
        found.append(RuleProblem.currency_unknown)

    if draft.step_order < 1:
        found.append(RuleProblem.step_order_not_positive)
    if draft.min_amount_minor_units < 0:
        found.append(RuleProblem.band_negative)
    if (
        draft.max_amount_minor_units is not None
        and draft.max_amount_minor_units < draft.min_amount_minor_units
    ):
        found.append(RuleProblem.band_inverted)

    if any(draft.overlaps(existing) for existing in against):
        found.append(RuleProblem.duplicate_of_live_rule)

    return tuple(found)


def explain_rule_problem(problem: RuleProblem) -> str:
    return RULE_PROBLEM_EXPLANATIONS[problem]


def field_for_rule_problem(problem: RuleProblem) -> str:
    return RULE_PROBLEM_FIELDS[problem]


def probe_amounts(rules: tuple[MatrixRule, ...], currency: str) -> tuple[int, ...]:
    """The amounts at which this matrix could possibly behave differently.

    Every band floor, and one minor unit above every band ceiling, plus zero.
    Between two adjacent boundaries the set of matching rules cannot change, so
    checking the boundaries checks everything without walking the number line.
    """
    boundaries: set[int] = {0}
    for rule in rules:
        if rule.currency.upper() != currency.upper():
            continue
        boundaries.add(rule.min_amount_minor_units)
        if rule.max_amount_minor_units is not None:
            boundaries.add(rule.max_amount_minor_units + _ONE_MINOR_UNIT)
    return tuple(sorted(boundaries))


def audit_matrix(
    rules: tuple[MatrixRule, ...],
    *,
    staffed_levels: frozenset[ApprovalLevel] = frozenset(),
) -> MatrixAudit:
    """Run the real planner across the whole matrix and report what it does.

    `staffed_levels` are the levels somebody currently holds. A matrix naming a
    level nobody holds is coherent and unusable, which is a gap rather than a
    fault: the fix is on the assignments screen, not this one.
    """
    if not rules:
        return MatrixAudit(
            gaps=(
                (
                    MatrixGap.nothing_configured,
                    "Nothing is configured, so every submission will be refused for "
                    "want of an approver. Add the first rule.",
                ),
            )
        )

    faults: list[tuple[MatrixFault, str]] = []
    gaps: list[tuple[MatrixGap, str]] = []
    readings: list[Reading] = []

    for currency in sorted({rule.currency.upper() for rule in rules}):
        for department in _department_scopes(rules):
            readings.extend(
                _read_scope(
                    rules,
                    currency=currency,
                    department=department,
                    faults=faults,
                    gaps=gaps,
                )
            )

    for level in sorted({rule.level for rule in rules}, key=lambda each: each.value):
        if level not in staffed_levels:
            gaps.append(
                (
                    MatrixGap.level_unstaffed,
                    f"{LEVEL_LABELS[level]} appears in the matrix but nobody holds it. "
                    "Anything routed there will be refused at submission until "
                    "somebody is assigned.",
                )
            )

    return MatrixAudit(faults=tuple(faults), gaps=tuple(gaps), readings=tuple(readings))


def _department_scopes(rules: tuple[MatrixRule, ...]) -> tuple[str | None, ...]:
    """Organisation-wide, plus every department the matrix singles out.

    A department with no rule of its own behaves exactly like the organisation-
    wide scope, so it needs no separate reading.
    """
    named = sorted({rule.department for rule in rules if rule.department is not None})
    return (None, *named)


def _read_scope(
    rules: tuple[MatrixRule, ...],
    *,
    currency: str,
    department: str | None,
    faults: list[tuple[MatrixFault, str]],
    gaps: list[tuple[MatrixGap, str]],
) -> list[Reading]:
    """Plan a route at every boundary amount for one currency and department."""
    readings: list[Reading] = []
    where = f"in {department}" if department else "organisation-wide"

    for minor_units in probe_amounts(rules, currency):
        amount = Money(minor_units, currency)
        try:
            steps = plan_route(list(rules), amount=amount, department=department)
        except AmountNotCoveredError:
            readings.append(
                Reading(
                    currency=currency,
                    department=department,
                    amount_minor_units=minor_units,
                    unreachable="No rule covers this amount.",
                )
            )
            _note_once(
                gaps,
                MatrixGap.amounts_with_no_route,
                f"Nothing covers {amount.format()} {where}. A request for that much "
                "cannot be submitted until a band includes it.",
            )
            continue
        except ParallelismNotDeclaredError as error:
            readings.append(
                Reading(
                    currency=currency,
                    department=department,
                    amount_minor_units=minor_units,
                    unreachable=str(error),
                )
            )
            _note_once(faults, MatrixFault.parallelism_not_declared, str(error))
            continue
        except RouteNotAvailableError as error:
            # Any future refusal the planner grows. Reported rather than
            # swallowed, because an unplannable amount is the failure this whole
            # function exists to surface, whatever its cause.
            readings.append(
                Reading(
                    currency=currency,
                    department=department,
                    amount_minor_units=minor_units,
                    unreachable=str(error),
                )
            )
            continue

        repeated = _levels_appearing_twice(steps)
        for level in repeated:
            _note_once(
                faults,
                MatrixFault.level_approves_twice,
                f"At {amount.format()} {where}, {LEVEL_LABELS[level]} is asked to "
                "approve at two separate steps. One of the two rules is redundant, "
                "and as written the same person is asked the same question twice.",
            )

        readings.append(
            Reading(
                currency=currency,
                department=department,
                amount_minor_units=minor_units,
                steps=steps,
            )
        )

    return readings


def _levels_appearing_twice(steps: tuple[PlannedStep, ...]) -> tuple[ApprovalLevel, ...]:
    seen: dict[ApprovalLevel, int] = {}
    for step in steps:
        seen[step.level] = seen.get(step.level, 0) + 1
    return tuple(level for level, count in seen.items() if count > 1)


def _note_once[T: StrEnum](notes: list[tuple[T, str]], kind: T, message: str) -> None:
    """Add a note unless the identical one is already there.

    The same fault is found at several probe amounts by construction, and an
    administrator reading the same sentence eight times learns nothing the first
    sentence did not tell them.
    """
    if (kind, message) not in notes:
        notes.append((kind, message))
