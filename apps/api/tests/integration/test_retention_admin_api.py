"""Retention-policy administration API."""

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
        email="retention.admin@example.com",
        display_name="Retention Admin",
        roles=[Role.administrator],
        department="Finance",
    )


@pytest.fixture
def finance_user(db_session: Session) -> User:
    return make_user(
        db_session,
        email="retention.finance@example.com",
        display_name="Retention Finance",
        roles=[Role.finance],
        department="Finance",
    )


def test_list_retention_requires_admin_retention(
    client: TestClient,
    api_prefix: str,
    finance_user: User,
) -> None:
    sign_in(client, finance_user.email, api_prefix)
    response = client.get(f"{api_prefix}/admin/retention")
    assert response.status_code == 403


def test_list_update_and_deactivate_retention(
    client: TestClient,
    api_prefix: str,
    administrator: User,
) -> None:
    sign_in(client, administrator.email, api_prefix)

    listed = client.get(f"{api_prefix}/admin/retention")
    assert listed.status_code == 200, listed.text
    rows: list[dict[str, Any]] = listed.json()
    classes = {row["record_class"] for row in rows}
    assert "inbound_messages" in classes
    assert "audit_entries" in classes
    assert "invoices" in classes

    invoices = next(row for row in rows if row["record_class"] == "invoices")
    assert invoices["retention_days"] == 2555
    assert invoices["is_active"] is True
    policy_id = invoices["id"]

    updated = client.patch(
        f"{api_prefix}/admin/retention/{policy_id}",
        json={
            "retention_days": 2920,
            "reason": "Extending invoice retention after legal review.",
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["id"] == policy_id
    assert updated.json()["retention_days"] == 2920
    assert updated.json()["is_active"] is True

    deactivated = client.post(
        f"{api_prefix}/admin/retention/{policy_id}/active",
        json={
            "is_active": False,
            "reason": "Suspending invoice retention while requirements settle.",
        },
    )
    assert deactivated.status_code == 200, deactivated.text
    assert deactivated.json()["is_active"] is False

    audit = next(row for row in rows if row["record_class"] == "audit_entries")
    assert audit["retention_days"] == 3650
