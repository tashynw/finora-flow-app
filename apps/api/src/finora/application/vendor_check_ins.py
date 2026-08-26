"""Asking suppliers whether the money arrived, and filing what they say.

The last mile of the payment chain. A submitted package means an instruction was
recorded, not that anybody was paid, and this service is what closes that gap: it
raises one question per supplier, sends it, chases it politely, files whatever
comes back, and then stops — because the step that follows is a person's decision
and not this code's.

Four things worth knowing before reading.

*It writes claims and never conclusions.* Everything a supplier does lands in
`record_claim`, which sets `claim`, `answered_at` and nothing else. No invoice
moves. `review` is the only method in here that touches the state machine, it
requires `payment:mark_paid`, and it takes the outcome from the reviewer rather
than from the claim. A supplier who says "yes" and a reviewer who disagrees is a
case this design has, deliberately, rather than a bug.

*It is careful about how much mail it sends.* A supplier is being asked a favour
about a payment we may have failed to make. The interval is days, the follow-ups
run out, and a per-supplier daily cap applies across every check-in they are
party to, so a month-end run touching forty of their invoices does not arrive as
forty emails.

*Two identifiers travel, and only one is secret.* The link token authorises
nothing but is still a bearer string, so it lives in the URL and nowhere else.
The correlation tag is not secret at all and travels in the `Reply-To` address
and the subject, where every downstream forward will quote it. Confusing the two
would put a credential in a subject line.

*Sending is a separate call from raising.* `raise_for_package` writes the rows
inside the caller's transaction; `send` puts mail in the outbox. Splitting them
means a reviewer can look at who is about to be emailed before anybody is, and it
keeps this service's mail behaviour on the same commit-then-send footing as
everything else.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from uuid import UUID

import structlog
from sqlalchemy import Sequence as SqlSequence
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from finora.application.outbox import enqueue
from finora.application.signed_links import IssuedLink, LinkRefusal, SignedLinkService
from finora.domain.audit import ActorType, AuditAction
from finora.domain.mail_correlation import new_tag, reply_address, subject_marker
from finora.domain.money import Money
from finora.domain.notifications import MessageKind
from finora.domain.reminders import ReminderPurpose
from finora.domain.roles import Permission, assert_can_act
from finora.domain.vendor_confirmation import (
    ASKABLE_STATE,
    REVIEW_TARGETS,
    CheckInLine,
    CheckInStanding,
    ClaimChannel,
    ClaimOutcome,
    Evidence,
    FollowUpPolicy,
    ReviewOutcome,
    Suggestion,
    chasing_exhausted,
    clean_note,
    clean_respondent,
    may_answer,
    may_review,
    standing,
    suggest,
    totals,
    within_vendor_limit,
)
from finora.domain.workflow import TransitionSource, WorkflowState, transition
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import (
    Invoice,
    OutboxMessage,
    PaymentPackage,
    PaymentPackageLine,
    StateTransitionRow,
    User,
    VendorCheckIn,
)

logger = structlog.get_logger(__name__)

#: How a check-in names itself to the audit trail and to signed links.
RECORD_TYPE = "vendor_check_in"

#: The record type of the things it concerns, whose states review does move.
INVOICE_RECORD_TYPE = "invoice"

REFERENCE_SEQUENCE = SqlSequence("vendor_check_in_reference_seq")


class VendorCheckInError(Exception):
    """Base class for a refused action on a check-in."""


class NotAskableError(VendorCheckInError):
    """Nothing here can be asked about yet."""

    def __init__(self, message: str) -> None:
        super().__init__(message)


class NoAddressError(VendorCheckInError):
    def __init__(self, vendor_name: str) -> None:
        self.vendor_name = vendor_name
        super().__init__(
            f"There is no email address for {vendor_name}, so they cannot be asked. "
            "Add one to the supplier record, or record their answer by hand once "
            "somebody has spoken to them."
        )


class WrongStandingError(VendorCheckInError):
    """The check-in is not at a point where this makes sense."""

    def __init__(self, current: CheckInStanding, attempted: str) -> None:
        self.standing = current
        self.attempted = attempted
        super().__init__(_WRONG_STANDING[current, attempted])


_WRONG_STANDING: dict[tuple[CheckInStanding, str], str] = {
    (CheckInStanding.not_sent, "answer"): (
        "This supplier has not been asked anything yet, so there is no answer to record."
    ),
    (CheckInStanding.reviewed, "answer"): (
        "This check-in has already been reviewed. A later answer from the supplier is "
        "worth recording as a note on the package, but it does not reopen a conclusion "
        "somebody has already reached."
    ),
    (CheckInStanding.not_sent, "review"): (
        "Nobody has asked the supplier yet. Ask them, or record what they told you by "
        "some other route, before concluding anything."
    ),
    (CheckInStanding.reviewed, "review"): (
        "This check-in has already been reviewed, and a conclusion is recorded once."
    ),
    (CheckInStanding.awaiting_vendor, "send"): (
        "This supplier has already been asked. Use a follow-up rather than a second first request."
    ),
    (CheckInStanding.vendor_answered, "send"): (
        "This supplier has already answered. There is nothing left to ask them."
    ),
    (CheckInStanding.reviewed, "send"): (
        "This check-in has been reviewed and closed. Asking again would be asking about "
        "something that is settled."
    ),
}


@dataclass(frozen=True, slots=True)
class CheckInDetails:
    """A check-in as a screen needs it, with the suggestion attached.

    The suggestion is computed here rather than stored, because it is a reading
    of evidence that changes — an invoice moving underneath, the chasing running
    out — and a stored one would go stale silently.
    """

    check_in: VendorCheckIn
    standing: CheckInStanding
    lines: tuple[CheckInLine, ...]
    totals: dict[str, Money]
    suggestion: Suggestion
    #: True only when every invoice concerned actually reached `paid`. The one
    #: condition under which a screen may show this in green.
    confirmed_paid: bool


@dataclass(frozen=True, slots=True)
class RaiseOutcome:
    """What raising check-ins for a package produced."""

    raised: tuple[VendorCheckIn, ...]
    #: Suppliers already asked about this package, named rather than duplicated.
    already_raised: tuple[str, ...]


class VendorCheckInService:
    def __init__(
        self,
        *,
        session: Session,
        audit: AuditRepository,
        links: SignedLinkService,
        reply_address_base: str,
        mail_domain: str = "finora.invalid",
        policy: FollowUpPolicy | None = None,
        now: datetime | None = None,
    ) -> None:
        self._session = session
        self._audit = audit
        self._links = links
        # The address replies are invited to, before the tag goes in it. Held
        # here rather than read from config at the point of use, so a test can
        # send mail somewhere harmless without patching config.
        self._reply_base = reply_address_base
        self._mail_domain = mail_domain
        self._policy = policy or FollowUpPolicy()
        self._now = now

    def _clock(self) -> datetime:
        return self._now or datetime.now(UTC)

    # ------------------------------------------------------------------ raising

    def raise_for_package(
        self,
        package: PaymentPackage,
        *,
        actor: User,
        correlation_id: UUID,
    ) -> RaiseOutcome:
        """Open one question per supplier in a submitted package.

        Grouped by supplier because that is how the money left: a bank pays a
        batch as one credit, so a supplier with four invoices in the package saw
        one deposit and can only sensibly be asked about the whole of it.

        Grouping is by `vendor_name` rather than `vendor_id`, matching the unique
        constraint on the table, because a package may hold an invoice whose
        supplier was never linked to a vendor record. Two spellings of one
        supplier therefore produce two check-ins, which is visible and fixable;
        collapsing them on a fuzzy match would produce one check-in that quietly
        asks the wrong company about somebody else's money.
        """
        assert_can_act(roles=actor.roles, permission=Permission.vendor_confirmation_review)

        if package.submitted_at is None:
            raise NotAskableError(
                "This package has not gone to the bank yet, so there is nothing a "
                "supplier could have received."
            )

        existing = {
            name
            for name in self._session.execute(
                select(VendorCheckIn.vendor_name).where(VendorCheckIn.package_id == package.id)
            )
            .scalars()
            .all()
        }

        grouped: dict[str, list[PaymentPackageLine]] = defaultdict(list)
        for line in package.lines:
            grouped[line.vendor_name].append(line)

        raised: list[VendorCheckIn] = []
        skipped: list[str] = []

        for vendor_name in sorted(grouped):
            if vendor_name in existing:
                skipped.append(vendor_name)
                continue
            raised.append(
                self._raise_one(
                    package=package,
                    vendor_name=vendor_name,
                    lines=grouped[vendor_name],
                    actor=actor,
                    correlation_id=correlation_id,
                )
            )

        return RaiseOutcome(raised=tuple(raised), already_raised=tuple(skipped))

    def _raise_one(
        self,
        *,
        package: PaymentPackage,
        vendor_name: str,
        lines: list[PaymentPackageLine],
        actor: User,
        correlation_id: UUID,
    ) -> VendorCheckIn:
        vendor = next((line.invoice.vendor for line in lines if line.invoice.vendor), None)

        check_in = VendorCheckIn(
            reference=self._next_reference(),
            package_id=package.id,
            vendor_id=vendor.id if vendor else None,
            vendor_name=vendor_name,
            vendor_email=vendor.email if vendor else None,
            correlation_tag=self._unused_tag(),
            created_by_id=actor.id,
        )
        self._session.add(check_in)
        self._session.flush()

        self._audit.append(
            action=AuditAction.record_created,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=check_in.id,
            correlation_id=correlation_id,
            detail={
                "reference": check_in.reference,
                "package": package.reference,
                "vendor_name": vendor_name,
                "invoices": len(lines),
            },
        )
        return check_in

    def _unused_tag(self) -> str:
        """A correlation tag nothing else is using.

        Collisions are vanishingly unlikely at sixteen characters and would be
        materially worse than unlikely-sounding: two live conversations sharing a
        tag means one supplier's reply filed against another supplier's payment.
        Cheap to check, so it is checked.
        """
        for _ in range(5):
            tag = new_tag()
            clash = self._session.execute(
                select(VendorCheckIn.id).where(VendorCheckIn.correlation_tag == tag)
            ).first()
            if clash is None:
                return tag
        raise VendorCheckInError("Could not allocate a correlation tag. Try again.")

    # ------------------------------------------------------------------ sending

    def send(
        self,
        check_in: VendorCheckIn,
        *,
        actor: User,
        correlation_id: UUID,
    ) -> IssuedLink:
        """Ask the supplier, for the first time."""
        assert_can_act(roles=actor.roles, permission=Permission.vendor_confirmation_review)

        current = self._standing(check_in)
        if current is not CheckInStanding.not_sent:
            raise WrongStandingError(current, "send")

        link = self._queue_message(
            check_in,
            kind=MessageKind.vendor_check_in_request,
            follow_up_number=0,
            correlation_id=correlation_id,
        )

        check_in.sent_at = self._clock()
        self._session.flush()

        self._audit.append(
            action=AuditAction.vendor_confirmation_requested,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=check_in.id,
            correlation_id=correlation_id,
            detail={
                "reference": check_in.reference,
                "vendor_name": check_in.vendor_name,
                "to": check_in.vendor_email,
                "follow_up": 0,
            },
        )
        return link

    def send_follow_up(
        self,
        check_in: VendorCheckIn,
        *,
        follow_up_number: int,
        correlation_id: UUID,
    ) -> IssuedLink | None:
        """Chase, if chasing is still allowed. Called by the scheduler, not a person.

        Returns None rather than raising when a limit stops the send. A scheduler
        sweeping a hundred check-ins should skip the ones it may not chase and
        carry on, and a rate limit is an ordinary outcome rather than a fault.
        """
        current = self._standing(check_in)
        if current is not CheckInStanding.awaiting_vendor:
            return None

        if chasing_exhausted(sent_count=follow_up_number, policy=self._policy):
            logger.info(
                "vendor_check_in.chasing_exhausted",
                reference=check_in.reference,
                sent_count=follow_up_number,
            )
            return None

        if not within_vendor_limit(
            sent_today=self._messages_sent_today(check_in),
            policy=self._policy,
        ):
            logger.info(
                "vendor_check_in.rate_limited",
                reference=check_in.reference,
                vendor_name=check_in.vendor_name,
            )
            return None

        link = self._queue_message(
            check_in,
            kind=MessageKind.vendor_check_in_reminder,
            follow_up_number=follow_up_number,
            correlation_id=correlation_id,
        )

        self._audit.append(
            action=AuditAction.reminder_sent,
            actor_type=ActorType.scheduler,
            actor_id=None,
            actor_label="check-in scheduler",
            subject_type=RECORD_TYPE,
            subject_id=check_in.id,
            correlation_id=correlation_id,
            detail={
                "reference": check_in.reference,
                "vendor_name": check_in.vendor_name,
                "follow_up": follow_up_number,
            },
        )
        return link

    def _messages_sent_today(self, check_in: VendorCheckIn) -> int:
        """How much mail this supplier has already had today, across everything.

        Counted per supplier rather than per check-in, which is the whole point:
        the failure being prevented is a month-end run producing one email per
        package to the same accounts clerk. Counted against the outbox rather
        than a tally on the vendor, so a message that was queued and never sent
        still counts — the limit protects the relationship, and a queued message
        is one that is about to arrive.
        """
        since = self._clock() - timedelta(days=1)
        peers = select(VendorCheckIn.id).where(
            VendorCheckIn.vendor_name == check_in.vendor_name,
        )
        return int(
            self._session.execute(
                select(func.count())
                .select_from(OutboxMessage)
                .where(
                    OutboxMessage.record_type == RECORD_TYPE,
                    OutboxMessage.record_id.in_(peers),
                    OutboxMessage.created_at >= since,
                )
            ).scalar_one()
        )

    def _queue_message(
        self,
        check_in: VendorCheckIn,
        *,
        kind: MessageKind,
        follow_up_number: int,
        correlation_id: UUID,
    ) -> IssuedLink:
        if not check_in.vendor_email:
            raise NoAddressError(check_in.vendor_name)

        link = self._links.issue_to_vendor(
            record_type=RECORD_TYPE,
            record_id=check_in.id,
            purpose=ReminderPurpose.payment_check_in,
            vendor_id=check_in.vendor_id or check_in.package_id,
            vendor_label=check_in.vendor_name,
            correlation_id=correlation_id,
        )

        lines = self._lines(check_in)
        subject = (
            f"{'Reminder: ' if follow_up_number else ''}"
            f"Did our payment reach you? {subject_marker(check_in.correlation_tag)}"
        )

        enqueue(
            self._session,
            kind=kind,
            idempotency_key=f"{RECORD_TYPE}:{check_in.id}:ask:{follow_up_number}",
            record_type=RECORD_TYPE,
            record_id=check_in.id,
            to_address=check_in.vendor_email,
            to_name=check_in.vendor_name,
            subject=subject[:400],
            body_text=_compose(
                check_in,
                lines=lines,
                link=link,
                follow_up_number=follow_up_number,
            ),
            reply_to_address=reply_address(self._reply_base, check_in.correlation_tag),
            correlation_id=correlation_id,
            domain=self._mail_domain,
        )
        return link

    # ------------------------------------------------------------------ answers

    def record_claim(
        self,
        check_in: VendorCheckIn,
        *,
        claim: ClaimOutcome,
        channel: ClaimChannel,
        respondent_name: str,
        note: str = "",
        inbound_message_id: UUID | None = None,
        actor: User | None = None,
        correlation_id: UUID,
    ) -> VendorCheckIn:
        """File what the supplier said. Moves nothing.

        The single most important method in this module, and it is short on
        purpose: it writes four fields and an audit entry. Every temptation to do
        more here — to close the invoices when the answer is "yes", to reopen
        something when it is "no" — is the thing ADR 9 exists to refuse.

        `actor` is None when the claim arrived from outside: through the link, or
        as a correlated reply. That is not a missing value to be filled in with a
        service account; it is the fact that nobody inside the organisation
        vouched for this, and the audit trail records it as an external actor for
        exactly that reason.
        """
        if actor is not None:
            assert_can_act(roles=actor.roles, permission=Permission.vendor_confirmation_review)

        current = self._standing(check_in)
        if not may_answer(current):
            raise WrongStandingError(current, "answer")

        check_in.claim = claim
        check_in.claim_channel = channel
        check_in.respondent_name = clean_respondent(respondent_name) or None
        check_in.respondent_note = clean_note(note) or None
        check_in.answered_from_message_id = inbound_message_id
        check_in.answered_at = self._clock()
        self._session.flush()

        self._audit.append(
            action=AuditAction.vendor_confirmation_received,
            actor_type=ActorType.user if actor else ActorType.external_vendor,
            actor_id=actor.id if actor else None,
            actor_label=(actor.display_name if actor else check_in.vendor_name),
            subject_type=RECORD_TYPE,
            subject_id=check_in.id,
            correlation_id=correlation_id,
            detail={
                "reference": check_in.reference,
                "claim": str(claim),
                "channel": str(channel),
                "respondent": check_in.respondent_name,
                "superseded": current is CheckInStanding.vendor_answered,
            },
        )
        logger.info(
            "vendor_check_in.claim_recorded",
            reference=check_in.reference,
            claim=str(claim),
            channel=str(channel),
        )
        return check_in

    # ------------------------------------------------------------------- review

    def review(
        self,
        check_in: VendorCheckIn,
        *,
        outcome: ReviewOutcome,
        note: str = "",
        actor: User,
        correlation_id: UUID,
    ) -> VendorCheckIn:
        """Somebody inside the organisation decides, and the invoices move.

        The only path in the platform from `submitted` to `paid`. It needs
        `payment:mark_paid`, which segregation of duties forbids alongside
        `payment:submit`, so the person who sent the money to the bank is never
        the person who declares it arrived.

        The outcome comes from the reviewer. The supplier's claim is on the
        screen beside the choice and is an input to a human, not to this method:
        a reviewer looking at a bank statement may record Outstanding over a
        supplier's cheerful "yes", and nothing here should make that awkward.
        """
        assert_can_act(roles=actor.roles, permission=Permission.payment_mark_paid)

        current = self._standing(check_in)
        if not may_review(current):
            raise WrongStandingError(current, "review")

        target = REVIEW_TARGETS[str(outcome)]
        moved = self._move_invoices(
            check_in,
            target=target,
            actor=actor,
            correlation_id=correlation_id,
        )

        check_in.reviewed_at = self._clock()
        check_in.reviewed_by_id = actor.id
        check_in.review_outcome = outcome
        check_in.review_note = clean_note(note) or None
        self._session.flush()

        self._audit.append(
            action=AuditAction.vendor_confirmation_reviewed,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=check_in.id,
            correlation_id=correlation_id,
            detail={
                "reference": check_in.reference,
                "outcome": str(outcome),
                "claim": str(check_in.claim) if check_in.claim else None,
                # Recorded because it is the interesting case: the reviewer
                # looked at the supplier's answer and did not agree with it.
                "against_claim": _disagrees(check_in.claim, outcome),
                "invoices_moved": moved,
            },
        )
        return check_in

    def _move_invoices(
        self,
        check_in: VendorCheckIn,
        *,
        target: WorkflowState,
        actor: User,
        correlation_id: UUID,
    ) -> int:
        """Take this supplier's invoices to whatever the reviewer concluded.

        Skips anything no longer in `submitted`. An invoice moved by some other
        route since the package went is not this review's to move, and forcing it
        would overwrite a decision nobody here can see. The suggestion for such a
        check-in already refuses to offer an outcome, so a reviewer reaching this
        point has been told.
        """
        moved = 0
        for invoice in self._invoices(check_in):
            if invoice.state is not ASKABLE_STATE:
                logger.info(
                    "vendor_check_in.invoice_skipped",
                    reference=check_in.reference,
                    invoice=invoice.reference,
                    state=str(invoice.state),
                )
                continue

            change = transition(
                record_id=invoice.id,
                current=invoice.state,
                target=target,
                source=TransitionSource.user,
                actor_id=actor.id,
                actor_label=actor.display_name,
                expected_version=invoice.version,
                actual_version=invoice.version,
                reason=f"Vendor payment check-in {check_in.reference}",
                correlation_id=correlation_id,
            )
            invoice.state = target
            self._session.add(
                StateTransitionRow(
                    record_type=INVOICE_RECORD_TYPE,
                    record_id=invoice.id,
                    from_state=change.from_state,
                    to_state=change.to_state,
                    source=change.source,
                    actor_id=change.actor_id,
                    actor_label=change.actor_label,
                    reason=change.reason,
                    correlation_id=change.correlation_id,
                    occurred_at=change.occurred_at,
                    context={"reference": invoice.reference},
                )
            )
            moved += 1

        if moved:
            self._session.flush()
        return moved

    # ------------------------------------------------------------------ reading

    def details(self, check_in: VendorCheckIn) -> CheckInDetails:
        """Everything a screen needs, with the suggestion worked out fresh."""
        lines = self._lines(check_in)
        states = tuple(line.state for line in lines)

        return CheckInDetails(
            check_in=check_in,
            standing=self._standing(check_in),
            lines=lines,
            totals=totals(lines),
            suggestion=suggest(
                Evidence(
                    claim=check_in.claim,
                    channel=check_in.claim_channel,
                    chasing_exhausted=self._chasing_exhausted(check_in),
                    all_lines_still_submitted=all(state is ASKABLE_STATE for state in states),
                )
            ),
            confirmed_paid=bool(states) and all(state is WorkflowState.paid for state in states),
        )

    def resolve_vendor_link(
        self,
        token: str,
        *,
        correlation_id: UUID,
        spend: bool,
    ) -> VendorCheckIn | LinkRefusal:
        """Turn a supplier's token into the check-in it opens.

        Two things can go wrong beyond the link itself being bad, and both are
        reported as the same refusal the link layer produces. A link that points
        at a record which no longer exists, and a link issued for some other
        purpose that somehow reached this path, are both `unknown` from the
        holder's side — telling them which would be telling them something about
        our data on the strength of a token that did not work.
        """
        outcome = self._links.resolve_for_vendor(token, correlation_id=correlation_id, spend=spend)
        if isinstance(outcome, LinkRefusal):
            return outcome

        if (
            outcome.record_type != RECORD_TYPE
            or outcome.purpose is not ReminderPurpose.payment_check_in
        ):
            return LinkRefusal.unknown

        check_in = self._session.get(VendorCheckIn, outcome.record_id)
        return check_in if check_in is not None else LinkRefusal.unknown

    def find_by_tag(self, tag: str) -> VendorCheckIn | None:
        """The check-in a correlated reply belongs to, if any."""
        return self._session.execute(
            select(VendorCheckIn).where(VendorCheckIn.correlation_tag == tag)
        ).scalar_one_or_none()

    def _standing(self, check_in: VendorCheckIn) -> CheckInStanding:
        return standing(
            sent_at=check_in.sent_at,
            answered_at=check_in.answered_at,
            reviewed_at=check_in.reviewed_at,
        )

    def _chasing_exhausted(self, check_in: VendorCheckIn) -> bool:
        sent = int(
            self._session.execute(
                select(func.count())
                .select_from(OutboxMessage)
                .where(
                    OutboxMessage.record_type == RECORD_TYPE,
                    OutboxMessage.record_id == check_in.id,
                )
            ).scalar_one()
        )
        return chasing_exhausted(sent_count=sent, policy=self._policy)

    def _invoices(self, check_in: VendorCheckIn) -> list[Invoice]:
        return list(
            self._session.execute(
                select(Invoice)
                .join(PaymentPackageLine, PaymentPackageLine.invoice_id == Invoice.id)
                .where(
                    PaymentPackageLine.package_id == check_in.package_id,
                    PaymentPackageLine.vendor_name == check_in.vendor_name,
                )
                .order_by(Invoice.reference)
            )
            .scalars()
            .all()
        )

    def _lines(self, check_in: VendorCheckIn) -> tuple[CheckInLine, ...]:
        """What the supplier is being asked about.

        Amounts come from the package line rather than the invoice, so the figure
        quoted to a supplier is the one that was actually submitted. The state
        comes from the invoice, because that is the thing that moves. Reading
        each from the place that is authoritative for it is what lets `details`
        notice that an invoice has changed underneath the conversation.
        """
        rows = self._session.execute(
            select(PaymentPackageLine, Invoice.state)
            .join(Invoice, Invoice.id == PaymentPackageLine.invoice_id)
            .where(
                PaymentPackageLine.package_id == check_in.package_id,
                PaymentPackageLine.vendor_name == check_in.vendor_name,
            )
            .order_by(PaymentPackageLine.invoice_reference)
        ).all()

        return tuple(
            CheckInLine(
                invoice_id=line.invoice_id,
                reference=line.invoice_reference,
                invoice_number=line.invoice_number,
                total=Money(minor_units=line.amount_minor_units, currency=line.currency),
                due_date=line.due_date,
                state=state,
            )
            for line, state in rows
        )

    def _next_reference(self) -> str:
        number = self._session.execute(REFERENCE_SEQUENCE.next_value()).scalar_one()
        return f"VCI-{number:06d}"


def _disagrees(claim: ClaimOutcome | None, outcome: ReviewOutcome) -> bool:
    """Whether the reviewer concluded against what the supplier said."""
    if claim is None:
        return False
    if claim is ClaimOutcome.received:
        return outcome is ReviewOutcome.outstanding
    return outcome is ReviewOutcome.paid


def _compose(
    check_in: VendorCheckIn,
    *,
    lines: tuple[CheckInLine, ...],
    link: IssuedLink,
    follow_up_number: int,
) -> str:
    """The email a supplier receives.

    Written for somebody outside the organisation who did not ask for it. It
    names what we think we sent, asks one question, and offers two ways to
    answer, because a supplier whose mail client mangles the link should still be
    able to reply and be understood.

    It does not name our internal invoice references first, carry the invoice
    document, or say anything about the state of our workflow. What the supplier
    needs is their own invoice numbers and the amount.
    """
    when = check_in.package.submitted_at
    listed = "\n".join(
        f"    {line.invoice_number or line.reference}"
        f"{f' ({line.reference})' if line.invoice_number else ''}"
        f" — {line.total.format()}"
        for line in lines
    )
    per_currency = totals(lines)
    summed = ", ".join(money.format() for money in per_currency.values())

    chase = (
        ""
        if follow_up_number == 0
        else (
            f"\nWe wrote to you about this "
            f"{'once' if follow_up_number == 1 else f'{follow_up_number} times'} "
            f"already and have not heard back. If the payment did arrive, saying so "
            f"takes one click and stops us writing again.\n"
        )
    )

    return (
        f"Hello,\n"
        f"\n"
        f"We are writing to check that a payment reached you. On "
        f"{when:%d %B %Y} we instructed our bank to pay the following:\n"
        f"\n"
        f"{listed}\n"
        f"\n"
        f"  Total: {summed}\n"
        f"{chase}"
        f"\n"
        f"Could you confirm whether it arrived? You can answer here:\n"
        f"\n"
        f"  {link.url}\n"
        f"\n"
        f"There is nothing to sign in to, and the page expires on "
        f"{link.expires_at:%d %B %Y}. If you would rather just reply to this "
        f"email, that works too — please leave the subject line as it is so we "
        f"can match your answer to the right payment.\n"
        f"\n"
        f"If something is wrong or only part of it arrived, tell us that instead. "
        f"It is more useful to us than a confirmation we would have to unpick "
        f"later.\n"
        f"\n"
        f"Thank you,\n"
        f"Accounts Payable\n"
    )


def next_due(*, last_sent_at: datetime, policy: FollowUpPolicy) -> datetime:
    """When this supplier may be chased again.

    Plain days rather than the business-hours arithmetic used for internal
    reminders. A supplier is not our colleague and does not work our calendar,
    and "five days" is both easier to explain to them and impossible to get
    subtly wrong across a public holiday we happen to observe.
    """
    return last_sent_at + timedelta(days=policy.interval_days)


def due_before(session: Session, *, moment: date) -> list[VendorCheckIn]:
    """Check-ins waiting on a supplier, oldest first.

    Used by the scheduler. Deliberately does not decide whether each one may
    actually be chased — that is `send_follow_up`'s job, and it needs the outbox
    to answer it.
    """
    return list(
        session.execute(
            select(VendorCheckIn)
            .where(
                VendorCheckIn.sent_at.is_not(None),
                VendorCheckIn.answered_at.is_(None),
                VendorCheckIn.reviewed_at.is_(None),
            )
            .order_by(VendorCheckIn.sent_at)
        )
        .scalars()
        .all()
    )
