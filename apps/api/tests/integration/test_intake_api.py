"""Intake endpoints.

The security-relevant assertions here are about what the API refuses: an
unauthenticated caller sees nothing, a caller without the permission is refused
and audited, and no download link is ever issued for a file that is quarantined,
refused or still being scanned.
"""

from __future__ import annotations

import io
import uuid
from collections.abc import Iterator
from typing import cast

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from tests.conftest import make_user, requires_db, sign_in
from tests.integration.test_intake_service import FakeObjectStore, FakeScanner

from finora.api.deps import get_object_store_dep, get_scanner_dep
from finora.domain.audit import AuditAction
from finora.domain.intake import IntakeStatus, ScanVerdict
from finora.domain.roles import Role
from finora.infrastructure.db.models import AuditEntryRow, MessageAttachment
from finora.infrastructure.object_store import Bucket

pytestmark = [pytest.mark.integration, requires_db]

PDF = b"%PDF-1.7\nan uploaded receipt\n"


@pytest.fixture
def fake_store() -> FakeObjectStore:
    return FakeObjectStore()


@pytest.fixture
def fake_scanner() -> FakeScanner:
    return FakeScanner()


@pytest.fixture
def api(
    client: TestClient, fake_store: FakeObjectStore, fake_scanner: FakeScanner
) -> Iterator[TestClient]:
    """The app with only the two outbound adapters replaced.

    Just the store and the scanner. `get_intake_service` is left alone so it
    still resolves the request's own session; building a second session here
    would deadlock against the advisory lock the audit chain takes.
    """
    app = cast(FastAPI, client.app)
    app.dependency_overrides[get_object_store_dep] = lambda: fake_store
    app.dependency_overrides[get_scanner_dep] = lambda: fake_scanner
    yield client
    app.dependency_overrides.clear()


def upload(
    api: TestClient, api_prefix: str, *, data: bytes = PDF, name: str = "a.pdf"
) -> httpx.Response:
    return cast(
        httpx.Response,
        api.post(
            f"{api_prefix}/intake/uploads",
            files={"file": (name, io.BytesIO(data), "application/pdf")},
        ),
    )


class TestAuthorization:
    def test_an_unauthenticated_caller_sees_nothing(self, api: TestClient, api_prefix: str) -> None:
        assert api.get(f"{api_prefix}/intake/messages").status_code == 401
        assert upload(api, api_prefix).status_code == 401

    def test_a_caller_without_the_permission_is_refused_and_audited(
        self, api: TestClient, db_session: Session, api_prefix: str
    ) -> None:
        # An auditor may read, but must never introduce a document: that would be
        # participating in the workflow they are reviewing.
        make_user(
            db_session,
            email="auditor@example.com",
            display_name="Ada Auditor",
            roles=[Role.auditor],
        )
        sign_in(api, "auditor@example.com", api_prefix)

        response = upload(api, api_prefix)
        assert response.status_code == 403

        actions = set(db_session.execute(select(AuditEntryRow.action)).scalars())
        assert AuditAction.permission_denied in actions

    def test_raw_mailbox_provenance_needs_its_own_permission(
        self,
        api: TestClient,
        db_session: Session,
        api_prefix: str,
    ) -> None:
        """The envelope is where a forged sender shows, so it is not for everyone."""
        make_user(
            db_session,
            email="clerk@example.com",
            display_name="Casey Clerk",
            roles=[Role.finance],
        )
        sign_in(api, "clerk@example.com", api_prefix)

        created = upload(api, api_prefix)
        assert created.status_code == 201
        message_id = created.json()["message_id"]

        detail = api.get(f"{api_prefix}/intake/messages/{message_id}")
        assert detail.status_code == 200
        # Finance can read the message but not the mailbox provenance.
        assert detail.json()["imap_folder"] is None


