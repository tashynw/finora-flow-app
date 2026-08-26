"""State machine rules, including the limits placed on AI authority."""

from __future__ import annotations

from uuid import uuid4

import pytest

from finora.domain.workflow import (
    ALLOWED_TRANSITIONS,
    TERMINAL_STATES,
    AiAuthorityError,
    CommentRequiredError,
    ConcurrencyError,
    IllegalTransitionError,
    TransitionSource,
    WorkflowState,
    can_transition,
    next_states,
    transition,
)


def _transition(**overrides: object) -> object:
    defaults: dict[str, object] = {
        "record_id": uuid4(),
        "current": WorkflowState.pending_approval,
        "target": WorkflowState.approved,
        "source": TransitionSource.user,
        "actor_id": uuid4(),
        "actor_label": "Alex Requester",
        "expected_version": 1,
        "actual_version": 1,
    }
    defaults.update(overrides)
    return transition(**defaults)  # type: ignore[arg-type]


class TestGraphIntegrity:
    def test_every_state_has_an_entry(self) -> None:
        for state in WorkflowState:
            assert state in ALLOWED_TRANSITIONS

    def test_terminal_states_have_no_exits(self) -> None:
        for state in TERMINAL_STATES:
            assert ALLOWED_TRANSITIONS[state] == frozenset()

    def test_no_state_transitions_to_itself(self) -> None:
        for state, targets in ALLOWED_TRANSITIONS.items():
            assert state not in targets

    def test_every_non_terminal_state_can_reach_somewhere(self) -> None:
        for state in WorkflowState:
            if state not in TERMINAL_STATES:
                assert next_states(state), f"{state} is a dead end"


class TestLegalTransitions:
    def test_approval_path(self) -> None:
        assert can_transition(WorkflowState.pending_approval, WorkflowState.approved)

    def test_approved_to_ready_for_submission(self) -> None:
        assert can_transition(WorkflowState.approved, WorkflowState.ready_for_submission)

    def test_submitted_to_paid(self) -> None:
        assert can_transition(WorkflowState.submitted, WorkflowState.paid)

    def test_draft_cannot_jump_straight_to_paid(self) -> None:
        assert not can_transition(WorkflowState.draft, WorkflowState.paid)

    def test_paid_is_final(self) -> None:
        with pytest.raises(IllegalTransitionError, match="final state"):
            _transition(current=WorkflowState.paid, target=WorkflowState.outstanding)

    def test_illegal_transition_message_lists_alternatives(self) -> None:
        with pytest.raises(IllegalTransitionError, match="Allowed next states"):
            _transition(current=WorkflowState.draft, target=WorkflowState.paid)


class TestMandatoryReasons:
    @pytest.mark.parametrize(
        ("current", "target"),
        [
            (WorkflowState.pending_approval, WorkflowState.rejected),
            (WorkflowState.draft, WorkflowState.cancelled),
            (WorkflowState.pending_approval, WorkflowState.exception),
            (WorkflowState.submitted, WorkflowState.outstanding),
        ],
    )
    def test_reason_required(self, current: WorkflowState, target: WorkflowState) -> None:
        with pytest.raises(CommentRequiredError):
            _transition(current=current, target=target)

    def test_blank_reason_is_not_accepted(self) -> None:
        with pytest.raises(CommentRequiredError):
            _transition(
                current=WorkflowState.pending_approval,
                target=WorkflowState.rejected,
                reason="   ",
            )

    def test_reason_is_trimmed_when_recorded(self) -> None:
        result = _transition(
            current=WorkflowState.pending_approval,
            target=WorkflowState.rejected,
            reason="  Vendor bank details do not match  ",
        )
        assert result.reason == "Vendor bank details do not match"  # type: ignore[attr-defined]

    def test_approval_does_not_require_a_reason(self) -> None:
        result = _transition()
        assert result.reason is None  # type: ignore[attr-defined]


class TestAiAuthority:
    @pytest.mark.parametrize(
        "target",
        [
            WorkflowState.approved,
            WorkflowState.ready_for_submission,
            WorkflowState.submitted,
            WorkflowState.paid,
            WorkflowState.rejected,
            WorkflowState.cancelled,
        ],
    )
    def test_ai_cannot_enact_financial_outcomes(self, target: WorkflowState) -> None:
        current = next(s for s, t in ALLOWED_TRANSITIONS.items() if target in t)
        with pytest.raises(AiAuthorityError, match="requires an authorized person"):
            _transition(
                current=current,
                target=target,
                is_ai_initiated=True,
                reason="model suggestion",
            )

    def test_ai_may_raise_an_exception_for_review(self) -> None:
        result = _transition(
            current=WorkflowState.pending_approval,
            target=WorkflowState.exception,
            is_ai_initiated=True,
            source=TransitionSource.system,
            reason="Extraction confidence below threshold",
        )
        assert result.to_state is WorkflowState.exception  # type: ignore[attr-defined]


class TestOptimisticConcurrency:
    def test_stale_version_is_refused(self) -> None:
        with pytest.raises(ConcurrencyError, match="changed while you were working"):
            _transition(expected_version=1, actual_version=2)

    def test_concurrency_is_checked_before_legality(self) -> None:
        """A stale caller should be told to reload rather than shown a
        confusing transition error about state they cannot see."""
        with pytest.raises(ConcurrencyError):
            _transition(
                current=WorkflowState.paid,
                target=WorkflowState.outstanding,
                expected_version=1,
                actual_version=9,
            )


class TestAuditRecord:
    def test_transition_captures_full_provenance(self) -> None:
        record_id = uuid4()
        actor_id = uuid4()
        correlation_id = uuid4()
        result = _transition(
            record_id=record_id,
            actor_id=actor_id,
            actor_label="Jane Approver",
            correlation_id=correlation_id,
            source=TransitionSource.user,
            metadata={"approval_level": "manager"},
        )
        assert result.record_id == record_id  # type: ignore[attr-defined]
        assert result.actor_id == actor_id  # type: ignore[attr-defined]
        assert result.actor_label == "Jane Approver"  # type: ignore[attr-defined]
        assert result.correlation_id == correlation_id  # type: ignore[attr-defined]
        assert result.from_state is WorkflowState.pending_approval  # type: ignore[attr-defined]
        assert result.to_state is WorkflowState.approved  # type: ignore[attr-defined]
        assert result.metadata == {"approval_level": "manager"}  # type: ignore[attr-defined]

    def test_timestamp_is_timezone_aware_utc(self) -> None:
        result = _transition()
        assert result.occurred_at.tzinfo is not None  # type: ignore[attr-defined]
        assert result.occurred_at.utcoffset().total_seconds() == 0  # type: ignore[union-attr]

    def test_correlation_id_is_generated_when_absent(self) -> None:
        assert _transition().correlation_id is not None  # type: ignore[attr-defined]
