"""Vendor payment confirmation end to end.

The point of this phase is a gap in the money's story: submitting a package
records that an instruction went to the bank, and nothing yet records that
anybody was paid. Closing it means asking somebody outside the organisation, and
the tests here are mostly about being careful with what they say back.

Five behaviours carry the design.

*A supplier's link authorises nothing.* The unauthenticated page records a claim
and cannot move an invoice. Every route to Paid runs through a signed-in
reviewer holding `payment:mark_paid`, and the test that matters most is the one
proving a supplier saying "yes" leaves every invoice exactly where it was.

*Every refusal on the public door looks identical.* Unknown, expired, spent and
issued-to-a-colleague all return one status and one sentence, because the
alternative tells a stranger which tokens are real.

*Sending money and confirming it arrived are different people.* Segregation of
duties forbids `payment:submit` alongside `payment:mark_paid`, so the
coordinator who sent the package can ask the supplier and cannot conclude.

*Silence is not payment.* An unanswered check-in never drifts into looking
settled, and the suggestion says so once the chasing has run out.

*Nothing answers a machine.* An out-of-office threads onto the check-in and is
never read as a claim.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from tests.conftest import (
    make_invoice,
    make_user,
    make_vendor,
    requires_db,
    sign_in,
)

from finora.domain.roles import Role
from finora.domain.workflow import WorkflowState
from finora.infrastructure.db.models import (
    Invoice,
    OutboxMessage,
    SignedLink,
    User,
    Vendor,
    VendorCheckIn,
)

pytestmark = [pytest.mark.integration, requires_db]


# ------------------------------------------------------------------- fixtures


@pytest.fixture
def coordinator(db_session: Session) -> User:
    """Assembles and sends packages, and asks suppliers. Cannot conclude."""
    return make_user(
        db_session,
        email="pat.payments@example.com",
        display_name="Pat Payments",
        roles=[Role.payment_coordinator],
        department="Finance",
    )


@pytest.fixture
def finance(db_session: Session) -> User:
    """Holds `payment:mark_paid`. The only role that can conclude a check-in."""
    return make_user(
        db_session,
        email="fern.finance@example.com",
        display_name="Fern Finance",
        roles=[Role.finance],
        department="Finance",
    )


@pytest.fixture
def onlooker(db_session: Session) -> User:
    return make_user(
        db_session,
        email="rita.requester@example.com",
        display_name="Rita Requester",
        roles=[Role.requester],
        department="Operations",
    )


@pytest.fixture
def vendor(db_session: Session) -> Vendor:
    return make_vendor(db_session)


@pytest.fixture
def other_vendor(db_session: Session) -> Vendor:
    return make_vendor(db_session, code="V-200", name="Ackee Trading Company")


# -------------------------------------------------------------------- helpers


def submitted_package(
    client: TestClient,
    api_prefix: str,
    db_session: Session,
    *,
    coordinator: User,
    finance: User,
    vendors: tuple[Vendor, ...],
    currency: str = "JMD",
) -> dict[str, Any]:
    """A package that has gone to the bank, holding one invoice per supplier."""
    invoices = [
        make_invoice(
            db_session,
            recorded_by=finance,
            vendor=each,
            total_minor_units=1_000_000,
            currency=currency,
            invoice_number=f"THEIRS-{index}",
            state=WorkflowState.approved,
        )
        for index, each in enumerate(vendors)
    ]

    sign_in(client, coordinator.email, api_prefix)
    package = client.post(
        f"{api_prefix}/payment-packages",
        json={
            "description": "Friday run",
            "payment_method": "bank_transfer",
            # Far enough ahead that a slow run cannot pass it and turn every
            # test in this file into a validation failure.
            "intended_payment_date": (datetime.now(UTC).date() + timedelta(days=7)).isoformat(),
        },
    ).json()

    added = client.post(
        f"{api_prefix}/payment-packages/{package['id']}/lines",
        json={"invoice_ids": [str(invoice.id) for invoice in invoices]},
    )
    assert added.status_code == 200, added.text

    sent = client.post(
        f"{api_prefix}/payment-packages/{package['id']}/submit",
        json={"submission_reference": "BANK-778899"},
    )
    assert sent.status_code == 200, sent.text
    body: dict[str, Any] = sent.json()["package"]
    return body


def raise_check_ins(client: TestClient, api_prefix: str, package_id: str) -> dict[str, Any]:
    response = client.post(f"{api_prefix}/vendor-check-ins", json={"package_id": package_id})
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def token_of(db_session: Session, check_in_id: str) -> str:
    """The raw token cannot be read back, so the test issues its own.

    The digest is all the platform keeps, exactly as it would for a password.
    Rather than weaken that for testing, this mints a link through the same
    service the mail path uses and returns what the supplier would have been
    sent.
    """
    from uuid import UUID, uuid4

    from finora.application.signed_links import SignedLinkService
    from finora.domain.reminders import ReminderPurpose
    from finora.infrastructure.audit_repository import AuditRepository

    check_in = db_session.get(VendorCheckIn, UUID(check_in_id))
    assert check_in is not None
    links = SignedLinkService(
        session=db_session,
        audit=AuditRepository(db_session),
        web_base_url="https://finora.example",
    )
    issued = links.issue_to_vendor(
        record_type="vendor_check_in",
        record_id=check_in.id,
        purpose=ReminderPurpose.payment_check_in,
        vendor_id=check_in.vendor_id or check_in.package_id,
        vendor_label=check_in.vendor_name,
        correlation_id=uuid4(),
    )
    db_session.commit()
    return issued.url.rsplit("/", 1)[-1]


def states_of(db_session: Session, package_id: str) -> set[WorkflowState]:
    from uuid import UUID

    from finora.infrastructure.db.models import PaymentPackageLine

    rows = db_session.execute(
        select(Invoice.state)
        .join(PaymentPackageLine, PaymentPackageLine.invoice_id == Invoice.id)
        .where(PaymentPackageLine.package_id == UUID(package_id))
    ).scalars()
    return set(rows)


# -------------------------------------------------------------------- raising


class TestRaising:
    def test_one_check_in_per_supplier_not_per_invoice(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
        other_vendor: Vendor,
    ) -> None:
        # A bank pays a batch as one credit, so a supplier with several invoices
        # in the package saw one deposit. Asking per invoice would be asking a
        # question they can only answer by doing our arithmetic.
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor, other_vendor, vendor),
        )

        result = raise_check_ins(client, api_prefix, package["id"])

        assert len(result["raised"]) == 2
        assert {row["vendor_name"] for row in result["raised"]} == {
            vendor.name,
            other_vendor.name,
        }

    def test_a_check_in_covers_every_invoice_for_that_supplier(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor, vendor, vendor),
        )

        raised = raise_check_ins(client, api_prefix, package["id"])["raised"]

        assert raised[0]["invoice_count"] == 3

    def test_raising_twice_names_who_was_already_asked(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # "Nothing happened" and "nothing needed to happen" look identical
        # otherwise, and the second one is not an error.
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor,),
        )
        raise_check_ins(client, api_prefix, package["id"])

        again = raise_check_ins(client, api_prefix, package["id"])

        assert again["raised"] == []
        assert again["already_raised"] == [vendor.name]

    def test_an_unsent_package_cannot_be_asked_about(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # Nothing has been instructed, so there is nothing a supplier could have
        # received. Asking would invite a "no" that means nothing.
        invoice = make_invoice(
            db_session,
            recorded_by=finance,
            vendor=vendor,
            state=WorkflowState.approved,
        )
        sign_in(client, coordinator.email, api_prefix)
        package = client.post(f"{api_prefix}/payment-packages", json={}).json()
        client.post(
            f"{api_prefix}/payment-packages/{package['id']}/lines",
            json={"invoice_ids": [str(invoice.id)]},
        )

        refused = client.post(f"{api_prefix}/vendor-check-ins", json={"package_id": package["id"]})

        assert refused.status_code == 409
        assert "not gone to the bank" in refused.json()["detail"]

    def test_a_requester_cannot_see_the_queue(
        self, client: TestClient, api_prefix: str, onlooker: User
    ) -> None:
        sign_in(client, onlooker.email, api_prefix)

        assert client.get(f"{api_prefix}/vendor-check-ins").status_code == 403


# -------------------------------------------------------------------- sending


class TestSending:
    def test_sending_queues_one_message_with_a_tagged_reply_address(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # The tag in the reply address is what files a reply whose client threw
        # the threading headers away. It is not the link token and opens
        # nothing, which is why it may travel in a header people can see.
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor,),
        )
        check_in = raise_check_ins(client, api_prefix, package["id"])["raised"][0]

        sent = client.post(f"{api_prefix}/vendor-check-ins/{check_in['id']}/send")

        assert sent.status_code == 200
        assert sent.json()["standing"] == "awaiting_vendor"
        queued = db_session.execute(
            select(OutboxMessage).where(OutboxMessage.record_type == "vendor_check_in")
        ).scalar_one()
        assert queued.to_address == vendor.email
        assert queued.reply_to_address is not None
        assert "+fnr" in queued.reply_to_address

    def test_the_email_never_carries_the_token_in_the_subject(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # The subject carries a correlation tag, which identifies a conversation
        # and opens nothing. Putting the link token there would put a credential
        # into every downstream forward of the thread.
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor,),
        )
        check_in = raise_check_ins(client, api_prefix, package["id"])["raised"][0]
        client.post(f"{api_prefix}/vendor-check-ins/{check_in['id']}/send")

        queued = db_session.execute(
            select(OutboxMessage).where(OutboxMessage.record_type == "vendor_check_in")
        ).scalar_one()
        link = db_session.execute(select(SignedLink)).scalars().all()[-1]

        assert link.token_sha256 not in queued.subject
        assert "[FNR-" in queued.subject

    def test_sending_twice_is_refused(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor,),
        )
        check_in = raise_check_ins(client, api_prefix, package["id"])["raised"][0]
        client.post(f"{api_prefix}/vendor-check-ins/{check_in['id']}/send")

        again = client.post(f"{api_prefix}/vendor-check-ins/{check_in['id']}/send")

        assert again.status_code == 409

    def test_a_supplier_with_no_address_is_refused_helpfully(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
    ) -> None:
        # The refusal names the alternative, because there is one: somebody
        # phones them and records the answer by hand.
        silent = make_vendor(db_session, code="V-300", name="Quiet Supplies", email=None)
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(silent,),
        )
        check_in = raise_check_ins(client, api_prefix, package["id"])["raised"][0]

        refused = client.post(f"{api_prefix}/vendor-check-ins/{check_in['id']}/send")

        assert refused.status_code == 422
        assert "record their answer by hand" in refused.json()["detail"]


# ------------------------------------------------------------ the supplier's page


class TestTheVendorPage:
    def test_a_supplier_reaches_it_with_no_session_at_all(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor,),
        )
        check_in = raise_check_ins(client, api_prefix, package["id"])["raised"][0]
        client.post(f"{api_prefix}/vendor-check-ins/{check_in['id']}/send")
        token = token_of(db_session, check_in["id"])
        client.cookies.clear()

        page = client.get(f"{api_prefix}/payment-check-in/{token}")

        assert page.status_code == 200
        assert page.json()["vendor_name"] == vendor.name

    def test_the_page_shows_the_suppliers_own_invoice_numbers(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # They cannot look anything up by our reference, and being asked about
        # "INV-000101" is how a confirmation request gets ignored.
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor,),
        )
        check_in = raise_check_ins(client, api_prefix, package["id"])["raised"][0]
        client.post(f"{api_prefix}/vendor-check-ins/{check_in['id']}/send")
        token = token_of(db_session, check_in["id"])
        client.cookies.clear()

        page = client.get(f"{api_prefix}/payment-check-in/{token}").json()

        assert page["lines"][0]["invoice_number"] == "THEIRS-0"

    def test_the_page_discloses_nothing_about_other_suppliers(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
        other_vendor: Vendor,
    ) -> None:
        # One package, two suppliers, and a page reachable by anybody holding a
        # URL. Each sees their own lines and no hint that the other exists.
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor, other_vendor),
        )
        raised = raise_check_ins(client, api_prefix, package["id"])["raised"]
        mine = next(row for row in raised if row["vendor_name"] == vendor.name)
        client.post(f"{api_prefix}/vendor-check-ins/{mine['id']}/send")
        token = token_of(db_session, mine["id"])
        client.cookies.clear()

        body = client.get(f"{api_prefix}/payment-check-in/{token}").text

        assert other_vendor.name not in body
        assert "BANK-778899" not in body

    def test_opening_the_page_does_not_spend_the_link(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # A supplier reads it, goes to check their bank, and comes back.
        # Burning the token on first view would teach them our links do not
        # work.
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor,),
        )
        check_in = raise_check_ins(client, api_prefix, package["id"])["raised"][0]
        token = token_of(db_session, check_in["id"])
        client.cookies.clear()

        client.get(f"{api_prefix}/payment-check-in/{token}")
        second = client.get(f"{api_prefix}/payment-check-in/{token}")

        assert second.status_code == 200

    def test_an_unknown_token_is_refused_without_saying_why(
        self, client: TestClient, api_prefix: str
    ) -> None:
        client.cookies.clear()

        refused = client.get(f"{api_prefix}/payment-check-in/not-a-real-token")

        assert refused.status_code == 404
        assert refused.json()["detail"] == (
            "This link is no longer usable. It may have expired, or the answer "
            "may already have been recorded. Replying to the email we sent you "
            "will reach the right people."
        )

    def test_a_spent_token_is_refused_in_the_same_words(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # The whole point of one message: a holder cannot tell a token that was
        # real and is now spent from one that never existed.
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor,),
        )
        check_in = raise_check_ins(client, api_prefix, package["id"])["raised"][0]
        client.post(f"{api_prefix}/vendor-check-ins/{check_in['id']}/send")
        token = token_of(db_session, check_in["id"])
        client.cookies.clear()
        client.post(
            f"{api_prefix}/payment-check-in/{token}",
            json={"claim": "received", "respondent_name": "Marcia"},
        )

        unknown = client.get(f"{api_prefix}/payment-check-in/nonsense").json()["detail"]
        spent = client.get(f"{api_prefix}/payment-check-in/{token}")

        assert spent.status_code == 404
        assert spent.json()["detail"] == unknown


# --------------------------------------------------------------- the claim itself


class TestTheClaim:
    def test_a_supplier_saying_yes_moves_no_invoice(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # The single most important assertion in this file. A link that marked
        # invoices paid on possession alone would be email authorising a
        # financial action, which is what ADR 8 and ADR 9 exist to refuse.
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor,),
        )
        check_in = raise_check_ins(client, api_prefix, package["id"])["raised"][0]
        client.post(f"{api_prefix}/vendor-check-ins/{check_in['id']}/send")
        token = token_of(db_session, check_in["id"])
        client.cookies.clear()

        answered = client.post(
            f"{api_prefix}/payment-check-in/{token}",
            json={"claim": "received", "respondent_name": "Marcia Brown"},
        )

        assert answered.status_code == 200
        db_session.expire_all()
        assert states_of(db_session, package["id"]) == {WorkflowState.submitted}

    def test_the_supplier_is_told_a_person_will_check_it(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # A page that just says "thank you" implies the matter is closed, and it
        # is not: nothing has been concluded yet.
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor,),
        )
        check_in = raise_check_ins(client, api_prefix, package["id"])["raised"][0]
        client.post(f"{api_prefix}/vendor-check-ins/{check_in['id']}/send")
        token = token_of(db_session, check_in["id"])
        client.cookies.clear()

        message = client.post(
            f"{api_prefix}/payment-check-in/{token}",
            json={"claim": "received", "respondent_name": "Marcia Brown"},
        ).json()["message"]

        assert "accounts team will check it" in message

    def test_the_claim_reaches_the_review_queue(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor,),
        )
        check_in = raise_check_ins(client, api_prefix, package["id"])["raised"][0]
        client.post(f"{api_prefix}/vendor-check-ins/{check_in['id']}/send")
        token = token_of(db_session, check_in["id"])
        client.cookies.clear()
        client.post(
            f"{api_prefix}/payment-check-in/{token}",
            json={
                "claim": "received",
                "respondent_name": "Marcia Brown",
                "note": "Came in on the 14th.",
            },
        )

        sign_in(client, finance.email, api_prefix)
        detail = client.get(f"{api_prefix}/vendor-check-ins/{check_in['id']}").json()

        assert detail["standing"] == "vendor_answered"
        assert detail["claim"] == "received"
        assert detail["claim_channel"] == "signed_link"
        assert detail["respondent_name"] == "Marcia Brown"
        assert detail["respondent_note"] == "Came in on the 14th."

    def test_no_green_paid_before_a_review(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # The design standard forbids a Paid state before the review condition
        # is met. `confirmed_paid` is that condition, and a supplier's
        # enthusiasm is not part of it.
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor,),
        )
        check_in = raise_check_ins(client, api_prefix, package["id"])["raised"][0]
        client.post(f"{api_prefix}/vendor-check-ins/{check_in['id']}/send")
        token = token_of(db_session, check_in["id"])
        client.cookies.clear()
        client.post(
            f"{api_prefix}/payment-check-in/{token}",
            json={"claim": "received", "respondent_name": "Marcia"},
        )

        sign_in(client, finance.email, api_prefix)
        detail = client.get(f"{api_prefix}/vendor-check-ins/{check_in['id']}").json()

        assert detail["confirmed_paid"] is False

    def test_the_suggestion_is_offered_and_hedged(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor,),
        )
        check_in = raise_check_ins(client, api_prefix, package["id"])["raised"][0]
        client.post(f"{api_prefix}/vendor-check-ins/{check_in['id']}/send")
        token = token_of(db_session, check_in["id"])
        client.cookies.clear()
        client.post(
            f"{api_prefix}/payment-check-in/{token}",
            json={"claim": "received", "respondent_name": "Marcia"},
        )

        sign_in(client, finance.email, api_prefix)
        detail = client.get(f"{api_prefix}/vendor-check-ins/{check_in['id']}").json()

        assert detail["suggestion"]["outcome"] == "paid"
        assert "their claim" in detail["suggestion"]["because"]
        # Offered, never applied: nothing has been reviewed.
        assert detail["review_outcome"] is None

    def test_staff_can_record_what_a_supplier_said_by_phone(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # Recorded as a claim like any other, with the channel saying a member
        # of staff typed it. Still not a review.
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor,),
        )
        check_in = raise_check_ins(client, api_prefix, package["id"])["raised"][0]
        client.post(f"{api_prefix}/vendor-check-ins/{check_in['id']}/send")

        recorded = client.post(
            f"{api_prefix}/vendor-check-ins/{check_in['id']}/answer",
            json={
                "claim": "not_received",
                "respondent_name": "Marcia Brown",
                "note": "Rang in, nothing on their statement.",
            },
        )

        assert recorded.status_code == 200
        assert recorded.json()["claim_channel"] == "recorded_by_staff"
        assert recorded.json()["standing"] == "vendor_answered"


# -------------------------------------------------------------------- reviewing


class TestReviewing:
    def test_finance_concluding_paid_moves_the_invoices(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor,),
        )
        check_in = raise_check_ins(client, api_prefix, package["id"])["raised"][0]
        client.post(f"{api_prefix}/vendor-check-ins/{check_in['id']}/send")

        sign_in(client, finance.email, api_prefix)
        reviewed = client.post(
            f"{api_prefix}/vendor-check-ins/{check_in['id']}/review",
            json={"outcome": "paid", "note": "Matches the statement."},
        )

        assert reviewed.status_code == 200
        assert reviewed.json()["standing"] == "reviewed"
        db_session.expire_all()
        assert states_of(db_session, package["id"]) == {WorkflowState.paid}

    def test_only_then_may_a_screen_show_paid(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor,),
        )
        check_in = raise_check_ins(client, api_prefix, package["id"])["raised"][0]
        client.post(f"{api_prefix}/vendor-check-ins/{check_in['id']}/send")

        sign_in(client, finance.email, api_prefix)
        reviewed = client.post(
            f"{api_prefix}/vendor-check-ins/{check_in['id']}/review",
            json={"outcome": "paid"},
        )

        assert reviewed.json()["confirmed_paid"] is True

    def test_outstanding_moves_the_invoices_somewhere_visible(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # Not left in `submitted`. An invoice the supplier says never arrived
        # has to be distinguishable from one nobody has asked about.
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor,),
        )
        check_in = raise_check_ins(client, api_prefix, package["id"])["raised"][0]
        client.post(f"{api_prefix}/vendor-check-ins/{check_in['id']}/send")

        sign_in(client, finance.email, api_prefix)
        client.post(
            f"{api_prefix}/vendor-check-ins/{check_in['id']}/review",
            json={"outcome": "outstanding", "note": "Nothing on the statement."},
        )

        db_session.expire_all()
        assert states_of(db_session, package["id"]) == {WorkflowState.outstanding}

    def test_a_reviewer_may_conclude_against_the_claim(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # The supplier says yes; the bank statement says otherwise. Nothing in
        # the design should make disagreeing awkward — it is the case the review
        # step exists for.
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor,),
        )
        check_in = raise_check_ins(client, api_prefix, package["id"])["raised"][0]
        client.post(f"{api_prefix}/vendor-check-ins/{check_in['id']}/send")
        token = token_of(db_session, check_in["id"])
        client.cookies.clear()
        client.post(
            f"{api_prefix}/payment-check-in/{token}",
            json={"claim": "received", "respondent_name": "Marcia"},
        )

        sign_in(client, finance.email, api_prefix)
        reviewed = client.post(
            f"{api_prefix}/vendor-check-ins/{check_in['id']}/review",
            json={"outcome": "outstanding", "note": "Not on our statement."},
        )

        assert reviewed.status_code == 200
        db_session.expire_all()
        assert states_of(db_session, package["id"]) == {WorkflowState.outstanding}

    def test_the_coordinator_who_sent_the_money_cannot_declare_it_paid(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # Segregation of duties, at the point it matters most: whoever sent the
        # instruction is never the person who confirms it arrived.
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor,),
        )
        check_in = raise_check_ins(client, api_prefix, package["id"])["raised"][0]
        client.post(f"{api_prefix}/vendor-check-ins/{check_in['id']}/send")

        refused = client.post(
            f"{api_prefix}/vendor-check-ins/{check_in['id']}/review",
            json={"outcome": "paid"},
        )

        assert refused.status_code == 403

    def test_nothing_is_reviewed_twice(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor,),
        )
        check_in = raise_check_ins(client, api_prefix, package["id"])["raised"][0]
        client.post(f"{api_prefix}/vendor-check-ins/{check_in['id']}/send")
        sign_in(client, finance.email, api_prefix)
        client.post(
            f"{api_prefix}/vendor-check-ins/{check_in['id']}/review",
            json={"outcome": "paid"},
        )

        again = client.post(
            f"{api_prefix}/vendor-check-ins/{check_in['id']}/review",
            json={"outcome": "outstanding"},
        )

        assert again.status_code == 409

    def test_a_late_answer_does_not_reopen_a_conclusion(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # The race that actually happens: a reviewer concludes from the bank
        # statement while the supplier's reply is in flight.
        package = submitted_package(
            client,
            api_prefix,
            db_session,
            coordinator=coordinator,
            finance=finance,
            vendors=(vendor,),
        )
        check_in = raise_check_ins(client, api_prefix, package["id"])["raised"][0]
        client.post(f"{api_prefix}/vendor-check-ins/{check_in['id']}/send")
        token = token_of(db_session, check_in["id"])
        sign_in(client, finance.email, api_prefix)
        client.post(
            f"{api_prefix}/vendor-check-ins/{check_in['id']}/review",
            json={"outcome": "paid"},
        )
        client.cookies.clear()

        late = client.post(
            f"{api_prefix}/payment-check-in/{token}",
            json={"claim": "not_received", "respondent_name": "Marcia"},
        )

        assert late.status_code == 409
        db_session.expire_all()
        assert states_of(db_session, package["id"]) == {WorkflowState.paid}
