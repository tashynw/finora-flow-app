"""What a supplier's answer is worth, and what it is never allowed to do.

The tests here are mostly about restraint. The module's job is to hold a claim
without acting on it, so most of what is checked is that a strong-looking piece
of evidence still produces a suggestion rather than an outcome, and that the one
function permitted to say "paid" refuses to say it on anything short of the
invoices actually being paid.

Three properties are load-bearing.

A suggestion is advisory. Every path through `suggest` returns something a screen
prints; nothing in the domain applies one, and the tests assert the type rather
than trusting the docstring.

Silence is not payment. An unanswered check-in whose chasing has run out
suggests Outstanding, and says silence is why. It is the only suggestion drawn
from an absence, which is why it gets its own test.

A moved invoice outranks everything. If the set being discussed has changed
underneath the conversation, no suggestion is offered at all, however clear the
supplier was.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from uuid import uuid4

import pytest

from finora.domain.money import Money
from finora.domain.vendor_confirmation import (
    ASKABLE_STATE,
    CLAIM_DESCRIPTIONS,
    CLAIM_LABELS,
    MAX_NOTE_LENGTH,
    MAX_RESPONDENT_LENGTH,
    REVIEW_TARGETS,
    STANDING_LABELS,
    CheckInLine,
    CheckInStanding,
    ClaimChannel,
    ClaimOutcome,
    Evidence,
    FollowUpPolicy,
    ReviewOutcome,
    chasing_exhausted,
    clean_note,
    clean_respondent,
    confirmed_paid,
    may_answer,
    may_review,
    standing,
    suggest,
    totals,
    within_vendor_limit,
)
from finora.domain.workflow import WorkflowState

SENT = datetime(2026, 5, 12, 9, 0, tzinfo=UTC)
ANSWERED = datetime(2026, 5, 14, 11, 30, tzinfo=UTC)
REVIEWED = datetime(2026, 5, 15, 16, 0, tzinfo=UTC)


def line(
    *,
    amount: int = 250_000,
    currency: str = "JMD",
    state: WorkflowState = WorkflowState.submitted,
    reference: str = "INV-000101",
) -> CheckInLine:
    return CheckInLine(
        invoice_id=uuid4(),
        reference=reference,
        invoice_number="A-99",
        total=Money(minor_units=amount, currency=currency),
        due_date=date(2026, 5, 30),
        state=state,
    )


def evidence(
    *,
    claim: ClaimOutcome | None = None,
    channel: ClaimChannel | None = None,
    exhausted: bool = False,
    intact: bool = True,
) -> Evidence:
    return Evidence(
        claim=claim,
        channel=channel,
        chasing_exhausted=exhausted,
        all_lines_still_submitted=intact,
    )


class TestStanding:
    """Four positions, read off three timestamps and stored nowhere."""

    def test_nothing_sent_is_not_sent(self) -> None:
        assert (
            standing(sent_at=None, answered_at=None, reviewed_at=None) is CheckInStanding.not_sent
        )

    def test_sent_and_quiet_is_awaiting(self) -> None:
        assert (
            standing(sent_at=SENT, answered_at=None, reviewed_at=None)
            is CheckInStanding.awaiting_vendor
        )

    def test_answered_needs_review(self) -> None:
        assert (
            standing(sent_at=SENT, answered_at=ANSWERED, reviewed_at=None)
            is CheckInStanding.vendor_answered
        )

    def test_reviewed_is_final(self) -> None:
        assert (
            standing(sent_at=SENT, answered_at=ANSWERED, reviewed_at=REVIEWED)
            is CheckInStanding.reviewed
        )

    def test_a_later_answer_does_not_reopen_a_review(self) -> None:
        """Read from the back, so evidence arriving after a decision is evidence.

        A supplier who answers twice, the second time after somebody has already
        concluded, has said something worth putting on the timeline. They have
        not undone a decision, and a standing that flipped back to "needs
        review" would mean anybody could reopen a closed conclusion by sending
        an email.
        """
        assert (
            standing(sent_at=SENT, answered_at=REVIEWED, reviewed_at=REVIEWED)
            is CheckInStanding.reviewed
        )

    def test_every_standing_has_a_label(self) -> None:
        assert set(STANDING_LABELS) == set(CheckInStanding)


class TestWhatIsAllowedWhen:
    def test_an_answer_needs_a_question_first(self) -> None:
        assert not may_answer(CheckInStanding.not_sent)

    def test_a_supplier_may_correct_themselves(self) -> None:
        assert may_answer(CheckInStanding.vendor_answered)

    def test_no_answers_after_review(self) -> None:
        assert not may_answer(CheckInStanding.reviewed)

    def test_a_reviewer_need_not_wait_for_a_reply(self) -> None:
        """Silence for three weeks is a finding somebody may act on.

        A reviewer holding a bank statement should not be blocked by a supplier
        who is never going to write back, which is the common case for the
        invoices that most need concluding.
        """
        assert may_review(CheckInStanding.awaiting_vendor)

    def test_nothing_is_reviewed_twice(self) -> None:
        assert not may_review(CheckInStanding.reviewed)

    def test_nothing_is_reviewed_before_it_is_asked(self) -> None:
        assert not may_review(CheckInStanding.not_sent)


class TestSuggestion:
    def test_yes_suggests_paid_and_hedges_about_it(self) -> None:
        result = suggest(evidence(claim=ClaimOutcome.received))
        assert result.outcome is ReviewOutcome.paid
        assert result.is_offered
        assert "their claim" in result.because

    def test_partly_suggests_outstanding(self) -> None:
        """ "Some of it" is not a weak yes.

        Nothing is settled until it is known which part is missing, so the
        suggestion is the same as an outright no even though the answer sounds
        halfway between.
        """
        assert suggest(evidence(claim=ClaimOutcome.partly_received)).outcome is (
            ReviewOutcome.outstanding
        )

    def test_no_suggests_outstanding(self) -> None:
        assert suggest(evidence(claim=ClaimOutcome.not_received)).outcome is (
            ReviewOutcome.outstanding
        )

    def test_nothing_yet_offers_nothing(self) -> None:
        result = suggest(evidence())
        assert result.outcome is None
        assert not result.is_offered

    def test_silence_once_chasing_runs_out_suggests_outstanding(self) -> None:
        result = suggest(evidence(exhausted=True))
        assert result.outcome is ReviewOutcome.outstanding
        assert "Silence is not payment" in result.because

    def test_mid_chase_silence_suggests_nothing(self) -> None:
        """A supplier who has had one email and two days is not evidence."""
        assert suggest(evidence(exhausted=False)).outcome is None

    def test_a_moved_invoice_beats_any_claim(self) -> None:
        """The strongest signal is that we are no longer discussing one thing.

        A supplier saying yes about a set of invoices, one of which somebody has
        since moved elsewhere, is a confident answer to a question that has
        changed. Offering a suggestion from it would be worse than offering
        none.
        """
        result = suggest(evidence(claim=ClaimOutcome.received, intact=False))
        assert result.outcome is None
        assert "moved since the package was sent" in result.because

    def test_a_moved_invoice_beats_exhausted_chasing_too(self) -> None:
        assert suggest(evidence(exhausted=True, intact=False)).outcome is None

    @pytest.mark.parametrize("claim", list(ClaimOutcome))
    def test_every_claim_produces_a_reason(self, claim: ClaimOutcome) -> None:
        assert suggest(evidence(claim=claim)).because.strip()

    def test_every_claim_has_a_label_and_a_description(self) -> None:
        assert set(CLAIM_LABELS) == set(ClaimOutcome)
        assert set(CLAIM_DESCRIPTIONS) == set(ClaimOutcome)

    def test_no_description_claims_the_platform_agrees(self) -> None:
        """Wording check with teeth.

        The descriptions are what a reviewer reads beside the choice, and
        "confirmed" there would be the platform adopting the supplier's answer as
        its own finding — the exact thing the review step exists to prevent.
        """
        for text in CLAIM_DESCRIPTIONS.values():
            assert "confirmed" not in text.lower()


class TestConfirmedPaid:
    """The one function allowed to license a green Paid on a page."""

    def test_all_paid_is_paid(self) -> None:
        assert confirmed_paid(states=(WorkflowState.paid, WorkflowState.paid))

    def test_one_short_is_not(self) -> None:
        assert not confirmed_paid(states=(WorkflowState.paid, WorkflowState.submitted))

    def test_a_claim_alone_licenses_nothing(self) -> None:
        """The condition is the invoices, not the supplier's word.

        There is no argument to this function that a supplier can influence,
        which is the point: no amount of enthusiasm in an email turns into a
        green badge.
        """
        assert not confirmed_paid(states=(WorkflowState.submitted, WorkflowState.submitted))

    def test_nothing_at_all_is_not_paid(self) -> None:
        """An empty set is vacuously all-paid, and must not be treated as such.

        A check-in whose lines failed to load would otherwise render as settled,
        which is the worst possible direction for that bug to fail in.
        """
        assert not confirmed_paid(states=())


class TestTotals:
    def test_one_currency_adds_up(self) -> None:
        result = totals((line(amount=100), line(amount=250)))
        assert result["JMD"] == Money(minor_units=350, currency="JMD")

    def test_two_currencies_stay_apart(self) -> None:
        """A supplier would notice a total denominated in nothing."""
        result = totals((line(amount=100), line(amount=250, currency="USD")))
        assert result["JMD"] == Money(minor_units=100, currency="JMD")
        assert result["USD"] == Money(minor_units=250, currency="USD")

    def test_nothing_totals_to_nothing(self) -> None:
        assert totals(()) == {}


class TestFollowUpPolicy:
    def test_chasing_runs_out(self) -> None:
        policy = FollowUpPolicy(max_follow_ups=3)
        assert not chasing_exhausted(sent_count=3, policy=policy)
        assert chasing_exhausted(sent_count=4, policy=policy)

    def test_the_daily_limit_is_per_supplier(self) -> None:
        policy = FollowUpPolicy(vendor_daily_limit=2)
        assert within_vendor_limit(sent_today=1, policy=policy)
        assert not within_vendor_limit(sent_today=2, policy=policy)

    def test_the_default_is_days_not_hours(self) -> None:
        """Guards the difference between chasing a colleague and a supplier.

        Internal sign-off reminders run every three hours. Doing that to a
        supplier would be rude and would land the platform's mail in a spam
        folder, after which the messages that matter go there too.
        """
        assert FollowUpPolicy().interval_days >= 1


class TestCleaning:
    def test_a_note_keeps_its_shape(self) -> None:
        assert clean_note("first\n\nsecond  ") == "first\n\nsecond"

    def test_a_note_is_bounded(self) -> None:
        assert len(clean_note("x" * (MAX_NOTE_LENGTH + 500))) == MAX_NOTE_LENGTH

    def test_an_empty_note_stays_empty(self) -> None:
        assert clean_note("   \n  ") == ""

    def test_a_respondent_name_collapses_whitespace(self) -> None:
        assert clean_respondent("  Marcia   Brown\n") == "Marcia Brown"

    def test_a_respondent_name_is_bounded(self) -> None:
        assert len(clean_respondent("y" * 400)) == MAX_RESPONDENT_LENGTH


class TestConstants:
    def test_only_submitted_invoices_are_worth_asking_about(self) -> None:
        assert ASKABLE_STATE is WorkflowState.submitted

    def test_review_targets_cover_both_outcomes(self) -> None:
        assert set(REVIEW_TARGETS) == {str(outcome) for outcome in ReviewOutcome}

    def test_review_targets_are_real_states(self) -> None:
        assert REVIEW_TARGETS["paid"] is WorkflowState.paid
        assert REVIEW_TARGETS["outstanding"] is WorkflowState.outstanding
