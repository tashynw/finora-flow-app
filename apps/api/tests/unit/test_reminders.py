"""A chaser nobody reads has made the delay it was measuring worse.

Almost every test here is the same assertion in a different disguise: that
"three hours" is counted the way a person counts it, so the clock stops at
close of business, over the weekend and on a public holiday. Read the wall
clock instead and the second reminder arrives at two in the morning, the third
an hour later, and the recipient has a filter rule by Monday.

Every instant below is fixed and timezone-aware. A working-calendar test that
reads the real clock passes all Tuesday afternoon and fails on Boxing Day,
which is the one occasion nobody is looking at it.

The dates are chosen so the weekday is stated rather than counted. In 2026,
1 April is a Wednesday, 2 April a Thursday, 3 April a Friday, 4 and 5 April the
weekend, and 6 and 13 April are Mondays.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from finora.domain.reminders import (
    MONDAY,
    SUPPRESSION_EXPLANATIONS,
    BusinessHours,
    CalendarError,
    Decision,
    ReminderPolicy,
    Suppression,
    decide,
    first_due,
    parse_business_days,
)

JAMAICA = ZoneInfo("America/Jamaica")


def _at(year: int, month: int, day: int, hour: int, minute: int = 0) -> datetime:
    """A fixed instant in the organisation's own timezone."""
    return datetime(year, month, day, hour, minute, tzinfo=JAMAICA)


def _every_monday_from(first: date, weeks: int) -> frozenset[date]:
    """Consecutive Mondays, for a calendar that is shut on every one of them."""
    return frozenset(first + timedelta(weeks=offset) for offset in range(weeks))


#: The default working week: Monday to Friday, 08:00 to 17:00, nine hours a day.
HOURS = BusinessHours()
POLICY = ReminderPolicy()

#: Thursday 2 April 2026, declared a public holiday.
HOLIDAY = date(2026, 4, 2)
WITH_HOLIDAY = BusinessHours(holidays=frozenset({HOLIDAY}))

#: A calendar that works Mondays only, with every Monday for the next two and a
#: half years declared a holiday. Nothing in it is ever open again.
BLOCKED_MONDAYS = _every_monday_from(date(2026, 4, 6), weeks=110)
NEVER_OPEN = BusinessHours(days=frozenset({MONDAY}), holidays=BLOCKED_MONDAYS)

#: Wednesday 1 April 2026, 09:00, with no timezone attached to it.
NAIVE = datetime(2026, 4, 1, 9)  # noqa: DTZ001


class TestAdvanceWithinOneDay:
    def test_three_hours_from_mid_morning_lands_the_same_morning(self) -> None:
        # Wednesday 09:00 plus three working hours, with nothing in the way.
        assert HOURS.advance(_at(2026, 4, 1, 9), 3) == _at(2026, 4, 1, 12)

    def test_minutes_are_carried_through_unchanged(self) -> None:
        assert HOURS.advance(_at(2026, 4, 1, 9, 40), 3) == _at(2026, 4, 1, 12, 40)

    def test_zero_hours_from_an_open_moment_is_that_moment(self) -> None:
        assert HOURS.advance(_at(2026, 4, 1, 9), 0) == _at(2026, 4, 1, 9)

    def test_zero_hours_from_a_closed_moment_is_the_next_opening(self) -> None:
        # A reminder due "now" at midnight is still not a reminder sent at
        # midnight, so even a nought-hour interval respects the working day.
        assert HOURS.advance(_at(2026, 4, 1, 23), 0) == _at(2026, 4, 2, 8)


