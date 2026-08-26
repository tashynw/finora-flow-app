"""Payment packages end to end.

Four behaviours here are the reason this feature exists, and each of them is
somewhere the platform would be wrong in a way that costs real money.

*An invoice can be in one package, ever.* Two packages holding the same invoice
is two payments for one debt, and it is the failure nobody notices because both
packages look correct on their own.

*Mixed currencies are never summed.* A package holding JMD and USD has two
totals. One number would be denominated in nothing, and somebody would put it in
front of a bank.

*Submission freezes what was submitted.* The manifest digest is recorded at the
moment of sending, so a file rebuilt afterwards can be checked against it.

*Assembling and sending are different authorities.* Segregation of duties keeps
the person who sends a package from being the person who later declares it paid.
"""

from __future__ import annotations

import hashlib
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

from finora.domain.audit import AuditAction
from finora.domain.roles import Role
from finora.domain.workflow import WorkflowState
from finora.infrastructure.db.models import AuditEntryRow, Invoice, User, Vendor

pytestmark = [pytest.mark.integration, requires_db]


def _soon() -> str:
    """A payment date far enough ahead that a slow test run cannot pass it."""
    return (datetime.now(UTC).date() + timedelta(days=7)).isoformat()


# ------------------------------------------------------------------- fixtures


@pytest.fixture
def coordinator(db_session: Session) -> User:
    """Assembles packages and sends them. Cannot declare anything paid."""
    return make_user(
        db_session,
        email="pat.payments@example.com",
        display_name="Pat Payments",
        roles=[Role.payment_coordinator],
        department="Finance",
    )


@pytest.fixture
def finance(db_session: Session) -> User:
    """Records invoices and marks things paid. Cannot submit a package."""
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
        email="alan.auditor@example.com",
        display_name="Alan Auditor",
        roles=[Role.auditor],
        department="Finance",
    )


@pytest.fixture
def vendor(db_session: Session) -> Vendor:
    return make_vendor(db_session)


@pytest.fixture
def other_vendor(db_session: Session) -> Vendor:
    return make_vendor(db_session, code="V-200", name="Ackee Trading Company")


# -------------------------------------------------------------------- helpers


def approved_invoice(
    session: Session,
    *,
    recorded_by: User,
    vendor: Vendor,
    total_minor_units: int = 1_000_000,
    currency: str = "JMD",
    invoice_number: str | None = None,
) -> Invoice:
    return make_invoice(
        session,
        recorded_by=recorded_by,
        vendor=vendor,
        total_minor_units=total_minor_units,
        currency=currency,
        invoice_number=invoice_number,
        state=WorkflowState.approved,
    )


def open_package(
    client: TestClient,
    api_prefix: str,
    *,
    description: str = "Friday run",
    payment_method: str | None = "bank_transfer",
    intended_payment_date: str | None = None,
) -> dict[str, Any]:
    created = client.post(
        f"{api_prefix}/payment-packages",
        json={
            "description": description,
            "payment_method": payment_method,
            "intended_payment_date": intended_payment_date or _soon(),
        },
    )
    assert created.status_code == 201, created.text
    body: dict[str, Any] = created.json()
    return body


def add(client: TestClient, api_prefix: str, package_id: str, *invoices: Invoice) -> dict[str, Any]:
    response = client.post(
        f"{api_prefix}/payment-packages/{package_id}/lines",
        json={"invoice_ids": [str(invoice.id) for invoice in invoices]},
    )
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


# ------------------------------------------------------------------ assembling


