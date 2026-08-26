"""Audit trail read and verification endpoints.

An auditor must be able to page the chain and check that it still holds. A
caller without `audit:view` must be refused. The trail itself is written on
business paths; these tests only cover reading it back.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from tests.conftest import make_user, requires_db, sign_in

from finora.domain.audit import ActorType, AuditAction
from finora.domain.roles import Role
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import AuditEntryRow, User

pytestmark = [pytest.mark.integration, requires_db]


@pytest.fixture
def auditor(db_session: Session) -> User:
    return make_user(
        db_session,
        email="alan.auditor@example.com",
        display_name="Alan Auditor",
        roles=[Role.auditor],
        department="Finance",
    )


@pytest.fixture
def requester(db_session: Session) -> User:
    return make_user(
        db_session,
        email="rita.requester@example.com",
        display_name="Rita Requester",
        roles=[Role.requester],
        department="Operations",
    )


def _seed_entries(session: Session, *, count: int = 3) -> list[AuditEntryRow]:
    audit = AuditRepository(session)
    rows: list[AuditEntryRow] = []
    for index in range(count):
        rows.append(
            audit.append(
                action=AuditAction.record_created if index % 2 == 0 else AuditAction.state_changed,
                actor_type=ActorType.user,
                actor_label=f"Seed {index}",
                subject_type="invoice",
                detail={"step": index},
            )
        )
    session.commit()
    return rows


class TestAuditList:
    def test_an_auditor_can_page_entries(
        self, client: TestClient, api_prefix: str, db_session: Session, auditor: User
    ) -> None:
        seeded = _seed_entries(db_session, count=3)
        sign_in(client, auditor.email, api_prefix)

        response = client.get(f"{api_prefix}/audit/entries", params={"limit": 2, "offset": 0})

        assert response.status_code == 200
        body = response.json()
        assert body["limit"] == 2
        assert body["offset"] == 0
        assert body["total"] >= 3
        assert len(body["items"]) == 2
        assert body["items"][0]["sequence"] == seeded[0].sequence
        assert "entry_hash" in body["items"][0]
        assert "detail" in body["items"][0]

    def test_entries_can_be_filtered_by_action(
        self, client: TestClient, api_prefix: str, db_session: Session, auditor: User
    ) -> None:
        _seed_entries(db_session, count=4)
        sign_in(client, auditor.email, api_prefix)

        response = client.get(
            f"{api_prefix}/audit/entries",
            params={"action": AuditAction.state_changed.value},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["total"] >= 1
        assert all(item["action"] == AuditAction.state_changed.value for item in body["items"])

    def test_one_entry_is_returned_by_sequence(
        self, client: TestClient, api_prefix: str, db_session: Session, auditor: User
    ) -> None:
        seeded = _seed_entries(db_session, count=1)
        sign_in(client, auditor.email, api_prefix)

        response = client.get(f"{api_prefix}/audit/entries/{seeded[0].sequence}")

        assert response.status_code == 200
        assert response.json()["sequence"] == seeded[0].sequence
        assert response.json()["entry_hash"] == seeded[0].entry_hash

    def test_a_missing_sequence_is_not_found(
        self, client: TestClient, api_prefix: str, auditor: User
    ) -> None:
        sign_in(client, auditor.email, api_prefix)

        response = client.get(f"{api_prefix}/audit/entries/999999")

        assert response.status_code == 404

    def test_a_caller_without_permission_is_refused(
        self, client: TestClient, api_prefix: str, db_session: Session, requester: User
    ) -> None:
        sign_in(client, requester.email, api_prefix)

        response = client.get(f"{api_prefix}/audit/entries")

        assert response.status_code == 403
        actions = set(db_session.execute(select(AuditEntryRow.action)).scalars())
        assert AuditAction.permission_denied in actions


class TestAuditVerify:
    def test_an_intact_chain_verifies(
        self, client: TestClient, api_prefix: str, db_session: Session, auditor: User
    ) -> None:
        _seed_entries(db_session, count=3)
        sign_in(client, auditor.email, api_prefix)

        response = client.post(f"{api_prefix}/audit/verify", json={})

        assert response.status_code == 200
        body = response.json()
        assert body["ok"] is True
        assert body["checked_count"] >= 3
        assert body["first_bad_sequence"] is None
        assert "intact" in body["message"]

    def test_a_range_can_be_verified(
        self, client: TestClient, api_prefix: str, db_session: Session, auditor: User
    ) -> None:
        seeded = _seed_entries(db_session, count=4)
        sign_in(client, auditor.email, api_prefix)

        response = client.post(
            f"{api_prefix}/audit/verify",
            json={"start_sequence": seeded[1].sequence, "limit": 2},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["ok"] is True
        assert body["checked_count"] == 2
