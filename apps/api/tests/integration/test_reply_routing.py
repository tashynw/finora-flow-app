"""What happens when a supplier writes back.

Intake was built for one shape of mail: a supplier sending an invoice, with a PDF
attached, which becomes a document for somebody to read. Phase 8 introduces a
second shape — a supplier answering a question the platform asked them — arriving
at the same mailbox and indistinguishable from the first until the headers are
read. Putting the second through the first would file the word "yes" as an
invoice awaiting extraction.

The tests here are about that fork, and about the three ways it can go wrong.

*A reply must reach the conversation it answers.* Through the threading headers
when the supplier's client sets them, through the tag on the reply address when
it does not, and through the tag in the subject when a forward has stripped
everything else. All three are exercised, because in practice all three happen.

*A reply must not become paperwork.* Correlated mail is not enrolled as a
document, whatever it carries. Its attachments are still stored and still
scanned — a remittance advice is worth keeping — they simply do not join the
extraction queue.

*A machine's reply must not become a claim, and must not provoke one.* An
out-of-office threads perfectly and means nothing. It lands on the timeline, it
records no answer, and crucially it puts no mail in the outbox, because two
systems each politely answering the other is how a mailbox fills overnight.

And underneath all of it, the rule ADR 9 exists for: nothing here moves an
invoice. The most a correlated reply achieves is a recorded claim, and a claim
is somebody's assertion about money rather than a fact about it.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from email.utils import format_datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from tests.conftest import (
    make_invoice,
    make_user,
    make_vendor,
    requires_db,
    sign_in,
)
from tests.integration.test_intake_service import (
    PDF,
    FakeObjectStore,
    FakeScanner,
)

from finora.application.intake import (
    DuplicateMessageError,
    ImapProvenance,
    IngestOutcome,
    IntakeService,
)
from finora.application.reminder_tasks import mail_domain
from finora.application.reply_routing import (
    AUTOMATIC_REPLY,
    UNREADABLE,
    ReplyRouter,
)
from finora.application.signed_links import SignedLinkService
from finora.application.vendor_check_ins import VendorCheckInService
from finora.config import get_settings
from finora.domain.intake import AttachmentLimits, IntakeSource
from finora.domain.mail_correlation import (
    AutomaticKind,
    CorrelationBasis,
    reply_address,
    subject_marker,
)
from finora.domain.roles import Role
from finora.domain.vendor_confirmation import ClaimChannel, ClaimOutcome
from finora.domain.workflow import WorkflowState
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import (
    Document,
    InboundMessage,
    OutboxMessage,
    User,
    Vendor,
    VendorCheckIn,
)

pytestmark = [pytest.mark.integration, requires_db]


# ------------------------------------------------------------------- fixtures


@pytest.fixture
def coordinator(db_session: Session) -> User:
    return make_user(
        db_session,
        email="pat.payments@example.com",
        display_name="Pat Payments",
        roles=[Role.payment_coordinator],
        department="Finance",
    )


@pytest.fixture
def finance(db_session: Session) -> User:
    return make_user(
        db_session,
        email="fern.finance@example.com",
        display_name="Fern Finance",
        roles=[Role.finance],
        department="Finance",
    )


@pytest.fixture
def vendor(db_session: Session) -> Vendor:
    return make_vendor(db_session)


# -------------------------------------------------------------------- helpers


def sent_check_in(
    client: TestClient,
    api_prefix: str,
    db_session: Session,
    *,
    coordinator: User,
    finance: User,
    vendor: Vendor,
) -> tuple[VendorCheckIn, OutboxMessage]:
    """A supplier who has been asked, and the email that asked them.

    Built through the API rather than by writing rows, so the correlation tag and
    the reply address under test are the ones the send path really produced.
    """
    invoice = make_invoice(
        db_session,
        recorded_by=finance,
        vendor=vendor,
        total_minor_units=1_000_000,
        currency="JMD",
        invoice_number="THEIRS-1",
        state=WorkflowState.approved,
    )

    sign_in(client, coordinator.email, api_prefix)
    package = client.post(
        f"{api_prefix}/payment-packages",
        json={
            "description": "Friday run",
            "payment_method": "bank_transfer",
            "intended_payment_date": (datetime.now(UTC).date() + timedelta(days=7)).isoformat(),
        },
    ).json()

    added = client.post(
        f"{api_prefix}/payment-packages/{package['id']}/lines",
        json={"invoice_ids": [str(invoice.id)]},
    )
    assert added.status_code == 200, added.text

    submitted = client.post(
        f"{api_prefix}/payment-packages/{package['id']}/submit",
        json={"submission_reference": "BANK-778899"},
    )
    assert submitted.status_code == 200, submitted.text

    raised = client.post(f"{api_prefix}/vendor-check-ins", json={"package_id": package["id"]})
    assert raised.status_code == 201, raised.text
    check_in_id = raised.json()["raised"][0]["id"]

    sent = client.post(f"{api_prefix}/vendor-check-ins/{check_in_id}/send")
    assert sent.status_code == 200, sent.text

    db_session.expire_all()
    check_in = db_session.get(VendorCheckIn, uuid.UUID(check_in_id))
    assert check_in is not None

    message = db_session.execute(
        select(OutboxMessage).where(
            OutboxMessage.record_type == "vendor_check_in",
            OutboxMessage.record_id == check_in.id,
        )
    ).scalar_one()
    return check_in, message


def build_router(db_session: Session) -> ReplyRouter:
    settings = get_settings()
    audit = AuditRepository(db_session)
    return ReplyRouter(
        session=db_session,
        audit=audit,
        check_ins=VendorCheckInService(
            session=db_session,
            audit=audit,
            links=SignedLinkService(
                session=db_session,
                audit=audit,
                web_base_url=settings.web_base_url,
            ),
            reply_address_base=settings.smtp.reply_to_address or settings.smtp.from_address,
            mail_domain=mail_domain(settings.smtp.from_address),
        ),
    )


def build_intake(db_session: Session, *, routing: bool = True) -> IntakeService:
    return IntakeService(
        session=db_session,
        object_store=FakeObjectStore(),  # type: ignore[arg-type]
        scanner=FakeScanner(),  # type: ignore[arg-type]
        audit=AuditRepository(db_session),
        limits=AttachmentLimits(
            max_bytes=25 * 1024 * 1024,
            max_archive_entries=500,
            max_archive_expansion_ratio=100,
        ),
        replies=build_router(db_session) if routing else None,
    )


def reply(
    *,
    sender: str,
    to: str,
    subject: str,
    body: str,
    in_reply_to: str | None = None,
    references: str | None = None,
    message_id: str | None = None,
    attachment: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> bytes:
    """One raw message, shaped like a real reply rather than a synthetic one."""
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = f"Accounts Payable <{sender}>"
    message["To"] = to
    message["Date"] = format_datetime(datetime.now(UTC))
    message["Message-ID"] = message_id or f"<{uuid.uuid4()}@vendor.example>"
    if in_reply_to:
        message["In-Reply-To"] = in_reply_to
    if references:
        message["References"] = references
    for name, value in (headers or {}).items():
        message[name] = value
    message.set_content(body)
    if attachment is not None:
        message.add_attachment(
            attachment, maintype="application", subtype="pdf", filename="remittance.pdf"
        )
    return message.as_bytes()


def ingest(service: IntakeService, raw: bytes) -> IngestOutcome:
    return service.ingest(
        raw,
        source=IntakeSource.imap,
        correlation_id=uuid.uuid4(),
        imap=ImapProvenance(folder="INBOX", uid=uuid.uuid4().int % 100_000, uid_validity=1),
    )


def documents(db_session: Session) -> int:
    return int(db_session.execute(select(func.count()).select_from(Document)).scalar_one())


def outbox_count(db_session: Session) -> int:
    return int(db_session.execute(select(func.count()).select_from(OutboxMessage)).scalar_one())


def scenario(
    client: TestClient,
    api_prefix: str,
    db_session: Session,
    coordinator: User,
    finance: User,
    vendor: Vendor,
) -> dict[str, Any]:
    check_in, message = sent_check_in(
        client,
        api_prefix,
        db_session,
        coordinator=coordinator,
        finance=finance,
        vendor=vendor,
    )
    return {
        "check_in": check_in,
        "message": message,
        "intake": build_intake(db_session),
        "sender": vendor.email or "",
        "reply_to": message.reply_to_address or "",
    }


# ----------------------------------------------------------------- correlating


class TestFindingTheConversation:
    def test_a_threaded_reply_lands_on_the_check_in(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # The ordinary case: a mail client that sets In-Reply-To, which is every
        # mail client worth the name.
        setup = scenario(client, api_prefix, db_session, coordinator, finance, vendor)

        outcome = ingest(
            setup["intake"],
            reply(
                sender=setup["sender"],
                to=setup["reply_to"],
                subject="Re: Did our payment reach you?",
                body="Yes, the payment was received on Friday. Thanks.",
                in_reply_to=setup["message"].message_id,
            ),
        )

        assert outcome.routing is not None
        assert outcome.routing.record_id == setup["check_in"].id
        assert outcome.routing.basis is CorrelationBasis.in_reply_to
        assert outcome.routing.claim_recorded is True

    def test_a_reply_with_no_threading_headers_is_found_by_the_reply_address(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # Some web clients and most "reply" buttons inside accounting packages
        # compose a fresh message. The tag on the address is what saves those.
        setup = scenario(client, api_prefix, db_session, coordinator, finance, vendor)

        outcome = ingest(
            setup["intake"],
            reply(
                sender=setup["sender"],
                to=setup["reply_to"],
                subject="payment",
                body="Yes we have received it.",
            ),
        )

        assert outcome.routing is not None
        assert outcome.routing.record_id == setup["check_in"].id
        assert outcome.routing.basis is CorrelationBasis.reply_address_tag

    def test_a_forward_stripped_of_everything_but_the_subject_still_correlates(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # Weakest evidence, and last resort. It is here because the alternative
        # is losing an answer somebody took the trouble to send.
        setup = scenario(client, api_prefix, db_session, coordinator, finance, vendor)
        check_in: VendorCheckIn = setup["check_in"]
        marker = subject_marker(check_in.correlation_tag)

        outcome = ingest(
            setup["intake"],
            reply(
                sender=setup["sender"],
                to="payments@company.example",
                subject=f"FW: Did our payment reach you? {marker}",
                body="Yes, received.",
            ),
        )

        assert outcome.routing is not None
        assert outcome.routing.record_id == check_in.id
        assert outcome.routing.basis is CorrelationBasis.subject_tag

    def test_threading_wins_over_a_tag_from_an_older_conversation(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # A supplier replying to this month's question on top of last month's
        # thread carries both. The headers describing what they actually clicked
        # reply on are better evidence than a string quoted in the body.
        setup = scenario(client, api_prefix, db_session, coordinator, finance, vendor)
        check_in: VendorCheckIn = setup["check_in"]

        outcome = ingest(
            setup["intake"],
            reply(
                sender=setup["sender"],
                to=reply_address("payments@company.example", "fnrzzzzzzzzzzzzzzzz"),
                subject=f"Re: payment {subject_marker('fnrzzzzzzzzzzzzzzzz')}",
                body="Yes, received.",
                in_reply_to=setup["message"].message_id,
            ),
        )

        assert outcome.routing is not None
        assert outcome.routing.record_id == check_in.id
        assert outcome.routing.basis is CorrelationBasis.in_reply_to

    def test_an_ordinary_invoice_is_left_to_the_document_pipeline(
        self,
        db_session: Session,
    ) -> None:
        # The negative case, and the one that would be catastrophic to get
        # wrong: a supplier sending an invoice must still get an invoice.
        service = build_intake(db_session)
        before = documents(db_session)

        outcome = ingest(
            service,
            reply(
                sender="billing@vendor.example",
                to="invoices@company.example",
                subject="Invoice 4821",
                body="Please find attached.",
                attachment=PDF,
            ),
        )

        assert outcome.routing is not None
        assert outcome.routing.handled is False
        assert outcome.enrolled_documents == 1
        assert documents(db_session) == before + 1


# --------------------------------------------------------------- not paperwork


class TestNotPaperwork:
    def test_a_correlated_reply_enrols_no_document(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        setup = scenario(client, api_prefix, db_session, coordinator, finance, vendor)
        before = documents(db_session)

        outcome = ingest(
            setup["intake"],
            reply(
                sender=setup["sender"],
                to=setup["reply_to"],
                subject="Re: Did our payment reach you?",
                body="Yes, received in full.",
                in_reply_to=setup["message"].message_id,
                attachment=PDF,
            ),
        )

        assert outcome.is_conversation is True
        assert outcome.enrolled_documents == 0
        assert documents(db_session) == before

    def test_the_attachment_is_still_stored_and_still_scanned(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # Diverting a message from the extraction queue is not the same as
        # discarding what came with it. A remittance advice is evidence.
        setup = scenario(client, api_prefix, db_session, coordinator, finance, vendor)

        outcome = ingest(
            setup["intake"],
            reply(
                sender=setup["sender"],
                to=setup["reply_to"],
                subject="Re: Did our payment reach you?",
                body="Yes — remittance attached.",
                in_reply_to=setup["message"].message_id,
                attachment=PDF,
            ),
        )

        assert outcome.stored_attachments == 1
        assert outcome.quarantined_attachments == 0


# ---------------------------------------------------------------- the claim


class TestWhatTheReplySays:
    def test_a_clear_yes_is_recorded_as_a_claim_and_moves_nothing(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        setup = scenario(client, api_prefix, db_session, coordinator, finance, vendor)
        check_in: VendorCheckIn = setup["check_in"]

        ingest(
            setup["intake"],
            reply(
                sender=setup["sender"],
                to=setup["reply_to"],
                subject="Re: Did our payment reach you?",
                body="Yes, we have received the payment. Thank you.",
                in_reply_to=setup["message"].message_id,
            ),
        )

        db_session.expire_all()
        refreshed = db_session.get(VendorCheckIn, check_in.id)
        assert refreshed is not None
        assert refreshed.claim is ClaimOutcome.received
        assert refreshed.claim_channel is ClaimChannel.email_reply
        assert refreshed.answered_from_message_id is not None
        # The whole point of ADR 9. A supplier said yes and nothing moved.
        assert refreshed.review_outcome is None

    def test_a_clear_no_is_recorded_just_as_readily(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        setup = scenario(client, api_prefix, db_session, coordinator, finance, vendor)

        ingest(
            setup["intake"],
            reply(
                sender=setup["sender"],
                to=setup["reply_to"],
                subject="Re: Did our payment reach you?",
                body="No, we have not received anything yet.",
                in_reply_to=setup["message"].message_id,
            ),
        )

        db_session.expire_all()
        refreshed = db_session.get(VendorCheckIn, setup["check_in"].id)
        assert refreshed is not None
        assert refreshed.claim is ClaimOutcome.not_received

    def test_an_ambiguous_reply_is_filed_and_left_for_a_person(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # Guessing is the failure mode to avoid. A question back from the
        # supplier is not an answer, and reading it as one would put a false
        # claim in front of a reviewer.
        setup = scenario(client, api_prefix, db_session, coordinator, finance, vendor)

        outcome = ingest(
            setup["intake"],
            reply(
                sender=setup["sender"],
                to=setup["reply_to"],
                subject="Re: Did our payment reach you?",
                body="Which invoice number is this against? Our reference is unclear.",
                in_reply_to=setup["message"].message_id,
            ),
        )

        assert outcome.routing is not None
        assert outcome.routing.handled is True
        assert outcome.routing.claim_recorded is False
        assert outcome.routing.unread_because == UNREADABLE

        db_session.expire_all()
        refreshed = db_session.get(VendorCheckIn, setup["check_in"].id)
        assert refreshed is not None
        assert refreshed.claim is None

    def test_a_quoted_yes_from_our_own_question_is_not_read_as_their_answer(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # Reply-below-the-quote is common, and our own message contains the word
        # the reader is looking for. Only what they wrote above the quote counts.
        setup = scenario(client, api_prefix, db_session, coordinator, finance, vendor)

        outcome = ingest(
            setup["intake"],
            reply(
                sender=setup["sender"],
                to=setup["reply_to"],
                subject="Re: Did our payment reach you?",
                body=(
                    "Passing this to our accounts team to look at.\n\n"
                    "On Tuesday, Finora wrote:\n"
                    "> Please reply yes if the payment has been received.\n"
                    "> We have received your invoice.\n"
                ),
                in_reply_to=setup["message"].message_id,
            ),
        )

        assert outcome.routing is not None
        # Correlated, so this is genuinely the reader declining to guess rather
        # than the message never reaching the check-in in the first place.
        assert outcome.routing.record_id == setup["check_in"].id
        assert outcome.routing.claim_recorded is False
        assert outcome.routing.unread_because == UNREADABLE


# ------------------------------------------------------------------ machines


class TestMachines:
    def test_an_out_of_office_is_filed_but_never_read_as_an_answer(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        setup = scenario(client, api_prefix, db_session, coordinator, finance, vendor)

        outcome = ingest(
            setup["intake"],
            reply(
                sender=setup["sender"],
                to=setup["reply_to"],
                subject="Automatic reply: Did our payment reach you?",
                body="I am out of the office until the third. Yes, I will look then.",
                in_reply_to=setup["message"].message_id,
                headers={"Auto-Submitted": "auto-replied"},
            ),
        )

        assert outcome.routing is not None
        assert outcome.routing.handled is True
        assert outcome.routing.automatic is AutomaticKind.vacation
        assert outcome.routing.claim_recorded is False
        assert outcome.routing.unread_because == AUTOMATIC_REPLY

        db_session.expire_all()
        refreshed = db_session.get(VendorCheckIn, setup["check_in"].id)
        assert refreshed is not None
        assert refreshed.claim is None

    def test_an_automatic_reply_puts_no_mail_in_the_outbox(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # The mail-loop guard. Two systems answering each other overnight is the
        # classic way to get an organisation's domain blocked.
        setup = scenario(client, api_prefix, db_session, coordinator, finance, vendor)
        before = outbox_count(db_session)
        # The request that was already sent. Asserted so that a future change
        # emptying the outbox cannot turn this test into one that passes by
        # comparing nothing to nothing.
        assert before == 1

        ingest(
            setup["intake"],
            reply(
                sender=setup["sender"],
                to=setup["reply_to"],
                subject="Re: Did our payment reach you?",
                body="Delivery to the following recipient failed permanently.",
                in_reply_to=setup["message"].message_id,
                headers={"Return-Path": "<>"},
            ),
        )

        assert outbox_count(db_session) == before

    def test_a_bounce_is_recognised_by_its_empty_return_path(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        setup = scenario(client, api_prefix, db_session, coordinator, finance, vendor)

        outcome = ingest(
            setup["intake"],
            reply(
                sender="mailer-daemon@vendor.example",
                to=setup["reply_to"],
                subject="Undeliverable: Did our payment reach you?",
                body="The address no longer exists.",
                in_reply_to=setup["message"].message_id,
                headers={"Return-Path": "<>"},
            ),
        )

        assert outcome.routing is not None
        assert outcome.routing.automatic is AutomaticKind.bounce


# -------------------------------------------------------------------- replay


class TestArrivingTwice:
    def test_the_same_message_delivered_twice_is_one_record(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # A worker that crashes after ingesting and before checkpointing sees
        # the message again on the next run. Idempotency, not routing, is what
        # stops the second pass — but routing must not undo it.
        setup = scenario(client, api_prefix, db_session, coordinator, finance, vendor)
        raw = reply(
            sender=setup["sender"],
            to=setup["reply_to"],
            subject="Re: Did our payment reach you?",
            body="Yes, received.",
            in_reply_to=setup["message"].message_id,
        )

        ingest(setup["intake"], raw)
        db_session.commit()

        with pytest.raises(DuplicateMessageError):
            ingest(build_intake(db_session), raw)

        db_session.rollback()
        stored = int(
            db_session.execute(select(func.count()).select_from(InboundMessage)).scalar_one()
        )
        assert stored == 1

    def test_a_second_distinct_reply_supersedes_the_first(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # A supplier who says no and then writes again an hour later to say the
        # money turned up. The later word is the one that counts.
        setup = scenario(client, api_prefix, db_session, coordinator, finance, vendor)

        for body in ("No, nothing has arrived.", "Sorry — it did arrive, we have received it."):
            ingest(
                setup["intake"],
                reply(
                    sender=setup["sender"],
                    to=setup["reply_to"],
                    subject="Re: Did our payment reach you?",
                    body=body,
                    in_reply_to=setup["message"].message_id,
                ),
            )

        db_session.expire_all()
        refreshed = db_session.get(VendorCheckIn, setup["check_in"].id)
        assert refreshed is not None
        assert refreshed.claim is ClaimOutcome.received

    def test_a_reply_arriving_after_review_does_not_reopen_it(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # The case that would otherwise let an outsider undo a decision. The
        # message is still filed against the check-in, so a person can see it;
        # what it cannot do is change the conclusion.
        setup = scenario(client, api_prefix, db_session, coordinator, finance, vendor)
        check_in: VendorCheckIn = setup["check_in"]

        sign_in(client, finance.email, api_prefix)
        reviewed = client.post(
            f"{api_prefix}/vendor-check-ins/{check_in.id}/review",
            json={"outcome": "outstanding", "note": "Bank statement shows no debit."},
        )
        assert reviewed.status_code == 200, reviewed.text

        db_session.expire_all()
        outcome = ingest(
            build_intake(db_session),
            reply(
                sender=setup["sender"],
                to=setup["reply_to"],
                subject="Re: Did our payment reach you?",
                body="Yes, it came in after all.",
                in_reply_to=setup["message"].message_id,
            ),
        )

        assert outcome.routing is not None
        assert outcome.routing.record_id == check_in.id
        assert outcome.routing.claim_recorded is False

        db_session.expire_all()
        refreshed = db_session.get(VendorCheckIn, check_in.id)
        assert refreshed is not None
        assert refreshed.review_outcome is not None
        assert refreshed.claim is None
