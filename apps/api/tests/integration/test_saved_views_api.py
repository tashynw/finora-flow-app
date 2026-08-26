"""Personal saved views for the work queue."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from tests.conftest import make_user, requires_db, sign_in

from finora.domain.roles import Role
from finora.infrastructure.db.models import User

pytestmark = [pytest.mark.integration, requires_db]


@pytest.fixture
def actor(db_session: Session) -> User:
    return make_user(
        db_session,
        email="views.actor@example.com",
        display_name="Views Actor",
        roles=[Role.approver],
        department="Facilities",
    )


def test_create_list_and_delete_work_view(
    client: TestClient,
    api_prefix: str,
    actor: User,
) -> None:
    sign_in(client, actor.email, api_prefix)

    created = client.post(
        f"{api_prefix}/saved-views",
        json={
            "scope": "work",
            "name": "Approvals only",
            "definition": {"kinds": ["approval"]},
            "is_default": True,
        },
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["name"] == "Approvals only"
    assert body["definition"] == {"kinds": ["approval"]}
    assert body["is_default"] is True
    view_id = body["id"]

    listed = client.get(f"{api_prefix}/saved-views", params={"scope": "work"})
    assert listed.status_code == 200
    assert any(row["id"] == view_id for row in listed.json())

    deleted = client.delete(f"{api_prefix}/saved-views/{view_id}")
    assert deleted.status_code == 204

    listed_again = client.get(f"{api_prefix}/saved-views", params={"scope": "work"})
    assert listed_again.json() == []


def test_refuse_empty_kinds(
    client: TestClient,
    api_prefix: str,
    actor: User,
) -> None:
    sign_in(client, actor.email, api_prefix)
    response = client.post(
        f"{api_prefix}/saved-views",
        json={
            "scope": "work",
            "name": "Nothing",
            "definition": {"kinds": []},
        },
    )
    assert response.status_code == 422


def test_views_are_owner_only(
    client: TestClient,
    api_prefix: str,
    db_session: Session,
    actor: User,
) -> None:
    sign_in(client, actor.email, api_prefix)
    created = client.post(
        f"{api_prefix}/saved-views",
        json={
            "scope": "work",
            "name": "Private",
            "definition": {"kinds": ["sign_off"]},
        },
    )
    assert created.status_code == 201
    view_id = created.json()["id"]

    other = make_user(
        db_session,
        email="views.other@example.com",
        display_name="Other Viewer",
        roles=[Role.approver],
        department="Facilities",
    )
    sign_in(client, other.email, api_prefix)
    listed = client.get(f"{api_prefix}/saved-views", params={"scope": "work"})
    assert listed.json() == []

    stolen = client.delete(f"{api_prefix}/saved-views/{view_id}")
    assert stolen.status_code == 404