class TestAssembling:
    def test_a_new_package_is_given_a_reference_immediately(
        self, client: TestClient, api_prefix: str, coordinator: User
    ) -> None:
        # Quoted to the bank and written on the manifest, so it exists before
        # anything is put in the package rather than at the moment of sending.
        sign_in(client, coordinator.email, api_prefix)

        created = client.post(f"{api_prefix}/payment-packages", json={})

        assert created.status_code == 201
        assert created.json()["reference"].startswith("PAY-")

    def test_two_packages_never_share_a_reference(
        self, client: TestClient, api_prefix: str, coordinator: User
    ) -> None:
        sign_in(client, coordinator.email, api_prefix)

        first = client.post(f"{api_prefix}/payment-packages", json={}).json()["reference"]
        second = client.post(f"{api_prefix}/payment-packages", json={}).json()["reference"]

        assert first != second

    def test_a_new_package_is_open(
        self, client: TestClient, api_prefix: str, coordinator: User
    ) -> None:
        # Standing rather than state. A package is not on the workflow machine,
        # because it asks nobody to decide anything.
        sign_in(client, coordinator.email, api_prefix)

        created = client.post(f"{api_prefix}/payment-packages", json={}).json()

        assert created["standing"] == "open"
        assert created["standing_label"] == "Open"

    def test_adding_an_approved_invoice_marks_it_ready_for_submission(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # The money's state runs on the machine even though the container's does
        # not, and this is the move that says an invoice is spoken for.
        invoice = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix)

        result = add(client, api_prefix, package["id"], invoice)

        assert result["added"] == [str(invoice.id)]
        assert result["package"]["lines"][0]["invoice_state"] == "ready_for_submission"
        db_session.refresh(invoice)
        assert invoice.state is WorkflowState.ready_for_submission

    def test_an_invoice_still_waiting_on_approval_cannot_be_added(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # A package is an envelope for decisions already taken.
        invoice = make_invoice(
            db_session,
            recorded_by=finance,
            vendor=vendor,
            state=WorkflowState.pending_approval,
        )
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix)

        result = add(client, api_prefix, package["id"], invoice)

        assert result["added"] == []
        assert result["refused"][0]["refusal"] == "not_approved"
        db_session.refresh(invoice)
        assert invoice.state is WorkflowState.pending_approval

    def test_the_same_invoice_cannot_be_in_two_packages(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # This is the double-payment control. Two packages holding one invoice
        # both look correct on their own, which is what makes it dangerous.
        invoice = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        sign_in(client, coordinator.email, api_prefix)
        first = open_package(client, api_prefix, description="Friday run")
        second = open_package(client, api_prefix, description="Monday run")
        add(client, api_prefix, first["id"], invoice)

        result = add(client, api_prefix, second["id"], invoice)

        assert result["added"] == []
        assert result["refused"][0]["refusal"] == "already_in_a_package"
        assert result["package"]["lines"] == []

    def test_a_batch_takes_what_it_can_and_names_what_it_cannot(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # Partial on purpose. Somebody adding a page of search results needs to
        # see which one of three was already spoken for.
        payable = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        also_payable = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        spoken_for = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        sign_in(client, coordinator.email, api_prefix)
        elsewhere = open_package(client, api_prefix, description="Earlier run")
        add(client, api_prefix, elsewhere["id"], spoken_for)
        package = open_package(client, api_prefix)

        result = add(client, api_prefix, package["id"], payable, spoken_for, also_payable)

        assert set(result["added"]) == {str(payable.id), str(also_payable.id)}
        assert [row["invoice_id"] for row in result["refused"]] == [str(spoken_for.id)]

    def test_removing_an_invoice_returns_it_to_approved(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        invoice = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix)
        add(client, api_prefix, package["id"], invoice)

        removed = client.delete(f"{api_prefix}/payment-packages/{package['id']}/lines/{invoice.id}")

        assert removed.status_code == 200, removed.text
        assert removed.json()["lines"] == []
        db_session.refresh(invoice)
        assert invoice.state is WorkflowState.approved

    def test_a_removed_invoice_can_go_into_another_package(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # The one-package rule is about being spoken for, not about having ever
        # been in one. Taking it out has to actually free it.
        invoice = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        sign_in(client, coordinator.email, api_prefix)
        first = open_package(client, api_prefix)
        add(client, api_prefix, first["id"], invoice)
        client.delete(f"{api_prefix}/payment-packages/{first['id']}/lines/{invoice.id}")
        second = open_package(client, api_prefix, description="Monday run")

        result = add(client, api_prefix, second["id"], invoice)

        assert result["added"] == [str(invoice.id)]

    def test_eligible_invoices_excludes_anything_already_in_a_package(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        free = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        taken = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix)
        add(client, api_prefix, package["id"], taken)

        offered = client.get(f"{api_prefix}/payment-packages/eligible-invoices").json()

        references = {row["reference"] for row in offered}
        assert free.reference in references
        assert taken.reference not in references


# ---------------------------------------------------------------------- totals


class TestTotals:
    def test_totals_are_reported_one_per_currency(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
        other_vendor: Vendor,
    ) -> None:
        # Two currencies, two totals. There is no rate at which they add up, and
        # a single figure would be denominated in nothing.
        jamaican = approved_invoice(
            db_session, recorded_by=finance, vendor=vendor, total_minor_units=250_000
        )
        american = approved_invoice(
            db_session,
            recorded_by=finance,
            vendor=other_vendor,
            total_minor_units=40_000,
            currency="USD",
        )
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix)

        result = add(client, api_prefix, package["id"], jamaican, american)

        totals = {row["currency"]: row["minor_units"] for row in result["package"]["totals"]}
        assert totals == {"JMD": 250_000, "USD": 40_000}

    def test_two_invoices_in_one_currency_are_added_together(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        first = approved_invoice(
            db_session, recorded_by=finance, vendor=vendor, total_minor_units=250_000
        )
        second = approved_invoice(
            db_session, recorded_by=finance, vendor=vendor, total_minor_units=125_000
        )
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix)

        result = add(client, api_prefix, package["id"], first, second)

        assert result["package"]["totals"] == [
            {"currency": "JMD", "minor_units": 375_000, "formatted": "JMD 3,750.00"}
        ]


# -------------------------------------------------------------------- manifest


class TestManifest:
    def test_the_manifest_carries_a_row_per_invoice_and_a_total_per_currency(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
        other_vendor: Vendor,
    ) -> None:
        jamaican = approved_invoice(
            db_session, recorded_by=finance, vendor=vendor, total_minor_units=250_000
        )
        american = approved_invoice(
            db_session,
            recorded_by=finance,
            vendor=other_vendor,
            total_minor_units=40_000,
            currency="USD",
        )
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix)
        add(client, api_prefix, package["id"], jamaican, american)

        manifest = client.get(f"{api_prefix}/payment-packages/{package['id']}/manifest").json()

        rows = [line for line in manifest["content"].splitlines() if line]
        assert manifest["line_count"] == 2
        # Header, two invoices, two currency totals.
        assert len(rows) == 5
        assert sum(row.startswith("Total,") for row in rows) == 2

    def test_the_manifest_is_the_same_file_every_time_it_is_built(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # Determinism is what makes the digest recorded at submission worth
        # anything: without it the file cannot be rebuilt and compared.
        first_invoice = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        second_invoice = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix)
        add(client, api_prefix, package["id"], first_invoice, second_invoice)

        once = client.get(f"{api_prefix}/payment-packages/{package['id']}/manifest").json()
        again = client.get(f"{api_prefix}/payment-packages/{package['id']}/manifest").json()

        assert once["digest"] == again["digest"]
        assert once["content"] == again["content"]

    def test_the_digest_is_of_the_file_that_downloads(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # A digest of anything other than the exact bytes the bank receives is
        # evidence about nothing.
        invoice = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix)
        add(client, api_prefix, package["id"], invoice)

        download = client.get(f"{api_prefix}/payment-packages/{package['id']}/manifest.csv")

        assert download.status_code == 200
        assert download.headers["x-manifest-sha256"] == hashlib.sha256(download.content).hexdigest()
        assert "attachment" in download.headers["content-disposition"]

    def test_downloading_the_manifest_is_audited_as_an_export(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # MP-D7: taking a copy of outgoing payments must leave the same kind of
        # trail as generating an accrual export, not merely the same trace as
        # opening the page.
        invoice = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix)
        add(client, api_prefix, package["id"], invoice)

        download = client.get(f"{api_prefix}/payment-packages/{package['id']}/manifest.csv")
        assert download.status_code == 200

        entry = db_session.execute(
            select(AuditEntryRow)
            .where(AuditEntryRow.action == AuditAction.export_generated)
            .order_by(AuditEntryRow.sequence.desc())
            .limit(1)
        ).scalar_one()
        assert str(entry.subject_id) == package["id"]
        assert entry.subject_type == "payment_package"
        assert entry.detail["format"] == "csv"
        assert entry.detail["reference"] == package["reference"]
        assert entry.detail["sha256"] == download.headers["x-manifest-sha256"]

    def test_a_package_with_no_payment_date_has_no_manifest(
        self, client: TestClient, api_prefix: str, coordinator: User
    ) -> None:
        sign_in(client, coordinator.email, api_prefix)
        package = client.post(
            f"{api_prefix}/payment-packages",
            json={"description": "Not ready", "payment_method": "wire"},
        ).json()

        response = client.get(f"{api_prefix}/payment-packages/{package['id']}/manifest")

        assert response.status_code == 409


# ------------------------------------------------------------------ submitting


class TestSubmitting:
    def test_submitting_records_the_reference_and_the_digest(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        invoice = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix)
        add(client, api_prefix, package["id"], invoice)

        sent = client.post(
            f"{api_prefix}/payment-packages/{package['id']}/submit",
            json={"submission_reference": "NCB-BATCH-99120"},
        )

        assert sent.status_code == 200, sent.text
        body = sent.json()
        assert body["package"]["standing"] == "submitted"
        assert body["package"]["submission_reference"] == "NCB-BATCH-99120"
        assert body["package"]["manifest_sha256"] == body["manifest"]["digest"]
        assert body["package"]["manifest_line_count"] == 1

    def test_submitting_moves_every_invoice_in_it(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        first_invoice = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        second_invoice = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix)
        add(client, api_prefix, package["id"], first_invoice, second_invoice)

        client.post(
            f"{api_prefix}/payment-packages/{package['id']}/submit",
            json={"submission_reference": "NCB-BATCH-99121"},
        )

        db_session.refresh(first_invoice)
        db_session.refresh(second_invoice)
        assert first_invoice.state is WorkflowState.submitted
        assert second_invoice.state is WorkflowState.submitted

    def test_a_sent_package_reports_no_problems_with_itself(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # Every problem asks for a change, and this package can take none. The
        # invoices in it have deliberately left `approved`, so a package that
        # kept checking for that would report the act of sending it as a control
        # firing, in red, above the evidence that it went.
        invoice = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix)
        add(client, api_prefix, package["id"], invoice)
        client.post(
            f"{api_prefix}/payment-packages/{package['id']}/submit",
            json={"submission_reference": "NCB-BATCH-99122"},
        )

        detail = client.get(f"{api_prefix}/payment-packages/{package['id']}").json()

        assert detail["standing"] == "submitted"
        assert detail["problems"] == []

    def test_a_submitted_package_cannot_be_changed(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # What went to the bank is what went. Anything else makes the recorded
        # digest a statement about a file nobody has.
        invoice = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        another = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix)
        add(client, api_prefix, package["id"], invoice)
        client.post(
            f"{api_prefix}/payment-packages/{package['id']}/submit",
            json={"submission_reference": "NCB-BATCH-99122"},
        )

        rejected = client.post(
            f"{api_prefix}/payment-packages/{package['id']}/lines",
            json={"invoice_ids": [str(another.id)]},
        )

        assert rejected.status_code == 409

    def test_the_manifest_still_matches_after_submission(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # The whole point of recording the digest: a file rebuilt later can be
        # checked against what was sent, and the API says whether it agrees.
        invoice = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix)
        add(client, api_prefix, package["id"], invoice)
        client.post(
            f"{api_prefix}/payment-packages/{package['id']}/submit",
            json={"submission_reference": "NCB-BATCH-99123"},
        )

        manifest = client.get(f"{api_prefix}/payment-packages/{package['id']}/manifest").json()

        assert manifest["matches_submitted"] is True

    def test_an_empty_package_cannot_be_submitted(
        self, client: TestClient, api_prefix: str, coordinator: User
    ) -> None:
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix)

        rejected = client.post(
            f"{api_prefix}/payment-packages/{package['id']}/submit",
            json={"submission_reference": "NCB-BATCH-99124"},
        )

        assert rejected.status_code == 422
        problems = {row["problem"] for row in rejected.json()["problems"]}
        assert "nothing_in_it" in problems

    def test_a_package_with_no_method_cannot_be_submitted(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        invoice = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix, payment_method=None)
        add(client, api_prefix, package["id"], invoice)

        rejected = client.post(
            f"{api_prefix}/payment-packages/{package['id']}/submit",
            json={"submission_reference": "NCB-BATCH-99125"},
        )

        assert rejected.status_code == 422
        problems = {row["problem"] for row in rejected.json()["problems"]}
        assert "payment_method_missing" in problems

    def test_a_payment_date_that_has_gone_by_stops_submission(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # A package that goes to the bank already saying it is late is a
        # supplier who was told the wrong thing.
        invoice = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(
            client,
            api_prefix,
            intended_payment_date=(datetime.now(UTC).date() - timedelta(days=1)).isoformat(),
        )
        add(client, api_prefix, package["id"], invoice)

        rejected = client.post(
            f"{api_prefix}/payment-packages/{package['id']}/submit",
            json={"submission_reference": "NCB-BATCH-99126"},
        )

        assert rejected.status_code == 422
        problems = {row["problem"] for row in rejected.json()["problems"]}
        assert "payment_date_in_the_past" in problems

    def test_the_same_supplier_twice_under_one_number_blocks_submission(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # Reached the only way it can be. The partial unique index on invoices
        # already forbids two live rows sharing a supplier and a number, so this
        # takes the route it cannot see: an invoice goes into the package, is
        # cancelled — freeing its number — and a replacement carrying the same
        # number is added beside the line that still quotes it.
        original = approved_invoice(
            db_session, recorded_by=finance, vendor=vendor, invoice_number="SUP-77"
        )
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix)
        add(client, api_prefix, package["id"], original)

        # Refreshed first: the API moved it to ready_for_submission through
        # another session, and this one is holding the version it had before.
        db_session.refresh(original)
        original.state = WorkflowState.cancelled
        db_session.commit()
        replacement = approved_invoice(
            db_session, recorded_by=finance, vendor=vendor, invoice_number="SUP-77"
        )
        add(client, api_prefix, package["id"], replacement)

        rejected = client.post(
            f"{api_prefix}/payment-packages/{package['id']}/submit",
            json={"submission_reference": "NCB-BATCH-99127"},
        )

        assert rejected.status_code == 422
        problems = {row["problem"] for row in rejected.json()["problems"]}
        assert "repeated_invoice_number" in problems

    def test_a_submission_needs_the_reference_the_bank_gave_back(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # Without it there is nothing tying this package to the payment on
        # either side, and "was this paid" has no answer.
        invoice = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix)
        add(client, api_prefix, package["id"], invoice)

        rejected = client.post(
            f"{api_prefix}/payment-packages/{package['id']}/submit",
            json={"submission_reference": "x"},
        )

        assert rejected.status_code == 422


# ------------------------------------------------------------------ abandoning


class TestAbandoning:
    def test_cancelling_returns_everything_to_approved(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        invoice = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix)
        add(client, api_prefix, package["id"], invoice)

        cancelled = client.post(
            f"{api_prefix}/payment-packages/{package['id']}/cancel",
            json={"reason": "Assembled against the wrong payment run."},
        )

        assert cancelled.status_code == 200, cancelled.text
        assert cancelled.json()["standing"] == "cancelled"
        db_session.refresh(invoice)
        assert invoice.state is WorkflowState.approved

    def test_a_cancelled_package_cannot_be_submitted(
        self, client: TestClient, api_prefix: str, coordinator: User
    ) -> None:
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix)
        client.post(
            f"{api_prefix}/payment-packages/{package['id']}/cancel",
            json={"reason": "Not going ahead."},
        )

        rejected = client.post(
            f"{api_prefix}/payment-packages/{package['id']}/submit",
            json={"submission_reference": "NCB-BATCH-99128"},
        )

        assert rejected.status_code == 409

    def test_a_submitted_package_cannot_be_cancelled(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # The money has gone. Recording it as abandoned would describe a payment
        # that happened as one that never did.
        invoice = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix)
        add(client, api_prefix, package["id"], invoice)
        client.post(
            f"{api_prefix}/payment-packages/{package['id']}/submit",
            json={"submission_reference": "NCB-BATCH-99129"},
        )

        rejected = client.post(
            f"{api_prefix}/payment-packages/{package['id']}/cancel",
            json={"reason": "Changed our minds."},
        )

        assert rejected.status_code == 409


