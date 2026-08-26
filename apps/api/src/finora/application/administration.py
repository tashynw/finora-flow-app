"""Editing the rules that decide who approves what.

Everything here writes to configuration that the payment path reads, which makes
it the highest-leverage screen in the platform: one careless edit changes who is
required to look at every future payment, and nothing about the record it changes
looks any different afterwards. Three principles follow from that.

*Rules are superseded, never edited.* A live rule is the reason somebody's
approval was demanded. Changing its band in place rewrites the explanation for
approvals already given, and an audit trail that cannot say what the rule said at
the time is not an audit trail. So a change retires the old row, writes a new one
pointing back at it, and route history stays legible for as long as the rows do.

*A change is checked against what it would do, not against what it looks like.*
`domain.matrix` runs the real planner across the whole proposed matrix before
anything is written. A rule that is individually reasonable and collectively
incoherent — two levels quietly sharing a step order, so two sequential approvals
become one — is refused here rather than discovered by the first person to submit
a large amount.

*Incoherent is refused; incomplete is reported and saved.* A matrix is incomplete
from the first rule until the last, so refusing gaps would make it impossible to
build one. Gaps come back with the response and belong on the screen.

Assignments and delegation are in this module rather than a user-administration
one because they are the other two ways the approval route can be silently
broken: a level nobody holds, and cover that never takes effect. All three are
one person's problem on one screen.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

import structlog
from sqlalchemy import select
from sqlalchemy.orm import Session

from finora.application.approvals import ApprovalService
from finora.domain.approvals import LEVEL_LABELS, MatrixRule
from finora.domain.audit import ActorType, AuditAction
from finora.domain.delegation import (
    Cover,
    DelegationProblem,
)
from finora.domain.delegation import (
    problems as delegation_problems,
)
from finora.domain.matrix import (
    MatrixAudit,
    RuleDraft,
    RuleProblem,
    audit_matrix,
    check_rule,
)
from finora.domain.money import Money
from finora.domain.roles import ApprovalLevel, Permission, assert_can_act, permissions_for
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import (
    ApprovalAssignment,
    ApprovalRule,
    User,
)

logger = structlog.get_logger(__name__)

#: What the audit trail calls these records. Not a database table name: an
#: auditor searching for changes to the approval matrix should not have to know
#: which table they landed in.
MATRIX_SUBJECT = "approval_matrix"
ASSIGNMENT_SUBJECT = "approval_assignment"
DELEGATION_SUBJECT = "approval_delegation"


class AdministrationError(Exception):
    """A configuration change that cannot be made."""


class RuleRejectedError(AdministrationError):
    """One proposed rule is wrong on its own terms."""

    def __init__(self, problems: tuple[RuleProblem, ...]) -> None:
        super().__init__("This rule cannot be saved as written.")
        self.problems = problems


class MatrixIncoherentError(AdministrationError):
    """The rule is fine; the matrix it would produce is not."""

    def __init__(self, verdict: MatrixAudit) -> None:
        super().__init__("Saving this would leave the approval matrix contradicting itself.")
        self.verdict = verdict


class DelegationRejectedError(AdministrationError):
    """Cover that would not take effect."""

    def __init__(self, problems: tuple[DelegationProblem, ...]) -> None:
        super().__init__("This cover would not take effect.")
        self.problems = problems


@dataclass(frozen=True, slots=True)
class Assignment:
    """Who holds an approval level, and where."""

    id: UUID
    level: ApprovalLevel
    level_label: str
    user_id: UUID
    user_name: str
    user_email: str
    department: str | None
    is_active: bool
    #: Whether this person is currently away with cover arranged, which is the
    #: difference between a staffed level and a staffed level that answers.
    is_covered_by_id: UUID | None
    is_covered_by_name: str | None


class AdministrationService:
    def __init__(
        self,
        *,
        session: Session,
        approvals: ApprovalService,
        audit: AuditRepository,
    ) -> None:
        self._session = session
        self._approvals = approvals
        self._audit = audit

    # ---------------------------------------------------------------- the matrix

    def rules(self, *, record_type: str, include_retired: bool = False) -> list[ApprovalRule]:
        """Rules for a record type, live first, then the retired ones by age.

        Retired rules are offered because they are the explanation for approvals
        already recorded. A screen that hides them makes last quarter's route
        look like a mistake.
        """
        query = select(ApprovalRule).where(ApprovalRule.record_type == record_type)
        if not include_retired:
            query = query.where(ApprovalRule.is_active)

        rows = list(
            self._session.execute(
                query.order_by(
                    ApprovalRule.is_active.desc(),
                    ApprovalRule.step_order,
                    ApprovalRule.min_amount_minor_units,
                )
            )
            .scalars()
            .all()
        )
        return rows

    def audit_of(self, *, record_type: str) -> MatrixAudit:
        """What the live matrix for a record type actually does."""
        return audit_matrix(
            tuple(self._approvals.matrix(record_type=record_type)),
            staffed_levels=self.staffed_levels(),
        )

    def staffed_levels(self) -> frozenset[ApprovalLevel]:
        """Levels somebody active currently holds.

        An assignment to a closed account is not staffing: the row exists, and
        nothing routed there will ever be answered.
        """
        rows = self._session.execute(
            select(ApprovalAssignment.level)
            .join(User, User.id == ApprovalAssignment.user_id)
            .where(ApprovalAssignment.is_active, User.is_active)
            .distinct()
        ).scalars()
        return frozenset(rows)

    def add_rule(
        self,
        draft: RuleDraft,
        *,
        actor: User,
        reason: str,
        correlation_id: UUID,
        supersedes: ApprovalRule | None = None,
    ) -> ApprovalRule:
        """Write a new rule, optionally retiring the one it replaces.

        Checked twice, and the two checks answer different questions. `check_rule`
        asks whether the rule makes sense by itself and does not collide with a
        live one. `audit_matrix` asks what the matrix would then do at every
        amount where the answer could change — which is the only question anybody
        actually cares about, and not one the rule can answer alone.
        """
        assert_can_act(roles=actor.roles, permission=Permission.admin_approval_matrix)

        if not reason.strip():
            raise AdministrationError(
                "Say why the approval matrix is changing. It is the only record of "
                "the decision; the rows themselves only show what it became."
            )

        # A rule replacing another does not clash with it: the old one is on its
        # way out in the same transaction.
        against = tuple(
            as_matrix_rule(row)
            for row in self.rules(record_type=draft.record_type)
            if supersedes is None or row.id != supersedes.id
        )

        faults = check_rule(draft, against=against)
        if faults:
            raise RuleRejectedError(faults)

        proposed = (*against, draft.as_rule())
        verdict = audit_matrix(proposed, staffed_levels=self.staffed_levels())
        if not verdict.is_coherent:
            raise MatrixIncoherentError(verdict)

        if supersedes is not None:
            self._retire(supersedes, actor=actor)

        row = ApprovalRule(
            name=draft.name.strip(),
            record_type=draft.record_type,
            level=draft.level,
            step_order=draft.step_order,
            min_amount_minor_units=draft.min_amount_minor_units,
            max_amount_minor_units=draft.max_amount_minor_units,
            currency=draft.currency.upper(),
            department=draft.department,
            is_parallel=draft.is_parallel,
            is_active=True,
            created_by_id=actor.id,
            supersedes_id=supersedes.id if supersedes is not None else None,
        )
        self._session.add(row)
        self._session.flush()

        self._audit.append(
            action=AuditAction.record_created,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=MATRIX_SUBJECT,
            subject_id=row.id,
            correlation_id=correlation_id,
            detail={
                "record_type": draft.record_type,
                "rule": _describe(row),
                "supersedes": _describe(supersedes) if supersedes is not None else None,
                "reason": reason.strip(),
                "gaps": [message for _, message in verdict.gaps],
            },
        )
        logger.info(
            "matrix.rule_added",
            record_type=draft.record_type,
            level=draft.level.value,
            superseded=str(supersedes.id) if supersedes is not None else None,
        )
        return row

    def retire_rule(
        self,
        rule: ApprovalRule,
        *,
        actor: User,
        reason: str,
        correlation_id: UUID,
    ) -> ApprovalRule:
        """Take a rule out of use without deleting the record of it.

        The gap this leaves is reported, not refused. Removing the last rule of a
        band is sometimes exactly the intent, and a screen that will not let you
        remove anything until the replacement exists cannot be used to fix a
        mistake.
        """
        assert_can_act(roles=actor.roles, permission=Permission.admin_approval_matrix)

        if not rule.is_active:
            raise AdministrationError("That rule is already retired.")
        if not reason.strip():
            raise AdministrationError("Say why this rule is being retired.")

        self._retire(rule, actor=actor)
        self._session.flush()

        verdict = self.audit_of(record_type=rule.record_type)
        self._audit.append(
            action=AuditAction.record_updated,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=MATRIX_SUBJECT,
            subject_id=rule.id,
            correlation_id=correlation_id,
            detail={
                "record_type": rule.record_type,
                "retired": _describe(rule),
                "reason": reason.strip(),
                "gaps": [message for _, message in verdict.gaps],
            },
        )
        return rule

    def preview(
        self, *, record_type: str, amount: Money, department: str | None
    ) -> tuple[tuple[int, ApprovalLevel], ...]:
        """What a given amount would do under the live matrix.

        A thin pass-through, deliberately: the preview an administrator sees must
        come from the same code path as the route a submission opens, or it is
        reassurance about something else.
        """
        return self._approvals.preview(
            record_type=record_type, amount=amount, department=department
        )

    # ----------------------------------------------------------- who holds a level

    def assignments(self, *, level: ApprovalLevel | None = None) -> list[Assignment]:
        rows = self._session.execute(
            select(ApprovalAssignment, User)
            .join(User, User.id == ApprovalAssignment.user_id)
            .where(*([ApprovalAssignment.level == level] if level is not None else []))
            .order_by(ApprovalAssignment.level, User.display_name)
        ).all()

        now = datetime.now(UTC)
        return [self._assignment_out(row, holder, now=now) for row, holder in rows]

    def assign(
        self,
        *,
        user: User,
        level: ApprovalLevel,
        department: str | None,
        actor: User,
        correlation_id: UUID,
    ) -> ApprovalAssignment:
        """Put somebody at an approval level.

        Refused for an account that cannot record approvals. The assignment would
        be honoured by route planning and refused by the permission check, which
        presents to everybody else as an approval queue that has stopped moving
        for no visible reason.
        """
        assert_can_act(roles=actor.roles, permission=Permission.admin_approval_matrix)

        if not user.is_active:
            raise AdministrationError(
                f"{user.display_name}'s account is closed, so anything routed to "
                "them would wait indefinitely."
            )
        if not _may_decide(user):
            raise AdministrationError(
                f"{user.display_name} cannot record approvals. Give them the "
                "approver role first, or the level will look staffed and answer nothing."
            )

        existing = self._session.execute(
            select(ApprovalAssignment).where(
                ApprovalAssignment.level == level,
                ApprovalAssignment.user_id == user.id,
                ApprovalAssignment.department.is_(department)
                if department is None
                else ApprovalAssignment.department == department,
            )
        ).scalar_one_or_none()

        if existing is not None:
            if existing.is_active:
                raise AdministrationError(
                    f"{user.display_name} already holds {LEVEL_LABELS[level]} here."
                )
            existing.is_active = True
            row = existing
        else:
            row = ApprovalAssignment(
                level=level, user_id=user.id, department=department, is_active=True
            )
            self._session.add(row)

        self._session.flush()

        self._audit.append(
            action=AuditAction.record_created,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=ASSIGNMENT_SUBJECT,
            subject_id=row.id,
            correlation_id=correlation_id,
            detail={
                "level": level.value,
                "user": user.display_name,
                "user_id": str(user.id),
                "department": department,
            },
        )
        return row

    def unassign(
        self,
        assignment: ApprovalAssignment,
        *,
        actor: User,
        correlation_id: UUID,
    ) -> ApprovalAssignment:
        """Take somebody off a level.

        Deactivated rather than deleted, because the row is part of the
        explanation for approvals they gave while they held it.
        """
        assert_can_act(roles=actor.roles, permission=Permission.admin_approval_matrix)

        if not assignment.is_active:
            raise AdministrationError("That assignment has already been removed.")

        assignment.is_active = False
        self._session.flush()

        holder = self._session.get(User, assignment.user_id)
        self._audit.append(
            action=AuditAction.record_updated,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=ASSIGNMENT_SUBJECT,
            subject_id=assignment.id,
            correlation_id=correlation_id,
            detail={
                "level": assignment.level.value,
                "user": holder.display_name if holder is not None else str(assignment.user_id),
                "department": assignment.department,
                "removed": True,
            },
        )
        return assignment

    # ------------------------------------------------------------------ delegation

    def set_cover(
        self,
        *,
        approver: User,
        delegate: User | None,
        until: datetime | None,
        actor: User,
        correlation_id: UUID,
    ) -> User:
        """Arrange, change or clear somebody's cover while they are away.

        An approver may arrange their own; an administrator may arrange anybody's,
        which is what happens when somebody is already away and did not set it up.
        Both are recorded with who did it, because "the approver arranged this"
        and "somebody else arranged it on their behalf" are different facts about
        a decision made under that cover.
        """
        if approver.id != actor.id:
            assert_can_act(roles=actor.roles, permission=Permission.admin_approval_matrix)
        else:
            assert_can_act(roles=actor.roles, permission=Permission.approval_delegate)

        cover = Cover(
            delegate=delegate,
            until=until,
            delegate_may_decide=delegate is not None and _may_decide(delegate),
        )
        faults = delegation_problems(cover, by=approver, now=datetime.now(UTC))
        if faults:
            raise DelegationRejectedError(faults)

        was = (approver.delegate_to_id, approver.out_of_office_until)
        approver.delegate_to_id = delegate.id if delegate is not None else None
        approver.out_of_office_until = until
        self._session.flush()

        self._audit.append(
            action=AuditAction.record_updated,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=DELEGATION_SUBJECT,
            subject_id=approver.id,
            correlation_id=correlation_id,
            detail={
                "approver": approver.display_name,
                "delegate": delegate.display_name if delegate is not None else None,
                "until": until.isoformat() if until is not None else None,
                "was_delegated_to": str(was[0]) if was[0] is not None else None,
                "was_until": was[1].isoformat() if was[1] is not None else None,
                "arranged_by_administrator": approver.id != actor.id,
            },
        )
        logger.info(
            "delegation.set",
            approver=str(approver.id),
            delegate=str(delegate.id) if delegate is not None else None,
        )
        return approver

    # ------------------------------------------------------------------- internals

    def _retire(self, rule: ApprovalRule, *, actor: User) -> None:
        rule.is_active = False
        rule.retired_at = datetime.now(UTC)
        rule.retired_by_id = actor.id

    def _assignment_out(
        self, assignment: ApprovalAssignment, holder: User, *, now: datetime
    ) -> Assignment:
        covering: User | None = None
        away = holder.out_of_office_until is not None and holder.out_of_office_until > now
        if away and holder.delegate_to_id is not None:
            covering = self._session.get(User, holder.delegate_to_id)

        return Assignment(
            id=assignment.id,
            level=assignment.level,
            level_label=LEVEL_LABELS[assignment.level],
            user_id=holder.id,
            user_name=holder.display_name,
            user_email=holder.email,
            department=assignment.department,
            is_active=assignment.is_active and holder.is_active,
            is_covered_by_id=covering.id if covering is not None else None,
            is_covered_by_name=covering.display_name if covering is not None else None,
        )


def as_matrix_rule(row: ApprovalRule) -> MatrixRule:
    """A stored rule as the planner sees it."""
    return MatrixRule(
        level=row.level,
        step_order=row.step_order,
        min_amount_minor_units=row.min_amount_minor_units,
        max_amount_minor_units=row.max_amount_minor_units,
        currency=row.currency,
        department=row.department,
        is_parallel=row.is_parallel,
    )


def _may_decide(user: User) -> bool:
    return Permission.approval_decide in permissions_for(user.roles)


def _describe(rule: ApprovalRule) -> dict[str, object]:
    """A rule in the audit trail, readable without the schema beside it."""
    ceiling = rule.max_amount_minor_units
    return {
        "id": str(rule.id),
        "name": rule.name,
        "level": rule.level.value,
        "step_order": rule.step_order,
        "band": (
            f"{Money(rule.min_amount_minor_units, rule.currency).format()} and above"
            if ceiling is None
            else f"{Money(rule.min_amount_minor_units, rule.currency).format()} to "
            f"{Money(ceiling, rule.currency).format()}"
        ),
        "department": rule.department,
        "is_parallel": rule.is_parallel,
    }
