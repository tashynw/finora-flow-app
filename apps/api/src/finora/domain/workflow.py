"""Workflow state machine.

State changes are only legal through this module. Every transition records the
previous and new state, the acting user or service, a reason, the source and a
correlation identifier, and some transitions cannot proceed without a comment.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Final
from uuid import UUID, uuid4


class WorkflowState(StrEnum):
    draft = "draft"
    pending_sign_off = "pending_sign_off"
    pending_approval = "pending_approval"
    approved = "approved"
    ready_for_submission = "ready_for_submission"
    submitted = "submitted"
    paid = "paid"
    outstanding = "outstanding"
    exception = "exception"
    accrual_needed = "accrual_needed"
    rejected = "rejected"
    cancelled = "cancelled"


class TransitionSource(StrEnum):
    """Where a transition originated. Recorded so an automated action can never
    be mistaken for a human decision during an audit."""

    user = "user"
    system = "system"
    scheduler = "scheduler"
    imap_intake = "imap_intake"
    vendor_reply = "vendor_reply"
    signed_link = "signed_link"
    manual_upload = "manual_upload"


# Terminal states cannot be left. Reopening requires a new record with a
# documented link, which preserves the original history.
TERMINAL_STATES: Final[frozenset[WorkflowState]] = frozenset(
    {WorkflowState.paid, WorkflowState.rejected, WorkflowState.cancelled}
)

# Transitions requiring a mandatory comment. Rejection, cancellation and
# anything that moves a record backwards must be explained.
COMMENT_REQUIRED_TARGETS: Final[frozenset[WorkflowState]] = frozenset(
    {
        WorkflowState.rejected,
        WorkflowState.cancelled,
        WorkflowState.exception,
        WorkflowState.outstanding,
    }
)

# AI has no authority over any of these. The gateway may suggest, never enact.
AI_PROHIBITED_TARGETS: Final[frozenset[WorkflowState]] = frozenset(
    {
        WorkflowState.approved,
        WorkflowState.ready_for_submission,
        WorkflowState.submitted,
        WorkflowState.paid,
        WorkflowState.rejected,
        WorkflowState.cancelled,
    }
)

ALLOWED_TRANSITIONS: Final[dict[WorkflowState, frozenset[WorkflowState]]] = {
    WorkflowState.draft: frozenset(
        {
            WorkflowState.pending_sign_off,
            WorkflowState.pending_approval,
            WorkflowState.exception,
            WorkflowState.cancelled,
        }
    ),
    WorkflowState.pending_sign_off: frozenset(
        {
            WorkflowState.pending_approval,
            WorkflowState.draft,
            WorkflowState.rejected,
            WorkflowState.exception,
            WorkflowState.cancelled,
        }
    ),
    WorkflowState.pending_approval: frozenset(
        {
            WorkflowState.approved,
            WorkflowState.pending_sign_off,
            WorkflowState.draft,
            WorkflowState.rejected,
            WorkflowState.exception,
            WorkflowState.cancelled,
        }
    ),
    WorkflowState.approved: frozenset(
        {
            WorkflowState.ready_for_submission,
            WorkflowState.accrual_needed,
            # An approved figure that changes has to be approved again. The
            # approval was given for an amount, not for a record, so raising the
            # amount afterwards would otherwise carry a signature nobody gave.
            # Reached by amending a live purchase order upwards; the record stops
            # being usable while the new figure is decided, which is the point.
            WorkflowState.pending_approval,
            WorkflowState.exception,
            WorkflowState.cancelled,
        }
    ),
    WorkflowState.ready_for_submission: frozenset(
        {
            WorkflowState.submitted,
            WorkflowState.approved,
            WorkflowState.exception,
            WorkflowState.cancelled,
        }
    ),
    WorkflowState.submitted: frozenset(
        {
            WorkflowState.paid,
            WorkflowState.outstanding,
            WorkflowState.exception,
        }
    ),
    WorkflowState.outstanding: frozenset(
        {
            WorkflowState.paid,
            WorkflowState.submitted,
            WorkflowState.exception,
            WorkflowState.accrual_needed,
        }
    ),
    WorkflowState.exception: frozenset(
        {
            WorkflowState.draft,
            WorkflowState.pending_sign_off,
            WorkflowState.pending_approval,
            WorkflowState.approved,
            WorkflowState.accrual_needed,
            WorkflowState.cancelled,
        }
    ),
    WorkflowState.accrual_needed: frozenset(
        {
            WorkflowState.ready_for_submission,
            WorkflowState.approved,
            WorkflowState.exception,
            WorkflowState.cancelled,
        }
    ),
    WorkflowState.paid: frozenset(),
    WorkflowState.rejected: frozenset(),
    WorkflowState.cancelled: frozenset(),
}

# Plain-language labels. The UI must never invent its own wording for a state,
# so display text lives with the state definition.
STATE_LABELS: Final[dict[WorkflowState, str]] = {
    WorkflowState.draft: "Draft",
    WorkflowState.pending_sign_off: "Pending sign-off",
    WorkflowState.pending_approval: "Pending approval",
    WorkflowState.approved: "Approved",
    WorkflowState.ready_for_submission: "Ready for submission",
    WorkflowState.submitted: "Submitted",
    WorkflowState.paid: "Paid",
    WorkflowState.outstanding: "Outstanding",
    WorkflowState.exception: "Exception",
    WorkflowState.accrual_needed: "Accrual needed",
    WorkflowState.rejected: "Rejected",
    WorkflowState.cancelled: "Cancelled",
}


class TransitionError(Exception):
    """Base class for a refused transition."""


class IllegalTransitionError(TransitionError):
    def __init__(self, current: WorkflowState, target: WorkflowState) -> None:
        self.current = current
        self.target = target
        if current in TERMINAL_STATES:
            detail = (
                f"{STATE_LABELS[current]} is a final state and cannot change. "
                "Create a linked follow-up record instead."
            )
        else:
            allowed = sorted(STATE_LABELS[s] for s in ALLOWED_TRANSITIONS[current])
            detail = (
                f"Cannot move from {STATE_LABELS[current]} to "
                f"{STATE_LABELS[target]}. Allowed next states: "
                + (", ".join(allowed) if allowed else "none")
            )
        super().__init__(detail)


class CommentRequiredError(TransitionError):
    def __init__(self, target: WorkflowState) -> None:
        self.target = target
        super().__init__(f"A reason is required to move a record to {STATE_LABELS[target]}.")


class AiAuthorityError(TransitionError):
    def __init__(self, target: WorkflowState) -> None:
        self.target = target
        super().__init__(
            f"AI cannot move a record to {STATE_LABELS[target]}. "
            "This action requires an authorized person."
        )


class ConcurrencyError(TransitionError):
    def __init__(self, expected: int, actual: int) -> None:
        self.expected = expected
        self.actual = actual
        super().__init__(
            "This record changed while you were working on it. "
            "Reload to see the current state before acting again."
        )


@dataclass(frozen=True, slots=True)
class StateTransition:
    """An immutable record of one state change, suitable for the audit trail."""

    record_id: UUID
    from_state: WorkflowState
    to_state: WorkflowState
    source: TransitionSource
    actor_id: UUID | None
    actor_label: str
    reason: str | None
    correlation_id: UUID
    occurred_at: datetime
    metadata: dict[str, str] = field(default_factory=dict)


def can_transition(current: WorkflowState, target: WorkflowState) -> bool:
    return target in ALLOWED_TRANSITIONS[current]


def next_states(current: WorkflowState) -> frozenset[WorkflowState]:
    return ALLOWED_TRANSITIONS[current]


def transition(
    *,
    record_id: UUID,
    current: WorkflowState,
    target: WorkflowState,
    source: TransitionSource,
    actor_id: UUID | None,
    actor_label: str,
    expected_version: int,
    actual_version: int,
    reason: str | None = None,
    is_ai_initiated: bool = False,
    correlation_id: UUID | None = None,
    metadata: dict[str, str] | None = None,
) -> StateTransition:
    """Validate and describe a state change.

    Returns the transition to persist. Raises when the change is not permitted.
    Checks run in a deliberate order so the caller gets the most fundamental
    reason for refusal first.
    """
    if expected_version != actual_version:
        raise ConcurrencyError(expected_version, actual_version)

    if is_ai_initiated and target in AI_PROHIBITED_TARGETS:
        raise AiAuthorityError(target)

    if not can_transition(current, target):
        raise IllegalTransitionError(current, target)

    if target in COMMENT_REQUIRED_TARGETS and not (reason and reason.strip()):
        raise CommentRequiredError(target)

    return StateTransition(
        record_id=record_id,
        from_state=current,
        to_state=target,
        source=source,
        actor_id=actor_id,
        actor_label=actor_label,
        reason=reason.strip() if reason else None,
        correlation_id=correlation_id or uuid4(),
        occurred_at=datetime.now(UTC),
        metadata=dict(metadata or {}),
    )
