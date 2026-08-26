"""The one queue an approver works from.

Three properties are checked here, because losing any of them is silent.

*It spans record types.* An estimate and a purchase order waiting on the same
person appear in the same list. The whole point of the queue is that nothing
hides behind a record type somebody visits less often.

*It is ordered oldest first and stays that way.* This is work rather than a
register: the item that has waited longest is the one somebody else is waiting
on.

*It never shows work the approver may not action.* Anything they raised
themselves is absent whatever levels they hold, and a level they do not hold
never appears. A queue containing items that will be refused is a queue people
learn to ignore.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update
from sqlalchemy.orm import Session
from tests.conftest import (
    assign_approver,
    make_cost_centre,
    make_user,
    make_vendor,
    requires_db,
    sign_in,
)

from finora.domain.roles import ApprovalLevel, Role
from finora.infrastructure.db.models import ApprovalRequest, User, Vendor

pytestmark = [pytest.mark.integration, requires_db]

#: Inside the Unit Head band the migration seeds, so one approver decides it.
SMALL = 4_000_000
#: Above it, so the route reaches a Manager as well.
LARGE = 25_000_000


# ------------------------------------------------------------------- fixtures


@pytest.fixture
def requester(db_session: Session) -> User:
    return make_user(
        db_session,
        email="rita.requester@example.com",
        display_name="Rita Requester",
        roles=[Role.requester],
        department="Facilities",
    )


@pytest.fixture
def buyer(db_session: Session) -> User:
    return make_user(
        db_session,
        email="bella.buyer@example.com",
        display_name="Bella Buyer",
        roles=[Role.finance],
        department="Facilities",
    )


@pytest.fixture
def unit_head(db_session: Session) -> User:
    user = make_user(
        db_session,
        email="ursula.head@example.com",
        display_name="Ursula Head",
        roles=[Role.approver],
        department="Facilities",
    )
    assign_approver(db_session, user=user, level=ApprovalLevel.unit_head)
    return user


@pytest.fixture
def manager(db_session: Session) -> User:
    user = make_user(
        db_session,
        email="marcus.manager@example.com",
        display_name="Marcus Manager",
        roles=[Role.approver],
        department="Facilities",
    )
    assign_approver(db_session, user=user, level=ApprovalLevel.manager)
    return user


@pytest.fixture
def auditor(db_session: Session) -> User:
    """May see that approvals exist, holds no level, so decides nothing."""
    return make_user(
        db_session,
        email="alan.auditor@example.com",
        display_name="Alan Auditor",
        roles=[Role.auditor],
        department="Finance",
    )


@pytest.fixture
def approving_requester(db_session: Session) -> User:
    """Holds a level and raises work of their own, which is ordinary.

    The prohibition is on deciding your own record, not on being both kinds of
    person, and the queue has to get that distinction right rather than solving
    it by refusing anybody who wears two hats.
    """
    user = make_user(
        db_session,
        email="dana.double@example.com",
        display_name="Dana Double",
        roles=[Role.approver, Role.requester],
        department="Facilities",
    )
    assign_approver(db_session, user=user, level=ApprovalLevel.unit_head)
    return user


@pytest.fixture
def vendor(db_session: Session) -> Vendor:
    return make_vendor(db_session, code="V-500", name="Kingston Supplies Limited")


@pytest.fixture
def cost_centre_id(db_session: Session) -> str:
    return str(make_cost_centre(db_session, code="CC-500", name="Facilities").id)


# -------------------------------------------------------------------- helpers


def submit_estimate(
    client: TestClient,
    api_prefix: str,
    *,
    requester: User,
    cost_centre_id: str,
    total_minor_units: int = SMALL,
) -> dict[str, Any]:
    sign_in(client, requester.email, api_prefix)
    draft = client.post(f"{api_prefix}/estimates", json={}).json()
    client.put(
        f"{api_prefix}/estimates/{draft['id']}",
        json={
            "vendor_name": "Kingston Supplies Limited",
            "description": "Replacement air handling unit for the third floor",
            "justification": "The existing unit has failed and cannot be repaired.",
            "estimate_number": "Q-4471",
            "estimate_date": "2026-08-01",
            "total_minor_units": total_minor_units,
            "currency": "JMD",
            "cost_centre_id": cost_centre_id,
        },
    )
    response = client.post(f"{api_prefix}/estimates/{draft['id']}/submit")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def submit_order(
    client: TestClient,
    api_prefix: str,
    *,
    buyer: User,
    vendor: Vendor,
    cost_centre_id: str,
    total_minor_units: int = SMALL,
) -> dict[str, Any]:
    sign_in(client, buyer.email, api_prefix)
    draft = client.post(f"{api_prefix}/purchase-orders", json={}).json()
    client.put(
        f"{api_prefix}/purchase-orders/{draft['id']}",
        json={
            "vendor_id": str(vendor.id),
            "description": "Air handling units for the third floor",
            "total_minor_units": total_minor_units,
            "currency": "JMD",
            "cost_centre_id": cost_centre_id,
            "estimate_id": None,
        },
    )
    response = client.post(f"{api_prefix}/purchase-orders/{draft['id']}/submit")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def age(session: Session, record_id: str, *, hours: int) -> None:
    """Backdate a route, so waiting time and ordering can be asserted."""
    changed = session.execute(
        update(ApprovalRequest)
        .where(ApprovalRequest.record_id == uuid.UUID(record_id))
        .values(opened_at=datetime.now(UTC) - timedelta(hours=hours))
    ).rowcount
    assert changed == 1, "No route to age; the record was not submitted."
    session.commit()


# ----------------------------------------------------------------- what is in it


class TestWhatTheQueueContains:
    def test_it_spans_record_types(
        self,
        client: TestClient,
        api_prefix: str,
        requester: User,
        buyer: User,
        unit_head: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        submit_estimate(client, api_prefix, requester=requester, cost_centre_id=cost_centre_id)
        submit_order(client, api_prefix, buyer=buyer, vendor=vendor, cost_centre_id=cost_centre_id)
        sign_in(client, unit_head.email, api_prefix)

        body = client.get(f"{api_prefix}/approvals/queue").json()

        assert {item["record_type"] for item in body["items"]} == {
            "estimate",
            "purchase_order",
        }
        assert body["total"] == 2

    def test_every_row_says_where_to_go_and_what_it_is_for(
        self,
        client: TestClient,
        api_prefix: str,
        requester: User,
        unit_head: User,
        cost_centre_id: str,
    ) -> None:
        """A queue row that does not name the supplier, the amount and the
        destination is a row somebody has to open to triage."""
        estimate = submit_estimate(
            client, api_prefix, requester=requester, cost_centre_id=cost_centre_id
        )
        sign_in(client, unit_head.email, api_prefix)

        item = client.get(f"{api_prefix}/approvals/queue").json()["items"][0]

        assert item["record_path"] == f"/estimates/{estimate['id']}"
        assert item["record_type_label"] == "Estimate"
        assert item["reference"] == estimate["reference"]
        assert item["vendor_name"] == "Kingston Supplies Limited"
        assert item["amount_formatted"] == "JMD 40,000.00"
        assert item["requester_label"] == "Rita Requester"

    def test_it_says_which_level_is_this_approvers_to_decide(
        self,
        client: TestClient,
        api_prefix: str,
        requester: User,
        unit_head: User,
        manager: User,
        cost_centre_id: str,
    ) -> None:
        submit_estimate(
            client,
            api_prefix,
            requester=requester,
            cost_centre_id=cost_centre_id,
            total_minor_units=LARGE,
        )
        sign_in(client, unit_head.email, api_prefix)

        item = client.get(f"{api_prefix}/approvals/queue").json()["items"][0]

        assert item["my_levels"] == ["Unit Head"]

    def test_a_level_further_down_the_route_is_not_waiting_yet(
        self,
        client: TestClient,
        api_prefix: str,
        requester: User,
        unit_head: User,
        manager: User,
        cost_centre_id: str,
    ) -> None:
        """The Manager step exists but is not ready. Showing it would put work in
        somebody's queue that they cannot yet action."""
        submit_estimate(
            client,
            api_prefix,
            requester=requester,
            cost_centre_id=cost_centre_id,
            total_minor_units=LARGE,
        )
        sign_in(client, manager.email, api_prefix)

        assert client.get(f"{api_prefix}/approvals/queue").json()["items"] == []


