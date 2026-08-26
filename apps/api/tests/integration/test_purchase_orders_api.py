"""Purchase orders end to end.

Three behaviours here are specific to an order being a commitment rather than a
request, and each of them is somewhere the platform would be wrong in an
expensive way if it drifted.

*An order covered by an approved estimate opens without going round again.* The
signature already exists. A control that fires on everything trains approvers to
clear the queue without reading, which is worse than the control not existing.

*Raising a live order's figure un-approves it.* The signature was given for an
amount. Carrying it over to a larger one is a signature nobody gave.

*Closing and cancelling are different endings.* Cancelling asserts the commitment
never existed, and an invoice billed against it is evidence to the contrary.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from tests.conftest import (
    assign_approver,
    make_cost_centre,
    make_estimate,
    make_invoice,
    make_purchase_order,
    make_user,
    make_vendor,
    requires_db,
    sign_in,
)

from finora.domain.money import Money
from finora.domain.roles import ApprovalLevel, Role
from finora.domain.workflow import WorkflowState
from finora.infrastructure.db.models import (
    CostCentre,
    User,
    Vendor,
)

pytestmark = [pytest.mark.integration, requires_db]

#: Inside the Unit Head band, so one approval opens the order.
SMALL = 4_000_000
#: High enough to reach more than one level of the seeded matrix.
LARGE = 60_000_000


# ------------------------------------------------------------------- fixtures


@pytest.fixture
def buyer(db_session: Session) -> User:
    """Raises orders. Holds no approval level, so cannot open one alone."""
    return make_user(
        db_session,
        email="pia.buyer@example.com",
        display_name="Pia Buyer",
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
    """The second rung, reached once an amount leaves the Unit Head band."""
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
def onlooker(db_session: Session) -> User:
    """Can see orders and change nothing."""
    return make_user(
        db_session,
        email="alan.auditor@example.com",
        display_name="Alan Auditor",
        roles=[Role.auditor],
        department="Finance",
    )


@pytest.fixture
def vendor(db_session: Session) -> Vendor:
    return make_vendor(db_session)


@pytest.fixture
def cost_centre(db_session: Session) -> CostCentre:
    return make_cost_centre(db_session)


# -------------------------------------------------------------------- helpers


def order_payload(
    *,
    vendor: Vendor,
    cost_centre: CostCentre,
    total_minor_units: int = SMALL,
    currency: str = "JMD",
    estimate_id: str | None = None,
) -> dict[str, Any]:
    return {
        "vendor_id": str(vendor.id),
        "description": "Air handling units for the third floor",
        "total_minor_units": total_minor_units,
        "currency": currency,
        "cost_centre_id": str(cost_centre.id),
        "gl_account_id": None,
        "estimate_id": estimate_id,
    }


def raise_order(
    client: TestClient,
    api_prefix: str,
    *,
    vendor: Vendor,
    cost_centre: CostCentre,
    **overrides: Any,
) -> dict[str, Any]:
    """A complete draft order, ready to be committed."""
    created = client.post(f"{api_prefix}/purchase-orders", json={})
    assert created.status_code == 201, created.text
    order_id = created.json()["id"]

    updated = client.put(
        f"{api_prefix}/purchase-orders/{order_id}",
        json=order_payload(vendor=vendor, cost_centre=cost_centre, **overrides),
    )
    assert updated.status_code == 200, updated.text
    body: dict[str, Any] = updated.json()
    return body


# ------------------------------------------------------------------ the number


class TestTheOrderNumber:
    def test_a_new_order_is_given_a_number_immediately(
        self, client: TestClient, api_prefix: str, buyer: User
    ) -> None:
        # Issued now rather than at submission so whoever is raising it can quote
        # it to the supplier while the details are still being agreed.
        sign_in(client, buyer.email, api_prefix)

        created = client.post(f"{api_prefix}/purchase-orders", json={})

        assert created.status_code == 201
        assert created.json()["number"].startswith("PO-")

    def test_two_orders_never_share_a_number(
        self, client: TestClient, api_prefix: str, buyer: User
    ) -> None:
        # A supplier quotes the number back on their invoice, and that is how the
        # invoice is matched to this commitment.
        sign_in(client, buyer.email, api_prefix)

        first = client.post(f"{api_prefix}/purchase-orders", json={}).json()["number"]
        second = client.post(f"{api_prefix}/purchase-orders", json={}).json()["number"]

        assert first != second


# ---------------------------------------------------------------- completeness


class TestWhatStopsAnOrderBeingCommitted:
    def test_a_blank_order_lists_everything_it_needs(
        self, client: TestClient, api_prefix: str, buyer: User
    ) -> None:
        sign_in(client, buyer.email, api_prefix)
        created = client.post(f"{api_prefix}/purchase-orders", json={}).json()

        found = {problem["problem"] for problem in created["problems"]}

        assert found == {
            "vendor_missing",
            "description_missing",
            "amount_missing",
            "cost_centre_missing",
        }

    def test_every_problem_names_a_field_and_explains_itself(
        self, client: TestClient, api_prefix: str, buyer: User
    ) -> None:
        sign_in(client, buyer.email, api_prefix)
        created = client.post(f"{api_prefix}/purchase-orders", json={}).json()

        for problem in created["problems"]:
            assert problem["field"]
            assert problem["explanation"]

    def test_a_complete_order_can_be_submitted(
        self,
        client: TestClient,
        api_prefix: str,
        buyer: User,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        sign_in(client, buyer.email, api_prefix)

        order = raise_order(client, api_prefix, vendor=vendor, cost_centre=cost_centre)

        assert order["problems"] == []
        assert order["can_submit"] is True

    def test_submitting_an_incomplete_order_is_refused_with_the_whole_list(
        self, client: TestClient, api_prefix: str, buyer: User
    ) -> None:
        # One refusal at a time would be a conversation rather than a form.
        sign_in(client, buyer.email, api_prefix)
        created = client.post(f"{api_prefix}/purchase-orders", json={}).json()

        refused = client.post(f"{api_prefix}/purchase-orders/{created['id']}/submit")

        assert refused.status_code == 422
        assert len(refused.json()["problems"]) == 4

    def test_an_unknown_vendor_is_refused_by_name_rather_than_as_an_integrity_error(
        self, client: TestClient, api_prefix: str, buyer: User, cost_centre: CostCentre
    ) -> None:
        import uuid as _uuid

        sign_in(client, buyer.email, api_prefix)
        created = client.post(f"{api_prefix}/purchase-orders", json={}).json()

        refused = client.put(
            f"{api_prefix}/purchase-orders/{created['id']}",
            json={
                "vendor_id": str(_uuid.uuid4()),
                "description": "Air handling units for the third floor",
                "total_minor_units": SMALL,
                "currency": "JMD",
                "cost_centre_id": str(cost_centre.id),
                "gl_account_id": None,
                "estimate_id": None,
            },
        )

        assert refused.status_code == 422
        assert "vendor" in refused.json()["detail"].lower()


# ------------------------------------------------------------------ committing


class TestCommittingAnOrder:
    def test_an_order_with_no_estimate_behind_it_goes_for_approval(
        self,
        client: TestClient,
        api_prefix: str,
        buyer: User,
        unit_head: User,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        sign_in(client, buyer.email, api_prefix)
        order = raise_order(client, api_prefix, vendor=vendor, cost_centre=cost_centre)

        submitted = client.post(f"{api_prefix}/purchase-orders/{order['id']}/submit")

        assert submitted.status_code == 200, submitted.text
        body = submitted.json()
        assert body["state"] == WorkflowState.pending_approval.value
        assert body["state_label"] == "Awaiting approval"
        assert body["is_open"] is False

    def test_an_order_covered_by_an_approved_estimate_opens_on_the_spot(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        buyer: User,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        # Somebody with authority has already looked at this spend, for this
        # supplier, at this figure. Sending it round again is a second signature
        # on one decision.
        estimate = make_estimate(db_session, requester=buyer, vendor=vendor)
        sign_in(client, buyer.email, api_prefix)
        order = raise_order(
            client,
            api_prefix,
            vendor=vendor,
            cost_centre=cost_centre,
            estimate_id=str(estimate.id),
        )

        submitted = client.post(f"{api_prefix}/purchase-orders/{order['id']}/submit")

        assert submitted.status_code == 200, submitted.text
        body = submitted.json()
        assert body["state"] == WorkflowState.approved.value
        assert body["state_label"] == "Open"
        assert body["route"] is None

    def test_opening_on_an_estimate_records_which_approval_it_stands_on(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        buyer: User,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        # Otherwise the order is live with no visible reason, which is
        # indistinguishable from a control having failed to fire.
        estimate = make_estimate(db_session, requester=buyer, vendor=vendor)
        sign_in(client, buyer.email, api_prefix)
        order = raise_order(
            client,
            api_prefix,
            vendor=vendor,
            cost_centre=cost_centre,
            estimate_id=str(estimate.id),
        )

        body = client.post(f"{api_prefix}/purchase-orders/{order['id']}/submit").json()

        opening = body["transitions"][-1]
        assert estimate.reference in (opening["reason"] or "")

    def test_an_order_larger_than_its_estimate_still_goes_for_approval(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        buyer: User,
        unit_head: User,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        estimate = make_estimate(
            db_session, requester=buyer, vendor=vendor, total_minor_units=SMALL
        )
        sign_in(client, buyer.email, api_prefix)
        order = raise_order(
            client,
            api_prefix,
            vendor=vendor,
            cost_centre=cost_centre,
            total_minor_units=SMALL + 1,
            estimate_id=str(estimate.id),
        )

        refused = client.post(f"{api_prefix}/purchase-orders/{order['id']}/submit")

        # Exceeding the estimate is a control firing, so it is refused outright
        # rather than routed at the larger figure.
        assert refused.status_code == 422
        problems = {problem["problem"] for problem in refused.json()["problems"]}
        assert "exceeds_estimate" in problems

    def test_the_planned_route_is_shown_before_submission(
        self,
        client: TestClient,
        api_prefix: str,
        buyer: User,
        unit_head: User,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        sign_in(client, buyer.email, api_prefix)

        order = raise_order(client, api_prefix, vendor=vendor, cost_centre=cost_centre)

        assert order["needs_approval"] is True
        assert [step["level"] for step in order["planned_route"]] == ["unit_head"]

    def test_an_order_an_estimate_covers_says_it_needs_no_approval(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        buyer: User,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        # Empty steps with no reason means a route of length zero, which is not
        # the same as no route being available.
        estimate = make_estimate(db_session, requester=buyer, vendor=vendor)
        sign_in(client, buyer.email, api_prefix)

        order = raise_order(
            client,
            api_prefix,
            vendor=vendor,
            cost_centre=cost_centre,
            estimate_id=str(estimate.id),
        )

        assert order["needs_approval"] is False
        assert order["planned_route"] == []
        assert order["route_unavailable"] is None


class TestApprovingAnOrder:
    def test_an_approval_opens_the_order(
        self,
        client: TestClient,
        api_prefix: str,
        buyer: User,
        unit_head: User,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        sign_in(client, buyer.email, api_prefix)
        order = raise_order(client, api_prefix, vendor=vendor, cost_centre=cost_centre)
        client.post(f"{api_prefix}/purchase-orders/{order['id']}/submit")

        sign_in(client, unit_head.email, api_prefix)
        decided = client.post(
            f"{api_prefix}/purchase-orders/{order['id']}/decisions",
            json={"step_order": 1, "level": "unit_head", "outcome": "approved", "comment": None},
        )

        assert decided.status_code == 200, decided.text
        assert decided.json()["state_label"] == "Open"
        assert decided.json()["is_open"] is True

    def test_a_rejection_leaves_the_order_correctable(
        self,
        client: TestClient,
        api_prefix: str,
        buyer: User,
        unit_head: User,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        # Retyping the whole thing into a new record would lose the rejection and
        # the reason for it.
        sign_in(client, buyer.email, api_prefix)
        order = raise_order(client, api_prefix, vendor=vendor, cost_centre=cost_centre)
        client.post(f"{api_prefix}/purchase-orders/{order['id']}/submit")

        sign_in(client, unit_head.email, api_prefix)
        decided = client.post(
            f"{api_prefix}/purchase-orders/{order['id']}/decisions",
            json={
                "step_order": 1,
                "level": "unit_head",
                "outcome": "rejected",
                "comment": "The third floor units were ordered last month.",
            },
        )

        assert decided.json()["state"] == WorkflowState.rejected.value

        sign_in(client, buyer.email, api_prefix)
        again = client.get(f"{api_prefix}/purchase-orders/{order['id']}").json()
        assert again["can_edit"] is True

    def test_the_person_who_raised_it_cannot_approve_it(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        both = make_user(
            db_session,
            email="dana.doubleduty@example.com",
            display_name="Dana Double-Duty",
            roles=[Role.finance, Role.approver],
            department="Facilities",
        )
        assign_approver(db_session, user=both, level=ApprovalLevel.unit_head)
        sign_in(client, both.email, api_prefix)

        order = raise_order(client, api_prefix, vendor=vendor, cost_centre=cost_centre)
        client.post(f"{api_prefix}/purchase-orders/{order['id']}/submit")

        detail = client.get(f"{api_prefix}/purchase-orders/{order['id']}").json()

        assert detail["can_decide"] is False

    def test_withdrawing_returns_the_order_to_draft(
        self,
        client: TestClient,
        api_prefix: str,
        buyer: User,
        unit_head: User,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        sign_in(client, buyer.email, api_prefix)
        order = raise_order(client, api_prefix, vendor=vendor, cost_centre=cost_centre)
        client.post(f"{api_prefix}/purchase-orders/{order['id']}/submit")

        withdrawn = client.post(
            f"{api_prefix}/purchase-orders/{order['id']}/withdraw",
            json={"reason": "The specification changed after the quote."},
        )

        assert withdrawn.status_code == 200, withdrawn.text
        assert withdrawn.json()["state"] == WorkflowState.draft.value
        assert withdrawn.json()["can_edit"] is True


# -------------------------------------------------------------------- amending


class TestAmendingALiveOrder:
    def test_raising_the_figure_sends_it_back_for_approval(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        buyer: User,
        unit_head: User,
        manager: User,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        # The signature was given for the old amount and does not cover the new
        # one.
        order = make_purchase_order(
            db_session,
            vendor=vendor,
            total_minor_units=SMALL,
            raised_by=buyer,
            cost_centre=cost_centre,
        )
        sign_in(client, buyer.email, api_prefix)

        amended = client.post(
            f"{api_prefix}/purchase-orders/{order.id}/amend",
            json={
                "total_minor_units": SMALL * 2,
                "reason": "The supplier revised the quote upwards.",
            },
        )

        assert amended.status_code == 200, amended.text
        assert amended.json()["state"] == WorkflowState.pending_approval.value
        assert amended.json()["is_open"] is False

    def test_lowering_the_figure_needs_no_new_authority(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        buyer: User,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        # Less money was already covered by the approval for more.
        order = make_purchase_order(
            db_session,
            vendor=vendor,
            total_minor_units=SMALL,
            raised_by=buyer,
            cost_centre=cost_centre,
        )
        sign_in(client, buyer.email, api_prefix)

        amended = client.post(
            f"{api_prefix}/purchase-orders/{order.id}/amend",
            json={"total_minor_units": SMALL // 2, "reason": "Half the units were cancelled."},
        )

        assert amended.status_code == 200, amended.text
        assert amended.json()["state_label"] == "Open"

    def test_lowering_below_what_suppliers_have_billed_is_refused(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        buyer: User,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        # Invoices that were correct when they arrived must not be put in breach
        # of an order changed afterwards.
        order = make_purchase_order(
            db_session,
            vendor=vendor,
            total_minor_units=SMALL,
            raised_by=buyer,
            cost_centre=cost_centre,
        )
        make_invoice(
            db_session,
            recorded_by=buyer,
            vendor=vendor,
            purchase_order=order,
            total_minor_units=SMALL - 1,
            invoice_number="INV-9001",
            state=WorkflowState.approved,
        )
        sign_in(client, buyer.email, api_prefix)

        refused = client.post(
            f"{api_prefix}/purchase-orders/{order.id}/amend",
            json={"total_minor_units": 1_000, "reason": "Reducing the commitment."},
        )

        assert refused.status_code == 422
        problems = {problem["problem"] for problem in refused.json()["problems"]}
        assert "below_what_is_billed" in problems


# --------------------------------------------------------------------- endings


class TestClosingAndCancelling:
    def test_closing_stops_further_invoices_without_denying_the_ones_taken(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        buyer: User,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        order = make_purchase_order(
            db_session, vendor=vendor, raised_by=buyer, cost_centre=cost_centre
        )
        sign_in(client, buyer.email, api_prefix)

        closed = client.post(
            f"{api_prefix}/purchase-orders/{order.id}/close",
            json={"reason": "Everything on the order was delivered."},
        )

        assert closed.status_code == 200, closed.text
        body = closed.json()
        # Still approved: it was. What changed is that nobody expects more.
        assert body["state"] == WorkflowState.approved.value
        assert body["state_label"] == "Closed"
        assert body["is_open"] is False
        assert body["closed_reason"] == "Everything on the order was delivered."

    def test_closing_records_who_finished_it(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        buyer: User,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        # An order that ran out and an order somebody shut early look the same
        # afterwards and are not the same thing.
        order = make_purchase_order(
            db_session, vendor=vendor, raised_by=buyer, cost_centre=cost_centre
        )
        sign_in(client, buyer.email, api_prefix)

        body = client.post(
            f"{api_prefix}/purchase-orders/{order.id}/close",
            json={"reason": "Project cancelled by the client."},
        ).json()

        assert body["closed_by_label"] == buyer.display_name
        assert body["closed_at"] is not None

    def test_an_order_nobody_billed_against_can_be_cancelled(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        buyer: User,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        order = make_purchase_order(
            db_session, vendor=vendor, raised_by=buyer, cost_centre=cost_centre
        )
        sign_in(client, buyer.email, api_prefix)

        cancelled = client.post(
            f"{api_prefix}/purchase-orders/{order.id}/cancel",
            json={"reason": "Raised against the wrong supplier."},
        )

        assert cancelled.status_code == 200, cancelled.text
        assert cancelled.json()["state"] == WorkflowState.cancelled.value

    def test_an_order_with_invoices_against_it_cannot_be_cancelled(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        buyer: User,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        # Cancelling says the commitment should never have existed, and an
        # invoice against it is evidence to the contrary.
        order = make_purchase_order(
            db_session, vendor=vendor, raised_by=buyer, cost_centre=cost_centre
        )
        make_invoice(
            db_session,
            recorded_by=buyer,
            vendor=vendor,
            purchase_order=order,
            total_minor_units=1_000,
            invoice_number="INV-9002",
            state=WorkflowState.approved,
        )
        sign_in(client, buyer.email, api_prefix)

        refused = client.post(
            f"{api_prefix}/purchase-orders/{order.id}/cancel",
            json={"reason": "Raised in error."},
        )

        assert refused.status_code == 422
        assert "close it instead" in refused.json()["detail"].lower()

    def test_the_cancel_control_is_absent_once_anything_is_billed(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        buyer: User,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        # A button that will certainly be refused should not be on the screen.
        order = make_purchase_order(
            db_session, vendor=vendor, raised_by=buyer, cost_centre=cost_centre
        )
        make_invoice(
            db_session,
            recorded_by=buyer,
            vendor=vendor,
            purchase_order=order,
            total_minor_units=1_000,
            invoice_number="INV-9003",
            state=WorkflowState.approved,
        )
        sign_in(client, buyer.email, api_prefix)

        detail = client.get(f"{api_prefix}/purchase-orders/{order.id}").json()

        assert detail["can_cancel"] is False
        assert detail["can_close"] is True


# -------------------------------------------------------------------- register


class TestTheRegister:
    def test_remaining_capacity_is_reported_beside_the_total(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        buyer: User,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        # An order at its ceiling looks identical to one with room on it until
        # somebody subtracts.
        order = make_purchase_order(
            db_session,
            vendor=vendor,
            total_minor_units=10_000,
            raised_by=buyer,
            cost_centre=cost_centre,
        )
        make_invoice(
            db_session,
            recorded_by=buyer,
            vendor=vendor,
            purchase_order=order,
            total_minor_units=4_000,
            invoice_number="INV-9004",
            state=WorkflowState.approved,
        )
        sign_in(client, buyer.email, api_prefix)

        detail = client.get(f"{api_prefix}/purchase-orders/{order.id}").json()

        assert detail["billed_formatted"] == Money(4_000, "JMD").format()
        assert detail["remaining_minor_units"] == 6_000

    def test_a_cancelled_invoice_does_not_consume_capacity(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        buyer: User,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        # An order's capacity is not consumed by a demand that was refused.
        order = make_purchase_order(
            db_session,
            vendor=vendor,
            total_minor_units=10_000,
            raised_by=buyer,
            cost_centre=cost_centre,
        )
        make_invoice(
            db_session,
            recorded_by=buyer,
            vendor=vendor,
            purchase_order=order,
            total_minor_units=4_000,
            invoice_number="INV-9005",
            state=WorkflowState.cancelled,
        )
        sign_in(client, buyer.email, api_prefix)

        detail = client.get(f"{api_prefix}/purchase-orders/{order.id}").json()

        assert detail["remaining_minor_units"] == 10_000

    def test_open_only_returns_live_orders_rather_than_a_state(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        buyer: User,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        # "Open" is not a state, and a caller filtering for live commitments
        # should not have to know that.
        live = make_purchase_order(
            db_session,
            vendor=vendor,
            number="PO-2001",
            raised_by=buyer,
            cost_centre=cost_centre,
        )
        make_purchase_order(
            db_session,
            vendor=vendor,
            number="PO-2002",
            raised_by=buyer,
            cost_centre=cost_centre,
            is_closed=True,
        )
        sign_in(client, buyer.email, api_prefix)

        page = client.get(f"{api_prefix}/purchase-orders", params={"open_only": True}).json()

        assert [row["id"] for row in page["rows"]] == [str(live.id)]

    def test_the_register_can_be_searched_by_number(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        buyer: User,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        wanted = make_purchase_order(
            db_session,
            vendor=vendor,
            number="PO-3777",
            raised_by=buyer,
            cost_centre=cost_centre,
        )
        make_purchase_order(
            db_session,
            vendor=vendor,
            number="PO-3888",
            raised_by=buyer,
            cost_centre=cost_centre,
        )
        sign_in(client, buyer.email, api_prefix)

        page = client.get(f"{api_prefix}/purchase-orders", params={"search": "3777"}).json()

        assert [row["id"] for row in page["rows"]] == [str(wanted.id)]


# ---------------------------------------------------------------- permissions


class TestWhoCanDoWhat:
    def test_somebody_who_can_only_look_cannot_raise_an_order(
        self, client: TestClient, api_prefix: str, onlooker: User
    ) -> None:
        sign_in(client, onlooker.email, api_prefix)

        refused = client.post(f"{api_prefix}/purchase-orders", json={})

        assert refused.status_code == 403

    def test_somebody_who_can_only_look_sees_no_controls(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        onlooker: User,
        buyer: User,
        vendor: Vendor,
        cost_centre: CostCentre,
    ) -> None:
        order = make_purchase_order(
            db_session, vendor=vendor, raised_by=buyer, cost_centre=cost_centre
        )
        sign_in(client, onlooker.email, api_prefix)

        detail = client.get(f"{api_prefix}/purchase-orders/{order.id}").json()

        assert detail["can_amend"] is False
        assert detail["can_close"] is False
        assert detail["can_cancel"] is False

    def test_signing_out_closes_the_register(self, client: TestClient, api_prefix: str) -> None:
        assert client.get(f"{api_prefix}/purchase-orders").status_code == 401
