"""The invoice lifecycle over HTTP, from a recorded document to an approval route.

Four properties are guarded here, and each is a control that exists to stop money
going somewhere it should not.

*The same invoice cannot be paid twice.* Checked from both ends: the register
refuses a second live invoice with the same vendor and number, and the check runs
again at sign-off, so a duplicate recorded while the first sat in somebody's inbox
is caught before it reaches approvers.

*An approval covers a figure, not an intention.* An invoice above the estimate that
approved it is refused, and above the purchase order it is billed against, counting
what other live invoices have already claimed.

*Nobody confirms receipt of their own paperwork.* Whoever recorded or submitted the
invoice is refused at sign-off by segregation of duties, and the button is absent
before they press it.

*A link proves where to go and nothing else.* Following one requires a session, is
refused for anybody but its recipient, works once, and confers no authority: the
sign-off it leads to is authorised against the session exactly as from the register.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from tests.conftest import (
    assign_approver,
    make_cost_centre,
    make_purchase_order,
    make_user,
    make_vendor,
    requires_db,
    sign_in,
)
from tests.integration.test_document_pipeline import (
    INVOICE,
    build_pipeline,
    ingest_document,
)
from tests.integration.test_intake_service import FakeObjectStore

from finora.application.invoices import RECORD_TYPE
from finora.application.reminder_tasks import build_services
from finora.domain.audit import AuditAction
from finora.domain.notifications import MessageKind
from finora.domain.reminders import ReminderPurpose
from finora.domain.roles import ApprovalLevel, Role
from finora.domain.workflow import WorkflowState
from finora.infrastructure.db.models import (
    AuditEntryRow,
    Document,
    Estimate,
    Invoice,
    OutboxMessage,
    ReminderSchedule,
    SignedLink,
    User,
    Vendor,
)

pytestmark = [pytest.mark.integration, requires_db]

#: Below the JMD 50,000 purchase order threshold, and inside the Unit Head band.
SMALL = 4_000_000
#: Above the JMD 50,000 threshold, so a purchase order is required.
LARGE = 60_000_000

TODAY = date(2026, 8, 1)


# ------------------------------------------------------------------ fixtures


@pytest.fixture
def finance(db_session: Session) -> User:
    """Records invoices and submits them for confirmation. Never signs them off."""
    return make_user(
        db_session,
        email="fiona.finance@example.com",
        display_name="Fiona Finance",
        roles=[Role.finance],
        department="Finance",
    )


@pytest.fixture
def requester(db_session: Session) -> User:
    """Asked for the goods, so the only person who can say they arrived."""
    return make_user(
        db_session,
        email="rita.requester@example.com",
        display_name="Rita Requester",
        roles=[Role.requester],
        department="Facilities",
    )


@pytest.fixture
def unit_head(db_session: Session) -> User:
    user = make_user(
        db_session,
        email="ursula.head@example.com",
        display_name="Ursula Head",
        roles=[Role.approver],
        department="Facilities",
    )
    assign_approver(db_session, user=user, level=ApprovalLevel.unit_head)
    return user


@pytest.fixture
def vendor(db_session: Session) -> Vendor:
    return make_vendor(db_session)


@pytest.fixture
def cost_centre_id(db_session: Session) -> str:
    return str(make_cost_centre(db_session).id)


# ------------------------------------------------------------------- helpers


def draft_payload(
    *,
    vendor_id: str,
    cost_centre_id: str,
    requester_id: str,
    total_minor_units: int = SMALL,
    currency: str = "JMD",
    invoice_number: str = "INV-8891",
    estimate_id: str | None = None,
    purchase_order_id: str | None = None,
    due_date: str | None = "2026-08-31",
) -> dict[str, Any]:
    """Everything the validation rules require, and nothing they do not."""
    return {
        "vendor_name": "Kingston Supplies Limited",
        "description": "Replacement air handling unit for the third floor",
        "vendor_id": vendor_id,
        "invoice_number": invoice_number,
        "invoice_date": "2026-08-01",
        "due_date": due_date,
        "total_minor_units": total_minor_units,
        "currency": currency,
        "estimate_id": estimate_id,
        "purchase_order_id": purchase_order_id,
        "cost_centre_id": cost_centre_id,
        "requester_id": requester_id,
    }


def record_invoice(
    client: TestClient,
    api_prefix: str,
    *,
    vendor: Vendor,
    cost_centre_id: str,
    requester: User,
    **overrides: Any,
) -> dict[str, Any]:
    """Record a complete draft invoice, ready to be sent for confirmation."""
    created = client.post(f"{api_prefix}/invoices", json={})
    assert created.status_code == 201, created.text
    invoice_id = created.json()["id"]

    payload = draft_payload(
        vendor_id=str(vendor.id),
        cost_centre_id=cost_centre_id,
        requester_id=str(requester.id),
        **overrides,
    )
    updated = client.put(f"{api_prefix}/invoices/{invoice_id}", json=payload)
    assert updated.status_code == 200, updated.text
    body: dict[str, Any] = updated.json()
    return body


def awaiting_sign_off(
    client: TestClient,
    api_prefix: str,
    *,
    finance: User,
    vendor: Vendor,
    cost_centre_id: str,
    requester: User,
    **overrides: Any,
) -> dict[str, Any]:
    """An invoice sitting with its requester, chased by a live reminder cycle."""
    sign_in(client, finance.email, api_prefix)
    invoice = record_invoice(
        client,
        api_prefix,
        vendor=vendor,
        cost_centre_id=cost_centre_id,
        requester=requester,
        **overrides,
    )
    response = client.post(f"{api_prefix}/invoices/{invoice['id']}/request-sign-off")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def approved_estimate(
    session: Session,
    *,
    requester: User,
    vendor: Vendor,
    cost_centre_id: str,
    total_minor_units: int = SMALL,
    currency: str = "JMD",
    state: WorkflowState = WorkflowState.approved,
) -> Estimate:
    """An approved spend for an invoice to draw against.

    Written directly rather than driven through the estimate endpoints. This file
    is testing what an invoice does with an approval, and routing one through four
    approvers to get it would make every such test depend on the estimate
    workflow's fixtures as well as its own.
    """
    row = Estimate(
        id=uuid.uuid4(),
        reference=f"EST-{uuid.uuid4().hex[:6].upper()}",
        state=state,
        requester_id=requester.id,
        vendor_id=vendor.id,
        vendor_name=vendor.name,
        description="Replacement air handling unit for the third floor",
        justification="The existing unit has failed and cannot be repaired.",
        estimate_number="Q-4471",
        estimate_date=TODAY,
        total_minor_units=total_minor_units,
        currency=currency,
        cost_centre_id=uuid.UUID(cost_centre_id),
        department="Facilities",
        # Anything past draft carries who submitted it and when: the database
        # refuses an approved estimate that nobody submitted, which is the point.
        submitted_at=datetime.now(UTC),
        submitted_by_id=requester.id,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def problems_of(invoice: dict[str, Any]) -> set[str]:
    return {problem["problem"] for problem in invoice["problems"]}


def live_link(session: Session, invoice_id: str) -> SignedLink:
    return session.execute(
        select(SignedLink).where(
            SignedLink.record_id == uuid.UUID(invoice_id),
            SignedLink.used_at.is_(None),
            SignedLink.revoked_at.is_(None),
        )
    ).scalar_one()


def token_for(session: Session, invoice_id: str, *, service_session: Session) -> str:
    """Mint a link the way the service does, keeping the secret this test needs.

    The token is never returned by the API — deliberately, since it is a
    single-use credential and the caller asking for confirmation is not the person
    who needs it. So a test that needs one issues it directly.
    """
    invoice = service_session.get(Invoice, uuid.UUID(invoice_id))
    assert invoice is not None and invoice.requester_id is not None
    recipient = service_session.get(User, invoice.requester_id)
    assert recipient is not None

    services = build_services(service_session)
    issued = services.links.issue(
        record_type=RECORD_TYPE,
        record_id=invoice.id,
        purpose=ReminderPurpose.sign_off,
        issued_to=recipient,
        correlation_id=uuid.uuid4(),
    )
    service_session.commit()
    return issued.url.rsplit("/", 1)[1]


# ------------------------------------------------------------- authentication


class TestWhoMayReachTheseEndpoints:
    def test_an_unauthenticated_caller_sees_nothing(
        self, client: TestClient, api_prefix: str
    ) -> None:
        assert client.get(f"{api_prefix}/invoices").status_code == 401
        assert client.post(f"{api_prefix}/invoices", json={}).status_code == 401
        assert (
            client.post(f"{api_prefix}/links/resolve", json={"token": "anything"}).status_code
            == 401
        )

    def test_a_role_without_the_permission_is_refused_and_recorded(
        self, client: TestClient, api_prefix: str, db_session: Session
    ) -> None:
        make_user(
            db_session,
            email="olive.ops@example.com",
            display_name="Olive Ops",
            roles=[Role.operations],
        )
        sign_in(client, "olive.ops@example.com", api_prefix)

        assert client.post(f"{api_prefix}/invoices", json={}).status_code == 403

        denials = (
            db_session.execute(
                select(AuditEntryRow).where(AuditEntryRow.action == AuditAction.permission_denied)
            )
            .scalars()
            .all()
        )
        assert [entry.detail["permission"] for entry in denials] == ["invoice:create"]

    def test_a_requester_sees_only_invoices_they_are_named_on(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        finance: User,
        requester: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        """A supplier's pricing is not general reading inside the organisation."""
        other = make_user(
            db_session,
            email="owen.other@example.com",
            display_name="Owen Other",
            roles=[Role.requester],
            department="Facilities",
        )
        mine = awaiting_sign_off(
            client,
            api_prefix,
            finance=finance,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
        )

        sign_in(client, other.email, api_prefix)
        listed = client.get(f"{api_prefix}/invoices")
        assert listed.status_code == 200
        assert listed.json()["items"] == []

        # And by identifier it is a 404, not a 403: a 403 on a record they may not
        # see would confirm that reference exists, and references are sequential.
        assert client.get(f"{api_prefix}/invoices/{mine['id']}").status_code == 404


