"""Purchase-order threshold administration API."""

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
        email="threshold.admin@example.com",
        display_name="Threshold Admin",
        roles=[Role.administrator],
        department="Finance",
    )


@pytest.fixture
def finance_user(db_session: Session) -> User:
    return make_user(
        db_session,
        email="threshold.finance@example.com",
        display_name="Threshold Finance",
        roles=[Role.finance],
        department="Finance",
    )


def _payload(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "currency": "USD",
        "applies_above_minor_units": 5_000_00,
        "reason": "Aligning the USD purchase-order control.",
    }
    body.update(overrides)
    return body


def test_list_thresholds_requires_admin_thresholds(
    client: TestClient,
    api_prefix: str,
    finance_user: User,
) -> None:
    sign_in(client, finance_user.email, api_prefix)
    response = client.get(f"{api_prefix}/admin/thresholds")
    assert response.status_code == 403


def test_create_update_and_deactivate_threshold(
    client: TestClient,
    api_prefix: str,
    administrator: User,
) -> None:
    sign_in(client, administrator.email, api_prefix)

    created = client.put(
        f"{api_prefix}/admin/thresholds",
        json=_payload(),
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["currency"] == "USD"
    assert body["applies_above_minor_units"] == 5_000_00
    assert body["is_active"] is True
    threshold_id = body["id"]

    listed = client.get(f"{api_prefix}/admin/thresholds")
    assert listed.status_code == 200
    currencies = {row["currency"] for row in listed.json()}
    assert "USD" in currencies

    updated = client.put(
        f"{api_prefix}/admin/thresholds",
        json=_payload(
            applies_above_minor_units=7_500_00,
            reason="Raising the USD threshold after review.",
        ),
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["id"] == threshold_id
    assert updated.json()["applies_above_minor_units"] == 7_500_00
    assert updated.json()["is_active"] is True

    deactivated = client.post(
        f"{api_prefix}/admin/thresholds/{threshold_id}/active",
        json={"is_active": False, "reason": "Suspending the USD control temporarily."},
    )
    assert deactivated.status_code == 200, deactivated.text
    assert deactivated.json()["is_active"] is False
