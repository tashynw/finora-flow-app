"""Chasing records that are waiting on somebody.

The arithmetic lives in `domain.reminders`, which knows nothing about databases.
This module is the part that has to be careful with the outside world: it finds
what is due, works out who to chase and who to involve, writes the mail into the
outbox, and moves the cursor forward.

One structural rule runs through it. **A cycle is stopped by the thing that
resolved it, not by the scheduler noticing.** When an invoice is signed off, the
sign-off stops the cycle in the same transaction. The scheduler's own
`still_waiting` check is a second line of defence for the case where something
resolved a record without telling us, not the primary mechanism — because between
a resolution and the next poll there is a window, and a reminder sent inside it
chases somebody about work they have already done.

Escalation adds a recipient rather than replacing one. The person originally asked
still holds the task, and quietly redirecting it would leave them believing it was
handled while the new recipient assumes the original owner is on it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from uuid import UUID

import structlog
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from finora.domain.audit import ActorType, AuditAction
from finora.domain.notifications import MessageKind
from finora.domain.reminders import (
    BusinessHours,
    ReminderPolicy,
    ReminderPurpose,
    Suppression,
    decide,
    first_due,
    parse_business_days,
)
from finora.domain.roles import ApprovalLevel
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import (
    ApprovalAssignment,
    BusinessCalendarDay,
    ReminderSchedule,
    User,
)

logger = structlog.get_logger(__name__)

#: The ladder escalation climbs. Level 0 is the original recipient alone; each
#: subsequent level copies in the next tier. Ordered deliberately: the immediate
#: supervisor first, the Chief Operating Officer last, because an escalation that
#: reaches the top on its first step has nowhere left to go and teaches everyone
#: below it that the ladder is decorative.
ESCALATION_LADDER: tuple[ApprovalLevel, ...] = (
    ApprovalLevel.unit_head,
    ApprovalLevel.manager,
    ApprovalLevel.hod,
    ApprovalLevel.coo,
)


@dataclass(frozen=True, slots=True)
class Recipients:
    """Who a reminder goes to at a given escalation level."""

    to: User
    cc: tuple[User, ...] = ()

    @property
    def cc_addresses(self) -> list[str]:
        return [user.email for user in self.cc]


@dataclass(frozen=True, slots=True)
class SweepResult:
    considered: int
    sent: int
    suppressed: int
    stopped: int

    @property
    def had_work(self) -> bool:
        return self.considered > 0


@dataclass(frozen=True, slots=True)
class MessageDraft:
    """What to say. Supplied by the caller that owns the record type.

    The reminder machinery deliberately does not know what an invoice is. It asks
    for a subject and a body and posts them, which keeps every record type that
    needs chasing from having to be enumerated here.
    """

    subject: str
    body_text: str
    kind: MessageKind


class ReminderService:
    def __init__(
        self,
        *,
        session: Session,
        audit: AuditRepository,
        hours: BusinessHours,
        policy: ReminderPolicy,
        globally_suppressed: bool = False,
    ) -> None:
        self._session = session
        self._audit = audit
        self._hours = hours
        self._policy = policy
        self._globally_suppressed = globally_suppressed

    # ------------------------------------------------------------------ lifecycle

    def start(
        self,
        *,
        record_type: str,
        record_id: UUID,
        purpose: ReminderPurpose,
        recipient: User,
        correlation_id: UUID | None = None,
        since: datetime | None = None,
    ) -> ReminderSchedule | None:
        """Begin chasing a record, or return None because it already is being.

        Idempotent, and enforced by a partial unique index rather than by this
        check alone. Two live cycles on one record would double every reminder,
        which is precisely the behaviour that trains people to filter them.
        """
        existing = self._live(record_type=record_type, record_id=record_id, purpose=purpose)
        if existing is not None:
            return None

        started = since or datetime.now(UTC)
        schedule = ReminderSchedule(
            record_type=record_type,
            record_id=record_id,
            purpose=purpose,
            recipient_id=recipient.id,
            started_at=started,
            next_due_at=first_due(since=started, hours=self._hours, policy=self._policy),
            sent_count=0,
            escalation_level=0,
        )

        try:
            with self._session.begin_nested():
                self._session.add(schedule)
                self._session.flush()
        except IntegrityError:
            # Lost a race with another transaction. The other one's cycle is as
            # good as this one would have been.
            logger.debug("reminder.already_started", record_id=str(record_id), purpose=str(purpose))
            return None

        return schedule

    def stop(
        self,
        *,
        record_type: str,
        record_id: UUID,
        purpose: ReminderPurpose,
        reason: str,
    ) -> bool:
        """Stop chasing, recording why.

        The row is kept and stamped rather than deleted. "We stopped chasing this
        on Tuesday because it was signed off" is an answer somebody will want, and
        a deleted row cannot give it.
        """
        schedule = self._live(record_type=record_type, record_id=record_id, purpose=purpose)
        if schedule is None:
            return False

        schedule.stopped_at = datetime.now(UTC)
        schedule.stopped_reason = reason[:200]
        # The check constraint requires this: a stopped cycle has nothing due.
        schedule.next_due_at = None
        self._session.flush()
        return True

    # -------------------------------------------------------------------- sweeping

    def due(self, *, now: datetime | None = None, limit: int = 50) -> list[ReminderSchedule]:
        """Live cycles whose next reminder has come round.

        Ordered by how overdue they are, so a backlog after an outage is worked
        off oldest first rather than in whatever order the index returns.
        """
        moment = now or datetime.now(UTC)
        return list(
            self._session.execute(
                select(ReminderSchedule)
                .where(
                    ReminderSchedule.stopped_at.is_(None),
                    ReminderSchedule.next_due_at.is_not(None),
                    ReminderSchedule.next_due_at <= moment,
                )
                .order_by(ReminderSchedule.next_due_at)
                .limit(limit)
            )
            .scalars()
            .all()
        )

    def consider(
        self,
        schedule: ReminderSchedule,
        *,
        now: datetime | None = None,
        still_waiting: bool = True,
    ) -> Suppression | Recipients:
        """Decide whether to chase this one now, and whom.

        Returns the recipients when a reminder should go, or the reason it should
        not. The caller composes the message, because only it knows what the
        record is.
        """
        moment = now or datetime.now(UTC)
        decision = decide(
            now=moment,
            due_at=schedule.next_due_at,
            sent=schedule.sent_count,
            hours=self._hours,
            policy=self._policy,
            still_waiting=still_waiting,
            globally_suppressed=self._globally_suppressed,
        )

        if decision.suppression is not None or not decision.send:
            self._apply_suppression(schedule, decision.next_due_at, decision.suppression)
            # A refusal always carries a reason. `already_actioned` stands in for
            # the theoretically impossible case of a refusal without one, rather
            # than an assertion that would take the worker down in production.
            return decision.suppression or Suppression.already_actioned

        recipient = (
            self._session.get(User, schedule.recipient_id)
            if schedule.recipient_id is not None
            else None
        )
        if recipient is None or not recipient.is_active:
            # Chasing a departed or deactivated account sends mail into a void and
            # leaves the record looking attended to. Stopping is visible; an
            # unanswered reminder cycle is not.
            self.stop(
                record_type=schedule.record_type,
                record_id=schedule.record_id,
                purpose=schedule.purpose,
                reason="The person being chased no longer has an active account.",
            )
            return Suppression.already_actioned

        return self._recipients_for(schedule, recipient=recipient, level=decision.escalation_level)

    def record_sent(
        self,
        schedule: ReminderSchedule,
        *,
        recipients: Recipients,
        escalated: bool,
        now: datetime | None = None,
        correlation_id: UUID | None = None,
    ) -> None:
        """Move the cursor on after a reminder has been queued.

        Called after the message is in the outbox and in the same transaction, so
        a committed reminder and an advanced cursor are one atomic fact. Advancing
        first would risk skipping a reminder; queueing first without advancing
        would risk sending it repeatedly.
        """
        moment = now or datetime.now(UTC)
        after = schedule.sent_count + 1

        schedule.sent_count = after
        schedule.last_sent_at = moment
        schedule.escalation_level = self._policy.escalation_level_after(after)
        schedule.next_due_at = (
            None
            if self._policy.is_exhausted(after)
            else self._hours.advance(moment, self._policy.interval_hours)
        )
        self._session.flush()

        self._audit.append(
            action=AuditAction.escalated if escalated else AuditAction.reminder_sent,
            actor_type=ActorType.scheduler,
            actor_id=None,
            actor_label="reminder scheduler",
            subject_type=schedule.record_type,
            subject_id=schedule.record_id,
            correlation_id=correlation_id,
            detail={
                "purpose": str(schedule.purpose),
                "reminder_number": after,
                "escalation_level": schedule.escalation_level,
                "to": recipients.to.email,
                "cc": recipients.cc_addresses,
                "next_due_at": (schedule.next_due_at.isoformat() if schedule.next_due_at else None),
            },
        )

    def _apply_suppression(
        self,
        schedule: ReminderSchedule,
        next_due_at: datetime | None,
        suppression: Suppression | None,
    ) -> None:
        """Persist what the decision said about scheduling.

        A closed office moves the due time to the next opening; anything else
        leaves it alone. The distinction matters: rewriting the due time on every
        poll would let a reminder that came due at five to five drift an hour later
        each evening until it was never quite due at all.
        """
        if suppression is Suppression.maximum_reached:
            schedule.next_due_at = None
            self._session.flush()
            return

        if suppression in {Suppression.outside_business_hours, Suppression.non_working_day}:
            if next_due_at is not None and next_due_at != schedule.next_due_at:
                schedule.next_due_at = next_due_at
                self._session.flush()

    def _recipients_for(
        self,
        schedule: ReminderSchedule,
        *,
        recipient: User,
        level: int,
    ) -> Recipients:
        """The original recipient, plus whoever the escalation level brings in."""
        if level <= 0:
            return Recipients(to=recipient)

        department = recipient.department
        seen: set[UUID] = {recipient.id}
        cc: list[User] = []

        for tier in ESCALATION_LADDER[:level]:
            for senior in self._assignees(tier, department=department):
                if senior.id in seen:
                    continue
                seen.add(senior.id)
                cc.append(senior)

        if not cc:
            # Nobody is configured above this person. The reminder still goes to
            # them; an escalation with no destination must not become a reminder
            # with no destination.
            logger.warning(
                "reminder.escalation_has_nobody",
                record_id=str(schedule.record_id),
                purpose=str(schedule.purpose),
                level=level,
                department=department,
            )

        return Recipients(to=recipient, cc=tuple(cc))

    def _assignees(self, level: ApprovalLevel, *, department: str | None) -> list[User]:
        """Active users holding an approval level, department first.

        A department-specific assignment wins outright when one exists. Falling
        back to the organisation-wide holders only when it does not keeps an
        escalation inside the recipient's own management line rather than copying
        in the head of an unrelated function.
        """
        for scope in ([department] if department else []) + [None]:
            rows = list(
                self._session.execute(
                    select(User)
                    .join(ApprovalAssignment, ApprovalAssignment.user_id == User.id)
                    .where(
                        ApprovalAssignment.level == level,
                        ApprovalAssignment.department == scope
                        if scope is not None
                        else ApprovalAssignment.department.is_(None),
                        ApprovalAssignment.is_active,
                        User.is_active,
                        User.archived_at.is_(None),
                    )
                    .order_by(User.display_name)
                )
                .scalars()
                .all()
            )
            if rows:
                return rows
        return []

    def _live(
        self, *, record_type: str, record_id: UUID, purpose: ReminderPurpose
    ) -> ReminderSchedule | None:
        return self._session.execute(
            select(ReminderSchedule).where(
                ReminderSchedule.record_type == record_type,
                ReminderSchedule.record_id == record_id,
                ReminderSchedule.purpose == purpose,
                ReminderSchedule.stopped_at.is_(None),
            )
        ).scalar_one_or_none()


#: How far back the holiday calendar is read. A cycle's first due time is computed
#: from when the record started waiting, which may be a little while ago, so the
#: window has to cover more than today; it does not have to cover a decade of past
#: public holidays that can no longer affect any answer.
HOLIDAY_LOOKBACK = timedelta(days=120)


def load_business_hours(
    session: Session,
    *,
    timezone: str,
    start_hour: int,
    end_hour: int,
    days: str,
    from_date: date | None = None,
) -> BusinessHours:
    """Build the working calendar, including the configured closures."""
    today = from_date or datetime.now(UTC).date()
    since = today - HOLIDAY_LOOKBACK
    closures = frozenset(
        session.execute(
            select(BusinessCalendarDay.calendar_date).where(
                BusinessCalendarDay.is_working_day.is_(False),
                BusinessCalendarDay.calendar_date >= since,
            )
        )
        .scalars()
        .all()
    )
    return BusinessHours(
        timezone=timezone,
        start_hour=start_hour,
        end_hour=end_hour,
        days=parse_business_days(days),
        holidays=closures,
    )