# -------------------------------------------------------------- recording


class TestRecordingAnInvoice:
    def accept(self, client: TestClient, api_prefix: str, document: Document) -> None:
        response = client.post(f"{api_prefix}/documents/{document.id}/accept", json={})
        assert response.status_code == 200, response.text

    def test_an_accepted_reading_becomes_a_draft_carrying_what_was_read(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        finance: User,
    ) -> None:
        document = read_document(db_session)
        sign_in(client, finance.email, api_prefix)
        self.accept(client, api_prefix, document)

        response = client.post(f"{api_prefix}/invoices", json={"document_id": str(document.id)})

        assert response.status_code == 201, response.text
        body = response.json()
        assert body["state"] == WorkflowState.draft
        assert body["document_id"] == str(document.id)
        assert body["invoice_number"]
        assert body["total_minor_units"]

    def test_a_reading_nobody_has_accepted_is_refused(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        finance: User,
    ) -> None:
        """This is the record a payment is made against, so unconfirmed values
        cannot be its starting point."""
        document = read_document(db_session)
        sign_in(client, finance.email, api_prefix)
        response = client.post(f"{api_prefix}/invoices", json={"document_id": str(document.id)})

        assert response.status_code == 409
        assert "accepted" in response.json()["detail"]

    def test_the_same_document_cannot_be_recorded_twice(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        finance: User,
    ) -> None:
        document = read_document(db_session)
        sign_in(client, finance.email, api_prefix)
        self.accept(client, api_prefix, document)

        first = client.post(f"{api_prefix}/invoices", json={"document_id": str(document.id)})
        assert first.status_code == 201

        second = client.post(f"{api_prefix}/invoices", json={"document_id": str(document.id)})
        assert second.status_code == 409
        assert first.json()["reference"] in second.json()["detail"]

    def test_a_blank_draft_reports_what_is_missing_without_being_submitted(
        self, client: TestClient, api_prefix: str, finance: User
    ) -> None:
        """The whole remaining task on the first read, not one refusal at a time."""
        sign_in(client, finance.email, api_prefix)
        body = client.post(f"{api_prefix}/invoices", json={}).json()

        # One problem per gap: an empty vendor name is reported as missing, not
        # also as absent from the master, because there is one thing to do about it.
        assert problems_of(body) == {
            "vendor_missing",
            "invoice_number_missing",
            "invoice_date_missing",
            "amount_missing",
            "description_missing",
            "cost_centre_missing",
            "requester_missing",
        }
        assert body["actions"]["may_request_sign_off"] is False
        # Each problem names the control to focus, so the form cannot drift from
        # the rule that refers to it.
        assert all(problem["field"] for problem in body["problems"])