class TestWhatTheQueueLeavesOut:
    def test_an_approver_never_sees_their_own_request(
        self,
        client: TestClient,
        api_prefix: str,
        approving_requester: User,
        cost_centre_id: str,
    ) -> None:
        """Segregation of duties refuses the decision anyway. Listing it would be
        offering work that will certainly be refused."""
        submit_estimate(
            client,
            api_prefix,
            requester=approving_requester,
            cost_centre_id=cost_centre_id,
        )

        sign_in(client, approving_requester.email, api_prefix)

        assert client.get(f"{api_prefix}/approvals/queue").json()["items"] == []

    def test_but_it_still_shows_them_somebody_elses(
        self,
        client: TestClient,
        api_prefix: str,
        approving_requester: User,
        requester: User,
        cost_centre_id: str,
    ) -> None:
        """Holding both roles is ordinary. Only the one record is out of bounds."""
        submit_estimate(
            client,
            api_prefix,
            requester=approving_requester,
            cost_centre_id=cost_centre_id,
        )
        theirs = submit_estimate(
            client, api_prefix, requester=requester, cost_centre_id=cost_centre_id
        )
        sign_in(client, approving_requester.email, api_prefix)

        items = client.get(f"{api_prefix}/approvals/queue").json()["items"]

        assert [item["record_id"] for item in items] == [theirs["id"]]

    def test_somebody_holding_no_level_has_an_empty_queue_rather_than_a_refusal(
        self,
        client: TestClient,
        api_prefix: str,
        requester: User,
        unit_head: User,
        auditor: User,
        cost_centre_id: str,
    ) -> None:
        """An auditor may see that approvals exist and holds no level. Nothing is
        waiting on them, which is an answer rather than a refusal."""
        submit_estimate(client, api_prefix, requester=requester, cost_centre_id=cost_centre_id)
        sign_in(client, auditor.email, api_prefix)

        response = client.get(f"{api_prefix}/approvals/queue")

        assert response.status_code == 200
        assert response.json()["items"] == []

    def test_somebody_who_may_not_see_approvals_at_all_is_refused(
        self, client: TestClient, api_prefix: str, requester: User
    ) -> None:
        sign_in(client, requester.email, api_prefix)

        assert client.get(f"{api_prefix}/approvals/queue").status_code == 403