class TestAdvanceAcrossCloseOfBusiness:
    def test_three_hours_from_late_afternoon_lands_the_next_morning(self) -> None:
        # Wednesday 16:00 has one working hour left in it, so the remaining two
        # are taken from Thursday morning. This is the case the whole module
        # exists for: the wall-clock answer would be 19:00 on Wednesday.
        assert HOURS.advance(_at(2026, 4, 1, 16), 3) == _at(2026, 4, 2, 10)

    def test_landing_exactly_on_closing_time_rolls_to_the_next_morning(self) -> None:
        # Wednesday 08:00 plus the whole nine-hour day is 17:00, an instant at
        # which the organisation is shut. A reminder scheduled there would sit
        # unsent until the next poll, so it is placed at the next opening.
        assert HOURS.advance(_at(2026, 4, 1, 8), 9) == _at(2026, 4, 2, 8)

    def test_a_moment_before_opening_counts_from_opening(self) -> None:
        # Not from 06:00. The organisation was shut for those two hours, and
        # counting them would deliver the reminder before anyone arrived.
        assert HOURS.advance(_at(2026, 4, 1, 6), 3) == _at(2026, 4, 1, 11)

    @pytest.mark.parametrize("hour", [17, 18, 23])
    def test_a_moment_after_closing_counts_from_the_next_opening(self, hour: int) -> None:
        assert HOURS.advance(_at(2026, 4, 1, hour), 3) == _at(2026, 4, 2, 11)


class TestAdvanceAcrossAWeekend:
    def test_three_hours_from_friday_afternoon_lands_on_monday_morning(self) -> None:
        # Friday 16:00 leaves one working hour before close, and the next two
        # are Monday's. Sixty-six hours of wall clock, three of working time.
        assert HOURS.advance(_at(2026, 4, 3, 16), 3) == _at(2026, 4, 6, 10)

    @pytest.mark.parametrize("day", [4, 5])
    def test_a_moment_on_the_weekend_counts_from_monday_opening(self, day: int) -> None:
        # Saturday and Sunday: a record that arrives over the weekend is chased
        # three hours into Monday, not at 13:00 on the Saturday.
        assert HOURS.advance(_at(2026, 4, day, 10), 3) == _at(2026, 4, 6, 11)


class TestAdvanceAcrossAHoliday:
    def test_a_configured_holiday_is_skipped_like_a_weekend(self) -> None:
        # Thursday is a public holiday, so Wednesday's last working hour is
        # followed by Friday's first two.
        assert WITH_HOLIDAY.advance(_at(2026, 4, 1, 16), 3) == _at(2026, 4, 3, 10)

    def test_a_moment_on_a_holiday_counts_from_the_next_working_day(self) -> None:
        assert WITH_HOLIDAY.advance(_at(2026, 4, 2, 10), 3) == _at(2026, 4, 3, 11)


class TestAdvanceOverSeveralDays:
    def test_twenty_four_working_hours_span_three_working_days(self) -> None:
        # Nine hours to Wednesday's close, nine more to Thursday's, which is
        # eighteen; the remaining six run from Friday's 08:00 to 14:00. The
        # wall-clock reading would put this at 08:00 on Thursday.
        assert HOURS.advance(_at(2026, 4, 1, 8), 24) == _at(2026, 4, 3, 14)

    def test_a_multi_day_span_also_steps_over_the_weekend(self) -> None:
        # From Thursday 08:00: nine hours on Thursday, nine on Friday, and the
        # last six on Monday, because Saturday and Sunday contribute nothing.
        assert HOURS.advance(_at(2026, 4, 2, 8), 24) == _at(2026, 4, 6, 14)

    def test_a_whole_working_week_lands_on_the_following_monday(self) -> None:
        # Five nine-hour days from Monday 08:00 exhausts Friday exactly, and an
        # exhausted day rolls forward rather than resting on the closed instant.
        assert HOURS.advance(_at(2026, 4, 6, 8), 45) == _at(2026, 4, 13, 8)


class TestAdvanceRefusesImpossibleArguments:
    def test_a_negative_number_of_hours_is_refused(self) -> None:
        with pytest.raises(ValueError, match="fall due in the past"):
            HOURS.advance(_at(2026, 4, 1, 9), -1)