class TestUpload:
    def test_a_clean_upload_is_accepted_and_stored(
        self,
        api: TestClient,
        db_session: Session,
        api_prefix: str,
        fake_store: FakeObjectStore,
    ) -> None:
        make_user(
            db_session,
            email="clerk@example.com",
            display_name="Casey Clerk",
            roles=[Role.finance],
        )
        sign_in(api, "clerk@example.com", api_prefix)

        response = upload(api, api_prefix)
        assert response.status_code == 201

        body = response.json()
        assert body["status"] == IntakeStatus.ready.value
        assert body["stored_attachments"] == 1
        assert body["quarantined_attachments"] == 0

    def test_an_empty_upload_is_refused(
        self, api: TestClient, db_session: Session, api_prefix: str
    ) -> None:
        make_user(
            db_session,
            email="clerk@example.com",
            display_name="Casey Clerk",
            roles=[Role.finance],
        )
        sign_in(api, "clerk@example.com", api_prefix)

        response = upload(api, api_prefix, data=b"")
        assert response.status_code == 400
        assert "empty" in response.json()["detail"].lower()

    def test_the_same_file_twice_is_a_conflict_naming_the_original(
        self, api: TestClient, db_session: Session, api_prefix: str
    ) -> None:
        make_user(
            db_session,
            email="clerk@example.com",
            display_name="Casey Clerk",
            roles=[Role.finance],
        )
        sign_in(api, "clerk@example.com", api_prefix)

        first = upload(api, api_prefix)
        assert first.status_code == 201

        second = upload(api, api_prefix)
        assert second.status_code == 409
        assert first.json()["message_id"] in second.json()["detail"]

    def test_an_infected_upload_is_accepted_but_quarantined(
        self,
        api: TestClient,
        db_session: Session,
        api_prefix: str,
        fake_scanner: FakeScanner,
        fake_store: FakeObjectStore,
    ) -> None:
        """The upload is recorded, so the submitter learns what happened.

        Refusing the request outright would leave no trail of an infected file
        having been sent, which is exactly the event worth keeping.
        """
        fake_scanner.verdict = ScanVerdict.infected
        fake_scanner.detail = "Eicar-Test-Signature"

        make_user(
            db_session,
            email="clerk@example.com",
            display_name="Casey Clerk",
            roles=[Role.finance],
        )
        sign_in(api, "clerk@example.com", api_prefix)

        response = upload(api, api_prefix)
        assert response.status_code == 201

        body = response.json()
        assert body["status"] == IntakeStatus.quarantined.value
        assert body["quarantined_attachments"] == 1
        assert body["stored_attachments"] == 0
        assert fake_store.keys_in(Bucket.documents) == []


class TestDownloadLinks:
    def _sign_in_downloader(self, api: TestClient, db_session: Session, api_prefix: str) -> None:
        # Finance is the role that legitimately holds both upload and download.
        make_user(
            db_session,
            email="clerk@example.com",
            display_name="Casey Clerk",
            roles=[Role.finance],
        )
        sign_in(api, "clerk@example.com", api_prefix)

    def _attachment_id(self, db_session: Session) -> uuid.UUID:
        return db_session.execute(select(MessageAttachment.id)).scalar_one()

    def test_a_clean_attachment_gets_a_short_lived_link(
        self, api: TestClient, db_session: Session, api_prefix: str
    ) -> None:
        self._sign_in_downloader(api, db_session, api_prefix)
        assert upload(api, api_prefix).status_code == 201

        attachment_id = self._attachment_id(db_session)
        response = api.get(f"{api_prefix}/intake/attachments/{attachment_id}/download-url")
        assert response.status_code == 200

        body = response.json()
        assert body["filename"] == "a.pdf"
        assert body["expires_in_seconds"] > 0
        # Short-lived on purpose: a leaked link should expire rather than grant
        # standing access to the document store.
        assert body["expires_in_seconds"] <= 3600

    def test_no_link_is_issued_for_a_quarantined_attachment(
        self,
        api: TestClient,
        db_session: Session,
        api_prefix: str,
        fake_scanner: FakeScanner,
    ) -> None:
        fake_scanner.verdict = ScanVerdict.infected
        fake_scanner.detail = "Eicar-Test-Signature"

        self._sign_in_downloader(api, db_session, api_prefix)
        assert upload(api, api_prefix).status_code == 201

        attachment_id = self._attachment_id(db_session)
        response = api.get(f"{api_prefix}/intake/attachments/{attachment_id}/download-url")
        assert response.status_code == 409
        assert "quarantined" in response.json()["detail"].lower()

    def test_no_link_is_issued_when_the_scanner_could_not_answer(
        self,
        api: TestClient,
        db_session: Session,
        api_prefix: str,
        fake_scanner: FakeScanner,
    ) -> None:
        """An absent verdict is not a clean verdict, at the API boundary too."""
        fake_scanner.raise_unavailable = True

        self._sign_in_downloader(api, db_session, api_prefix)
        assert upload(api, api_prefix).status_code == 201

        attachment_id = self._attachment_id(db_session)
        response = api.get(f"{api_prefix}/intake/attachments/{attachment_id}/download-url")
        assert response.status_code == 409

    def test_a_refused_attachment_explains_why_it_was_never_stored(
        self, api: TestClient, db_session: Session, api_prefix: str
    ) -> None:
        self._sign_in_downloader(api, db_session, api_prefix)
        # Declared as a PDF, but the bytes are a Windows executable.
        assert upload(api, api_prefix, data=b"MZ\x90\x00not a pdf at all").status_code == 201

        attachment_id = self._attachment_id(db_session)
        response = api.get(f"{api_prefix}/intake/attachments/{attachment_id}/download-url")
        assert response.status_code == 409
        assert "never stored" in response.json()["detail"].lower()

    def test_issuing_a_link_is_audited(
        self, api: TestClient, db_session: Session, api_prefix: str
    ) -> None:
        """A link that has been issued has effectively been used."""
        self._sign_in_downloader(api, db_session, api_prefix)
        assert upload(api, api_prefix).status_code == 201

        attachment_id = self._attachment_id(db_session)
        assert (
            api.get(f"{api_prefix}/intake/attachments/{attachment_id}/download-url").status_code
            == 200
        )

        actions = set(db_session.execute(select(AuditEntryRow.action)).scalars())
        assert AuditAction.document_downloaded in actions

    def test_the_summary_marks_a_quarantined_attachment_as_undownloadable(
        self,
        api: TestClient,
        db_session: Session,
        api_prefix: str,
        fake_scanner: FakeScanner,
    ) -> None:
        """Computed server-side, so a UI that forgets to check cannot offer it."""
        fake_scanner.verdict = ScanVerdict.infected

        self._sign_in_downloader(api, db_session, api_prefix)
        created = upload(api, api_prefix)
        message_id = created.json()["message_id"]

        detail = api.get(f"{api_prefix}/intake/messages/{message_id}")
        assert detail.status_code == 200

        attachment = detail.json()["attachments"][0]
        assert attachment["can_download"] is False
        assert attachment["is_quarantined"] is True


