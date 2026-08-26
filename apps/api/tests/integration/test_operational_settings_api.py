"""Operational settings API: AI kill switch and workflow snapshot."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from tests.conftest import make_user, requires_db, sign_in

from finora.domain.roles import Role
from finora.infrastructure.ai_gateway import effective_kill_switch, set_runtime_kill_switch
from finora.infrastructure.db.models import User

pytestmark = [pytest.mark.integration, requires_db]


@pytest.fixture
def administrator(db_session: Session) -> User:
    return make_user(
        db_session,
        email="ops.settings.admin@example.com",
        display_name="Ops Settings Admin",
        roles=[Role.administrator],
        department="Finance",
    )


@pytest.fixture
def finance_user(db_session: Session) -> User:
    return make_user(
        db_session,
        email="ops.settings.finance@example.com",
        display_name="Ops Settings Finance",
        roles=[Role.finance],
        department="Finance",
    )


@pytest.fixture(autouse=True)
def _reset_kill_switch() -> None:
    set_runtime_kill_switch(None)
    yield
    set_runtime_kill_switch(None)


def test_operational_settings_requires_admin_ai_config(
    client: TestClient,
    api_prefix: str,
    finance_user: User,
) -> None:
    sign_in(client, finance_user.email, api_prefix)
    response = client.get(f"{api_prefix}/admin/operational-settings")
    assert response.status_code == 403

    refused = client.post(
        f"{api_prefix}/admin/operational-settings/ai-kill-switch",
        json={"engaged": True, "reason": "Should be refused without permission."},
    )
    assert refused.status_code == 403


def test_toggle_kill_switch_and_read_snapshot(
    client: TestClient,
    api_prefix: str,
    administrator: User,
) -> None:
    sign_in(client, administrator.email, api_prefix)

    before = client.get(f"{api_prefix}/admin/operational-settings")
    assert before.status_code == 200, before.text
    body = before.json()
    assert "ai" in body
    assert "workflow" in body
    assert "enabled" in body["ai"]
    assert "kill_switch_env" in body["ai"]
    assert "kill_switch_effective" in body["ai"]
    assert "model_extraction" in body["ai"]
    assert "model_classification" in body["ai"]
    assert body["ai"]["kill_switch_effective"] is False
    assert "reminder_interval_hours" in body["workflow"]
    assert "display_timezone" in body["workflow"]
    assert "base_currency" in body["workflow"]
    assert "invoice_tolerance_percent" in body["workflow"]
    assert "sign_off_link_ttl_hours" in body["workflow"]
    # No secrets in the payload.
    assert "api_key" not in body["ai"]
    assert "password" not in str(body).lower()

    engaged = client.post(
        f"{api_prefix}/admin/operational-settings/ai-kill-switch",
        json={
            "engaged": True,
            "reason": "Suspending assistive reading during an incident review.",
        },
    )
    assert engaged.status_code == 200, engaged.text
    assert engaged.json()["engaged"] is True
    assert engaged.json()["kill_switch_effective"] is True
    assert effective_kill_switch(False) is True

    after = client.get(f"{api_prefix}/admin/operational-settings")
    assert after.status_code == 200
    assert after.json()["ai"]["kill_switch_effective"] is True

    cleared = client.post(
        f"{api_prefix}/admin/operational-settings/ai-kill-switch",
        json={
            "engaged": False,
            "reason": "Incident closed; restoring assistive reading.",
        },
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["engaged"] is False
    assert cleared.json()["kill_switch_effective"] is False
    assert effective_kill_switch(False) is False