class TestIsOpen:
    def test_exactly_at_opening_the_organisation_is_open(self) -> None:
        assert HOURS.is_open(_at(2026, 4, 1, 8)) is True

    def test_exactly_at_closing_the_organisation_is_not_open(self) -> None:
        # The working day is a half-open interval. Treating 17:00 as open would
        # let a reminder go out to an empty office at the moment it emptied.
        assert HOURS.is_open(_at(2026, 4, 1, 17)) is False

    @pytest.mark.parametrize("hour", [0, 7, 18, 23])
    def test_outside_the_working_hours_it_is_not_open(self, hour: int) -> None:
        assert HOURS.is_open(_at(2026, 4, 1, hour)) is False

    def test_the_last_minute_before_closing_is_still_open(self) -> None:
        assert HOURS.is_open(_at(2026, 4, 1, 16, 59)) is True

    @pytest.mark.parametrize("day", [4, 5])
    def test_a_weekend_day_is_not_open(self, day: int) -> None:
        assert HOURS.is_open(_at(2026, 4, day, 10)) is False

    def test_a_holiday_is_not_open_even_during_working_hours(self) -> None:
        assert WITH_HOLIDAY.is_open(_at(2026, 4, 2, 10)) is False

    def test_the_same_holiday_is_open_on_a_calendar_that_does_not_have_it(self) -> None:
        assert HOURS.is_open(_at(2026, 4, 2, 10)) is True


class TestWhyClosed:
    def test_an_open_moment_has_no_reason(self) -> None:
        assert HOURS.why_closed(_at(2026, 4, 1, 10)) is None

    @pytest.mark.parametrize("hour", [7, 17, 23])
    def test_a_working_day_outside_its_hours_is_outside_business_hours(self, hour: int) -> None:
        assert HOURS.why_closed(_at(2026, 4, 1, hour)) is Suppression.outside_business_hours

    @pytest.mark.parametrize("day", [4, 5])
    def test_a_weekend_day_is_a_non_working_day(self, day: int) -> None:
        # Distinguished from the hours reason on purpose. "We are shut today"
        # and "we are shut this evening" set different expectations of when the
        # chase will actually arrive, and the recipient is told which it is.
        assert HOURS.why_closed(_at(2026, 4, day, 10)) is Suppression.non_working_day

    def test_a_holiday_is_a_non_working_day_rather_than_a_matter_of_hours(self) -> None:
        assert WITH_HOLIDAY.why_closed(_at(2026, 4, 2, 10)) is Suppression.non_working_day

    def test_the_middle_of_the_night_on_a_holiday_is_still_a_non_working_day(self) -> None:
        assert WITH_HOLIDAY.why_closed(_at(2026, 4, 2, 3)) is Suppression.non_working_day


class TestNextOpening:
    def test_an_open_moment_is_returned_unchanged(self) -> None:
        assert HOURS.next_opening(_at(2026, 4, 1, 10, 30)) == _at(2026, 4, 1, 10, 30)

    def test_opening_time_itself_is_returned_unchanged(self) -> None:
        assert HOURS.next_opening(_at(2026, 4, 1, 8)) == _at(2026, 4, 1, 8)

    def test_before_opening_rolls_forward_to_the_same_day(self) -> None:
        assert HOURS.next_opening(_at(2026, 4, 1, 6)) == _at(2026, 4, 1, 8)

    @pytest.mark.parametrize("hour", [17, 20, 23])
    def test_after_closing_rolls_forward_to_the_next_morning(self, hour: int) -> None:
        assert HOURS.next_opening(_at(2026, 4, 1, hour)) == _at(2026, 4, 2, 8)

    @pytest.mark.parametrize(("day", "hour"), [(4, 10), (5, 10), (3, 20), (5, 23)])
    def test_the_weekend_rolls_forward_to_monday_morning(self, day: int, hour: int) -> None:
        assert HOURS.next_opening(_at(2026, 4, day, hour)) == _at(2026, 4, 6, 8)

    def test_a_holiday_rolls_forward_to_the_next_working_day(self) -> None:
        assert WITH_HOLIDAY.next_opening(_at(2026, 4, 2, 10)) == _at(2026, 4, 3, 8)

    def test_the_evening_before_a_holiday_skips_it(self) -> None:
        assert WITH_HOLIDAY.next_opening(_at(2026, 4, 1, 20)) == _at(2026, 4, 3, 8)


class TestANaiveTimestampIsRefused:
    def test_is_open_refuses_a_naive_timestamp(self) -> None:
        # A calendar answer computed from a timestamp with no timezone is wrong
        # by whatever the server's offset happens to be, and wrong silently.
        with pytest.raises(ValueError, match="aware timestamp"):
            HOURS.is_open(NAIVE)

    def test_why_closed_refuses_a_naive_timestamp(self) -> None:
        with pytest.raises(ValueError, match="aware timestamp"):
            HOURS.why_closed(NAIVE)

    def test_next_opening_refuses_a_naive_timestamp(self) -> None:
        with pytest.raises(ValueError, match="aware timestamp"):
            HOURS.next_opening(NAIVE)

    def test_advance_refuses_a_naive_timestamp(self) -> None:
        with pytest.raises(ValueError, match="aware timestamp"):
            HOURS.advance(NAIVE, 3)