# ----------------------------------------------------------------- permissions


class TestWhoMayDoWhat:
    def test_an_auditor_can_read_the_register_and_change_nothing(
        self, client: TestClient, api_prefix: str, onlooker: User
    ) -> None:
        sign_in(client, onlooker.email, api_prefix)

        assert client.get(f"{api_prefix}/payment-packages").status_code == 200
        assert client.post(f"{api_prefix}/payment-packages", json={}).status_code == 403

    def test_finance_cannot_submit_a_package(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # Finance marks things paid in the next phase. Somebody who can do both
        # can pay whatever they like and then say it was paid.
        invoice = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix)
        add(client, api_prefix, package["id"], invoice)

        sign_in(client, finance.email, api_prefix)
        rejected = client.post(
            f"{api_prefix}/payment-packages/{package['id']}/submit",
            json={"submission_reference": "NCB-BATCH-99130"},
        )

        assert rejected.status_code == 403

    def test_the_submit_control_is_absent_until_the_package_is_ready(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        coordinator: User,
        finance: User,
        vendor: Vendor,
    ) -> None:
        # A button that will certainly be refused should not be on the screen.
        invoice = approved_invoice(db_session, recorded_by=finance, vendor=vendor)
        sign_in(client, coordinator.email, api_prefix)
        package = open_package(client, api_prefix)
        assert package["can_submit"] is False

        result = add(client, api_prefix, package["id"], invoice)

        assert result["package"]["can_submit"] is True
