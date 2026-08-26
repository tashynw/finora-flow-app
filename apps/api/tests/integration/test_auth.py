"""Authentication, authorization and the audit records they produce."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from tests.conftest import make_user, requires_db, sign_in

from finora.domain.audit import AuditAction
from finora.domain.roles import Role
from finora.infrastructure.db.models import AuditEntryRow

pytestmark = [pytest.mark.integration, requires_db]


class TestSignIn:
    def test_known_user_receives_session_cookie(
        self, client: TestClient, db_session: Session, api_prefix: str
    ) -> None:
        make_user(
            db_session,
            email="alex@example.com",
            display_name="Alex Requester",
            roles=[Role.requester],
        )
        response = client.post(
            f"{api_prefix}/auth/local/sign-in", json={"email": "alex@example.com"}
        )
        assert response.status_code == 200
        assert "finora_session" in response.cookies
        assert response.json()["display_name"] == "Alex Requester"

    def test_unknown_user_is_rejected(self, client: TestClient, api_prefix: str) -> None:
        response = client.post(
            f"{api_prefix}/auth/local/sign-in", json={"email": "nobody@example.com"}
        )
        assert response.status_code == 401

    def test_inactive_user_is_rejected(
        self, client: TestClient, db_session: Session, api_prefix: str
    ) -> None:
        make_user(
            db_session,
            email="gone@example.com",
            display_name="Former Staff",
            roles=[Role.finance],
            is_active=False,
        )
        response = client.post(
            f"{api_prefix}/auth/local/sign-in", json={"email": "gone@example.com"}
        )
        assert response.status_code == 401

    def test_absent_and_disabled_accounts_are_indistinguishable(
        self, client: TestClient, db_session: Session, api_prefix: str
    ) -> None:
        """The endpoint must not enable user enumeration."""
        make_user(
            db_session,
            email="disabled@example.com",
            display_name="Disabled",
            roles=[Role.finance],
            is_active=False,
        )
        disabled = client.post(
            f"{api_prefix}/auth/local/sign-in", json={"email": "disabled@example.com"}
        )
        missing = client.post(
            f"{api_prefix}/auth/local/sign-in", json={"email": "absent@example.com"}
        )
        assert disabled.status_code == missing.status_code
        assert disabled.json()["detail"] == missing.json()["detail"]

    def test_malformed_email_is_a_validation_error(
        self, client: TestClient, api_prefix: str
    ) -> None:
        response = client.post(f"{api_prefix}/auth/local/sign-in", json={"email": "not-an-email"})
        assert response.status_code == 422
        assert response.json()["code"] == "validation_failed"


class TestCurrentUser:
    def test_requires_a_session(self, client: TestClient, api_prefix: str) -> None:
        assert client.get(f"{api_prefix}/auth/me").status_code == 401

    def test_returns_roles_and_permissions(
        self, client: TestClient, db_session: Session, api_prefix: str
    ) -> None:
        make_user(
            db_session,
            email="jane@example.com",
            display_name="Jane Approver",
            roles=[Role.approver],
        )
        sign_in(client, "jane@example.com", api_prefix)
        body = client.get(f"{api_prefix}/auth/me").json()
        assert body["roles"] == ["approver"]
        assert "approval:decide" in body["permissions"]
        assert "payment:mark_paid" not in body["permissions"]

    def test_auditor_permissions_are_read_only(
        self, client: TestClient, db_session: Session, api_prefix: str
    ) -> None:
        make_user(
            db_session,
            email="audit@example.com",
            display_name="Read Only",
            roles=[Role.auditor],
        )
        sign_in(client, "audit@example.com", api_prefix)
        permissions = client.get(f"{api_prefix}/auth/me").json()["permissions"]
        assert all(p.endswith(":view") for p in permissions)

    def test_tampered_cookie_is_refused(
        self, client: TestClient, db_session: Session, api_prefix: str
    ) -> None:
        make_user(
            db_session,
            email="alex@example.com",
            display_name="Alex",
            roles=[Role.requester],
        )
        sign_in(client, "alex@example.com", api_prefix)
        client.cookies.set("finora_session", "forged.session.value")
        assert client.get(f"{api_prefix}/auth/me").status_code == 401


class TestSignOut:
    def test_sign_out_clears_the_session(
        self, client: TestClient, db_session: Session, api_prefix: str
    ) -> None:
        make_user(
            db_session,
            email="alex@example.com",
            display_name="Alex",
            roles=[Role.requester],
        )
        sign_in(client, "alex@example.com", api_prefix)
        assert client.post(f"{api_prefix}/auth/sign-out").status_code == 204
        assert client.get(f"{api_prefix}/auth/me").status_code == 401


class TestOidc:
    def test_methods_describes_available_options(self, client: TestClient, api_prefix: str) -> None:
        body = client.get(f"{api_prefix}/auth/methods").json()
        assert body["local_accounts_enabled"] is True
        assert body["environment"] == "development"

    def test_unconfigured_callback_does_not_fake_a_session(
        self, client: TestClient, api_prefix: str
    ) -> None:
        """An unimplemented provider must refuse, not invent a login."""
        response = client.get(f"{api_prefix}/auth/oidc/callback")
        assert response.status_code == 501
        assert "finora_session" not in response.cookies


class TestAuditTrail:
    def test_successful_sign_in_is_recorded(
        self, client: TestClient, db_session: Session, api_prefix: str
    ) -> None:
        make_user(
            db_session,
            email="alex@example.com",
            display_name="Alex",
            roles=[Role.requester],
        )
        sign_in(client, "alex@example.com", api_prefix)
        actions = set(db_session.execute(select(AuditEntryRow.action)).scalars())
        assert AuditAction.sign_in in actions

    def test_failed_sign_in_is_recorded(
        self, client: TestClient, db_session: Session, api_prefix: str
    ) -> None:
        client.post(f"{api_prefix}/auth/local/sign-in", json={"email": "nobody@example.com"})
        actions = set(db_session.execute(select(AuditEntryRow.action)).scalars())
        assert AuditAction.sign_in_failed in actions

    def test_audit_chain_starts_at_genesis(
        self, client: TestClient, db_session: Session, api_prefix: str
    ) -> None:
        make_user(
            db_session,
            email="alex@example.com",
            display_name="Alex",
            roles=[Role.requester],
        )
        sign_in(client, "alex@example.com", api_prefix)
        first = db_session.execute(
            select(AuditEntryRow).order_by(AuditEntryRow.sequence.asc()).limit(1)
        ).scalar_one()
        assert first.sequence == 1
        assert first.previous_hash == "0" * 64

    def test_audit_detail_does_not_contain_the_session_token(
        self, client: TestClient, db_session: Session, api_prefix: str
    ) -> None:
        make_user(
            db_session,
            email="alex@example.com",
            display_name="Alex",
            roles=[Role.requester],
        )
        sign_in(client, "alex@example.com", api_prefix)
        for detail in db_session.execute(select(AuditEntryRow.detail)).scalars():
            serialised = str(detail).lower()
            assert "session" not in serialised or "[redacted]" in serialised