class TestBusinessHoursValidation:
    def test_a_day_that_ends_before_it_starts_is_refused(self) -> None:
        with pytest.raises(CalendarError, match="end after it starts"):
            BusinessHours(start_hour=17, end_hour=8)

    def test_a_day_of_no_length_at_all_is_refused(self) -> None:
        # Nought working hours a day is a calendar in which no reminder is ever
        # due, which is a misconfiguration rather than a very patient policy.
        with pytest.raises(CalendarError, match="end after it starts"):
            BusinessHours(start_hour=8, end_hour=8)

    def test_a_week_with_no_working_days_is_refused(self) -> None:
        with pytest.raises(CalendarError, match="At least one day"):
            BusinessHours(days=frozenset())

    @pytest.mark.parametrize(("start_hour", "end_hour"), [(-1, 17), (24, 25), (25, 26)])
    def test_a_start_hour_outside_the_day_is_refused(self, start_hour: int, end_hour: int) -> None:
        with pytest.raises(CalendarError, match="start at an hour of the day"):
            BusinessHours(start_hour=start_hour, end_hour=end_hour)

    @pytest.mark.parametrize("end_hour", [0, -1, 25])
    def test_an_end_hour_outside_the_day_is_refused(self, end_hour: int) -> None:
        with pytest.raises(CalendarError, match="end at an hour of the day"):
            BusinessHours(start_hour=8, end_hour=end_hour)

    def test_a_day_ending_at_midnight_is_accepted(self) -> None:
        assert BusinessHours(start_hour=0, end_hour=24).hours_per_day == 24

    def test_the_default_working_day_is_nine_hours(self) -> None:
        assert HOURS.hours_per_day == 9


class TestACalendarThatNeverOpensIsRefusedRatherThanSearchedForever:
    def test_next_opening_gives_up_after_two_years(self) -> None:
        # The alternative to this guard is a scheduler thread wedged in a loop
        # over a misconfigured calendar, which presents as reminders silently
        # stopping rather than as an error anybody can act on.
        with pytest.raises(CalendarError, match="within two years"):
            NEVER_OPEN.next_opening(_at(2026, 4, 6, 9))

    def test_advance_gives_up_after_two_years(self) -> None:
        with pytest.raises(CalendarError, match="misconfigured"):
            NEVER_OPEN.advance(_at(2026, 4, 6, 9), 3)


class TestEscalationLadder:
    @pytest.mark.parametrize(
        ("sent", "level"),
        [
            (0, 0),
            (1, 0),
            (2, 0),
            (3, 1),
            (4, 1),
            (5, 1),
            (6, 2),
            (8, 2),
            (9, 3),
        ],
    )
    def test_every_third_reminder_copies_in_the_next_person_up(self, sent: int, level: int) -> None:
        assert POLICY.escalation_level_after(sent) == level

    @pytest.mark.parametrize("sent", [9, 12, 30, 300])
    def test_the_ladder_stops_at_the_configured_top(self, sent: int) -> None:
        # There is nobody above the managing director to copy in, and a level
        # that keeps counting would index past the end of the recipient list.
        assert POLICY.escalation_level_after(sent) == POLICY.max_escalation_level

    def test_a_shorter_ladder_is_honoured(self) -> None:
        policy = ReminderPolicy(escalate_every=1, max_escalation_level=2)

        assert [policy.escalation_level_after(sent) for sent in range(5)] == [0, 1, 2, 2, 2]

    @pytest.mark.parametrize(("sent", "exhausted"), [(0, False), (7, False), (8, True), (9, True)])
    def test_the_policy_is_exhausted_once_the_maximum_has_gone(
        self, sent: int, exhausted: bool
    ) -> None:
        assert POLICY.is_exhausted(sent) is exhausted

    def test_a_maximum_of_none_is_exhausted_before_it_starts(self) -> None:
        assert ReminderPolicy(max_reminders=0).is_exhausted(0) is True


