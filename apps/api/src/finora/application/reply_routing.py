"""Deciding what an inbound message is a reply to, and what to do about it.

Runs immediately after intake and before anything treats a message as a
document. Most mail arriving in the shared mailbox is a supplier sending an
invoice, which is what the document pipeline exists for; a small and important
minority is a supplier answering a question the platform asked them, and putting
that through document extraction would produce a reading of the word "yes".

The order of operations is the design.

*Correlate first, interpret second, and separately.* Deciding which conversation
a message belongs to is a question about headers. Deciding what it says is a
question about prose. Keeping them apart means a reply that is correlated
confidently but worded ambiguously is filed against the right check-in and left
for a person, rather than being either dropped or guessed at.

*A machine's reply is correlated and never interpreted.* An out-of-office that
threads correctly belongs on the timeline — "their accounts clerk is back on the
third" is exactly what somebody chasing this needs. What it must never do is
become a claim, or provoke an answer.

*Nothing here decides anything financial.* The most this module does is call
`record_claim`, which writes a supplier's answer and moves no money and no
record. If it cannot read the reply it writes nothing at all and the check-in
stays where it was, with the message attached to it.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from uuid import UUID

import structlog
from sqlalchemy import select
from sqlalchemy.orm import Session

from finora.application.vendor_check_ins import RECORD_TYPE as CHECK_IN_RECORD_TYPE
from finora.application.vendor_check_ins import VendorCheckInError, VendorCheckInService
from finora.domain.audit import ActorType, AuditAction
from finora.domain.mail_correlation import (
    AutomaticKind,
    CorrelationBasis,
    ReplyHeaders,
    candidates,
)
from finora.domain.vendor_confirmation import ClaimChannel, read_claim, top_of_reply
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import InboundMessage, OutboxMessage, VendorCheckIn

logger = structlog.get_logger(__name__)


@dataclass(frozen=True, slots=True)
class RoutingOutcome:
    """What became of one inbound message.

    `handled` means the document pipeline should leave this message alone. It is
    true for anything correlated to a check-in, including automatic replies and
    replies nobody could read, because all three are conversation rather than
    paperwork.
    """

    handled: bool = False
    record_type: str | None = None
    record_id: UUID | None = None
    basis: CorrelationBasis | None = None
    automatic: AutomaticKind | None = None
    #: True when a claim was written. False when the reply was filed but its
    #: meaning was left to a person.
    claim_recorded: bool = False
    #: Why nothing was read from it, when nothing was. Shown on the check-in.
    unread_because: str | None = None


UNREADABLE = (
    "The supplier replied, but the wording was not clear enough to record an "
    "answer from. Read what they wrote and record it here."
)
AUTOMATIC_REPLY = (
    "This was an automatic reply rather than an answer. Nothing has been "
    "recorded from it, and the supplier has not been chased again because of it."
)


class ReplyRouter:
    def __init__(
        self,
        *,
        session: Session,
        audit: AuditRepository,
        check_ins: VendorCheckInService,
    ) -> None:
        self._session = session
        self._audit = audit
        self._check_ins = check_ins

    def route(self, message: InboundMessage, *, correlation_id: UUID) -> RoutingOutcome:
        """Work out what this message answers, and file it there.

        Whether a machine sent it was settled at intake, while the whole header
        set was in hand. This reads that verdict rather than second-guessing it
        from the columns that survived.
        """
        match = self._correlate(_headers_of(message))
        if match is None:
            return RoutingOutcome(automatic=message.automatic_kind)

        record_type, record_id, basis = match
        message.correlated_record_type = record_type
        message.correlated_record_id = record_id
        message.correlation_basis = basis
        self._session.flush()

        self._audit.append(
            action=AuditAction.message_ingested,
            actor_type=ActorType.service,
            actor_id=None,
            actor_label="reply router",
            subject_type=record_type,
            subject_id=record_id,
            correlation_id=correlation_id,
            detail={
                "inbound_message": str(message.id),
                "basis": str(basis),
                "automatic": str(message.automatic_kind) if message.automatic_kind else None,
                "from_address": message.from_address,
            },
        )

        if record_type != CHECK_IN_RECORD_TYPE:
            # Correlated to something else entirely — an internal thread, most
            # likely. Recorded, and not this module's business beyond that.
            return RoutingOutcome(
                handled=False,
                record_type=record_type,
                record_id=record_id,
                basis=basis,
                automatic=message.automatic_kind,
            )

        return self._answer_check_in(
            message,
            record_id=record_id,
            basis=basis,
            correlation_id=correlation_id,
        )

    def _answer_check_in(
        self,
        message: InboundMessage,
        *,
        record_id: UUID,
        basis: CorrelationBasis,
        correlation_id: UUID,
    ) -> RoutingOutcome:
        base = RoutingOutcome(
            handled=True,
            record_type=CHECK_IN_RECORD_TYPE,
            record_id=record_id,
            basis=basis,
            automatic=message.automatic_kind,
        )

        if message.automatic_kind is not None:
            logger.info(
                "reply_routing.automatic",
                inbound_message=str(message.id),
                kind=str(message.automatic_kind),
            )
            return replace(base, unread_because=AUTOMATIC_REPLY)

        check_in = self._session.get(VendorCheckIn, record_id)
        if check_in is None:
            return base

        claim = read_claim(message.body_text or "")
        if claim is None:
            logger.info("reply_routing.unreadable", inbound_message=str(message.id))
            return replace(base, unread_because=UNREADABLE)

        try:
            self._check_ins.record_claim(
                check_in,
                claim=claim,
                channel=ClaimChannel.email_reply,
                # The display name from the message, unverified and labelled as
                # such wherever it is shown. A reply carries no name we can
                # stand behind, and inventing "the supplier" would be worse.
                respondent_name=message.from_display_name or message.from_address or "",
                note=top_of_reply(message.body_text or ""),
                inbound_message_id=message.id,
                actor=None,
                correlation_id=correlation_id,
            )
        except VendorCheckInError as error:
            # Almost always a reply arriving after somebody already reviewed the
            # check-in. The message stays correlated, so it is on the timeline
            # and a person can see it; what it does not do is reopen a
            # conclusion.
            logger.info(
                "reply_routing.claim_refused",
                inbound_message=str(message.id),
                reason=str(error),
            )
            return replace(base, unread_because=str(error))

        return replace(base, claim_recorded=True)

    def _correlate(self, headers: ReplyHeaders) -> tuple[str, UUID, CorrelationBasis] | None:
        """The strongest candidate that resolves to something real.

        Candidates come back strongest first, and this walks them in that order
        and stops at the first hit. A message quoting an old thread and carrying
        a current tag is matched on the tag only if the thread resolves to
        nothing.
        """
        for candidate in candidates(headers):
            if candidate.basis in {
                CorrelationBasis.in_reply_to,
                CorrelationBasis.references,
            }:
                found = self._by_message_id(candidate.value)
            else:
                found = self._by_tag(candidate.value)

            if found is not None:
                return found[0], found[1], candidate.basis
        return None

    def _by_message_id(self, value: str) -> tuple[str, UUID] | None:
        """The record whose outgoing message has this `Message-ID`.

        Matched against what the platform sent rather than against anything the
        reply asserts about itself. The column is unique, so a match is a match.
        """
        row = self._session.execute(
            select(OutboxMessage.record_type, OutboxMessage.record_id).where(
                OutboxMessage.message_id == f"<{value}>"
            )
        ).first()
        return (row[0], row[1]) if row else None

    def _by_tag(self, tag: str) -> tuple[str, UUID] | None:
        row = self._session.execute(
            select(VendorCheckIn.id).where(VendorCheckIn.correlation_tag == tag)
        ).first()
        return (CHECK_IN_RECORD_TYPE, row[0]) if row else None


def _headers_of(message: InboundMessage) -> ReplyHeaders:
    """The stored message, in the shape the correlation rules read.

    Only the fields correlation uses are populated. The auto-reply fields are
    left empty on purpose: that question was answered at intake and its answer
    is on the row, so filling them in here from columns that do not exist would
    invite somebody to call `automatic_kind` on this and get a confident no.

    Everything here was sender-controlled when it arrived and still is. Nothing
    downstream treats any of it as verified.
    """
    return ReplyHeaders(
        message_id=message.message_id,
        in_reply_to=message.in_reply_to,
        references=tuple(message.references or ()),
        subject=message.subject or "",
        from_address=message.from_address,
        to_addresses=tuple(message.to_addresses or ()),
        delivered_to=tuple(message.delivered_to_addresses or ()),
    )