# ------------------------------------------------------------------- ordering


class TestOrderingAndWaiting:
    def test_the_oldest_thing_is_first(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        requester: User,
        buyer: User,
        unit_head: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        newer = submit_estimate(
            client, api_prefix, requester=requester, cost_centre_id=cost_centre_id
        )
        older = submit_order(
            client, api_prefix, buyer=buyer, vendor=vendor, cost_centre_id=cost_centre_id
        )
        age(db_session, older["id"], hours=30)
        sign_in(client, unit_head.email, api_prefix)

        items = client.get(f"{api_prefix}/approvals/queue").json()["items"]

        assert [item["record_id"] for item in items] == [older["id"], newer["id"]]

    def test_how_long_it_has_waited_is_answered_by_the_server(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        requester: User,
        unit_head: User,
        cost_centre_id: str,
    ) -> None:
        """Not left to the browser's clock, which is set by whoever owns the
        laptop and is the wrong thing to decide urgency from."""
        estimate = submit_estimate(
            client, api_prefix, requester=requester, cost_centre_id=cost_centre_id
        )
        age(db_session, estimate["id"], hours=51)
        sign_in(client, unit_head.email, api_prefix)

        item = client.get(f"{api_prefix}/approvals/queue").json()["items"][0]

        assert item["waiting_hours"] == 51


# -------------------------------------------------------------------- filtering


class TestFilteringByKind:
    def test_a_filter_narrows_the_list_but_not_the_counts(
        self,
        client: TestClient,
        api_prefix: str,
        requester: User,
        buyer: User,
        unit_head: User,
        vendor: Vendor,
        cost_centre_id: str,
    ) -> None:
        """The counts describe the whole queue, so a screen can say how much the
        filter is hiding rather than implying the rest does not exist."""
        submit_estimate(client, api_prefix, requester=requester, cost_centre_id=cost_centre_id)
        submit_order(client, api_prefix, buyer=buyer, vendor=vendor, cost_centre_id=cost_centre_id)
        sign_in(client, unit_head.email, api_prefix)

        body = client.get(
            f"{api_prefix}/approvals/queue", params={"record_type": ["estimate"]}
        ).json()

        assert body["total"] == 1
        assert body["counts_by_type"] == {"estimate": 1, "purchase_order": 1}