class TestReminderPolicyValidation:
    @pytest.mark.parametrize("interval_hours", [0, -1])
    def test_an_interval_of_less_than_an_hour_is_refused(self, interval_hours: int) -> None:
        # Fractions are not supported and a nought-hour interval would chase on
        # every poll, which is the barrage this module exists to prevent.
        with pytest.raises(ValueError, match="at least one working hour"):
            ReminderPolicy(interval_hours=interval_hours)

    def test_a_negative_maximum_is_refused(self) -> None:
        with pytest.raises(ValueError, match="cannot be negative"):
            ReminderPolicy(max_reminders=-1)

    @pytest.mark.parametrize("escalate_every", [0, -1])
    def test_an_escalation_step_of_less_than_one_reminder_is_refused(
        self, escalate_every: int
    ) -> None:
        with pytest.raises(ValueError, match="at least one reminder"):
            ReminderPolicy(escalate_every=escalate_every)


class TestFirstDue:
    def test_the_first_reminder_falls_three_working_hours_after_the_wait_began(self) -> None:
        assert first_due(since=_at(2026, 4, 1, 9), hours=HOURS, policy=POLICY) == _at(
            2026, 4, 1, 12
        )

    def test_a_record_arriving_late_in_the_day_is_first_chased_the_next_morning(self) -> None:
        assert first_due(since=_at(2026, 4, 1, 16), hours=HOURS, policy=POLICY) == _at(
            2026, 4, 2, 10
        )

    def test_a_record_arriving_overnight_is_first_chased_after_opening(self) -> None:
        # Half past two in the morning is not the start of the interval; 08:00
        # is, so the first chase is at 11:00 rather than half past five.
        assert first_due(since=_at(2026, 4, 2, 2, 30), hours=HOURS, policy=POLICY) == _at(
            2026, 4, 2, 11
        )

    def test_a_record_arriving_on_a_saturday_is_first_chased_on_monday(self) -> None:
        assert first_due(since=_at(2026, 4, 4, 14), hours=HOURS, policy=POLICY) == _at(
            2026, 4, 6, 11
        )


class TestDecideWhenDueAndOpen:
    def test_a_reminder_that_is_due_during_working_hours_is_sent(self) -> None:
        decision = decide(
            now=_at(2026, 4, 1, 12),
            due_at=_at(2026, 4, 1, 12),
            sent=0,
            hours=HOURS,
            policy=POLICY,
        )

        assert decision.send is True
        assert decision.suppression is None

    def test_the_next_reminder_is_scheduled_three_working_hours_later(self) -> None:
        decision = decide(
            now=_at(2026, 4, 1, 12),
            due_at=_at(2026, 4, 1, 12),
            sent=0,
            hours=HOURS,
            policy=POLICY,
        )

        assert decision.next_due_at == _at(2026, 4, 1, 15)

    def test_an_overdue_reminder_is_sent_at_the_first_open_moment(self) -> None:
        decision = decide(
            now=_at(2026, 4, 6, 8),
            due_at=_at(2026, 4, 3, 16, 55),
            sent=1,
            hours=HOURS,
            policy=POLICY,
        )

        assert decision.send is True
        assert decision.next_due_at == _at(2026, 4, 6, 11)

    def test_the_escalation_level_counts_the_reminder_about_to_go(self) -> None:
        # Two have gone and this is the third, so the decision that carries it
        # is the one that has to name the extra recipient.
        decision = decide(
            now=_at(2026, 4, 1, 12),
            due_at=_at(2026, 4, 1, 12),
            sent=2,
            hours=HOURS,
            policy=POLICY,
        )

        assert decision.send is True
        assert decision.escalation_level == 1

    def test_the_last_permitted_reminder_schedules_nothing_after_itself(self) -> None:
        # Eight have been allowed and this is the eighth. Scheduling a ninth
        # that can never be sent would leave the record looking live for ever.
        decision = decide(
            now=_at(2026, 4, 1, 12),
            due_at=_at(2026, 4, 1, 12),
            sent=7,
            hours=HOURS,
            policy=POLICY,
        )

        assert decision.send is True
        assert decision.next_due_at is None
        assert decision.suppression is None


