"""Document reading and review endpoints.

Two things are guarded here. The first is what the API refuses: an
unauthenticated caller sees nothing, a caller without the permission is refused
and that refusal is written to the audit trail, an accepted reading cannot be
edited or read again, and a reading with anything outstanding cannot be accepted.

The second is that every value arrives with its provenance. A field is never
served as a bare string, so each assertion about a value is also an assertion
about who produced it, how far it should be trusted, whether a person has looked
at it, and where on the page it was found. Alongside that, every read of a
document carries the whole remaining task in `acceptance_blockers`, so a
reviewer is never shown one refusal at a time.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any, cast

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from tests.conftest import make_user, requires_db, sign_in
from tests.integration.test_document_pipeline import (
    INVOICE,
    UNLABELLED,
    WITH_BANK_DETAILS,
    FakeGateway,
    build_pipeline,
    ingest_document,
)
from tests.integration.test_intake_service import FakeObjectStore

from finora.api.deps import get_ai_gateway_dep, get_object_store_dep
from finora.domain.audit import AuditAction
from finora.domain.extraction import DocumentSignal, ExtractionStatus
from finora.domain.roles import Permission, Role, permissions_for
from finora.infrastructure.db.models import AuditEntryRow, Document

pytestmark = [pytest.mark.integration, requires_db]


# ------------------------------------------------------------------ fixtures


@pytest.fixture
def fake_store() -> FakeObjectStore:
    return FakeObjectStore()


@pytest.fixture
def fake_gateway() -> FakeGateway:
    return FakeGateway()


@pytest.fixture
def api(
    client: TestClient, fake_store: FakeObjectStore, fake_gateway: FakeGateway
) -> Iterator[TestClient]:
    """The app with only the two outbound adapters replaced.

    Just the store and the gateway. `get_document_pipeline` is left alone so it
    still resolves the request's own session; building a second session here
    would deadlock against the advisory lock the audit chain takes.
    """
    app = cast(FastAPI, client.app)
    app.dependency_overrides[get_object_store_dep] = lambda: fake_store
    app.dependency_overrides[get_ai_gateway_dep] = lambda: fake_gateway
    yield client
    app.dependency_overrides.clear()


def read_a_document(session: Session, store: FakeObjectStore, *, body: bytes = INVOICE) -> Document:
    """Ingest one document and read it, arranging it directly rather than over HTTP.

    The `read-pending` endpoint queues a background task that builds its own
    object store, so it would look for these bytes in the real store rather than
    in the fake one. Reading here with the same store instance the app's
    `get_object_store_dep` override returns is what lets `viewer-url` sign the
    key afterwards.
    """
    document, _ = ingest_document(session, body=body, store=store)
    build_pipeline(session, store=store).read(document, correlation_id=uuid.uuid4())
    session.commit()
    return document


@pytest.fixture
def invoice(db_session: Session, fake_store: FakeObjectStore) -> Document:
    """A labelled invoice, read cleanly, with nothing outstanding on it."""
    return read_a_document(db_session, fake_store)


@pytest.fixture
def unlabelled(db_session: Session, fake_store: FakeObjectStore) -> Document:
    """An invoice with no title and no labels, so its kind and vendor need a person."""
    return read_a_document(db_session, fake_store, body=UNLABELLED)


@pytest.fixture
def banked(db_session: Session, fake_store: FakeObjectStore) -> Document:
    """A cleanly read invoice that carries bank details, so it needs an acknowledgement."""
    return read_a_document(db_session, fake_store, body=WITH_BANK_DETAILS)


# ------------------------------------------------------------------- helpers

#: A decoded JSON object. Untyped on purpose: the schemas these tests assert
#: against live in the router, and re-declaring them here would let a test pass
#: against a shape the API never sends.
Json = dict[str, Any]

Call = tuple[str, str, Json | None]


def edit_calls(api_prefix: str, document_id: uuid.UUID) -> list[Call]:
    """Every call that changes a reading and asks for `extraction:edit`."""
    base = f"{api_prefix}/documents"
    return [
        ("PATCH", f"{base}/{document_id}/fields/total", {"text": "1.00"}),
        ("POST", f"{base}/{document_id}/fields/total/review", {"review": "confirmed"}),
        ("POST", f"{base}/{document_id}/kind", {"kind": "invoice"}),
        ("POST", f"{base}/{document_id}/acknowledge", {"signal": "bank_details_present"}),
        ("POST", f"{base}/read-pending", None),
        ("POST", f"{base}/{document_id}/read", None),
    ]


def accept_call(api_prefix: str, document_id: uuid.UUID) -> Call:
    return ("POST", f"{api_prefix}/documents/{document_id}/accept", {})


def send(api: TestClient, call: Call) -> httpx.Response:
    method, url, body = call
    return cast(httpx.Response, api.request(method, url, json=body))


def sign_in_as(api: TestClient, db_session: Session, api_prefix: str, *, roles: list[Role]) -> None:
    email = f"person-{uuid.uuid4().hex[:8]}@company.example"
    make_user(db_session, email=email, display_name="Ann Reviewer", roles=roles)
    sign_in(api, email, api_prefix)


def field_in(body: Json, name: str) -> Json:
    fields = cast(list[Json], body["extraction"]["fields"])
    return next(row for row in fields if row["name"] == name)


def signal_in(body: Json, name: str) -> Json:
    signals = cast(list[Json], body["extraction"]["signals"])
    return next(row for row in signals if row["signal"] == name)


def audit_actions(db_session: Session) -> set[AuditAction]:
    return set(db_session.execute(select(AuditEntryRow.action)).scalars())


# ------------------------------------------------------------- authorization


class TestAuthorization:
    def test_an_unauthenticated_caller_sees_nothing(self, api: TestClient, api_prefix: str) -> None:
        document_id = uuid.uuid4()
        base = f"{api_prefix}/documents"

        assert api.get(base).status_code == 401
        assert api.get(f"{base}/{document_id}").status_code == 401
        assert api.get(f"{base}/{document_id}/viewer-url").status_code == 401
        for call in [*edit_calls(api_prefix, document_id), accept_call(api_prefix, document_id)]:
            assert send(api, call).status_code == 401, call

    def test_a_caller_who_cannot_edit_a_reading_is_refused_every_way_of_changing_one(
        self, api: TestClient, db_session: Session, api_prefix: str, invoice: Document
    ) -> None:
        """An auditor may read the platform but must never alter what it recorded.

        Auditor is the role to use here because it carries `document:view` and so
        is a genuinely authorized user rather than a stranger, which makes the
        refusal a statement about the permission and not about the session.
        """
        sign_in_as(api, db_session, api_prefix, roles=[Role.auditor])

        for call in edit_calls(api_prefix, invoice.id):
            assert send(api, call).status_code == 403, call

    def test_a_refused_call_is_written_to_the_audit_trail(
        self, api: TestClient, db_session: Session, api_prefix: str, invoice: Document
    ) -> None:
        """Repeated denials are how probing shows up, so each one is a record."""
        sign_in_as(api, db_session, api_prefix, roles=[Role.auditor])

        response = api.post(f"{api_prefix}/documents/{invoice.id}/read")
        assert response.status_code == 403

        assert AuditAction.permission_denied in audit_actions(db_session)

    def test_accepting_asks_for_a_permission_of_its_own(
        self, api: TestClient, db_session: Session, api_prefix: str, invoice: Document
    ) -> None:
        """Acceptance is a separate permission that no role holds apart from editing.

        Finance is the only role granting `extraction:edit`, and it also grants
        `extraction:accept`, so no user can be arranged who may correct a value
        but not confirm the set. That is deliberate, because correcting a misread
        total and confirming the corrected reading is one job. What is asserted
        here is therefore that the permission is checked at all, using a role
        that holds neither.
        """
        editors = {role for role in Role if Permission.extraction_edit in permissions_for([role])}
        assert editors == {Role.finance}
        assert Permission.extraction_accept in permissions_for([Role.finance])

        sign_in_as(api, db_session, api_prefix, roles=[Role.auditor])
        assert send(api, accept_call(api_prefix, invoice.id)).status_code == 403


# ------------------------------------------------------------------ the queue


class TestTheQueue:
    def test_the_queue_shows_what_the_reading_found_without_opening_the_document(
        self, api: TestClient, db_session: Session, api_prefix: str, unlabelled: Document
    ) -> None:
        sign_in_as(api, db_session, api_prefix, roles=[Role.finance])

        response = api.get(f"{api_prefix}/documents")
        assert response.status_code == 200

        item = response.json()["items"][0]
        assert item["id"] == str(unlabelled.id)
        assert item["fields_needing_attention"] == 1
        assert item["lowest_confidence"] == pytest.approx(0.4)
        assert item["signal_count"] == 1
        assert item["subject"] == "Invoice 12345"
        assert item["from_address"] == "billing@vendor.example"

    def test_the_queue_is_oldest_first_and_filters_on_status_and_kind(
        self,
        api: TestClient,
        db_session: Session,
        api_prefix: str,
        fake_store: FakeObjectStore,
    ) -> None:
        """Oldest first, because this is a work queue rather than a record of arrivals."""
        first = read_a_document(db_session, fake_store)
        second = read_a_document(db_session, fake_store, body=UNLABELLED)
        sign_in_as(api, db_session, api_prefix, roles=[Role.finance])

        listing = api.get(f"{api_prefix}/documents").json()
        assert listing["total"] == 2
        assert listing["limit"] == 25
        assert listing["offset"] == 0
        assert [item["id"] for item in listing["items"]] == [str(first.id), str(second.id)]

        by_status = api.get(
            f"{api_prefix}/documents", params={"status": ExtractionStatus.needs_review.value}
        ).json()
        assert by_status["total"] == 1
        assert by_status["items"][0]["id"] == str(second.id)

        by_kind = api.get(f"{api_prefix}/documents", params={"kind": "invoice"}).json()
        assert by_kind["total"] == 1
        assert by_kind["items"][0]["id"] == str(first.id)

        page = api.get(f"{api_prefix}/documents", params={"limit": 1, "offset": 1}).json()
        assert page["total"] == 2
        assert page["limit"] == 1
        assert page["offset"] == 1
        assert [item["id"] for item in page["items"]] == [str(second.id)]

    def test_asking_to_read_when_nothing_is_waiting_says_so_plainly(
        self, api: TestClient, db_session: Session, api_prefix: str, invoice: Document
    ) -> None:
        sign_in_as(api, db_session, api_prefix, roles=[Role.finance])

        response = api.post(f"{api_prefix}/documents/read-pending")
        assert response.status_code == 200

        body = response.json()
        assert body["documents_queued"] == 0
        assert body["detail"] == "Nothing is waiting to be read."

    def test_asking_to_read_counts_what_is_waiting(
        self,
        api: TestClient,
        db_session: Session,
        api_prefix: str,
        fake_store: FakeObjectStore,
    ) -> None:
        """Only the count is asserted, because the reading itself is queued.

        The background task builds its own object store, so it cannot find bytes
        that only exist in the fake one. Whether it succeeds is beside the point
        of this endpoint, which reports what it has accepted for reading.
        """
        ingest_document(db_session, store=fake_store)
        sign_in_as(api, db_session, api_prefix, roles=[Role.finance])

        response = api.post(f"{api_prefix}/documents/read-pending")
        assert response.status_code == 200

        body = response.json()
        assert body["documents_queued"] == 1
        assert "1 of 1 documents waiting" in body["detail"]

    def test_reading_a_document_again_keeps_the_earlier_attempt(
        self, api: TestClient, db_session: Session, api_prefix: str, invoice: Document
    ) -> None:
        sign_in_as(api, db_session, api_prefix, roles=[Role.finance])

        response = api.post(f"{api_prefix}/documents/{invoice.id}/read")
        assert response.status_code == 200

        body = response.json()
        assert body["extraction"]["attempt"] == 2
        assert [item["attempt"] for item in body["history"]] == [1]


# --------------------------------------------------------------- one document


class TestOneDocument:
    def test_a_document_carries_the_provenance_of_every_value_it_reports(
        self, api: TestClient, db_session: Session, api_prefix: str, unlabelled: Document
    ) -> None:
        sign_in_as(api, db_session, api_prefix, roles=[Role.finance])

        response = api.get(f"{api_prefix}/documents/{unlabelled.id}")
        assert response.status_code == 200

        body = response.json()
        assert body["acceptance_blockers"]

        vendor = field_in(body, "vendor_name")
        assert vendor["label"] == "Vendor"
        assert vendor["origin"] == "rule"
        assert vendor["confidence"] == pytest.approx(0.4)
        assert vendor["band"] == "low"
        assert vendor["review"] == "unreviewed"
        assert vendor["evidence"]["page_number"] == 1
        assert vendor["evidence"]["boxes"]
        assert vendor["needs_attention"] is True

        # The same shape for a value read confidently, so `needs_attention` is
        # shown to be a judgement rather than a constant.
        currency = field_in(body, "currency")
        assert currency["band"] == "high"
        assert currency["needs_attention"] is False

    def test_a_document_that_does_not_exist_is_a_clean_404(
        self, api: TestClient, db_session: Session, api_prefix: str
    ) -> None:
        sign_in_as(api, db_session, api_prefix, roles=[Role.finance])

        response = api.get(f"{api_prefix}/documents/{uuid.uuid4()}")
        assert response.status_code == 404

    def test_opening_a_document_issues_a_short_lived_link_and_records_it(
        self, api: TestClient, db_session: Session, api_prefix: str, invoice: Document
    ) -> None:
        """A link that has been issued has effectively been used."""
        sign_in_as(api, db_session, api_prefix, roles=[Role.finance])

        response = api.get(f"{api_prefix}/documents/{invoice.id}/viewer-url")
        assert response.status_code == 200

        body = response.json()
        assert body["url"]
        assert body["expires_in_seconds"] > 0
        assert body["filename"] == "invoice.txt"
        assert body["content_type"].startswith("text/plain")

        assert AuditAction.document_viewed in audit_actions(db_session)


# --------------------------------------------------------------- corrections


class TestCorrections:
    def test_a_persons_value_replaces_the_readers_and_keeps_it_beside_it(
        self, api: TestClient, db_session: Session, api_prefix: str, invoice: Document
    ) -> None:
        sign_in_as(api, db_session, api_prefix, roles=[Role.finance])

        response = api.patch(
            f"{api_prefix}/documents/{invoice.id}/fields/total",
            json={"text": "120,000.00", "reason": "The document was amended by hand."},
        )
        assert response.status_code == 200

        body = response.json()
        # Every write returns the whole document, because one correction can
        # change the status and clear a blocker as well as the field.
        assert body["id"] == str(invoice.id)
        assert "acceptance_blockers" in body

        total = field_in(body, "total")
        assert total["text"] == "120,000.00"
        assert total["origin"] == "human"
        assert total["review"] == "corrected"
        assert total["reader_text"] == "115,000.00"
        assert total["amount_minor_units"] == 120_000_00
        assert total["currency"] == "JMD"
        assert total["correction_reason"] == "The document was amended by hand."
        assert total["needs_attention"] is False

    def test_a_value_the_field_cannot_hold_is_refused_and_nothing_is_stored(
        self, api: TestClient, db_session: Session, api_prefix: str, invoice: Document
    ) -> None:
        sign_in_as(api, db_session, api_prefix, roles=[Role.finance])

        refused = api.patch(
            f"{api_prefix}/documents/{invoice.id}/fields/document_date",
            json={"text": "not a date"},
        )
        assert refused.status_code == 422
        assert "not a date" in refused.json()["detail"]

        after = api.get(f"{api_prefix}/documents/{invoice.id}")
        assert after.status_code == 200

        document_date = field_in(after.json(), "document_date")
        assert document_date["text"] == "2026-03-15"
        assert document_date["origin"] == "rule"
        assert document_date["review"] == "unreviewed"

    def test_confirming_a_field_takes_it_off_the_list_needing_attention(
        self, api: TestClient, db_session: Session, api_prefix: str, unlabelled: Document
    ) -> None:
        sign_in_as(api, db_session, api_prefix, roles=[Role.finance])

        response = api.post(
            f"{api_prefix}/documents/{unlabelled.id}/fields/vendor_name/review",
            json={"review": "confirmed"},
        )
        assert response.status_code == 200

        body = response.json()
        assert body["fields_needing_attention"] == 0

        vendor = field_in(body, "vendor_name")
        assert vendor["review"] == "confirmed"
        assert vendor["origin"] == "rule"
        assert vendor["needs_attention"] is False

    def test_clearing_a_field_records_that_the_document_does_not_carry_it(
        self, api: TestClient, db_session: Session, api_prefix: str, invoice: Document
    ) -> None:
        sign_in_as(api, db_session, api_prefix, roles=[Role.finance])

        response = api.post(
            f"{api_prefix}/documents/{invoice.id}/fields/due_date/review",
            json={"review": "cleared"},
        )
        assert response.status_code == 200

        due_date = field_in(response.json(), "due_date")
        assert due_date["text"] == ""
        assert due_date["origin"] == "absent"
        assert due_date["review"] == "cleared"
        assert due_date["reader_text"] == "2026-04-14"
        assert due_date["needs_attention"] is False

    def test_saying_what_a_document_is_amends_the_reading_rather_than_replacing_it(
        self, api: TestClient, db_session: Session, api_prefix: str, unlabelled: Document
    ) -> None:
        """The kind is settled on the current attempt, not by reading the file again.

        A person who has looked at the page knows what it is, and the values the
        rules already found are still theirs. The fields the new kind requires
        appear as explicit rows to fill.
        """
        sign_in_as(api, db_session, api_prefix, roles=[Role.finance])

        response = api.post(
            f"{api_prefix}/documents/{unlabelled.id}/kind", json={"kind": "invoice"}
        )
        assert response.status_code == 200

        body = response.json()
        assert body["kind"] == "invoice"
        assert body["extraction"]["kind"] == "invoice"
        assert body["extraction"]["kind_confidence"] == pytest.approx(1.0)
        assert body["extraction"]["attempt"] == 1
        assert body["history"] == []

        total = field_in(body, "total")
        assert total["origin"] == "absent"
        assert total["needs_attention"] is True
        assert any("Total is needed" in blocker for blocker in body["acceptance_blockers"])

    def test_acknowledging_a_warning_marks_it_and_clears_its_blocker(
        self, api: TestClient, db_session: Session, api_prefix: str, banked: Document
    ) -> None:
        sign_in_as(api, db_session, api_prefix, roles=[Role.finance])

        before = api.get(f"{api_prefix}/documents/{banked.id}").json()
        assert any("vendor master" in blocker for blocker in before["acceptance_blockers"])

        response = api.post(
            f"{api_prefix}/documents/{banked.id}/acknowledge",
            json={"signal": DocumentSignal.bank_details_present.value},
        )
        assert response.status_code == 200

        body = response.json()
        signal = signal_in(body, DocumentSignal.bank_details_present.value)
        assert signal["acknowledged"] is True
        assert signal["requires_acknowledgement"] is True
        assert not any("vendor master" in blocker for blocker in body["acceptance_blockers"])


# ---------------------------------------------------------------- acceptance


class TestAcceptance:
    def test_accepting_while_anything_is_outstanding_is_refused_with_the_whole_list(
        self, api: TestClient, db_session: Session, api_prefix: str, banked: Document
    ) -> None:
        """The refusal explains the remaining task rather than the first obstacle."""
        sign_in_as(api, db_session, api_prefix, roles=[Role.finance])

        response = api.post(f"{api_prefix}/documents/{banked.id}/accept", json={})
        assert response.status_code == 409

        body = response.json()
        assert body["detail"] == "This reading is not ready to be accepted."
        assert any("vendor master" in blocker for blocker in body["blockers"])

    def test_a_reading_with_nothing_outstanding_is_accepted(
        self, api: TestClient, db_session: Session, api_prefix: str, banked: Document
    ) -> None:
        sign_in_as(api, db_session, api_prefix, roles=[Role.finance])

        acknowledged = api.post(
            f"{api_prefix}/documents/{banked.id}/acknowledge",
            json={"signal": DocumentSignal.bank_details_present.value},
        )
        assert acknowledged.status_code == 200
        assert acknowledged.json()["acceptance_blockers"] == []

        response = api.post(
            f"{api_prefix}/documents/{banked.id}/accept",
            json={"note": "Checked against the paper copy."},
        )
        assert response.status_code == 200

        body = response.json()
        assert body["status"] == ExtractionStatus.accepted.value
        assert body["extraction"]["status"] == ExtractionStatus.accepted.value
        assert body["extraction"]["accepted_at"] is not None
        assert body["extraction"]["accepted_note"] == "Checked against the paper copy."

    def test_accepting_a_second_time_is_refused(
        self, api: TestClient, db_session: Session, api_prefix: str, invoice: Document
    ) -> None:
        sign_in_as(api, db_session, api_prefix, roles=[Role.finance])

        first = api.post(f"{api_prefix}/documents/{invoice.id}/accept", json={})
        assert first.status_code == 200

        second = api.post(f"{api_prefix}/documents/{invoice.id}/accept", json={})
        assert second.status_code == 409
        assert "accepted" in second.json()["detail"]

    def test_an_accepted_reading_can_neither_be_corrected_nor_read_again(
        self, api: TestClient, db_session: Session, api_prefix: str, invoice: Document
    ) -> None:
        """Re-reading is how a rule fix reaches old documents.

        It must not be how an accepted invoice quietly acquires a different
        total, so both paths are closed once a person has confirmed the values.
        """
        sign_in_as(api, db_session, api_prefix, roles=[Role.finance])
        assert api.post(f"{api_prefix}/documents/{invoice.id}/accept", json={}).status_code == 200

        corrected = api.patch(
            f"{api_prefix}/documents/{invoice.id}/fields/total", json={"text": "1.00"}
        )
        assert corrected.status_code == 409

        reread = api.post(f"{api_prefix}/documents/{invoice.id}/read")
        assert reread.status_code == 409
