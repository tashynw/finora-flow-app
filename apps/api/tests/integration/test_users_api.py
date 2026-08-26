"""User administration and role-composition refusal (threat model T5)."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from tests.conftest import make_user, requires_db, sign_in

from finora.domain.roles import Role
from finora.infrastructure.db.models import User

pytestmark = [pytest.mark.integration, requires_db]


@pytest.fixture
def administrator(db_session: Session) -> User:
    return make_user(
        db_session,
        email="users.admin@example.com",
        display_name="Users Admin",
        roles=[Role.administrator],
        department="Finance",
    )


@pytest.fixture
def finance_user(db_session: Session) -> User:
    return make_user(
        db_session,
        email="users.finance@example.com",
        display_name="Users Finance",
        roles=[Role.finance],
        department="Finance",
    )


def _create_payload(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "email": "new.colleague@example.com",
        "display_name": "New Colleague",
        "department": "Facilities",
        "roles": ["finance"],
        "reason": "Joining the month-end team.",
    }
    body.update(overrides)
    return body


def test_list_users_requires_admin_users(
    client: TestClient,
    api_prefix: str,
    finance_user: User,
) -> None:
    sign_in(client, finance_user.email, api_prefix)
    response = client.get(f"{api_prefix}/admin/users")
    assert response.status_code == 403


def test_create_and_list_user(
    client: TestClient,
    api_prefix: str,
    administrator: User,
) -> None:
    sign_in(client, administrator.email, api_prefix)
    created = client.post(f"{api_prefix}/admin/users", json=_create_payload())
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["email"] == "new.colleague@example.com"
    assert body["roles"] == ["finance"]
    assert "invoice:view" in body["permissions"]

    listed = client.get(f"{api_prefix}/admin/users")
    assert listed.status_code == 200
    emails = {row["email"] for row in listed.json()}
    assert "new.colleague@example.com" in emails
    assert administrator.email in emails


def test_refuse_administrator_with_approver_on_create(
    client: TestClient,
    api_prefix: str,
    administrator: User,
) -> None:
    sign_in(client, administrator.email, api_prefix)
    response = client.post(
        f"{api_prefix}/admin/users",
        json=_create_payload(
            email="both.sides@example.com",
            display_name="Both Sides",
            roles=["administrator", "approver"],
            reason="Trying to hold both sides of T5.",
        ),
    )
    assert response.status_code == 422, response.text
    assert "admin:approval_matrix" in response.json()["detail"]
    assert "approval:decide" in response.json()["detail"]


def test_refuse_administrator_with_approver_on_role_change(
    client: TestClient,
    api_prefix: str,
    administrator: User,
    finance_user: User,
) -> None:
    sign_in(client, administrator.email, api_prefix)
    response = client.put(
        f"{api_prefix}/admin/users/{finance_user.id}/roles",
        json={
            "roles": ["administrator", "approver"],
            "reason": "Promoting into a conflicting pair.",
        },
    )
    assert response.status_code == 422, response.text
    assert "cannot be held together" in response.json()["detail"]


def test_set_roles_happy_path(
    client: TestClient,
    api_prefix: str,
    administrator: User,
    finance_user: User,
) -> None:
    sign_in(client, administrator.email, api_prefix)
    response = client.put(
        f"{api_prefix}/admin/users/{finance_user.id}/roles",
        json={
            "roles": ["finance", "auditor"],
            "reason": "Also needs read-only audit access.",
        },
    )
    assert response.status_code == 200, response.text
    assert set(response.json()["roles"]) == {"auditor", "finance"}


def test_deactivate_user(
    client: TestClient,
    api_prefix: str,
    administrator: User,
    finance_user: User,
) -> None:
    sign_in(client, administrator.email, api_prefix)
    response = client.post(
        f"{api_prefix}/admin/users/{finance_user.id}/active",
        json={"is_active": False, "reason": "Left the organisation."},
    )
    assert response.status_code == 200, response.text
    assert response.json()["is_active"] is False