class TestDecideWhenDueButClosed:
    def test_a_reminder_due_after_hours_waits_for_the_morning(self) -> None:
        decision = decide(
            now=_at(2026, 4, 1, 20),
            due_at=_at(2026, 4, 1, 16, 55),
            sent=1,
            hours=HOURS,
            policy=POLICY,
        )

        assert decision.send is False
        assert decision.suppression is Suppression.outside_business_hours
        assert decision.next_due_at == _at(2026, 4, 2, 8)

    def test_a_reminder_due_over_the_weekend_waits_for_monday(self) -> None:
        decision = decide(
            now=_at(2026, 4, 4, 11),
            due_at=_at(2026, 4, 3, 16, 55),
            sent=1,
            hours=HOURS,
            policy=POLICY,
        )

        assert decision.send is False
        assert decision.suppression is Suppression.non_working_day
        assert decision.next_due_at == _at(2026, 4, 6, 8)

    def test_a_reminder_due_on_a_holiday_waits_for_the_next_working_day(self) -> None:
        decision = decide(
            now=_at(2026, 4, 2, 11),
            due_at=_at(2026, 4, 1, 16, 55),
            sent=1,
            hours=WITH_HOLIDAY,
            policy=POLICY,
        )

        assert decision.send is False
        assert decision.suppression is Suppression.non_working_day
        assert decision.next_due_at == _at(2026, 4, 3, 8)


class TestTheDueTimeDoesNotDriftOvernight:
    def test_repeated_overnight_polls_report_the_same_next_opening(self) -> None:
        # A reminder that came due at five to five is polled all night. Each
        # poll reports the same 08:00, because a due time that moved on with
        # every poll would walk further into the evening and never be reached.
        due_at = _at(2026, 4, 1, 16, 55)
        opening = _at(2026, 4, 2, 8)

        for now in (
            _at(2026, 4, 1, 17),
            _at(2026, 4, 1, 20, 30),
            _at(2026, 4, 1, 23, 59),
            _at(2026, 4, 2, 2),
            _at(2026, 4, 2, 7, 59),
        ):
            decision = decide(now=now, due_at=due_at, sent=1, hours=HOURS, policy=POLICY)

            assert decision.send is False
            assert decision.next_due_at == opening

    def test_the_reminder_goes_out_promptly_the_next_morning(self) -> None:
        # The point of not rescheduling overnight: the record is still overdue
        # at 08:00 and is chased then, not three further working hours later.
        due_at = _at(2026, 4, 1, 16, 55)
        for now in (_at(2026, 4, 1, 17), _at(2026, 4, 2, 2), _at(2026, 4, 2, 7, 59)):
            decide(now=now, due_at=due_at, sent=1, hours=HOURS, policy=POLICY)

        morning = decide(now=_at(2026, 4, 2, 8), due_at=due_at, sent=1, hours=HOURS, policy=POLICY)

        assert morning.send is True

    def test_a_weekend_of_polling_does_not_delay_the_monday_chase(self) -> None:
        due_at = _at(2026, 4, 3, 16, 55)
        for now in (_at(2026, 4, 4, 9), _at(2026, 4, 5, 3), _at(2026, 4, 6, 7, 59)):
            weekend = decide(now=now, due_at=due_at, sent=1, hours=HOURS, policy=POLICY)
            assert weekend.next_due_at == _at(2026, 4, 6, 8)

        monday = decide(now=_at(2026, 4, 6, 8), due_at=due_at, sent=1, hours=HOURS, policy=POLICY)

        assert monday.send is True


class TestDecideWhenNotYetDue:
    def test_a_reminder_before_its_time_is_not_sent(self) -> None:
        decision = decide(
            now=_at(2026, 4, 1, 10),
            due_at=_at(2026, 4, 1, 12),
            sent=1,
            hours=HOURS,
            policy=POLICY,
        )

        assert decision.send is False
        assert decision.suppression is Suppression.not_yet_due
        assert decision.next_due_at == _at(2026, 4, 1, 12)

    def test_a_record_with_no_due_time_is_not_chased(self) -> None:
        decision = decide(now=_at(2026, 4, 1, 10), due_at=None, sent=0, hours=HOURS, policy=POLICY)

        assert decision.send is False
        assert decision.suppression is Suppression.not_yet_due
        assert decision.next_due_at is None


