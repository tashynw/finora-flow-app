"""Reference-data administration API."""

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
        email="ref.admin@example.com",
        display_name="Reference Admin",
        roles=[Role.administrator],
        department="Finance",
    )


@pytest.fixture
def finance_user(db_session: Session) -> User:
    return make_user(
        db_session,
        email="ref.finance@example.com",
        display_name="Reference Finance",
        roles=[Role.finance],
        department="Finance",
    )


def _vendor_payload(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "code": "V-NEW-01",
        "name": "New Supplies Ltd",
        "email": "ap@newsupplies.example",
        "default_currency": "JMD",
        "reason": "Onboarding a preferred supplier.",
    }
    body.update(overrides)
    return body


def test_list_vendors_requires_admin_reference_data(
    client: TestClient,
    api_prefix: str,
    finance_user: User,
) -> None:
    sign_in(client, finance_user.email, api_prefix)
    response = client.get(f"{api_prefix}/admin/reference/vendors")
    assert response.status_code == 403


def test_create_vendor(
    client: TestClient,
    api_prefix: str,
    administrator: User,
) -> None:
    sign_in(client, administrator.email, api_prefix)
    created = client.post(
        f"{api_prefix}/admin/reference/vendors",
        json=_vendor_payload(),
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["code"] == "V-NEW-01"
    assert body["name"] == "New Supplies Ltd"
    assert body["is_active"] is True

    listed = client.get(f"{api_prefix}/admin/reference/vendors")
    assert listed.status_code == 200
    codes = {row["code"] for row in listed.json()}
    assert "V-NEW-01" in codes


def test_deactivate_vendor(
    client: TestClient,
    api_prefix: str,
    administrator: User,
) -> None:
    sign_in(client, administrator.email, api_prefix)
    created = client.post(
        f"{api_prefix}/admin/reference/vendors",
        json=_vendor_payload(code="V-TEMP-01", name="Temporary Vendor"),
    )
    assert created.status_code == 201, created.text
    vendor_id = created.json()["id"]

    response = client.post(
        f"{api_prefix}/admin/reference/vendors/{vendor_id}/active",
        json={"is_active": False, "reason": "No longer trading with us."},
    )
    assert response.status_code == 200, response.text
    assert response.json()["is_active"] is False


def test_refuse_duplicate_vendor_code(
    client: TestClient,
    api_prefix: str,
    administrator: User,
) -> None:
    sign_in(client, administrator.email, api_prefix)
    first = client.post(
        f"{api_prefix}/admin/reference/vendors",
        json=_vendor_payload(code="V-DUP-01", name="First"),
    )
    assert first.status_code == 201, first.text

    second = client.post(
        f"{api_prefix}/admin/reference/vendors",
        json=_vendor_payload(code="V-DUP-01", name="Second"),
    )
    assert second.status_code == 422, second.text
    assert "already exists" in second.json()["detail"]
