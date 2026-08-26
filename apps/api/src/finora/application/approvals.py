"""Running an approval route against the database.

The domain decides whether a decision is allowed and what a route amounts to.
This module does the parts that need the database: reading the configured matrix,
working out whether a particular user stands at a particular level, writing a
decision, and keeping the denormalised "whose turn is it" column honest.

Everything that changes a route also writes an audit entry, and the entry names
the level and the amount rather than only the record. An auditor asking "who
approved spending this much" should not have to join their way to the answer.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol
from uuid import UUID

import structlog
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from finora.domain.approvals import (
    LEVEL_LABELS,
    ApprovalOutcome,
    MatrixRule,
    RouteNotAvailableError,
    RouteState,
    StepProgress,
    StepState,
    decide,
    open_step_order,
    plan_route,
    route_state,
    summarise,
    with_states,
)
from finora.domain.audit import ActorType, AuditAction
from finora.domain.money import Money
from finora.domain.roles import ApprovalLevel
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import (
    ApprovalAssignment,
    ApprovalRequest,
    ApprovalRule,
    ApprovalStep,
    User,
)

logger = structlog.get_logger(__name__)


class Actor(Protocol):
    """Structural type for whoever is acting. See `document_pipeline.Reviewer`."""

    @property
    def user_id(self) -> UUID: ...

    @property
    def display_name(self) -> str: ...


@dataclass(frozen=True, slots=True)
class Standing:
    """Whether a user may decide a step, and under whose authority.

    A delegate's approval is recorded as theirs, with the person they stood in
    for named beside it. Recording it as the absent approver's would be a
    forgery; recording it without them would lose the reason a delegate had any
    authority at all.
    """

    may_decide: bool
    on_behalf_of_id: UUID | None = None
    on_behalf_of_label: str | None = None

    @classmethod
    def refused(cls) -> Standing:
        return cls(may_decide=False)


class ApprovalService:
    def __init__(self, *, session: Session, audit: AuditRepository) -> None:
        self._session = session
        self._audit = audit

    # ------------------------------------------------------------------ opening

    def matrix(self, *, record_type: str) -> list[MatrixRule]:
        """The configured bands for a record type, as domain values."""
        rows = (
            self._session.execute(
                select(ApprovalRule)
                .where(ApprovalRule.record_type == record_type, ApprovalRule.is_active)
                .order_by(ApprovalRule.step_order)
            )
            .scalars()
            .all()
        )
        return [
            MatrixRule(
                level=row.level,
                step_order=row.step_order,
                min_amount_minor_units=row.min_amount_minor_units,
                max_amount_minor_units=row.max_amount_minor_units,
                currency=row.currency,
                department=row.department,
                is_parallel=row.is_parallel,
            )
            for row in rows
        ]

    def preview(
        self, *, record_type: str, amount: Money, department: str | None
    ) -> tuple[tuple[int, ApprovalLevel], ...]:
        """The route an amount would take, without opening one.

        Used by the estimate screen so a requester can see who will have to
        approve before they submit, and by tests, which is the same need.
        """
        planned = plan_route(
            self.matrix(record_type=record_type), amount=amount, department=department
        )
        return tuple((step.step_order, step.level) for step in planned)

    def open_route(
        self,
        *,
        record_type: str,
        record_id: UUID,
        amount: Money,
        department: str | None,
        requester_id: UUID,
        actor: Actor,
        correlation_id: UUID,
    ) -> ApprovalRequest:
        """Plan and open the route a record needs.

        Raises `RouteNotAvailableError` when the matrix cannot produce one, which
        the caller turns into a refusal to submit. There is deliberately no
        fallback: a record that nobody is configured to approve must not become a
        record that needs no approval.
        """
        if self.open_request(record_type=record_type, record_id=record_id) is not None:
            raise RouteNotAvailableError(
                "This record already has an approval route open. "
                "Withdraw it before opening another."
            )

        planned = plan_route(
            self.matrix(record_type=record_type), amount=amount, department=department
        )
        unstaffed = [
            step.level
            for step in planned
            if not self._assignees(level=step.level, department=department)
        ]
        if unstaffed:
            levels = ", ".join(sorted(LEVEL_LABELS[level] for level in unstaffed))
            raise RouteNotAvailableError(
                f"Nobody is assigned as {levels} for this record, so it cannot be "
                "approved. An administrator must assign an approver before this is submitted."
            )

        request = ApprovalRequest(
            record_type=record_type,
            record_id=record_id,
            attempt=self._next_attempt(record_type=record_type, record_id=record_id),
            state=RouteState.open,
            current_step_order=planned[0].step_order,
            amount_minor_units=amount.minor_units,
            currency=amount.currency,
            department=department,
            requester_id=requester_id,
        )
        self._session.add(request)
        self._session.flush()

        for step in planned:
            request.steps.append(
                ApprovalStep(
                    step_order=step.step_order,
                    level=step.level,
                    state=StepState.waiting,
                )
            )
        self._session.flush()

        self._audit.append(
            action=AuditAction.approval_requested,
            actor_type=ActorType.user,
            actor_id=actor.user_id,
            actor_label=actor.display_name,
            subject_type=record_type,
            subject_id=record_id,
            correlation_id=correlation_id,
            detail={
                "attempt": request.attempt,
                "amount": amount.format(),
                "department": department,
                "route": [{"step": step.step_order, "level": str(step.level)} for step in planned],
            },
        )
        logger.info(
            "approval.route_opened",
            record_type=record_type,
            record_id=str(record_id),
            attempt=request.attempt,
            steps=len(planned),
        )
        return request

    # ------------------------------------------------------------------ reading

    def open_request(self, *, record_type: str, record_id: UUID) -> ApprovalRequest | None:
        return self._session.execute(
            select(ApprovalRequest).where(
                ApprovalRequest.record_type == record_type,
                ApprovalRequest.record_id == record_id,
                ApprovalRequest.state == RouteState.open,
            )
        ).scalar_one_or_none()

    def history(self, *, record_type: str, record_id: UUID) -> list[ApprovalRequest]:
        """Every route this record has been through, oldest first."""
        return list(
            self._session.execute(
                select(ApprovalRequest)
                .where(
                    ApprovalRequest.record_type == record_type,
                    ApprovalRequest.record_id == record_id,
                )
                .order_by(ApprovalRequest.attempt)
            )
            .scalars()
            .all()
        )

    @staticmethod
    def progress(request: ApprovalRequest) -> tuple[StepProgress, ...]:
        """The route's steps with readiness computed, in order."""
        return with_states(
            tuple(
                StepProgress(step_order=step.step_order, level=step.level, state=step.state)
                for step in sorted(request.steps, key=lambda s: (s.step_order, s.level.value))
            )
        )

    def summary(self, request: ApprovalRequest) -> str:
        return summarise(self.progress(request))

    def awaiting(self, *, user: User, record_type: str | None = None) -> list[ApprovalRequest]:
        """Open routes whose current step this user can decide.

        Excludes anything they raised themselves. An approver's queue that shows
        work they are forbidden to action is a queue they learn to ignore.
        """
        levels = self.levels_held(user=user)
        if not levels:
            return []

        query = (
            select(ApprovalRequest)
            .join(ApprovalStep, ApprovalStep.request_id == ApprovalRequest.id)
            .where(
                ApprovalRequest.state == RouteState.open,
                ApprovalRequest.requester_id != user.id,
                ApprovalStep.step_order == ApprovalRequest.current_step_order,
                ApprovalStep.state.notin_([StepState.approved, StepState.rejected]),
                ApprovalStep.level.in_(sorted(levels, key=lambda level: level.value)),
            )
            .order_by(ApprovalRequest.opened_at)
            .distinct()
        )
        if record_type is not None:
            query = query.where(ApprovalRequest.record_type == record_type)

        candidates = list(self._session.execute(query).scalars().all())
        # The level test above is necessary but not sufficient: an assignment may
        # be scoped to a department, and whether it covers this route is a
        # per-route question. Confirmed here rather than in SQL because the
        # answer also has to carry who a delegate is standing in for.
        return [
            request
            for request in candidates
            if any(
                self.standing(request=request, level=step.level, user=user).may_decide
                for step in self.progress(request)
                if step.state is StepState.ready
            )
        ]

    # -------------------------------------------------------------- eligibility

    def levels_held(self, *, user: User) -> frozenset[ApprovalLevel]:
        """Every level this user can act at, directly or as a delegate."""
        direct = self._session.execute(
            select(ApprovalAssignment.level).where(
                ApprovalAssignment.user_id == user.id, ApprovalAssignment.is_active
            )
        ).scalars()

        delegated = self._session.execute(
            select(ApprovalAssignment.level)
            .join(User, User.id == ApprovalAssignment.user_id)
            .where(
                ApprovalAssignment.is_active,
                User.delegate_to_id == user.id,
                User.out_of_office_until.is_not(None),
                User.out_of_office_until > func.now(),
            )
        ).scalars()

        return frozenset({*direct, *delegated})

    def standing(self, *, request: ApprovalRequest, level: ApprovalLevel, user: User) -> Standing:
        """Whether this user may decide this level on this route.

        A direct assignment is checked first. Delegation is only consulted when
        there is none, so an approver who also happens to be someone's delegate
        acts under their own authority rather than appearing to stand in for a
        colleague.
        """
        assignees = self._assignees(level=level, department=request.department)
        if not assignees:
            return Standing.refused()

        if any(assignee.id == user.id for assignee in assignees):
            return Standing(may_decide=True)

        now = datetime.now(UTC)
        for assignee in assignees:
            if (
                assignee.delegate_to_id == user.id
                and assignee.out_of_office_until is not None
                and assignee.out_of_office_until > now
            ):
                return Standing(
                    may_decide=True,
                    on_behalf_of_id=assignee.id,
                    on_behalf_of_label=assignee.display_name,
                )

        return Standing.refused()

    def _assignees(self, *, level: ApprovalLevel, department: str | None) -> list[User]:
        """Users assigned at a level whose scope covers this department.

        An assignment with no department is organisation-wide. One naming a
        department applies only there.
        """
        scope: list[ColumnElement[bool]] = [ApprovalAssignment.department.is_(None)]
        if department is not None:
            scope.append(func.lower(ApprovalAssignment.department) == department.casefold())

        return list(
            self._session.execute(
                select(User)
                .join(ApprovalAssignment, ApprovalAssignment.user_id == User.id)
                .where(
                    ApprovalAssignment.level == level,
                    ApprovalAssignment.is_active,
                    User.is_active,
                    User.archived_at.is_(None),
                    or_(*scope),
                )
                .distinct()
            )
            .scalars()
            .all()
        )

    # ----------------------------------------------------------------- deciding

    def record_decision(
        self,
        *,
        request: ApprovalRequest,
        step_order: int,
        level: ApprovalLevel,
        outcome: ApprovalOutcome,
        user: User,
        comment: str | None,
        correlation_id: UUID,
    ) -> RouteState:
        """Apply one decision and report where the route now stands.

        Validation is the domain's, including the refusal to let a requester
        approve their own request. This method's job is to be the only place that
        writes a decision, so the denormalised open-step column and the audit
        entry cannot be forgotten.
        """
        standing = self.standing(request=request, level=level, user=user)
        validated = decide(
            steps=self.progress(request),
            step_order=step_order,
            level=level,
            outcome=outcome,
            actor_id=user.id,
            actor_label=user.display_name,
            requester_id=request.requester_id,
            actor_is_assigned=standing.may_decide,
            comment=comment,
            on_behalf_of_id=standing.on_behalf_of_id,
        )

        row = next(
            step for step in request.steps if step.step_order == step_order and step.level is level
        )
        row.state = (
            StepState.approved
            if validated.outcome is ApprovalOutcome.approved
            else StepState.rejected
        )
        row.decided_at = validated.decided_at
        row.decided_by_id = validated.actor_id
        row.decided_by_label = validated.actor_label
        row.comment = validated.comment
        row.on_behalf_of_id = validated.on_behalf_of_id
        self._session.flush()

        state = self._settle(request)

        self._audit.append(
            action=(
                AuditAction.approved
                if validated.outcome is ApprovalOutcome.approved
                else AuditAction.rejected
            ),
            actor_type=ActorType.user,
            actor_id=user.id,
            actor_label=user.display_name,
            subject_type=request.record_type,
            subject_id=request.record_id,
            correlation_id=correlation_id,
            detail={
                "attempt": request.attempt,
                "step": step_order,
                "level": str(level),
                "level_label": LEVEL_LABELS[level],
                "amount": Money(request.amount_minor_units, request.currency).format(),
                "comment": validated.comment,
                "on_behalf_of": standing.on_behalf_of_label,
                "route_state": str(state),
            },
        )
        logger.info(
            "approval.decided",
            record_type=request.record_type,
            record_id=str(request.record_id),
            level=str(level),
            outcome=str(validated.outcome),
            route_state=str(state),
        )
        return state

    def withdraw(
        self,
        *,
        request: ApprovalRequest,
        actor: Actor,
        reason: str,
        correlation_id: UUID,
    ) -> ApprovalRequest:
        """End an open route without a verdict.

        Every step nobody had decided is marked withdrawn; decisions already
        given are left exactly as they were. An approval that was genuinely given
        must remain visible even though the route it belonged to was abandoned,
        because "the Unit Head approved this and then the requester changed the
        amount" is precisely what an auditor is looking for.
        """
        for step in request.steps:
            if step.state not in {StepState.approved, StepState.rejected}:
                step.state = StepState.withdrawn
        self._session.flush()
        self._settle(request)

        self._audit.append(
            action=AuditAction.approval_withdrawn,
            actor_type=ActorType.user,
            actor_id=actor.user_id,
            actor_label=actor.display_name,
            subject_type=request.record_type,
            subject_id=request.record_id,
            correlation_id=correlation_id,
            detail={
                "attempt": request.attempt,
                "reason": reason,
                "approvals_already_given": [
                    {"level": str(step.level), "by": step.decided_by_label}
                    for step in request.steps
                    if step.state is StepState.approved
                ],
            },
        )
        return request

    # ---------------------------------------------------------------- internals

    def _settle(self, request: ApprovalRequest) -> RouteState:
        """Recompute the route's state and whose turn it is."""
        steps = self.progress(request)
        state = route_state(steps)
        request.state = state
        request.current_step_order = open_step_order(steps) if state is RouteState.open else None
        request.closed_at = None if state is RouteState.open else datetime.now(UTC)
        self._session.flush()
        return state

    def _next_attempt(self, *, record_type: str, record_id: UUID) -> int:
        highest = self._session.execute(
            select(func.max(ApprovalRequest.attempt)).where(
                ApprovalRequest.record_type == record_type,
                ApprovalRequest.record_id == record_id,
            )
        ).scalar()
        return (highest or 0) + 1