class TestDecideWhenExhausted:
    def test_the_maximum_number_of_reminders_stops_the_chase(self) -> None:
        decision = decide(
            now=_at(2026, 4, 1, 12),
            due_at=_at(2026, 4, 1, 12),
            sent=8,
            hours=HOURS,
            policy=POLICY,
        )

        assert decision.send is False
        assert decision.suppression is Suppression.maximum_reached

    def test_an_exhausted_record_is_given_no_further_due_time(self) -> None:
        # It needs a person, not a ninth email. Leaving a due time on it would
        # keep it in every "chase pending" list for ever.
        decision = decide(
            now=_at(2026, 4, 1, 12),
            due_at=_at(2026, 4, 1, 12),
            sent=9,
            hours=HOURS,
            policy=POLICY,
        )

        assert decision.next_due_at is None

    def test_an_exhausted_record_still_reports_where_it_reached(self) -> None:
        decision = decide(
            now=_at(2026, 4, 1, 12),
            due_at=_at(2026, 4, 1, 12),
            sent=8,
            hours=HOURS,
            policy=POLICY,
        )

        assert decision.escalation_level == 2


class TestDecideWhenActionedOrSuppressed:
    def test_a_record_that_has_moved_on_is_not_chased(self) -> None:
        decision = decide(
            now=_at(2026, 4, 1, 12),
            due_at=_at(2026, 4, 1, 12),
            sent=1,
            hours=HOURS,
            policy=POLICY,
            still_waiting=False,
        )

        assert decision.send is False
        assert decision.suppression is Suppression.already_actioned
        assert decision.next_due_at is None

    def test_global_suppression_stops_the_send_but_keeps_the_schedule(self) -> None:
        # Switching sending off is not the same as cancelling the reminders.
        # The due time survives so the chase resumes where it left off.
        decision = decide(
            now=_at(2026, 4, 1, 12),
            due_at=_at(2026, 4, 1, 12),
            sent=1,
            hours=HOURS,
            policy=POLICY,
            globally_suppressed=True,
        )

        assert decision.send is False
        assert decision.suppression is Suppression.globally_suppressed
        assert decision.next_due_at == _at(2026, 4, 1, 12)


class TestDecideOrderOfPrecedence:
    def test_already_actioned_beats_every_other_reason(self) -> None:
        # The strongest statement available: this record does not need chasing
        # at all, so no other reason for not chasing it is worth recording.
        decision = decide(
            now=_at(2026, 4, 4, 3),
            due_at=_at(2026, 4, 1, 12),
            sent=8,
            hours=HOURS,
            policy=POLICY,
            still_waiting=False,
            globally_suppressed=True,
        )

        assert decision.suppression is Suppression.already_actioned
        assert decision.next_due_at is None

    def test_global_suppression_beats_exhaustion(self) -> None:
        # Reported as switched off rather than finished, because the two need
        # different remedies and only one of them is somebody's fault.
        decision = decide(
            now=_at(2026, 4, 1, 12),
            due_at=_at(2026, 4, 1, 12),
            sent=8,
            hours=HOURS,
            policy=POLICY,
            globally_suppressed=True,
        )

        assert decision.suppression is Suppression.globally_suppressed
        assert decision.next_due_at == _at(2026, 4, 1, 12)

    def test_exhaustion_beats_not_yet_due(self) -> None:
        # A record that has run out of reminders is finished with, and the
        # working day beginning again does not restart it.
        decision = decide(
            now=_at(2026, 4, 1, 10),
            due_at=_at(2026, 4, 1, 16),
            sent=8,
            hours=HOURS,
            policy=POLICY,
        )

        assert decision.suppression is Suppression.maximum_reached
        assert decision.next_due_at is None

    def test_not_yet_due_beats_closed_hours(self) -> None:
        # Both are true at two in the morning. The reported due time has to be
        # the record's own, not the next opening, or a reminder not due until
        # the afternoon would look as though it were going out at breakfast.
        decision = decide(
            now=_at(2026, 4, 2, 2),
            due_at=_at(2026, 4, 2, 14),
            sent=1,
            hours=HOURS,
            policy=POLICY,
        )

        assert decision.suppression is Suppression.not_yet_due
        assert decision.next_due_at == _at(2026, 4, 2, 14)

    def test_exhaustion_beats_closed_hours(self) -> None:
        decision = decide(
            now=_at(2026, 4, 4, 3),
            due_at=_at(2026, 4, 3, 12),
            sent=8,
            hours=HOURS,
            policy=POLICY,
        )

        assert decision.suppression is Suppression.maximum_reached

    def test_closed_hours_are_reported_only_when_nothing_else_applies(self) -> None:
        decision = decide(
            now=_at(2026, 4, 2, 2),
            due_at=_at(2026, 4, 1, 16, 55),
            sent=1,
            hours=HOURS,
            policy=POLICY,
        )

        assert decision.suppression is Suppression.outside_business_hours


