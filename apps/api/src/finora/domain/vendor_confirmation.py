"""Asking a supplier whether the money arrived, and what that answer is worth.

Submitting a payment package records that an instruction went to the bank. It
does not record that anybody was paid. Those are different facts and the gap
between them is where the money actually goes missing: a file never uploaded, a
transfer rejected for a stale account number, a cheque in a drawer. Nothing
inside this platform can see any of that. The only party who can is the supplier,
who knows perfectly well whether their account moved.

So the platform asks them. That is the whole of this module, and almost all of it
is about being careful with the answer.

## A vendor's answer is evidence, never a transition

The supplier is outside the organisation, has no account here, and is
authenticated by nothing stronger than possession of a link that arrived in
email. Their reply is worth having and is worth nothing as authorisation. A
"yes" here is a claim recorded against a name and a timestamp; moving an invoice
to Paid is a separate act by somebody inside the organisation holding
`payment:mark_paid`, who can see the claim and is not bound by it.

This is not caution for its own sake. The master prompt states that email replies
cannot enact internal financial actions, and a link that marked an invoice paid on
possession alone would be exactly that with the click moved to a browser. It is
also the specific shape of a real fraud: a forged confirmation closing out an
invoice that was in fact never paid, so the supplier's genuine chase months later
meets a record saying they were settled.

## One question per supplier, not per invoice

A package holding nine invoices across three suppliers produces three check-ins,
not nine. A bank pays a batch as one credit, so the supplier sees one deposit and
has no way to answer "did invoice 4 of 9 arrive" except by doing arithmetic on
our behalf. Asking them a question they cannot answer accurately is how a
confirmation process collects confident wrong answers.

The consequence is that the answer covers a set, and "some of it" is a real
answer rather than an edge case. It suggests Outstanding and hands a person the
note the supplier wrote, because working out which part is missing needs the
remittance advice and a human.

## Silence is not payment

A supplier who never replies leaves the check-in unanswered forever, and an
unanswered check-in must not drift into looking settled. After the chasing is
exhausted the suggestion becomes Outstanding with silence named as the reason —
the one suggestion in here that is made from the absence of evidence, and
therefore the one it matters most to say out loud.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime
from enum import StrEnum
from typing import Final

from finora.domain.money import Money, group_by_currency
from finora.domain.workflow import WorkflowState

#: The state an invoice must be in for its payment to be worth asking about.
#: Anything earlier has not been sent to the bank, so there is nothing a supplier
#: could have received.
ASKABLE_STATE: Final[WorkflowState] = WorkflowState.submitted

#: Where a reviewed invoice ends up, depending on what the reviewer concluded.
REVIEW_TARGETS: Final[dict[str, WorkflowState]] = {
    "paid": WorkflowState.paid,
    "outstanding": WorkflowState.outstanding,
}

MAX_NOTE_LENGTH: Final[int] = 2000
MAX_RESPONDENT_LENGTH: Final[int] = 120


class ClaimOutcome(StrEnum):
    """What the supplier said.

    Three answers rather than two, because "some of it" is what a supplier
    actually says when a batch payment is short, and forcing that into "no"
    loses the only useful thing about the reply.
    """

    received = "received"
    partly_received = "partly_received"
    not_received = "not_received"


CLAIM_LABELS: Final[dict[ClaimOutcome, str]] = {
    ClaimOutcome.received: "Says the money arrived",
    ClaimOutcome.partly_received: "Says only part of it arrived",
    ClaimOutcome.not_received: "Says nothing arrived",
}

#: Deliberately hedged wording throughout. "Confirmed paid" would be the
#: platform adopting the supplier's claim as its own finding, which is the exact
#: mistake the review step exists to prevent.
CLAIM_DESCRIPTIONS: Final[dict[ClaimOutcome, str]] = {
    ClaimOutcome.received: (
        "The supplier says the payment reached their account. Their word, not a "
        "bank statement, and not yet a decision by anybody here."
    ),
    ClaimOutcome.partly_received: (
        "The supplier says something arrived but not all of it. Which part is "
        "missing needs the remittance advice and a person."
    ),
    ClaimOutcome.not_received: (
        "The supplier says nothing has reached them. Worth checking against the "
        "bank before assuming the instruction failed."
    ),
}


class ClaimChannel(StrEnum):
    """How the answer reached us, which is part of how much it is worth.

    A link answer came from whoever held the link. A reply came from whatever
    address the mail claimed to be from. Somebody phoning in came through a
    member of staff who typed it. None of the three is authentication, and
    keeping them apart is what lets a reviewer weigh them differently.
    """

    signed_link = "signed_link"
    email_reply = "email_reply"
    recorded_by_staff = "recorded_by_staff"


CHANNEL_LABELS: Final[dict[ClaimChannel, str]] = {
    ClaimChannel.signed_link: "Answered the link we emailed",
    ClaimChannel.email_reply: "Replied to our email",
    ClaimChannel.recorded_by_staff: "Told us, and we wrote it down",
}


class ReviewOutcome(StrEnum):
    """What somebody inside the organisation concluded."""

    paid = "paid"
    outstanding = "outstanding"


REVIEW_LABELS: Final[dict[ReviewOutcome, str]] = {
    ReviewOutcome.paid: "Paid",
    ReviewOutcome.outstanding: "Outstanding",
}


class CheckInStanding(StrEnum):
    """Where a check-in is, derived from its timestamps rather than stored.

    Same reasoning as a payment package: this is a conversation with a supplier,
    not a financial record with a lifecycle anybody signs off. The invoices it
    concerns are on the state machine; the conversation is not.
    """

    not_sent = "not_sent"
    awaiting_vendor = "awaiting_vendor"
    vendor_answered = "vendor_answered"
    reviewed = "reviewed"


STANDING_LABELS: Final[dict[CheckInStanding, str]] = {
    CheckInStanding.not_sent: "Not asked yet",
    CheckInStanding.awaiting_vendor: "Waiting on the supplier",
    CheckInStanding.vendor_answered: "Needs review",
    CheckInStanding.reviewed: "Reviewed",
}

STANDING_DESCRIPTIONS: Final[dict[CheckInStanding, str]] = {
    CheckInStanding.not_sent: ("Nobody has asked this supplier whether the money reached them."),
    CheckInStanding.awaiting_vendor: ("We have asked and are chasing. Nothing has come back yet."),
    CheckInStanding.vendor_answered: (
        "The supplier has answered. Somebody here has to decide what it means "
        "before anything is recorded as paid."
    ),
    CheckInStanding.reviewed: ("Someone here has weighed the evidence and recorded a conclusion."),
}


def standing(
    *,
    sent_at: datetime | None,
    answered_at: datetime | None,
    reviewed_at: datetime | None,
) -> CheckInStanding:
    """Which of the four a check-in is in.

    Read from the back, so a reviewed check-in reads as reviewed even if a
    supplier replies again afterwards. A later reply is new evidence and shows on
    the timeline; it does not reopen a conclusion somebody already reached.
    """
    if reviewed_at is not None:
        return CheckInStanding.reviewed
    if answered_at is not None:
        return CheckInStanding.vendor_answered
    if sent_at is not None:
        return CheckInStanding.awaiting_vendor
    return CheckInStanding.not_sent


def may_answer(current: CheckInStanding) -> bool:
    """Whether a supplier's answer can still be recorded against this check-in.

    Answers are accepted right up until review and not after. Before it has been
    sent there is no question to answer, and after review the conclusion is
    somebody's recorded decision rather than a running tally.
    """
    return current in {CheckInStanding.awaiting_vendor, CheckInStanding.vendor_answered}


def may_review(current: CheckInStanding) -> bool:
    """Whether a reviewer can conclude now.

    Deliberately permitted while still waiting on the supplier. Silence for three
    weeks is a finding, and a reviewer who has the bank statement in front of
    them should not be made to wait for a reply that is never coming.
    """
    return current in {CheckInStanding.awaiting_vendor, CheckInStanding.vendor_answered}


# ------------------------------------------------------------------ suggestion


@dataclass(frozen=True, slots=True)
class Evidence:
    """Everything known about one check-in when a suggestion is worked out."""

    claim: ClaimOutcome | None
    channel: ClaimChannel | None
    #: Whether the chasing cycle has run out rather than merely being mid-flight.
    chasing_exhausted: bool
    #: Every invoice in the check-in is still where package submission left it.
    #: False means one has been moved by somebody else since, which is a reason
    #: to look rather than to conclude.
    all_lines_still_submitted: bool


@dataclass(frozen=True, slots=True)
class Suggestion:
    """What the evidence points at, and why.

    Advisory in the strongest sense available in a type system: nothing in the
    application applies a suggestion, every path to Paid or Outstanding goes
    through a reviewer naming their own conclusion, and this object exists to be
    printed on a page beside that choice rather than to be acted on.
    """

    outcome: ReviewOutcome | None
    because: str

    @property
    def is_offered(self) -> bool:
        return self.outcome is not None


NOTHING_YET = Suggestion(
    outcome=None,
    because=(
        "Nothing has come back from the supplier yet, and the chasing has not run "
        "out. There is no evidence here to draw a conclusion from."
    ),
)


def suggest(evidence: Evidence) -> Suggestion:
    """Read the evidence, and say what it looks like without acting on it.

    Ordered so the strongest signal wins. A line that has moved on since the
    package went outranks anything a supplier said, because it means the platform
    and the supplier are no longer discussing the same set of invoices, and a
    suggestion drawn from a mismatched set would be confidently wrong.
    """
    if not evidence.all_lines_still_submitted:
        return Suggestion(
            outcome=None,
            because=(
                "One of these invoices has been moved since the package was sent, "
                "so this check-in and the record no longer describe the same thing. "
                "Work out what happened to it before concluding anything."
            ),
        )

    if evidence.claim is ClaimOutcome.received:
        return Suggestion(
            outcome=ReviewOutcome.paid,
            because=(
                "The supplier says the money reached them. That is their claim "
                "rather than a bank statement, so it is worth a glance at the "
                "account before you agree with it."
            ),
        )

    if evidence.claim is ClaimOutcome.partly_received:
        return Suggestion(
            outcome=ReviewOutcome.outstanding,
            because=(
                "The supplier says only part of it arrived. Until it is known "
                "which part, none of this is settled."
            ),
        )

    if evidence.claim is ClaimOutcome.not_received:
        return Suggestion(
            outcome=ReviewOutcome.outstanding,
            because=(
                "The supplier says nothing arrived. Either the instruction did not "
                "go through or it went somewhere else, and both need chasing at "
                "the bank."
            ),
        )

    if evidence.chasing_exhausted:
        return Suggestion(
            outcome=ReviewOutcome.outstanding,
            because=(
                "We have asked as many times as we are going to and the supplier "
                "has not answered. Silence is not payment, and leaving this alone "
                "is how an unpaid invoice quietly ages out of view."
            ),
        )

    return NOTHING_YET


def confirmed_paid(*, states: tuple[WorkflowState, ...]) -> bool:
    """Whether this check-in may be shown as paid, in green, on a page.

    The design standard forbids a green Paid state before the review condition is
    satisfied, and this is where that condition is stated once so no screen has to
    reimplement it. The condition is not "the supplier said yes" and not "a
    suggestion says paid": it is that every invoice concerned is actually in
    `paid`, which only a reviewer can bring about.
    """
    return bool(states) and all(state is WorkflowState.paid for state in states)


# ------------------------------------------------------------------- follow-up


#: How often a supplier is chased, and how often at most. Far slower and far
#: shorter than an internal reminder: a colleague who has not signed off is
#: holding up work they agreed to do, whereas a supplier is being asked a favour
#: about money we may well have failed to send. Chasing them every three hours
#: would be rude and would land the platform's mail in a spam folder, after which
#: the genuinely important messages go there too.
DEFAULT_FOLLOW_UP_DAYS: Final[int] = 5
DEFAULT_MAX_FOLLOW_UPS: Final[int] = 3

#: Nothing sends more than this many messages to one supplier in a day, across
#: every check-in they are party to. A month-end run touching forty of their
#: invoices must not arrive as forty emails; the limit is what makes the platform
#: a correspondent rather than a mailer.
DEFAULT_VENDOR_DAILY_LIMIT: Final[int] = 2


@dataclass(frozen=True, slots=True)
class FollowUpPolicy:
    """How persistently a supplier is chased."""

    interval_days: int = DEFAULT_FOLLOW_UP_DAYS
    max_follow_ups: int = DEFAULT_MAX_FOLLOW_UPS
    vendor_daily_limit: int = DEFAULT_VENDOR_DAILY_LIMIT


def chasing_exhausted(*, sent_count: int, policy: FollowUpPolicy) -> bool:
    """Whether there are any chasers left to send.

    `sent_count` counts the first request as well as the follow-ups, because from
    the supplier's side those are all just emails from us.
    """
    return sent_count > policy.max_follow_ups


def within_vendor_limit(*, sent_today: int, policy: FollowUpPolicy) -> bool:
    """Whether one more message to this supplier today is acceptable."""
    return sent_today < policy.vendor_daily_limit


# ------------------------------------------------------------------- summaries


@dataclass(frozen=True, slots=True)
class CheckInLine:
    """One invoice as a check-in refers to it."""

    invoice_id: object
    reference: str
    invoice_number: str | None
    total: Money
    due_date: date | None
    state: WorkflowState


def totals(lines: tuple[CheckInLine, ...]) -> dict[str, Money]:
    """What the supplier is being asked about, per currency.

    One figure per currency for the same reason a package has them: there is no
    rate at which two currencies add up, and this number is going in front of the
    supplier, who would notice.
    """
    return group_by_currency([line.total for line in lines])


# ----------------------------------------------------------- reading a reply


#: How much of a reply is considered. A supplier's actual answer is at the top;
#: below it is the quoted thread, which contains our own question and would
#: otherwise be read as their answer to it.
QUOTED_MARKERS: Final[tuple[str, ...]] = (
    "-----original message-----",
    "________________________________",
    "from:",
    "sent from my",
)
_WROTE_LINE: Final[re.Pattern[str]] = re.compile(r"^on .{0,120}wrote:\s*$", re.IGNORECASE)

#: Ordered most specific first. "Only part of it arrived" contains "arrived", so
#: whichever family is checked first wins, and the order below is chosen so the
#: reading errs towards Outstanding — the conclusion that causes somebody to look
#: rather than the one that closes an invoice.
_PARTIAL_PHRASES: Final[tuple[str, ...]] = (
    "part of",
    "partial",
    "partially",
    "only received",
    "only got",
    "short by",
    "short payment",
    "less than",
    "some of it",
    "one of the",
)
_NEGATIVE_PHRASES: Final[tuple[str, ...]] = (
    "not received",
    "not yet received",
    "have not received",
    "haven't received",
    "hasn't been received",
    "not arrived",
    "hasn't arrived",
    "has not arrived",
    "no payment",
    "nothing has",
    "nothing yet",
    "still waiting",
    "still outstanding",
    "no sign of",
    "cannot see",
    "can't see",
    "do not see",
    "don't see",
    "unpaid",
)
_POSITIVE_PHRASES: Final[tuple[str, ...]] = (
    "received",
    "arrived",
    "has cleared",
    "cleared",
    "credited",
    "paid in full",
    "confirm receipt",
    "all good",
    "got it",
    "thank you for the payment",
)


def top_of_reply(body: str) -> str:
    """A supplier's own words, with our quoted question cut off the bottom.

    Necessary rather than tidy. Our question contains the words "did our payment
    reach you", and a reply quoting it below a one-word answer would read as
    though the supplier used all of those words themselves.
    """
    lines: list[str] = []
    for line in (body or "").splitlines():
        stripped = line.strip()
        lowered = stripped.lower()
        if stripped.startswith(">"):
            break
        if _WROTE_LINE.match(stripped) or lowered.startswith(QUOTED_MARKERS):
            break
        lines.append(line)
    return "\n".join(lines).strip()


def read_claim(body: str) -> ClaimOutcome | None:
    """What a free-text reply appears to say, or None if it is not clear.

    Returning None is the important half of this function and the common one.
    An unread reply still reaches a person — it is filed against the check-in
    and shown on the timeline — whereas a misread one silently becomes a claim
    the supplier never made. So this only answers when the words are
    unambiguous, and everything else is handed to a human.

    The order errs towards Outstanding. Reading "we received only part of it" as
    a plain yes would close an invoice that is short; reading a genuine yes as
    unclear costs somebody ten seconds.
    """
    text = top_of_reply(body).lower()
    if not text:
        return None

    if any(phrase in text for phrase in _PARTIAL_PHRASES):
        return ClaimOutcome.partly_received
    if any(phrase in text for phrase in _NEGATIVE_PHRASES):
        return ClaimOutcome.not_received
    if any(phrase in text for phrase in _POSITIVE_PHRASES):
        return ClaimOutcome.received
    return None


def clean_note(note: str) -> str:
    """Tidy free text from outside the organisation before it is stored.

    Whitespace only. The text is rendered as text and never as markup, so there
    is nothing here to strip for safety; what this prevents is a note that is
    three hundred blank lines and one word.
    """
    return "\n".join(line.rstrip() for line in note.strip().splitlines())[:MAX_NOTE_LENGTH]


def clean_respondent(name: str) -> str:
    """The name the supplier typed for themselves.

    Required on a link answer, and required to be understood for what it is: an
    unverified string, kept because "Marcia in accounts said so on the 14th" is
    the sentence somebody needs six months later, not because it identifies
    anybody.
    """
    return " ".join(name.split())[:MAX_RESPONDENT_LENGTH]
