"""Month-end accruals: proposing, adjusting, finalizing and locking a period.

An accrual is a claim that something is owed at period end even though it has
not been paid. The work is generating the candidates, letting a person edit them
with a reason, finalizing each one, and locking the period so the set cannot
change after it has been exported.

## Documented defaults (requirements still open)

Candidate and reversal rules are not yet defined in the authoritative
requirements. Until they are, the defaults below are provisional and named as
such in the requirements matrix:

*A candidate is an unpaid invoice dated on or before the period end* whose
state is one of approved, outstanding, exception or accrual_needed. Paid,
cancelled, declined and draft invoices are never proposed.

*A reversal is a negative adjustment a person enters*, not something the
platform invents from a prior period. Automatic reversals need the rules that
are still open.

*AI never finalizes or locks.* Those paths take a named person and a reason.

## Two authorities, not one

Editing a candidate and locking its period are different permissions.
`accrual:edit` changes amounts and standing; `accrual:lock_period` freezes the
period. Segregation of duties forbids the same person both against the same
period.

## Standing is derived

A period is open or locked. That is read from `locked_at`, the same way a
credit-card period is open or closed. Inventing a workflow state for the
container would put a reporting pack on the machine that governs claims about
money still owed — and an accrual period is not one of those claims; the
invoices on it already are.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from enum import StrEnum
from typing import Final
from uuid import UUID

from finora.domain.money import Money
from finora.domain.workflow import WorkflowState

MAX_REASON_LENGTH: Final[int] = 2000
MIN_REASON_LENGTH: Final[int] = 3
MAX_NOTE_LENGTH: Final[int] = 2000
MAX_DESCRIPTION_LENGTH: Final[int] = 500

#: States that mean money is still owed, so an unpaid invoice at period end is
#: a candidate. Draft and declined never are: nothing has been accepted yet.
#: Paid and cancelled never are: the obligation is gone.
CANDIDATE_SOURCE_STATES: Final[frozenset[WorkflowState]] = frozenset(
    {
        WorkflowState.approved,
        WorkflowState.outstanding,
        WorkflowState.exception,
        WorkflowState.accrual_needed,
        WorkflowState.ready_for_submission,
    }
)


class PeriodStanding(StrEnum):
    """Where an accrual period is, derived from `locked_at`."""

    open = "open"
    locked = "locked"


PERIOD_STANDING_LABELS: Final[dict[PeriodStanding, str]] = {
    PeriodStanding.open: "Open",
    PeriodStanding.locked: "Locked",
}

PERIOD_STANDING_DESCRIPTIONS: Final[dict[PeriodStanding, str]] = {
    PeriodStanding.open: (
        "Still being reviewed. Candidates can change; nothing is locked for export."
    ),
    PeriodStanding.locked: (
        "Locked. Candidates are fixed, and the period cannot be reopened from here."
    ),
}


class CandidateStanding(StrEnum):
    """Where a candidate is in the review."""

    proposed = "proposed"
    adjusted = "adjusted"
    finalized = "finalized"
    excluded = "excluded"


CANDIDATE_STANDING_LABELS: Final[dict[CandidateStanding, str]] = {
    CandidateStanding.proposed: "Proposed",
    CandidateStanding.adjusted: "Adjusted",
    CandidateStanding.finalized: "Finalized",
    CandidateStanding.excluded: "Excluded",
}


class PeriodProblem(StrEnum):
    already_locked = "already_locked"
    not_locked = "not_locked"
    open_candidates = "open_candidates"
    no_candidates = "no_candidates"
    reason_required = "reason_required"
    reason_too_short = "reason_too_short"
    reason_too_long = "reason_too_long"
    dates_unordered = "dates_unordered"
    period_overlap = "period_overlap"


class CandidateProblem(StrEnum):
    period_locked = "period_locked"
    already_finalized = "already_finalized"
    already_excluded = "already_excluded"
    reason_required = "reason_required"
    reason_too_short = "reason_too_short"
    reason_too_long = "reason_too_long"
    amount_missing = "amount_missing"
    not_ready_to_finalize = "not_ready_to_finalize"


PROBLEM_EXPLANATIONS: Final[dict[PeriodProblem | CandidateProblem, str]] = {
    PeriodProblem.already_locked: "This period is already locked.",
    PeriodProblem.not_locked: "Lock the period before producing an official export.",
    PeriodProblem.open_candidates: (
        "Every candidate must be finalized or excluded before the period can lock."
    ),
    PeriodProblem.no_candidates: "Generate candidates before locking an empty period.",
    PeriodProblem.reason_required: "Say why.",
    PeriodProblem.reason_too_short: "Give a reason of at least a few words.",
    PeriodProblem.reason_too_long: "Shorten the reason.",
    PeriodProblem.dates_unordered: "The period end must be on or after the period start.",
    PeriodProblem.period_overlap: ("Another open or locked period already covers these dates."),
    CandidateProblem.period_locked: "The period is locked; candidates cannot change.",
    CandidateProblem.already_finalized: "This candidate is already finalized.",
    CandidateProblem.already_excluded: "This candidate is already excluded.",
    CandidateProblem.reason_required: "Say why the figure or standing changed.",
    CandidateProblem.reason_too_short: "Give a reason of at least a few words.",
    CandidateProblem.reason_too_long: "Shorten the reason.",
    CandidateProblem.amount_missing: "Enter an amount.",
    CandidateProblem.not_ready_to_finalize: (
        "Only a proposed or adjusted candidate can be finalized."
    ),
}

PROBLEM_FIELDS: Final[dict[PeriodProblem | CandidateProblem, str]] = {
    PeriodProblem.already_locked: "locked_at",
    PeriodProblem.not_locked: "locked_at",
    PeriodProblem.open_candidates: "candidates",
    PeriodProblem.no_candidates: "candidates",
    PeriodProblem.reason_required: "reason",
    PeriodProblem.reason_too_short: "reason",
    PeriodProblem.reason_too_long: "reason",
    PeriodProblem.dates_unordered: "period_end",
    PeriodProblem.period_overlap: "period_start",
    CandidateProblem.period_locked: "locked_at",
    CandidateProblem.already_finalized: "standing",
    CandidateProblem.already_excluded: "standing",
    CandidateProblem.reason_required: "reason",
    CandidateProblem.reason_too_short: "reason",
    CandidateProblem.reason_too_long: "reason",
    CandidateProblem.amount_missing: "amount",
    CandidateProblem.not_ready_to_finalize: "standing",
}

LOCK_PROBLEM_ORDER: Final[tuple[PeriodProblem, ...]] = (
    PeriodProblem.already_locked,
    PeriodProblem.no_candidates,
    PeriodProblem.open_candidates,
    PeriodProblem.reason_required,
    PeriodProblem.reason_too_short,
    PeriodProblem.reason_too_long,
)


@dataclass(frozen=True, slots=True)
class InvoiceCandidateSource:
    """The facts on an invoice that decide whether it becomes a candidate."""

    id: UUID
    state: WorkflowState
    invoice_date: date | None
    currency: str | None
    total_minor_units: int | None
    vendor_name: str
    invoice_number: str | None
    description: str
    gl_account_id: UUID | None
    cost_centre_id: UUID | None
    department: str | None


@dataclass(frozen=True, slots=True)
class CandidateView:
    standing: CandidateStanding
    amount: Money | None
    edit_reason: str | None


@dataclass(frozen=True, slots=True)
class PeriodView:
    locked_at: datetime | None
    candidates: tuple[CandidateView, ...]


@dataclass(frozen=True, slots=True)
class EditDraft:
    amount: Money | None
    standing: CandidateStanding
    reason: str | None
    note: str | None = None
    description: str | None = None


def period_standing(*, locked_at: datetime | None) -> PeriodStanding:
    return PeriodStanding.locked if locked_at is not None else PeriodStanding.open


def may_change(*, locked_at: datetime | None) -> bool:
    return locked_at is None


def is_settled(candidate: CandidateView) -> bool:
    return candidate.standing in {
        CandidateStanding.finalized,
        CandidateStanding.excluded,
    }


def open_candidate_count(candidates: tuple[CandidateView, ...]) -> int:
    return sum(1 for row in candidates if not is_settled(row))


def is_candidate_source(invoice: InvoiceCandidateSource, *, period_end: date) -> bool:
    """Whether this invoice should be proposed for the period.

    Provisional rule: unpaid (in a source state), dated on or before period end,
    with an amount. Invoices without a date are skipped rather than guessed at —
    inventing a date would put a fabricated figure into the books.
    """

    if invoice.state not in CANDIDATE_SOURCE_STATES:
        return False
    if invoice.invoice_date is None or invoice.invoice_date > period_end:
        return False
    if invoice.currency is None or invoice.total_minor_units is None:
        return False
    return True


def _reason_problems(
    reason: str | None,
    *,
    as_period: bool,
) -> list[FieldProblem]:
    found: list[FieldProblem] = []
    cleaned = (reason or "").strip()
    if not cleaned:
        code: PeriodProblem | CandidateProblem = (
            PeriodProblem.reason_required if as_period else CandidateProblem.reason_required
        )
        found.append(
            FieldProblem(
                code=code,
                field=PROBLEM_FIELDS[code],
                message=PROBLEM_EXPLANATIONS[code],
            )
        )
        return found
    if len(cleaned) < MIN_REASON_LENGTH:
        code = PeriodProblem.reason_too_short if as_period else CandidateProblem.reason_too_short
        found.append(
            FieldProblem(
                code=code,
                field=PROBLEM_FIELDS[code],
                message=PROBLEM_EXPLANATIONS[code],
            )
        )
    elif len(cleaned) > MAX_REASON_LENGTH:
        code = PeriodProblem.reason_too_long if as_period else CandidateProblem.reason_too_long
        found.append(
            FieldProblem(
                code=code,
                field=PROBLEM_FIELDS[code],
                message=PROBLEM_EXPLANATIONS[code],
            )
        )
    return found


def open_period_problems(*, period_start: date, period_end: date) -> tuple[FieldProblem, ...]:
    if period_end < period_start:
        return (
            FieldProblem(
                code=PeriodProblem.dates_unordered,
                field=PROBLEM_FIELDS[PeriodProblem.dates_unordered],
                message=PROBLEM_EXPLANATIONS[PeriodProblem.dates_unordered],
            ),
        )
    return ()


def edit_problems(
    draft: EditDraft,
    *,
    locked_at: datetime | None,
    current: CandidateStanding,
) -> tuple[FieldProblem, ...]:
    found: list[FieldProblem] = []

    def add(code: CandidateProblem) -> None:
        found.append(
            FieldProblem(
                code=code,
                field=PROBLEM_FIELDS[code],
                message=PROBLEM_EXPLANATIONS[code],
            )
        )

    if locked_at is not None:
        add(CandidateProblem.period_locked)
        return tuple(found)

    if current is CandidateStanding.finalized:
        add(CandidateProblem.already_finalized)
        return tuple(found)

    if current is CandidateStanding.excluded and draft.standing is CandidateStanding.excluded:
        add(CandidateProblem.already_excluded)
        return tuple(found)

    if draft.amount is None:
        add(CandidateProblem.amount_missing)

    found.extend(_reason_problems(draft.reason, as_period=False))
    return tuple(found)


def finalize_problems(
    *,
    locked_at: datetime | None,
    standing: CandidateStanding,
) -> tuple[FieldProblem, ...]:
    found: list[FieldProblem] = []

    def add(code: CandidateProblem) -> None:
        found.append(
            FieldProblem(
                code=code,
                field=PROBLEM_FIELDS[code],
                message=PROBLEM_EXPLANATIONS[code],
            )
        )

    if locked_at is not None:
        add(CandidateProblem.period_locked)
        return tuple(found)

    if standing is CandidateStanding.finalized:
        add(CandidateProblem.already_finalized)
        return tuple(found)

    if standing is CandidateStanding.excluded:
        add(CandidateProblem.already_excluded)
        return tuple(found)

    # Remaining live standings are proposed and adjusted — both may finalize.
    return tuple(found)


def lock_problems(period: PeriodView, *, reason: str | None) -> tuple[FieldProblem, ...]:
    found: list[FieldProblem] = []

    def add(code: PeriodProblem) -> None:
        found.append(
            FieldProblem(
                code=code,
                field=PROBLEM_FIELDS[code],
                message=PROBLEM_EXPLANATIONS[code],
            )
        )

    if period.locked_at is not None:
        add(PeriodProblem.already_locked)
        return tuple(found)

    if not period.candidates:
        add(PeriodProblem.no_candidates)

    if open_candidate_count(period.candidates) > 0:
        add(PeriodProblem.open_candidates)

    found.extend(_reason_problems(reason, as_period=True))

    order = {code: index for index, code in enumerate(LOCK_PROBLEM_ORDER)}
    found.sort(key=lambda item: order.get(item.code, 99))  # type: ignore[arg-type]
    return tuple(found)


def export_problems(*, locked_at: datetime | None, official: bool) -> tuple[FieldProblem, ...]:
    """Official exports require a locked period. Draft exports do not."""

    if official and locked_at is None:
        return (
            FieldProblem(
                code=PeriodProblem.not_locked,
                field=PROBLEM_FIELDS[PeriodProblem.not_locked],
                message=PROBLEM_EXPLANATIONS[PeriodProblem.not_locked],
            ),
        )
    return ()


def standing_after_edit(*, exclude: bool, amount_changed: bool) -> CandidateStanding:
    if exclude:
        return CandidateStanding.excluded
    if amount_changed:
        return CandidateStanding.adjusted
    return CandidateStanding.adjusted


EXPORT_COLUMNS: Final[tuple[str, ...]] = (
    "reference",
    "standing",
    "invoice_reference",
    "invoice_number",
    "vendor",
    "description",
    "currency",
    "amount",
    "department",
    "gl_code",
    "cost_centre_code",
    "edit_reason",
    "note",
)


@dataclass(frozen=True, slots=True)
class FieldProblem:
    """One refusal, named against the field a person can fix."""

    code: PeriodProblem | CandidateProblem
    field: str
    message: str