class TestEverySuppressionCanBeExplained:
    def test_each_reason_has_an_explanation(self) -> None:
        # An unexplained silence is indistinguishable from a broken scheduler,
        # and the difference matters at month end.
        assert set(SUPPRESSION_EXPLANATIONS) == set(Suppression)

    def test_no_explanation_is_empty(self) -> None:
        assert all(text.strip() for text in SUPPRESSION_EXPLANATIONS.values())

    @pytest.mark.parametrize("suppression", list(Suppression))
    def test_a_decision_explains_its_own_suppression(self, suppression: Suppression) -> None:
        decision = Decision(send=False, next_due_at=None, suppression=suppression)

        assert decision.explanation == SUPPRESSION_EXPLANATIONS[suppression]

    def test_a_decision_to_send_has_nothing_to_explain(self) -> None:
        assert Decision(send=True, next_due_at=None).explanation is None


class TestParseBusinessDays:
    def test_the_ordinary_working_week_is_read(self) -> None:
        assert parse_business_days("MON,TUE,WED,THU,FRI") == frozenset({0, 1, 2, 3, 4})

    def test_lowercase_names_are_accepted(self) -> None:
        assert parse_business_days("mon,tue,sat") == frozenset({0, 1, 5})

    def test_whitespace_around_the_names_is_ignored(self) -> None:
        assert parse_business_days("  MON , TUE ,   SUN  ") == frozenset({0, 1, 6})

    def test_full_day_names_are_truncated_to_three_letters(self) -> None:
        assert parse_business_days("Monday,Tuesday,Thursday") == frozenset({0, 1, 3})

    @pytest.mark.parametrize("value", ["MON,,TUE", "MON,TUE,", ",MON,TUE", "MON, ,TUE"])
    def test_empty_entries_are_skipped(self, value: str) -> None:
        assert parse_business_days(value) == frozenset({0, 1})

    def test_a_repeated_day_is_counted_once(self) -> None:
        assert parse_business_days("MON,MON,TUE") == frozenset({0, 1})

    @pytest.mark.parametrize("value", ["MON,XYZ", "FUNDAY", "MON,TUE,WEB"])
    def test_an_unrecognised_name_is_refused_rather_than_skipped(self, value: str) -> None:
        # Dropping it silently would shorten the working week, which surfaces as
        # reminders arriving at odd times long after anyone would connect the
        # two to a typo in an environment file.
        with pytest.raises(CalendarError, match="not a day of the week"):
            parse_business_days(value)

    @pytest.mark.parametrize("value", ["", "   ", ",,,"])
    def test_a_setting_with_no_days_in_it_is_refused(self, value: str) -> None:
        with pytest.raises(CalendarError, match="At least one day"):
            parse_business_days(value)

    def test_the_parsed_days_can_be_used_as_a_calendar(self) -> None:
        # The point of the function: what it returns goes straight into
        # `BusinessHours`, so a four-day week configured as text behaves as one.
        hours = BusinessHours(days=parse_business_days("mon,tue,wed,thu"))

        assert hours.is_open(_at(2026, 4, 2, 10)) is True
        assert hours.is_open(_at(2026, 4, 3, 10)) is False
        assert hours.advance(_at(2026, 4, 2, 16), 3) == _at(2026, 4, 6, 10)
