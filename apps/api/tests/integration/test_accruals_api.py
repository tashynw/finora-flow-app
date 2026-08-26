"""Accrual period lifecycle end to end.

Five behaviours matter here:

*Open and generate.* A finance user opens a period, seeds the candidates from
approved invoices, and can edit them.

*Editing and locking are different people.* The person who edits a candidate
cannot lock the period it belongs to.

*A candidate must be finalized or excluded before the period locks.* Calling
lock while a proposed or adjusted candidate still exists is refused.

*An official export requires a locked period.* A draft export may be produced
at any time; an official one is refused until the period is locked.

*Segregation of duties is enforced at the record level.* The first person to
record an `accrual:edit` action on a period cannot be the one who locks it.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from tests.conftest import make_invoice, make_user, make_vendor, requires_db, sign_in

from finora.domain.roles import Role
from finora.infrastructure.db.models import User

pytestmark = [pytest.mark.integration, requires_db]


@pytest.fixture
def editor(db_session: Session) -> User:
    return make_user(
        db_session,
        email="alice.editor@example.com",
        display_name="Alice Editor",
        roles=[Role.finance],
        department="Finance",
    )


@pytest.fixture
def locker(db_session: Session) -> User:
    return make_user(
        db_session,
        email="bob.locker@example.com",
        display_name="Bob Locker",
        roles=[Role.finance],
        department="Finance",
    )


class TestAccrualsApi:
    def test_full_lifecycle(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        editor: User,
        locker: User,
    ) -> None:
        """Open → generate (seeded invoice) → edit → finalize → lock (second
        user) → official CSV export."""

        # Seed an approved invoice that falls within the period.
        vendor = make_vendor(db_session)
        make_invoice(
            db_session,
            recorded_by=editor,
            vendor=vendor,
            total_minor_units=1_500_000,
            currency="JMD",
        )

        # ---------------------------------------------------------------- open
        sign_in(client, editor.email, api_prefix)
        opened = client.post(
            f"{api_prefix}/accruals/periods",
            json={
                "period_start": "2026-08-01",
                "period_end": "2026-08-31",
                "label": "August 2026 accruals",
            },
        )
        assert opened.status_code == 201, opened.text
        body = opened.json()
        assert body["standing"] == "open"
        assert body["candidate_count"] == 0
        assert body["actions"]["edit"] is True
        assert body["actions"]["lock"] is False
        period_id = body["id"]

        # ----------------------------------------------------------- generate
        generated = client.post(f"{api_prefix}/accruals/periods/{period_id}/candidates/generate")
        assert generated.status_code == 200, generated.text
        body = generated.json()
        assert body["candidate_count"] >= 1, "Expected the seeded invoice as a candidate"
        candidate = body["candidates"][0]
        assert candidate["standing"] == "proposed"
        assert candidate["amount"]["minor_units"] == 1_500_000
        candidate_id = candidate["id"]

        # ------------------------------------------------------------- edit
        edited = client.patch(
            f"{api_prefix}/accruals/candidates/{candidate_id}",
            json={
                "amount_minor": 1_200_000,
                "currency": "JMD",
                "exclude": False,
                "reason": "Adjusted to the confirmed delivery note figure.",
                "note": "Supplier confirmed partial delivery.",
            },
        )
        assert edited.status_code == 200, edited.text
        body = edited.json()
        assert body["standing"] == "adjusted"
        assert body["amount"]["minor_units"] == 1_200_000
        assert body["edit_reason"] == "Adjusted to the confirmed delivery note figure."

        # ---------------------------------------------------------- finalize
        finalized = client.post(
            f"{api_prefix}/accruals/candidates/{candidate_id}/finalize",
            json={},
        )
        assert finalized.status_code == 200, finalized.text
        assert finalized.json()["standing"] == "finalized"

        # ---- the editor cannot also lock (SoD) ---------------------
        refused_lock = client.post(
            f"{api_prefix}/accruals/periods/{period_id}/lock",
            json={"reason": "Month-end complete."},
        )
        assert refused_lock.status_code == 403, refused_lock.text

        # ---- second user locks the period --------------------------
        sign_in(client, locker.email, api_prefix)
        locked = client.post(
            f"{api_prefix}/accruals/periods/{period_id}/lock",
            json={"reason": "Finance sign-off complete for August 2026."},
        )
        assert locked.status_code == 200, locked.text
        body = locked.json()
        assert body["standing"] == "locked"
        assert body["actions"]["lock"] is False
        assert body["actions"]["export"] is True

        # ---- official CSV export -----------------------------------
        exported = client.post(
            f"{api_prefix}/accruals/periods/{period_id}/export",
            json={"format": "csv", "official": True},
        )
        assert exported.status_code == 200, exported.text
        assert exported.headers["content-type"].startswith("text/csv")
        csv_text = exported.content.decode("utf-8")
        # Header row must be present.
        assert "reference" in csv_text
        assert "vendor" in csv_text
        # The finalized candidate appears in the file.
        assert "finalized" in csv_text

    def test_draft_export_does_not_require_lock(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        editor: User,
    ) -> None:
        """A draft export is allowed while the period is still open."""
        vendor = make_vendor(db_session, code="V-DRAFT", name="Draft Vendor")
        make_invoice(db_session, recorded_by=editor, vendor=vendor)

        sign_in(client, editor.email, api_prefix)
        opened = client.post(
            f"{api_prefix}/accruals/periods",
            json={
                "period_start": "2026-08-01",
                "period_end": "2026-08-31",
                "label": "August draft check",
            },
        )
        period_id = opened.json()["id"]

        client.post(f"{api_prefix}/accruals/periods/{period_id}/candidates/generate")

        draft_export = client.post(
            f"{api_prefix}/accruals/periods/{period_id}/export",
            json={"format": "csv", "official": False},
        )
        assert draft_export.status_code == 200, draft_export.text

    def test_official_export_refused_on_open_period(
        self,
        client: TestClient,
        api_prefix: str,
        editor: User,
    ) -> None:
        sign_in(client, editor.email, api_prefix)
        opened = client.post(
            f"{api_prefix}/accruals/periods",
            json={
                "period_start": "2026-08-01",
                "period_end": "2026-08-31",
                "label": "Premature export test",
            },
        )
        period_id = opened.json()["id"]

        refused = client.post(
            f"{api_prefix}/accruals/periods/{period_id}/export",
            json={"format": "csv", "official": True},
        )
        assert refused.status_code == 422, refused.text

    def test_open_period_refuses_unordered_dates(
        self,
        client: TestClient,
        api_prefix: str,
        editor: User,
    ) -> None:
        sign_in(client, editor.email, api_prefix)
        refused = client.post(
            f"{api_prefix}/accruals/periods",
            json={
                "period_start": "2026-08-31",
                "period_end": "2026-08-01",
                "label": "Bad dates",
            },
        )
        assert refused.status_code == 422, refused.text

    def test_lock_refused_with_open_candidates(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        editor: User,
        locker: User,
    ) -> None:
        """A period cannot lock while any candidate is still proposed."""
        vendor = make_vendor(db_session, code="V-LOCK", name="Lock Test Vendor")
        make_invoice(db_session, recorded_by=editor, vendor=vendor)

        sign_in(client, editor.email, api_prefix)
        opened = client.post(
            f"{api_prefix}/accruals/periods",
            json={
                "period_start": "2026-08-01",
                "period_end": "2026-08-31",
                "label": "Lock test",
            },
        )
        period_id = opened.json()["id"]
        client.post(f"{api_prefix}/accruals/periods/{period_id}/candidates/generate")

        sign_in(client, locker.email, api_prefix)
        refused = client.post(
            f"{api_prefix}/accruals/periods/{period_id}/lock",
            json={"reason": "Trying to lock with open candidates."},
        )
        assert refused.status_code == 422, refused.text

    def test_list_periods_filtered_by_standing(
        self,
        client: TestClient,
        api_prefix: str,
        editor: User,
    ) -> None:
        sign_in(client, editor.email, api_prefix)
        client.post(
            f"{api_prefix}/accruals/periods",
            json={
                "period_start": "2026-07-01",
                "period_end": "2026-07-31",
                "label": "July 2026",
            },
        )

        open_list = client.get(f"{api_prefix}/accruals/periods?standing=open")
        assert open_list.status_code == 200, open_list.text
        assert len(open_list.json()) >= 1

        locked_list = client.get(f"{api_prefix}/accruals/periods?standing=locked")
        assert locked_list.status_code == 200, locked_list.text
        # No locked periods yet in this test.
        assert len(locked_list.json()) == 0
