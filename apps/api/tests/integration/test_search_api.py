"""Federated search across registers."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from tests.conftest import make_estimate, make_user, make_vendor, requires_db, sign_in

from finora.domain.roles import Role
from finora.infrastructure.db.models import User

pytestmark = [pytest.mark.integration, requires_db]


@pytest.fixture
def finance_user(db_session: Session) -> User:
    return make_user(
        db_session,
        email="search.finance@example.com",
        display_name="Search Finance",
        roles=[Role.finance],
        department="Finance",
    )


@pytest.fixture
def requester(db_session: Session) -> User:
    return make_user(
        db_session,
        email="search.requester@example.com",
        display_name="Search Requester",
        roles=[Role.requester],
        department="Facilities",
    )


def test_search_finds_estimate_by_vendor(
    client: TestClient,
    api_prefix: str,
    db_session: Session,
    finance_user: User,
    requester: User,
) -> None:
    vendor = make_vendor(
        db_session,
        code="V-SRCH",
        name="Unique Search Vendor Co",
    )
    make_estimate(
        db_session,
        requester=requester,
        vendor=vendor,
        reference="EST-SRCH01",
    )
    sign_in(client, finance_user.email, api_prefix)

    response = client.get(f"{api_prefix}/search", params={"q": "Unique Search"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] >= 1
    refs = {item["reference"] for item in body["items"]}
    assert "EST-SRCH01" in refs
    hit = next(item for item in body["items"] if item["reference"] == "EST-SRCH01")
    assert hit["record_type"] == "estimate"
    assert hit["record_path"].startswith("/estimates/")


def test_search_short_query_returns_empty(
    client: TestClient,
    api_prefix: str,
    finance_user: User,
) -> None:
    sign_in(client, finance_user.email, api_prefix)
    response = client.get(f"{api_prefix}/search", params={"q": "a"})
    assert response.status_code == 200, response.text
    assert response.json()["items"] == []


def test_search_respects_type_filter(
    client: TestClient,
    api_prefix: str,
    db_session: Session,
    finance_user: User,
    requester: User,
) -> None:
    vendor = make_vendor(db_session, code="V-FILT", name="Filter Vendor Only")
    make_estimate(
        db_session,
        requester=requester,
        vendor=vendor,
        reference="EST-FILT01",
    )
    sign_in(client, finance_user.email, api_prefix)
    response = client.get(
        f"{api_prefix}/search",
        params={"q": "Filter Vendor", "record_type": "invoice"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["items"] == []


def test_requester_does_not_see_others_estimates(
    client: TestClient,
    api_prefix: str,
    db_session: Session,
    requester: User,
) -> None:
    other = make_user(
        db_session,
        email="search.other@example.com",
        display_name="Other Requester",
        roles=[Role.requester],
        department="Facilities",
    )
    vendor = make_vendor(db_session, code="V-HIDE", name="Hidden From Requester")
    make_estimate(
        db_session,
        requester=other,
        vendor=vendor,
        reference="EST-HIDE01",
    )
    sign_in(client, requester.email, api_prefix)
    response = client.get(f"{api_prefix}/search", params={"q": "Hidden From"})
    assert response.status_code == 200, response.text
    refs = {item["reference"] for item in response.json()["items"]}
    assert "EST-HIDE01" not in refs