# --------------------------------------------------------------- validation


class TestTheControlsThatStopAPayment:
    def test_a_second_live_invoice_with_the_same_number_is_refused(
        self,
        client: TestClient,
        api_prefix: str,
        finance: User,
        requester: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        """Paying the same invoice twice is what this platform exists to prevent."""
        sign_in(client, finance.email, api_prefix)
        record_invoice(
            client,
            api_prefix,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
        )
        duplicate = record_invoice(
            client,
            api_prefix,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
        )

        assert "duplicate_invoice_number" in problems_of(duplicate)
        assert duplicate["blocker_count"] >= 1
        # Distinguished from an unfinished form, because nobody else will chase it.
        blocking = {
            problem["problem"] for problem in duplicate["problems"] if problem["is_blocking"]
        }
        assert "duplicate_invoice_number" in blocking

        refused = client.post(f"{api_prefix}/invoices/{duplicate['id']}/request-sign-off")
        assert refused.status_code == 422
        assert "duplicate_invoice_number" in {
            problem["problem"] for problem in refused.json()["problems"]
        }

    def test_a_cancelled_invoice_frees_its_number_for_another(
        self,
        client: TestClient,
        api_prefix: str,
        finance: User,
        requester: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        """A demand that was refused does not consume the number it claimed."""
        sign_in(client, finance.email, api_prefix)
        first = record_invoice(
            client,
            api_prefix,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
        )
        cancelled = client.post(
            f"{api_prefix}/invoices/{first['id']}/cancel",
            json={"reason": "Recorded in error against the wrong supplier."},
        )
        assert cancelled.status_code == 200, cancelled.text

        second = record_invoice(
            client,
            api_prefix,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
        )
        assert "duplicate_invoice_number" not in problems_of(second)

    def test_an_invoice_above_its_estimate_is_stopped(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        finance: User,
        requester: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        """The approval covers the smaller figure, so this needs deciding again."""
        estimate = approved_estimate(
            db_session,
            requester=requester,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            total_minor_units=SMALL,
        )
        sign_in(client, finance.email, api_prefix)

        invoice = record_invoice(
            client,
            api_prefix,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
            total_minor_units=SMALL * 2,
            estimate_id=str(estimate.id),
        )

        assert "exceeds_estimate" in problems_of(invoice)
        # The remaining figure is reported rather than left to the reviewer to
        # work out, and goes negative rather than clamping at zero.
        assert invoice["estimate"]["remaining_minor_units"] == SMALL - SMALL * 2

    def test_an_unapproved_estimate_cannot_be_drawn_against(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        finance: User,
        requester: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        estimate = approved_estimate(
            db_session,
            requester=requester,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            state=WorkflowState.pending_approval,
        )
        sign_in(client, finance.email, api_prefix)

        invoice = record_invoice(
            client,
            api_prefix,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
            estimate_id=str(estimate.id),
        )

        assert "estimate_not_approved" in problems_of(invoice)

    def test_spend_above_the_threshold_needs_a_purchase_order(
        self,
        client: TestClient,
        api_prefix: str,
        finance: User,
        requester: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        sign_in(client, finance.email, api_prefix)
        invoice = record_invoice(
            client,
            api_prefix,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
            total_minor_units=LARGE,
        )

        assert "purchase_order_required" in problems_of(invoice)

    def test_an_order_already_billed_to_its_limit_takes_no_more(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        finance: User,
        requester: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        """The order's capacity is measured across every live invoice on it, not
        against each one in isolation."""
        order = make_purchase_order(
            db_session, vendor=vendor, total_minor_units=LARGE, currency="JMD"
        )
        sign_in(client, finance.email, api_prefix)

        record_invoice(
            client,
            api_prefix,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
            total_minor_units=LARGE,
            invoice_number="INV-FIRST",
            purchase_order_id=str(order.id),
        )
        second = record_invoice(
            client,
            api_prefix,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
            total_minor_units=LARGE,
            invoice_number="INV-SECOND",
            purchase_order_id=str(order.id),
        )

        assert "exceeds_purchase_order" in problems_of(second)
        assert second["purchase_order"]["billed_by_others_minor_units"] == LARGE
        assert second["purchase_order"]["remaining_minor_units"] == 0

    def test_a_closed_order_cannot_take_further_invoices(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        finance: User,
        requester: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        order = make_purchase_order(
            db_session,
            vendor=vendor,
            total_minor_units=LARGE,
            is_closed=True,
        )
        sign_in(client, finance.email, api_prefix)

        invoice = record_invoice(
            client,
            api_prefix,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
            total_minor_units=LARGE,
            purchase_order_id=str(order.id),
        )

        assert "purchase_order_not_open" in problems_of(invoice)

    def test_a_supplier_not_on_the_master_cannot_be_paid(
        self,
        client: TestClient,
        api_prefix: str,
        finance: User,
        requester: User,
        cost_centre_id: str,
    ) -> None:
        """A name in free text is enough for an estimate and not for a payment."""
        sign_in(client, finance.email, api_prefix)
        created = client.post(f"{api_prefix}/invoices", json={}).json()
        response = client.put(
            f"{api_prefix}/invoices/{created['id']}",
            json={
                "vendor_name": "Somebody Nobody Has Recorded",
                "description": "Replacement air handling unit for the third floor",
                "invoice_number": "INV-9001",
                "invoice_date": "2026-08-01",
                "total_minor_units": SMALL,
                "currency": "JMD",
                "cost_centre_id": cost_centre_id,
                "requester_id": str(requester.id),
            },
        )

        assert response.status_code == 200, response.text
        assert "vendor_not_on_master" in problems_of(response.json())

    def test_a_reference_to_something_absent_is_refused_rather_than_stored(
        self,
        client: TestClient,
        api_prefix: str,
        finance: User,
        requester: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        sign_in(client, finance.email, api_prefix)
        created = client.post(f"{api_prefix}/invoices", json={}).json()

        response = client.put(
            f"{api_prefix}/invoices/{created['id']}",
            json=draft_payload(
                vendor_id=str(vendor.id),
                cost_centre_id=cost_centre_id,
                requester_id=str(requester.id),
                purchase_order_id=str(uuid.uuid4()),
            ),
        )

        assert response.status_code == 422
        assert "purchase order" in response.json()["detail"]


# ------------------------------------------------------------------ sign-off


class TestAskingForReceiptConfirmation:
    def test_a_complete_invoice_goes_to_its_requester_with_a_link_and_a_clock(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        finance: User,
        requester: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        """One transaction: the state, the message, the link and the chasing."""
        invoice = awaiting_sign_off(
            client,
            api_prefix,
            finance=finance,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
        )

        assert invoice["state"] == WorkflowState.pending_sign_off
        assert invoice["sign_off"]["requester_label"] == "Rita Requester"
        assert invoice["sign_off"]["requested_at"] is not None

        queued = db_session.execute(
            select(OutboxMessage).where(OutboxMessage.record_id == uuid.UUID(invoice["id"]))
        ).scalar_one()
        assert queued.kind is MessageKind.sign_off_request
        assert queued.to_address == requester.email
        # The document itself stays behind authentication: an invoice is
        # commercially sensitive and email is the channel nobody controls copies of.
        assert "http" in queued.body_text

        schedule = db_session.execute(
            select(ReminderSchedule).where(
                ReminderSchedule.record_id == uuid.UUID(invoice["id"]),
                ReminderSchedule.stopped_at.is_(None),
            )
        ).scalar_one()
        assert schedule.purpose is ReminderPurpose.sign_off
        assert schedule.next_due_at is not None

        assert live_link(db_session, invoice["id"]).issued_to_id == requester.id

    def test_the_link_never_appears_in_the_response(
        self,
        client: TestClient,
        api_prefix: str,
        finance: User,
        requester: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        """A single-use credential does not belong in a browser's network log."""
        invoice = awaiting_sign_off(
            client,
            api_prefix,
            finance=finance,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
        )
        assert "/link/" not in str(invoice)

    def test_an_invoice_with_nobody_assigned_cannot_be_sent_anywhere(
        self,
        client: TestClient,
        api_prefix: str,
        finance: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        sign_in(client, finance.email, api_prefix)
        created = client.post(f"{api_prefix}/invoices", json={}).json()
        client.put(
            f"{api_prefix}/invoices/{created['id']}",
            json={
                "vendor_name": vendor.name,
                "description": "Replacement air handling unit for the third floor",
                "vendor_id": str(vendor.id),
                "invoice_number": "INV-8891",
                "invoice_date": "2026-08-01",
                "total_minor_units": SMALL,
                "currency": "JMD",
                "cost_centre_id": cost_centre_id,
            },
        )

        response = client.post(f"{api_prefix}/invoices/{created['id']}/request-sign-off")

        assert response.status_code == 422
        # Refused as an ordinary gap, in the same shape as every other gap, so the
        # form marks the selector that is empty. Reported as a one-off sentence it
        # would arrive as a banner pointing at nothing in particular.
        refused = response.json()["problems"]
        assert [problem["problem"] for problem in refused] == ["requester_missing"]
        assert refused[0]["field"] == "requester_id"
        assert "confirm" in refused[0]["explanation"]

    def test_an_invoice_with_sign_off_pending_cannot_be_edited(
        self,
        client: TestClient,
        api_prefix: str,
        finance: User,
        requester: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        """Sign-off is a decision about a specific figure, so the figure holds still."""
        invoice = awaiting_sign_off(
            client,
            api_prefix,
            finance=finance,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
        )

        response = client.put(
            f"{api_prefix}/invoices/{invoice['id']}",
            json=draft_payload(
                vendor_id=str(vendor.id),
                cost_centre_id=cost_centre_id,
                requester_id=str(requester.id),
                total_minor_units=SMALL * 3,
            ),
        )

        assert response.status_code == 409
        assert "Recall" in response.json()["detail"]


class TestConfirmingReceipt:
    def test_confirming_opens_the_approval_route_and_stops_the_chasing(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        finance: User,
        requester: User,
        unit_head: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        invoice = awaiting_sign_off(
            client,
            api_prefix,
            finance=finance,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
        )

        sign_in(client, requester.email, api_prefix)
        response = client.post(
            f"{api_prefix}/invoices/{invoice['id']}/sign-off",
            json={"note": "Delivered on 30 July, all three units."},
        )

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["state"] == WorkflowState.pending_approval
        assert body["sign_off"]["signed_off_by_label"] == "Rita Requester"
        assert body["route"] is not None
        assert body["awaiting_labels"] == ["Unit Head"]

        # The chase stops inside the same transaction rather than when the
        # scheduler next notices, so no reminder chases work already done.
        assert (
            db_session.execute(
                select(ReminderSchedule).where(
                    ReminderSchedule.record_id == uuid.UUID(invoice["id"]),
                    ReminderSchedule.stopped_at.is_(None),
                )
            ).scalar_one_or_none()
            is None
        )
        # And the link stops working, so it cannot open a sign-off screen for an
        # invoice that has already been signed off.
        remaining = (
            db_session.execute(
                select(SignedLink).where(
                    SignedLink.record_id == uuid.UUID(invoice["id"]),
                    SignedLink.used_at.is_(None),
                    SignedLink.revoked_at.is_(None),
                )
            )
            .scalars()
            .all()
        )
        assert remaining == []

    def test_only_the_assigned_person_may_confirm(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        finance: User,
        requester: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        """Not a permission problem but an attribution one, so the answer is 403
        rather than a segregation-of-duties conflict."""
        other = make_user(
            db_session,
            email="sam.someone@example.com",
            display_name="Sam Someone",
            roles=[Role.requester, Role.finance],
            department="Facilities",
        )
        invoice = awaiting_sign_off(
            client,
            api_prefix,
            finance=finance,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
        )

        sign_in(client, other.email, api_prefix)
        response = client.post(f"{api_prefix}/invoices/{invoice['id']}/sign-off", json={})

        assert response.status_code == 403
        assert "assigned" in response.json()["detail"]

    def test_whoever_submitted_it_cannot_also_confirm_receipt(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        """Holding both roles is legitimate; using both on one invoice is not."""
        both = make_user(
            db_session,
            email="dana.doubled@example.com",
            display_name="Dana Doubled",
            roles=[Role.finance, Role.requester],
            department="Facilities",
        )
        invoice = awaiting_sign_off(
            client,
            api_prefix,
            finance=both,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=both,
        )
        # The server says so before the button is pressed, not only after.
        assert invoice["actions"]["may_sign_off"] is False

        response = client.post(f"{api_prefix}/invoices/{invoice['id']}/sign-off", json={})

        assert response.status_code == 409

    def test_a_duplicate_recorded_in_the_meantime_is_caught_at_sign_off(
        self,
        client: TestClient,
        api_prefix: str,
        finance: User,
        requester: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        """Validation runs again at the moment of confirmation, not only when it
        was requested. Invoices sit in inboxes, and the register moves on."""
        invoice = awaiting_sign_off(
            client,
            api_prefix,
            finance=finance,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
        )
        record_invoice(
            client,
            api_prefix,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
        )

        sign_in(client, requester.email, api_prefix)
        response = client.post(f"{api_prefix}/invoices/{invoice['id']}/sign-off", json={})

        assert response.status_code == 422
        assert "duplicate_invoice_number" in {
            problem["problem"] for problem in response.json()["problems"]
        }


class TestDecliningAndRecalling:
    def test_declining_moves_the_invoice_to_exception_with_the_reason_kept(
        self,
        client: TestClient,
        api_prefix: str,
        finance: User,
        requester: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        """A refusal is a finding about a supplier, not a formatting problem, so it
        does not quietly become somebody's draft again."""
        invoice = awaiting_sign_off(
            client,
            api_prefix,
            finance=finance,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
        )

        sign_in(client, requester.email, api_prefix)
        response = client.post(
            f"{api_prefix}/invoices/{invoice['id']}/decline",
            json={"reason": "Only two of the three units arrived."},
        )

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["state"] == WorkflowState.exception
        assert body["transitions"][-1]["reason"] == "Only two of the three units arrived."

    def test_declining_without_saying_why_is_refused(
        self,
        client: TestClient,
        api_prefix: str,
        finance: User,
        requester: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        invoice = awaiting_sign_off(
            client,
            api_prefix,
            finance=finance,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
        )
        sign_in(client, requester.email, api_prefix)

        assert (
            client.post(
                f"{api_prefix}/invoices/{invoice['id']}/decline", json={"reason": ""}
            ).status_code
            == 422
        )

    def test_recalling_returns_it_to_draft_and_withdraws_the_link(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        finance: User,
        requester: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        """Finance's counterpart to a decline. The requester must not confirm a
        figure that is about to change."""
        invoice = awaiting_sign_off(
            client,
            api_prefix,
            finance=finance,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
        )

        response = client.post(
            f"{api_prefix}/invoices/{invoice['id']}/recall",
            json={"reason": "The total was read from the wrong line."},
        )

        assert response.status_code == 200, response.text
        assert response.json()["state"] == WorkflowState.draft
        assert response.json()["actions"]["may_edit"] is True
        assert (
            db_session.execute(
                select(SignedLink).where(
                    SignedLink.record_id == uuid.UUID(invoice["id"]),
                    SignedLink.revoked_at.is_(None),
                )
            ).scalar_one_or_none()
            is None
        )


# --------------------------------------------------------------- deep links


class TestFollowingASignedLink:
    def test_a_valid_link_names_its_record_and_is_then_spent(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        finance: User,
        requester: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        invoice = awaiting_sign_off(
            client,
            api_prefix,
            finance=finance,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
        )
        token = token_for(db_session, invoice["id"], service_session=db_session)

        sign_in(client, requester.email, api_prefix)
        first = client.post(f"{api_prefix}/links/resolve", json={"token": token})

        assert first.status_code == 200, first.text
        assert first.json() == {
            "record_type": RECORD_TYPE,
            "record_id": invoice["id"],
            "purpose": ReminderPurpose.sign_off,
        }

        # Once. A second use is far more likely to be somebody who should not have
        # it than the intended recipient clicking twice.
        second = client.post(f"{api_prefix}/links/resolve", json={"token": token})
        assert second.status_code == 404

    def test_a_link_forwarded_to_a_colleague_does_not_work_for_them(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        finance: User,
        requester: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        """They may well be entitled to see the invoice. They are not entitled to
        see it as the answer to somebody else's chaser."""
        invoice = awaiting_sign_off(
            client,
            api_prefix,
            finance=finance,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
        )
        token = token_for(db_session, invoice["id"], service_session=db_session)

        sign_in(client, finance.email, api_prefix)
        response = client.post(f"{api_prefix}/links/resolve", json={"token": token})

        assert response.status_code == 404

    def test_an_expired_link_is_refused_and_looks_like_every_other_refusal(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        finance: User,
        requester: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        """One message for every refusal, so the response cannot be used to learn
        which tokens are real."""
        invoice = awaiting_sign_off(
            client,
            api_prefix,
            finance=finance,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
        )
        token = token_for(db_session, invoice["id"], service_session=db_session)
        expiring = live_link(db_session, invoice["id"])
        expiring.expires_at = datetime.now(UTC) - timedelta(minutes=1)
        db_session.commit()

        sign_in(client, requester.email, api_prefix)
        expired = client.post(f"{api_prefix}/links/resolve", json={"token": token})
        unknown = client.post(f"{api_prefix}/links/resolve", json={"token": "not-a-real-token"})

        assert expired.status_code == unknown.status_code == 404
        assert expired.json()["detail"] == unknown.json()["detail"]

    def test_every_refused_link_is_written_down(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        requester: User,
    ) -> None:
        """A run of misses from one account is what guessing looks like from the
        inside, and it is invisible unless the misses are recorded too."""
        sign_in(client, requester.email, api_prefix)
        client.post(f"{api_prefix}/links/resolve", json={"token": "guess-one"})
        client.post(f"{api_prefix}/links/resolve", json={"token": "guess-two"})

        refusals = (
            db_session.execute(
                select(AuditEntryRow).where(AuditEntryRow.action == AuditAction.link_refused)
            )
            .scalars()
            .all()
        )
        assert len(refusals) == 2
        assert {entry.detail["refusal"] for entry in refusals} == {"unknown"}

    def test_the_link_confers_no_authority_of_its_own(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        finance: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        """The point of the whole design. Somebody with the link, signed in, and
        without the permission still cannot sign anything off."""
        powerless = make_user(
            db_session,
            email="pat.powerless@example.com",
            display_name="Pat Powerless",
            roles=[Role.operations],
            department="Facilities",
        )
        invoice = awaiting_sign_off(
            client,
            api_prefix,
            finance=finance,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=powerless,
        )
        token = token_for(db_session, invoice["id"], service_session=db_session)

        sign_in(client, powerless.email, api_prefix)
        resolved = client.post(f"{api_prefix}/links/resolve", json={"token": token})
        assert resolved.status_code == 200

        refused = client.post(f"{api_prefix}/invoices/{invoice['id']}/sign-off", json={})
        assert refused.status_code == 403


# ------------------------------------------------------------------ register


class TestTheRegister:
    def test_it_separates_what_is_waiting_on_me_from_what_is_merely_mine(
        self,
        client: TestClient,
        api_prefix: str,
        finance: User,
        requester: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        waiting = awaiting_sign_off(
            client,
            api_prefix,
            finance=finance,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
        )
        record_invoice(
            client,
            api_prefix,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
            invoice_number="INV-QUIET",
        )

        sign_in(client, requester.email, api_prefix)
        mine = client.get(f"{api_prefix}/invoices").json()
        assert {row["reference"] for row in mine["items"]} >= {waiting["reference"]}

        filtered = client.get(
            f"{api_prefix}/invoices", params={"awaiting_my_sign_off": True}
        ).json()
        assert [row["id"] for row in filtered["items"]] == [waiting["id"]]
        assert filtered["items"][0]["awaiting_my_sign_off"] is True

    def test_it_reports_urgency_and_blockers_without_opening_each_row(
        self,
        client: TestClient,
        api_prefix: str,
        finance: User,
        requester: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        sign_in(client, finance.email, api_prefix)
        record_invoice(
            client,
            api_prefix,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
            due_date="2020-01-01",
        )
        record_invoice(
            client,
            api_prefix,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
            invoice_number="INV-DUPLICATE-OF-ONE",
        )
        duplicate = record_invoice(
            client,
            api_prefix,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
            invoice_number="INV-DUPLICATE-OF-ONE",
        )

        listed = client.get(f"{api_prefix}/invoices").json()
        rows = {row["id"]: row for row in listed["items"]}
        assert rows[duplicate["id"]]["blocker_count"] >= 1

        overdue = client.get(f"{api_prefix}/invoices", params={"overdue": True}).json()
        assert overdue["total"] == 1
        assert overdue["items"][0]["days_until_due"] is not None
        assert overdue["items"][0]["days_until_due"] < 0

    def test_a_search_matches_the_vendor_their_number_and_our_reference(
        self,
        client: TestClient,
        api_prefix: str,
        finance: User,
        requester: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        sign_in(client, finance.email, api_prefix)
        invoice = record_invoice(
            client,
            api_prefix,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
            invoice_number="INV-FINDME",
        )

        for term in ("findme", "kingston", invoice["reference"].lower()):
            found = client.get(f"{api_prefix}/invoices", params={"search": term}).json()
            assert [row["id"] for row in found["items"]] == [invoice["id"]], term


# ------------------------------------------------------------------ approval


class TestApprovingAnInvoice:
    def test_the_route_only_opens_once_receipt_is_confirmed(
        self,
        client: TestClient,
        api_prefix: str,
        finance: User,
        requester: User,
        unit_head: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        """An approver never sees an invoice nobody has confirmed arrived."""
        invoice = awaiting_sign_off(
            client,
            api_prefix,
            finance=finance,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
        )
        assert invoice["route"] is None
        # What it would take is still shown, so nobody is surprised later.
        assert [step["level_label"] for step in invoice["planned_route"]] == ["Unit Head"]

        sign_in(client, unit_head.email, api_prefix)
        queue = client.get(f"{api_prefix}/invoices", params={"awaiting_me": True}).json()
        assert queue["items"] == []

    def test_an_approval_that_closes_the_route_approves_the_invoice(
        self,
        client: TestClient,
        api_prefix: str,
        finance: User,
        requester: User,
        unit_head: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        invoice = awaiting_sign_off(
            client,
            api_prefix,
            finance=finance,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=requester,
        )
        sign_in(client, requester.email, api_prefix)
        confirmed = client.post(f"{api_prefix}/invoices/{invoice['id']}/sign-off", json={}).json()

        sign_in(client, unit_head.email, api_prefix)
        target = confirmed["route"]["steps"][0]
        response = client.post(
            f"{api_prefix}/invoices/{invoice['id']}/decision",
            json={
                "step_order": target["step_order"],
                "level": target["level"],
                "outcome": "approved",
                "comment": None,
            },
        )

        assert response.status_code == 200, response.text
        assert response.json()["state"] == WorkflowState.approved
        assert response.json()["decided_at"] is not None

    def test_the_person_who_confirmed_receipt_cannot_also_approve_it(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        finance: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        """Confirming that goods arrived and approving the spend are two
        signatures, and one person cannot supply both."""
        both = make_user(
            db_session,
            email="carla.confirms@example.com",
            display_name="Carla Confirms",
            roles=[Role.requester, Role.approver],
            department="Facilities",
        )
        assign_approver(db_session, user=both, level=ApprovalLevel.unit_head)

        invoice = awaiting_sign_off(
            client,
            api_prefix,
            finance=finance,
            vendor=vendor,
            cost_centre_id=cost_centre_id,
            requester=both,
        )
        sign_in(client, both.email, api_prefix)
        confirmed = client.post(f"{api_prefix}/invoices/{invoice['id']}/sign-off", json={}).json()

        assert confirmed["actions"]["may_decide"] is False
        target = confirmed["route"]["steps"][0]
        response = client.post(
            f"{api_prefix}/invoices/{invoice['id']}/decision",
            json={
                "step_order": target["step_order"],
                "level": target["level"],
                "outcome": "approved",
                "comment": None,
            },
        )

        assert response.status_code == 409


def read_document(session: Session, *, body: bytes = INVOICE) -> Document:
    """Put one document through intake and read it, as Phase 3 does."""
    store = FakeObjectStore()
    document, _ = ingest_document(session, body=body, store=store)
    build_pipeline(session, store=store).read(document, correlation_id=uuid.uuid4())
    session.commit()
    return document
