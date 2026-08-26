"""When to chase somebody, and when to leave them alone.

The platform sends a reminder every three hours until a record moves. Stated that
plainly the rule is almost trivial, and implemented that plainly it is actively
harmful: three hours of wall-clock time sends the second reminder at two in the
morning, the third an hour later, and by Monday the recipient has eight emails
they slept through and a filter that deletes the ninth. A chaser that trained its
audience to ignore it has made the delay it was measuring worse.

So "three hours" here means three *working* hours, and the clock stops at the end
of the day, over the weekend, and on a public holiday. A reminder generated at
half past four in the afternoon is due at half past ten the next working morning,
which is both what a person means by "in three hours" and the only reading under
which a maximum of eight reminders describes something other than a single
overnight barrage.

Everything in this module is a pure function of a clock, a calendar and a policy.
Nothing here decides *whether* a record deserves chasing, only when the next
chase would fall due and whether now is a reasonable moment for it. That keeps the
awkward part, the arithmetic, testable without a database or a mail server.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from enum import StrEnum
from typing import Final
from zoneinfo import ZoneInfo

#: Weekday numbers as `datetime.weekday()` reports them, for readable policy.
MONDAY: Final[int] = 0
FRIDAY: Final[int] = 4
SATURDAY: Final[int] = 5

DEFAULT_BUSINESS_DAYS: Final[frozenset[int]] = frozenset(range(MONDAY, FRIDAY + 1))

#: Names accepted in configuration, which stores business days as text so the
#: setting is legible in an environment file.
WEEKDAY_NAMES: Final[dict[str, int]] = {
    "MON": 0,
    "TUE": 1,
    "WED": 2,
    "THU": 3,
    "FRI": 4,
    "SAT": 5,
    "SUN": 6,
}

#: A guard against a misconfiguration turning a search for the next working
#: moment into an unbounded loop. Two years of closure is not a working calendar,
#: it is a mistake, and the caller is told so rather than left hanging.
_MAX_LOOKAHEAD_DAYS: Final[int] = 730


class CalendarError(ValueError):
    """The configured calendar has no working time in it at all."""


class ReminderPurpose(StrEnum):
    """What a record is being chased for.

    Kept distinct because they run on the same clock but climb different ladders.
    A sign-off is chased towards the requester and then their management line; an
    approval is chased towards whoever the matrix put on the step.

    `payment_check_in` is the odd one and is marked as such wherever it is used:
    the party being chased is a supplier outside the organisation, so it climbs
    no ladder at all — there is nobody senior to them here to copy in — and it
    runs on a policy measured in days rather than working hours. Chasing a
    supplier about our own payment every three hours would be both rude and a
    reliable way to have the platform's mail classified as spam, after which the
    messages that matter go there too.
    """

    sign_off = "sign_off"
    approval = "approval"
    payment_check_in = "payment_check_in"


class Suppression(StrEnum):
    """Why a reminder that was otherwise due is not being sent.

    Recorded rather than inferred, so "we are not chasing this" is a statement
    with a reason attached. An unexplained silence is indistinguishable from a
    broken scheduler, and the difference matters at month end.
    """

    not_yet_due = "not_yet_due"
    outside_business_hours = "outside_business_hours"
    non_working_day = "non_working_day"
    maximum_reached = "maximum_reached"
    already_actioned = "already_actioned"
    globally_suppressed = "globally_suppressed"


SUPPRESSION_EXPLANATIONS: Final[dict[Suppression, str]] = {
    Suppression.not_yet_due: "The next reminder is not due yet.",
    Suppression.outside_business_hours: (
        "It is outside working hours. The reminder will go at the start of the next working period."
    ),
    Suppression.non_working_day: (
        "Today is not a working day. The reminder will go on the next one."
    ),
    Suppression.maximum_reached: (
        "This has been chased the maximum number of times. It needs a person to "
        "intervene rather than another email."
    ),
    Suppression.already_actioned: "The record has moved on and no longer needs chasing.",
    Suppression.globally_suppressed: "Reminder sending is switched off.",
}


@dataclass(frozen=True, slots=True)
class BusinessHours:
    """The working week, in one timezone.

    The timezone is part of the policy rather than ambient, because the whole
    point is to send at a civilised local hour and "local" is a property of the
    organisation, not of whichever server happens to run the scheduler.
    """

    timezone: str = "America/Jamaica"
    start_hour: int = 8
    end_hour: int = 17
    days: frozenset[int] = DEFAULT_BUSINESS_DAYS
    #: Dates the organisation is closed, over and above the weekly pattern.
    holidays: frozenset[date] = field(default_factory=frozenset)

    def __post_init__(self) -> None:
        if not 0 <= self.start_hour <= 23:
            raise CalendarError("The working day must start at an hour of the day.")
        if not 1 <= self.end_hour <= 24:
            raise CalendarError("The working day must end at an hour of the day.")
        if self.end_hour <= self.start_hour:
            raise CalendarError("The working day must end after it starts.")
        if not self.days:
            raise CalendarError("At least one day of the week must be a working day.")

    @property
    def zone(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)

    @property
    def hours_per_day(self) -> int:
        return self.end_hour - self.start_hour

    def is_working_day(self, day: date) -> bool:
        return day.weekday() in self.days and day not in self.holidays

    def is_open(self, moment: datetime) -> bool:
        """Whether the organisation is open at this instant."""
        local = self._local(moment)
        if not self.is_working_day(local.date()):
            return False
        return self.start_hour <= local.hour < self.end_hour

    def why_closed(self, moment: datetime) -> Suppression | None:
        """The reason the organisation is shut, or None when it is open."""
        local = self._local(moment)
        if not self.is_working_day(local.date()):
            return Suppression.non_working_day
        if not self.start_hour <= local.hour < self.end_hour:
            return Suppression.outside_business_hours
        return None

    def next_opening(self, moment: datetime) -> datetime:
        """The first working instant at or after `moment`.

        Returns `moment` itself when the organisation is already open, so this is
        safe to apply to a time that may or may not need moving.
        """
        local = self._local(moment)

        if self.is_working_day(local.date()) and local.hour < self.start_hour:
            return self._utc(self._at(local.date(), self.start_hour))
        if self.is_working_day(local.date()) and local.hour < self.end_hour:
            return moment.astimezone(UTC)

        return self._utc(self._at(self._next_working_day(local.date()), self.start_hour))

    def advance(self, moment: datetime, hours: int) -> datetime:
        """`hours` working hours after `moment`.

        Counted only while the organisation is open, so the interval survives a
        weekend without the recipient hearing anything over it. Fractions are not
        supported and are not wanted: a reminder policy measured in minutes is a
        different feature with different consent implications.
        """
        if hours < 0:
            raise ValueError("A reminder cannot fall due in the past.")

        cursor = self.next_opening(moment)
        remaining = timedelta(hours=hours)

        while remaining > timedelta():
            local = self._local(cursor)
            closes = self._at(local.date(), self.end_hour)
            left_today = closes - local

            if remaining < left_today:
                return self._utc(local + remaining)

            remaining -= left_today
            # Landing exactly on closing time is the end of today's allowance,
            # not the start of tomorrow's, so the next opening is found from the
            # following day rather than from the boundary itself.
            cursor = self._utc(self._at(self._next_working_day(local.date()), self.start_hour))

        return cursor

    def _next_working_day(self, day: date) -> date:
        for offset in range(1, _MAX_LOOKAHEAD_DAYS + 1):
            candidate = day + timedelta(days=offset)
            if self.is_working_day(candidate):
                return candidate
        raise CalendarError(
            "No working day was found within two years. The business calendar is "
            "misconfigured, so no reminder can be scheduled."
        )

    def _at(self, day: date, hour: int) -> datetime:
        return datetime.combine(day, time(hour=0), tzinfo=self.zone) + timedelta(hours=hour)

    def _local(self, moment: datetime) -> datetime:
        if moment.tzinfo is None:
            raise ValueError("A reminder clock needs an aware timestamp to work from.")
        return moment.astimezone(self.zone)

    @staticmethod
    def _utc(moment: datetime) -> datetime:
        return moment.astimezone(UTC)


@dataclass(frozen=True, slots=True)
class ReminderPolicy:
    """How persistently to chase, and when to involve somebody senior."""

    interval_hours: int = 3
    max_reminders: int = 8
    #: Reminders at the current level before the next person up is copied in.
    #: Escalation adds a recipient rather than replacing one: the original
    #: recipient still has the task, and quietly redirecting it would leave them
    #: believing it was handled.
    escalate_every: int = 3
    max_escalation_level: int = 3
    #: Whether a due reminder may go out while the organisation is shut. Off, and
    #: configurable rather than absolute, because a finance function that genuinely
    #: works a night shift should be able to say so. The interval is still counted
    #: in working hours either way: this governs whether a reminder that came due
    #: at four waits until morning, not how the four o'clock was arrived at.
    send_outside_business_hours: bool = False

    def __post_init__(self) -> None:
        if self.interval_hours < 1:
            raise ValueError("The reminder interval must be at least one working hour.")
        if self.max_reminders < 0:
            raise ValueError("The reminder maximum cannot be negative.")
        if self.escalate_every < 1:
            raise ValueError("Escalation must take at least one reminder.")

    def escalation_level_after(self, sent: int) -> int:
        """How far up the ladder a record sits once `sent` reminders have gone."""
        return min(sent // self.escalate_every, self.max_escalation_level)

    def is_exhausted(self, sent: int) -> bool:
        return sent >= self.max_reminders


@dataclass(frozen=True, slots=True)
class Decision:
    """Whether to send now, and what the schedule looks like either way."""

    send: bool
    #: When the next reminder falls due, whether or not one is going now.
    next_due_at: datetime | None
    suppression: Suppression | None = None
    escalation_level: int = 0

    @property
    def explanation(self) -> str | None:
        return SUPPRESSION_EXPLANATIONS[self.suppression] if self.suppression else None


def first_due(
    *,
    since: datetime,
    hours: BusinessHours,
    policy: ReminderPolicy,
) -> datetime:
    """When the first reminder for a record that started waiting at `since` falls due."""
    return hours.advance(since, policy.interval_hours)


def decide(
    *,
    now: datetime,
    due_at: datetime | None,
    sent: int,
    hours: BusinessHours,
    policy: ReminderPolicy,
    still_waiting: bool = True,
    globally_suppressed: bool = False,
) -> Decision:
    """Whether to send a reminder at this moment.

    The order of the checks is the order in which the reasons matter. A record
    that has been actioned is not chased even if a reminder is overdue; a policy
    that has run out is not restarted by the working day beginning; and a due
    reminder still waits for a civilised hour.
    """
    if not still_waiting:
        return Decision(send=False, next_due_at=None, suppression=Suppression.already_actioned)

    if globally_suppressed:
        return Decision(
            send=False,
            next_due_at=due_at,
            suppression=Suppression.globally_suppressed,
            escalation_level=policy.escalation_level_after(sent),
        )

    if policy.is_exhausted(sent):
        return Decision(
            send=False,
            next_due_at=None,
            suppression=Suppression.maximum_reached,
            escalation_level=policy.escalation_level_after(sent),
        )

    if due_at is None or now < due_at:
        return Decision(
            send=False,
            next_due_at=due_at,
            suppression=Suppression.not_yet_due,
            escalation_level=policy.escalation_level_after(sent),
        )

    closed = None if policy.send_outside_business_hours else hours.why_closed(now)
    if closed is not None:
        # Deliberately not rescheduled to the next opening here. Moving the due
        # time on every overnight poll would let a reminder that came due at five
        # to five drift later each evening until it was never quite due at all.
        return Decision(
            send=False,
            next_due_at=hours.next_opening(now),
            suppression=closed,
            escalation_level=policy.escalation_level_after(sent),
        )

    after = sent + 1
    # Counted from now rather than from when this one fell due, so a late poll
    # pushes the next reminder out by the lag instead of clawing it back. The
    # alternative catches up: a scheduler that was down for a day would find
    # several reminders due at once and send them in a burst, which is the exact
    # barrage the working-hours arithmetic above exists to prevent. Three hours
    # from the mail actually going out is also what the recipient experiences.
    return Decision(
        send=True,
        next_due_at=(
            None if policy.is_exhausted(after) else hours.advance(now, policy.interval_hours)
        ),
        escalation_level=policy.escalation_level_after(after),
    )


def parse_business_days(value: str) -> frozenset[int]:
    """Read `MON,TUE,WED` from configuration into weekday numbers.

    An unrecognised name is refused rather than skipped. Silently dropping it
    would shorten the working week, which shows up as reminders arriving at
    unexpected times long after anyone would connect the two.
    """
    days: set[int] = set()
    for raw in value.split(","):
        name = raw.strip().upper()[:3]
        if not name:
            continue
        if name not in WEEKDAY_NAMES:
            raise CalendarError(
                f"{raw.strip()!r} is not a day of the week. Use three-letter names "
                "such as MON,TUE,WED,THU,FRI."
            )
        days.add(WEEKDAY_NAMES[name])
    if not days:
        raise CalendarError("At least one day of the week must be a working day.")
    return frozenset(days)