class TestListing:
    def test_lists_newest_first_and_filters_by_status(
        self, api: TestClient, db_session: Session, api_prefix: str
    ) -> None:
        make_user(
            db_session,
            email="clerk@example.com",
            display_name="Casey Clerk",
            roles=[Role.finance],
        )
        sign_in(api, "clerk@example.com", api_prefix)

        assert upload(api, api_prefix, data=PDF, name="first.pdf").status_code == 201
        assert upload(api, api_prefix, data=PDF + b"second", name="second.pdf").status_code == 201

        listing = api.get(f"{api_prefix}/intake/messages")
        assert listing.status_code == 200
        assert listing.json()["total"] == 2

        ready = api.get(f"{api_prefix}/intake/messages", params={"status": "ready"})
        assert ready.json()["total"] == 2

        quarantined = api.get(f"{api_prefix}/intake/messages", params={"status": "quarantined"})
        assert quarantined.json()["total"] == 0

    def test_an_unknown_message_is_a_clean_404(
        self, api: TestClient, db_session: Session, api_prefix: str
    ) -> None:
        make_user(
            db_session,
            email="clerk@example.com",
            display_name="Casey Clerk",
            roles=[Role.finance],
        )
        sign_in(api, "clerk@example.com", api_prefix)

        response = api.get(f"{api_prefix}/intake/messages/{uuid.uuid4()}")
        assert response.status_code == 404


class TestOperations:
    def test_reading_intake_messages_does_not_grant_the_operations_view(
        self, api: TestClient, db_session: Session, api_prefix: str
    ) -> None:
        """Separate permissions because they answer to different people.

        Finance triages documents; the operational picture, including mailbox
        credentials and quota, belongs to whoever runs the platform.
        """
        make_user(
            db_session,
            email="clerk@example.com",
            display_name="Casey Clerk",
            roles=[Role.finance],
        )
        sign_in(api, "clerk@example.com", api_prefix)

        assert api.get(f"{api_prefix}/intake/messages").status_code == 200
        assert api.get(f"{api_prefix}/intake/operations").status_code == 403

    def test_an_operator_sees_the_state_and_backlog(
        self, api: TestClient, db_session: Session, api_prefix: str
    ) -> None:
        make_user(
            db_session,
            email="ops@example.com",
            display_name="Omar Operations",
            roles=[Role.operations],
        )
        sign_in(api, "ops@example.com", api_prefix)

        response = api.get(f"{api_prefix}/intake/operations")
        assert response.status_code == 200

        body = response.json()
        # No poll has ever been recorded, so the honest answer is `unknown`
        # rather than a reassuring `healthy`.
        assert body["state"] == "unknown"
        assert body["concerns"]
        assert body["backlog"]["total"] == 0
        # The live probe is opt-in, so the default response touches no network.
        assert body["mailbox"] is None
