"""The estimate lifecycle over HTTP.

Three properties are guarded here, and each one is a rule the platform would be
worthless without.

*Nobody approves their own spending.* Checked from both directions: the requester
is refused at the route, and refused again by segregation of duties even though
they hold every role involved.

*A refusal names the whole remaining task.* Submitting an incomplete draft returns
every unmet rule at once, with the field each one refers to, and the same list is
on every read so the screen never has to guess.

*An approval that was given stays given.* Withdrawing a route to correct an
amount does not erase the approval already recorded against it, and the
resubmission is a visibly separate attempt.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from tests.conftest import (
    assign_approver,
    make_cost_centre,
    make_user,
    requires_db,
    sign_in,
)
from tests.integration.test_document_pipeline import (
    INVOICE,
    build_pipeline,
    ingest_document,
)
from tests.integration.test_intake_service import FakeObjectStore

from finora.domain.approvals import RouteState, StepState
from finora.domain.audit import AuditAction
from finora.domain.roles import ApprovalLevel, Role
from finora.domain.workflow import WorkflowState
from finora.infrastructure.db.models import AuditEntryRow, Document, User

pytestmark = [pytest.mark.integration, requires_db]

#: Below the JMD 50,000 band, so the seeded matrix needs the Unit Head alone.
SMALL = 4_000_000
#: Above JMD 500,000, so it needs Unit Head, then Manager, then Head of Department.
LARGE = 60_000_000

#: A vendor's quotation that reads cleanly: it says what it is, and every field
#: an estimate requires carries a label a rule can match.
QUOTATION = b"""KINGSTON SUPPLIES LIMITED
QUOTATION
This is not an invoice
Quotation Number: Q-4471
Quotation Date: 2026-03-15
Quotation valid until: 2026-04-14
Vendor: Kingston Supplies Limited
Subtotal: JMD 100,000.00
Tax: JMD 15,000.00
Total: JMD 115,000.00
"""


# ------------------------------------------------------------------ fixtures


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
def head_of_department(db_session: Session) -> User:
    user = make_user(
        db_session,
        email="hilda.hod@example.com",
        display_name="Hilda Hod",
        roles=[Role.approver],
        department="Facilities",
    )
    assign_approver(db_session, user=user, level=ApprovalLevel.hod)
    return user


@pytest.fixture
def cost_centre_id(db_session: Session) -> str:
    return str(make_cost_centre(db_session).id)


def read_document(session: Session, *, body: bytes) -> Document:
    """Put one document through intake and read it, as Phase 3 does."""
    store = FakeObjectStore()
    document, _ = ingest_document(session, body=body, store=store)
    build_pipeline(session, store=store).read(document, correlation_id=uuid.uuid4())
    session.commit()
    return document


# ------------------------------------------------------------------- helpers


def create_draft(client: TestClient, api_prefix: str) -> dict[str, Any]:
    response = client.post(f"{api_prefix}/estimates", json={})
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def complete_draft(
    client: TestClient,
    api_prefix: str,
    estimate_id: str,
    *,
    cost_centre_id: str,
    total_minor_units: int = SMALL,
    currency: str = "JMD",
) -> dict[str, Any]:
    """Fill in everything the completeness rules require."""
    response = client.put(
        f"{api_prefix}/estimates/{estimate_id}",
        json={
            "vendor_name": "Kingston Supplies Limited",
            "description": "Replacement air handling unit for the third floor",
            "justification": "The existing unit has failed and cannot be repaired.",
            "estimate_number": "Q-4471",
            "estimate_date": "2026-08-01",
            "needed_by": "2026-09-01",
            "total_minor_units": total_minor_units,
            "currency": currency,
            "cost_centre_id": cost_centre_id,
        },
    )
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def submitted_estimate(
    client: TestClient,
    api_prefix: str,
    *,
    requester: User,
    cost_centre_id: str,
    total_minor_units: int = SMALL,
) -> dict[str, Any]:
    sign_in(client, requester.email, api_prefix)
    draft = create_draft(client, api_prefix)
    complete_draft(
        client,
        api_prefix,
        draft["id"],
        cost_centre_id=cost_centre_id,
        total_minor_units=total_minor_units,
    )
    response = client.post(f"{api_prefix}/estimates/{draft['id']}/submit")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def step(estimate: dict[str, Any], level: str) -> dict[str, Any]:
    found: dict[str, Any] = next(
        item for item in estimate["route"]["steps"] if item["level"] == level
    )
    return found


def approve(
    client: TestClient,
    api_prefix: str,
    estimate: dict[str, Any],
    *,
    level: str,
    comment: str | None = None,
) -> Any:
    target = step(estimate, level)
    return client.post(
        f"{api_prefix}/estimates/{estimate['id']}/decision",
        json={
            "step_order": target["step_order"],
            "level": level,
            "outcome": "approved",
            "comment": comment,
        },
    )


# ------------------------------------------------------------- authentication


class TestWhoMayReachTheseEndpoints:
    def test_an_unauthenticated_caller_sees_nothing(
        self, client: TestClient, api_prefix: str
    ) -> None:
        assert client.get(f"{api_prefix}/estimates").status_code == 401
        assert client.post(f"{api_prefix}/estimates", json={}).status_code == 401

    def test_a_role_without_the_permission_is_refused_and_recorded(
        self, client: TestClient, api_prefix: str, db_session: Session
    ) -> None:
        """An operations user has no business raising a spending request, and the
        attempt is written to the trail: repeated denials are how probing shows up."""
        make_user(
            db_session,
            email="olive.ops@example.com",
            display_name="Olive Ops",
            roles=[Role.operations],
        )
        sign_in(client, "olive.ops@example.com", api_prefix)

        assert client.post(f"{api_prefix}/estimates", json={}).status_code == 403

        denials = (
            db_session.execute(
                select(AuditEntryRow).where(AuditEntryRow.action == AuditAction.permission_denied)
            )
            .scalars()
            .all()
        )
        assert [entry.detail["permission"] for entry in denials] == ["estimate:create"]

    def test_a_refusal_arrives_in_the_same_envelope_as_every_other_error(
        self, client: TestClient, api_prefix: str, requester: User
    ) -> None:
        """A machine code, a sentence for a person, and any structure beside them.

        Asserted here rather than left implicit because a client that had to look
        in two shapes for the sentence to show a user would eventually show
        nothing, and the refusals it matters most for are the ones that carry
        extra structure.
        """
        sign_in(client, requester.email, api_prefix)
        draft = create_draft(client, api_prefix)

        refused = client.post(f"{api_prefix}/estimates/{draft['id']}/submit").json()

        assert refused["code"] == "unprocessable"
        assert isinstance(refused["detail"], str)
        assert isinstance(refused["problems"], list)

    def test_an_estimate_raised_by_somebody_else_is_not_found(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        requester: User,
        cost_centre_id: str,
    ) -> None:
        """A 404 rather than a 403. References are sequential, so confirming one
        exists would let a requester enumerate the organisation's spending."""
        sign_in(client, requester.email, api_prefix)
        draft = create_draft(client, api_prefix)

        make_user(
            db_session,
            email="rory.other@example.com",
            display_name="Rory Other",
            roles=[Role.requester],
        )
        sign_in(client, "rory.other@example.com", api_prefix)

        assert client.get(f"{api_prefix}/estimates/{draft['id']}").status_code == 404


# ------------------------------------------------------------- raising a draft


class TestRaisingADraft:
    def test_a_new_draft_lists_every_unmet_rule(
        self, client: TestClient, api_prefix: str, requester: User
    ) -> None:
        sign_in(client, requester.email, api_prefix)
        draft = create_draft(client, api_prefix)

        assert draft["state"] == WorkflowState.draft
        assert draft["reference"].startswith("EST-")
        problems = {item["problem"] for item in draft["problems"]}
        assert problems == {
            "vendor_missing",
            "description_missing",
            "amount_missing",
            "estimate_date_missing",
            "cost_centre_missing",
            "justification_missing",
        }

    def test_every_problem_names_the_field_and_explains_itself(
        self, client: TestClient, api_prefix: str, requester: User
    ) -> None:
        sign_in(client, requester.email, api_prefix)
        draft = create_draft(client, api_prefix)

        assert all(item["field"] for item in draft["problems"])
        assert all(item["explanation"].strip() for item in draft["problems"])

    def test_a_completed_draft_has_nothing_outstanding_and_may_be_submitted(
        self, client: TestClient, api_prefix: str, requester: User, cost_centre_id: str
    ) -> None:
        sign_in(client, requester.email, api_prefix)
        draft = create_draft(client, api_prefix)

        filled = complete_draft(client, api_prefix, draft["id"], cost_centre_id=cost_centre_id)

        assert filled["problems"] == []
        assert filled["actions"]["may_submit"] is True
        assert filled["total_formatted"] == "JMD 40,000.00"

    def test_a_draft_shows_who_will_have_to_approve_before_it_is_sent(
        self,
        client: TestClient,
        api_prefix: str,
        requester: User,
        cost_centre_id: str,
    ) -> None:
        """The point of showing it on the draft: a requester finding out at
        submission that four people must sign has already wasted the effort."""
        sign_in(client, requester.email, api_prefix)
        draft = create_draft(client, api_prefix)

        filled = complete_draft(
            client,
            api_prefix,
            draft["id"],
            cost_centre_id=cost_centre_id,
            total_minor_units=LARGE,
        )

        assert [item["level_label"] for item in filled["planned_route"]] == [
            "Unit Head",
            "Manager",
            "Head of Department",
        ]

    def test_an_unknown_cost_centre_is_refused_by_name(
        self, client: TestClient, api_prefix: str, requester: User
    ) -> None:
        sign_in(client, requester.email, api_prefix)
        draft = create_draft(client, api_prefix)

        response = client.put(
            f"{api_prefix}/estimates/{draft['id']}",
            json={
                "vendor_name": "Kingston Supplies Limited",
                "description": "A thing",
                "justification": "Because it is needed.",
                "cost_centre_id": str(uuid.uuid4()),
            },
        )

        assert response.status_code == 422
        assert "cost centre" in response.json()["detail"]

    def test_somebody_else_cannot_edit_a_draft_they_can_see(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        requester: User,
        cost_centre_id: str,
    ) -> None:
        """Finance sees every estimate. Rewriting one would make the requester's
        name on it a lie."""
        sign_in(client, requester.email, api_prefix)
        draft = create_draft(client, api_prefix)

        make_user(
            db_session,
            email="fiona.finance@example.com",
            display_name="Fiona Finance",
            roles=[Role.finance, Role.requester],
        )
        sign_in(client, "fiona.finance@example.com", api_prefix)

        assert client.get(f"{api_prefix}/estimates/{draft['id']}").status_code == 200
        response = client.put(
            f"{api_prefix}/estimates/{draft['id']}",
            json={
                "vendor_name": "Someone Else Entirely",
                "description": "Rewritten",
                "justification": "Because I felt like it.",
            },
        )
        assert response.status_code == 403


class TestRaisingOneFromADocument:
    """The join between reading a document and asking to spend against it.

    Only an accepted reading may be used. A reading still in review has values
    nobody has confirmed, and this is the point of having a review workspace at
    all.
    """

    @pytest.fixture
    def reviewer(self, db_session: Session) -> User:
        return make_user(
            db_session,
            email="fiona.finance@example.com",
            display_name="Fiona Finance",
            roles=[Role.finance],
        )

    def accept(self, client: TestClient, api_prefix: str, document: Document) -> None:
        response = client.post(f"{api_prefix}/documents/{document.id}/accept", json={})
        assert response.status_code == 200, response.text

    def test_an_accepted_quotation_carries_its_values_onto_the_draft(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        reviewer: User,
        requester: User,
    ) -> None:
        document = read_document(db_session, body=QUOTATION)
        sign_in(client, reviewer.email, api_prefix)
        self.accept(client, api_prefix, document)

        sign_in(client, requester.email, api_prefix)
        response = client.post(f"{api_prefix}/estimates", json={"document_id": str(document.id)})

        assert response.status_code == 201, response.text
        draft = response.json()
        assert draft["vendor_name"] == "Kingston Supplies Limited"
        assert draft["estimate_number"] == "Q-4471"
        assert draft["total_formatted"] == "JMD 115,000.00"
        assert draft["document_id"] == str(document.id)

    def test_the_description_and_reason_are_left_for_the_requester(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        reviewer: User,
        requester: User,
    ) -> None:
        """A description assembled from a filename is not a description of what is
        being bought, and pre-filling one invites it through unread."""
        document = read_document(db_session, body=QUOTATION)
        sign_in(client, reviewer.email, api_prefix)
        self.accept(client, api_prefix, document)

        sign_in(client, requester.email, api_prefix)
        draft = client.post(
            f"{api_prefix}/estimates", json={"document_id": str(document.id)}
        ).json()

        assert {item["problem"] for item in draft["problems"]} == {
            "description_missing",
            "justification_missing",
            "cost_centre_missing",
        }

    def test_a_reading_nobody_has_accepted_is_refused(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        requester: User,
    ) -> None:
        document = read_document(db_session, body=QUOTATION)
        sign_in(client, requester.email, api_prefix)

        response = client.post(f"{api_prefix}/estimates", json={"document_id": str(document.id)})

        assert response.status_code == 409
        assert "have not been accepted yet" in response.json()["detail"]

    def test_a_document_accepted_as_something_else_is_refused_by_name(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        reviewer: User,
        requester: User,
    ) -> None:
        document = read_document(db_session, body=INVOICE)
        sign_in(client, reviewer.email, api_prefix)
        self.accept(client, api_prefix, document)

        sign_in(client, requester.email, api_prefix)
        response = client.post(f"{api_prefix}/estimates", json={"document_id": str(document.id)})

        assert response.status_code == 409
        assert "accepted as a invoice" in response.json()["detail"]

    def test_one_document_cannot_become_two_requests_for_the_same_spend(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        reviewer: User,
        requester: User,
    ) -> None:
        document = read_document(db_session, body=QUOTATION)
        sign_in(client, reviewer.email, api_prefix)
        self.accept(client, api_prefix, document)

        sign_in(client, requester.email, api_prefix)
        first = client.post(
            f"{api_prefix}/estimates", json={"document_id": str(document.id)}
        ).json()
        response = client.post(f"{api_prefix}/estimates", json={"document_id": str(document.id)})

        assert response.status_code == 409
        assert first["reference"] in response.json()["detail"]


# ----------------------------------------------------------------- submission


class TestSubmission:
    def test_an_incomplete_draft_is_refused_with_every_gap_at_once(
        self, client: TestClient, api_prefix: str, requester: User
    ) -> None:
        sign_in(client, requester.email, api_prefix)
        draft = create_draft(client, api_prefix)

        response = client.post(f"{api_prefix}/estimates/{draft['id']}/submit")

        assert response.status_code == 422
        body = response.json()
        assert body["detail"] == "This estimate is not ready to be sent for approval."
        assert len(body["problems"]) == 6
        assert {item["field"] for item in body["problems"]} == {
            "vendor_name",
            "description",
            "total",
            "estimate_date",
            "cost_centre_id",
            "justification",
        }

    def test_submitting_opens_a_route_and_moves_the_estimate(
        self,
        client: TestClient,
        api_prefix: str,
        requester: User,
        unit_head: User,
        cost_centre_id: str,
    ) -> None:
        estimate = submitted_estimate(
            client, api_prefix, requester=requester, cost_centre_id=cost_centre_id
        )

        assert estimate["state"] == WorkflowState.pending_approval
        assert estimate["route"]["state"] == RouteState.open
        assert estimate["route"]["attempt"] == 1
        assert estimate["route"]["amount_formatted"] == "JMD 40,000.00"
        assert [item["level"] for item in estimate["route"]["steps"]] == ["unit_head"]
        assert estimate["awaiting_labels"] == ["Unit Head"]

    def test_a_larger_amount_opens_the_steps_in_order_with_one_ready(
        self,
        client: TestClient,
        api_prefix: str,
        requester: User,
        unit_head: User,
        manager: User,
        head_of_department: User,
        cost_centre_id: str,
    ) -> None:
        estimate = submitted_estimate(
            client,
            api_prefix,
            requester=requester,
            cost_centre_id=cost_centre_id,
            total_minor_units=LARGE,
        )

        assert [item["state"] for item in estimate["route"]["steps"]] == [
            StepState.ready,
            StepState.waiting,
            StepState.waiting,
        ]
        assert estimate["route"]["summary"] == ("Waiting on Unit Head. 0 of 3 approvals given.")

    def test_an_estimate_nobody_is_assigned_to_approve_stays_a_draft(
        self, client: TestClient, api_prefix: str, requester: User, cost_centre_id: str
    ) -> None:
        """The fail-closed direction. A record nobody can approve must not become a
        record that needs no approval, and it must not become a pending request
        sitting on no queue either."""
        sign_in(client, requester.email, api_prefix)
        draft = create_draft(client, api_prefix)
        complete_draft(client, api_prefix, draft["id"], cost_centre_id=cost_centre_id)

        response = client.post(f"{api_prefix}/estimates/{draft['id']}/submit")

        assert response.status_code == 409
        assert "Nobody is assigned as Unit Head" in response.json()["detail"]
        after = client.get(f"{api_prefix}/estimates/{draft['id']}").json()
        assert after["state"] == WorkflowState.draft

    def test_a_currency_with_no_configured_bands_is_refused(
        self,
        client: TestClient,
        api_prefix: str,
        requester: User,
        unit_head: User,
        cost_centre_id: str,
    ) -> None:
        """Only JMD is seeded. Inventing bands for USD would silently decide who may
        approve a foreign-currency spend."""
        sign_in(client, requester.email, api_prefix)
        draft = create_draft(client, api_prefix)
        complete_draft(
            client,
            api_prefix,
            draft["id"],
            cost_centre_id=cost_centre_id,
            currency="USD",
        )

        response = client.post(f"{api_prefix}/estimates/{draft['id']}/submit")

        assert response.status_code == 409
        assert "USD 40,000.00" in response.json()["detail"]

    def test_a_pending_estimate_cannot_be_edited(
        self,
        client: TestClient,
        api_prefix: str,
        requester: User,
        unit_head: User,
        cost_centre_id: str,
    ) -> None:
        """Otherwise approvers are deciding on a figure that is no longer there."""
        estimate = submitted_estimate(
            client, api_prefix, requester=requester, cost_centre_id=cost_centre_id
        )

        response = client.put(
            f"{api_prefix}/estimates/{estimate['id']}",
            json={
                "vendor_name": "Kingston Supplies Limited",
                "description": "Something much more expensive",
                "justification": "The existing unit has failed and cannot be repaired.",
                "total_minor_units": LARGE,
                "currency": "JMD",
                "cost_centre_id": cost_centre_id,
                "estimate_date": "2026-08-01",
            },
        )

        assert response.status_code == 409
        assert "Withdraw it first" in response.json()["detail"]


# ------------------------------------------------------------------ deciding


class TestDeciding:
    def test_the_requester_cannot_approve_their_own_estimate(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        cost_centre_id: str,
    ) -> None:
        """The rule the module exists for. This user holds both roles and is
        assigned as Unit Head, which is legitimate; using both on this record is
        not."""
        both = make_user(
            db_session,
            email="cara.conflict@example.com",
            display_name="Cara Conflict",
            roles=[Role.requester, Role.approver],
            department="Facilities",
        )
        assign_approver(db_session, user=both, level=ApprovalLevel.unit_head)

        estimate = submitted_estimate(
            client, api_prefix, requester=both, cost_centre_id=cost_centre_id
        )
        response = approve(client, api_prefix, estimate, level="unit_head")

        assert response.status_code == 409
        assert "segregation of duties" in response.json()["detail"].lower()

    def test_a_step_is_not_offered_to_the_requester_even_when_they_are_assigned(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        cost_centre_id: str,
    ) -> None:
        both = make_user(
            db_session,
            email="cara.conflict@example.com",
            display_name="Cara Conflict",
            roles=[Role.requester, Role.approver],
            department="Facilities",
        )
        assign_approver(db_session, user=both, level=ApprovalLevel.unit_head)

        estimate = submitted_estimate(
            client, api_prefix, requester=both, cost_centre_id=cost_centre_id
        )

        assert estimate["actions"]["may_decide"] is False
        assert step(estimate, "unit_head")["is_mine_to_decide"] is False
        assert estimate["awaiting_me"] is False

    def test_an_unassigned_approver_is_refused(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        requester: User,
        unit_head: User,
        cost_centre_id: str,
    ) -> None:
        estimate = submitted_estimate(
            client, api_prefix, requester=requester, cost_centre_id=cost_centre_id
        )
        make_user(
            db_session,
            email="alan.aside@example.com",
            display_name="Alan Aside",
            roles=[Role.approver],
            department="Facilities",
        )
        sign_in(client, "alan.aside@example.com", api_prefix)

        response = approve(client, api_prefix, estimate, level="unit_head")

        assert response.status_code == 409
        assert "not assigned as Unit Head" in response.json()["detail"]

    def test_the_assigned_approver_sees_it_as_theirs_and_can_approve(
        self,
        client: TestClient,
        api_prefix: str,
        requester: User,
        unit_head: User,
        cost_centre_id: str,
    ) -> None:
        estimate = submitted_estimate(
            client, api_prefix, requester=requester, cost_centre_id=cost_centre_id
        )
        sign_in(client, unit_head.email, api_prefix)

        seen = client.get(f"{api_prefix}/estimates/{estimate['id']}").json()
        assert seen["awaiting_me"] is True
        assert seen["actions"]["may_decide"] is True
        assert step(seen, "unit_head")["is_mine_to_decide"] is True

        response = approve(client, api_prefix, seen, level="unit_head")

        assert response.status_code == 200
        decided = response.json()
        assert decided["state"] == WorkflowState.approved
        # The route that approved it stays the current route. It is not an
        # "earlier round": it is the round that decided this estimate, and there
        # is nothing after it.
        assert decided["route"]["state"] == RouteState.approved
        assert decided["route"]["steps"][0]["decided_by_label"] == "Ursula Head"
        assert decided["route_history"] == []
        # And no route is offered as a plan, because there is nothing left to plan.
        assert decided["planned_route"] is None

    def test_a_later_step_cannot_be_decided_before_an_earlier_one(
        self,
        client: TestClient,
        api_prefix: str,
        requester: User,
        unit_head: User,
        manager: User,
        head_of_department: User,
        cost_centre_id: str,
    ) -> None:
        estimate = submitted_estimate(
            client,
            api_prefix,
            requester=requester,
            cost_centre_id=cost_centre_id,
            total_minor_units=LARGE,
        )
        sign_in(client, manager.email, api_prefix)

        response = approve(client, api_prefix, estimate, level="manager")

        assert response.status_code == 409
        assert "not due yet" in response.json()["detail"]
        assert "Unit Head" in response.json()["detail"]

    def test_a_route_is_only_approved_once_every_step_is(
        self,
        client: TestClient,
        api_prefix: str,
        requester: User,
        unit_head: User,
        manager: User,
        head_of_department: User,
        cost_centre_id: str,
    ) -> None:
        estimate = submitted_estimate(
            client,
            api_prefix,
            requester=requester,
            cost_centre_id=cost_centre_id,
            total_minor_units=LARGE,
        )

        sign_in(client, unit_head.email, api_prefix)
        after_first = approve(client, api_prefix, estimate, level="unit_head").json()
        assert after_first["state"] == WorkflowState.pending_approval
        assert after_first["awaiting_labels"] == ["Manager"]

        sign_in(client, manager.email, api_prefix)
        after_second = approve(client, api_prefix, after_first, level="manager").json()
        assert after_second["state"] == WorkflowState.pending_approval
        assert after_second["awaiting_labels"] == ["Head of Department"]

        sign_in(client, head_of_department.email, api_prefix)
        after_third = approve(client, api_prefix, after_second, level="hod").json()
        assert after_third["state"] == WorkflowState.approved
        assert after_third["decided_at"] is not None

    def test_rejecting_without_a_reason_is_refused(
        self,
        client: TestClient,
        api_prefix: str,
        requester: User,
        unit_head: User,
        cost_centre_id: str,
    ) -> None:
        estimate = submitted_estimate(
            client, api_prefix, requester=requester, cost_centre_id=cost_centre_id
        )
        sign_in(client, unit_head.email, api_prefix)

        response = client.post(
            f"{api_prefix}/estimates/{estimate['id']}/decision",
            json={"step_order": 1, "level": "unit_head", "outcome": "rejected"},
        )

        assert response.status_code == 409
        assert "reason is required" in response.json()["detail"]

    def test_one_rejection_ends_the_route_and_the_reason_is_readable(
        self,
        client: TestClient,
        api_prefix: str,
        requester: User,
        unit_head: User,
        manager: User,
        head_of_department: User,
        cost_centre_id: str,
    ) -> None:
        estimate = submitted_estimate(
            client,
            api_prefix,
            requester=requester,
            cost_centre_id=cost_centre_id,
            total_minor_units=LARGE,
        )
        sign_in(client, unit_head.email, api_prefix)

        response = client.post(
            f"{api_prefix}/estimates/{estimate['id']}/decision",
            json={
                "step_order": 1,
                "level": "unit_head",
                "outcome": "rejected",
                "comment": "Get a second quotation before we commit to this.",
            },
        )

        assert response.status_code == 200
        decided = response.json()
        assert decided["state"] == WorkflowState.rejected
        route = decided["route"]
        assert route["state"] == RouteState.rejected
        assert route["summary"] == "Rejected by Unit Head."
        assert decided["route_history"] == []
        rejected = next(item for item in route["steps"] if item["level"] == "unit_head")
        assert rejected["comment"] == "Get a second quotation before we commit to this."

    def test_the_same_step_cannot_be_decided_twice(
        self,
        client: TestClient,
        api_prefix: str,
        requester: User,
        unit_head: User,
        cost_centre_id: str,
    ) -> None:
        estimate = submitted_estimate(
            client, api_prefix, requester=requester, cost_centre_id=cost_centre_id
        )
        sign_in(client, unit_head.email, api_prefix)
        approve(client, api_prefix, estimate, level="unit_head")

        again = approve(client, api_prefix, estimate, level="unit_head")

        assert again.status_code == 409


# ----------------------------------------------------------------- delegation


class TestDelegation:
    def test_a_delegate_may_decide_while_the_approver_is_away(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        requester: User,
        unit_head: User,
        cost_centre_id: str,
    ) -> None:
        """And the approval is recorded as the delegate's, naming whose authority
        it was exercised under. Recording it as the absent approver's would be a
        forgery."""
        stand_in = make_user(
            db_session,
            email="dennis.delegate@example.com",
            display_name="Dennis Delegate",
            roles=[Role.approver],
            department="Facilities",
        )
        away = db_session.get(User, unit_head.id)
        assert away is not None
        away.delegate_to_id = stand_in.id
        away.out_of_office_until = datetime.now(UTC) + timedelta(days=3)
        db_session.commit()

        estimate = submitted_estimate(
            client, api_prefix, requester=requester, cost_centre_id=cost_centre_id
        )
        sign_in(client, stand_in.email, api_prefix)

        seen = client.get(f"{api_prefix}/estimates/{estimate['id']}").json()
        assert step(seen, "unit_head")["would_act_for"] == "Ursula Head"

        decided = approve(client, api_prefix, seen, level="unit_head").json()

        assert decided["state"] == WorkflowState.approved
        recorded = decided["route"]["steps"][0]
        assert recorded["decided_by_label"] == "Dennis Delegate"
        assert recorded["on_behalf_of_label"] == "Ursula Head"

    def test_a_delegate_may_not_decide_once_the_approver_is_back(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        requester: User,
        unit_head: User,
        cost_centre_id: str,
    ) -> None:
        stand_in = make_user(
            db_session,
            email="dennis.delegate@example.com",
            display_name="Dennis Delegate",
            roles=[Role.approver],
            department="Facilities",
        )
        away = db_session.get(User, unit_head.id)
        assert away is not None
        away.delegate_to_id = stand_in.id
        away.out_of_office_until = datetime.now(UTC) - timedelta(hours=1)
        db_session.commit()

        estimate = submitted_estimate(
            client, api_prefix, requester=requester, cost_centre_id=cost_centre_id
        )
        sign_in(client, stand_in.email, api_prefix)

        assert approve(client, api_prefix, estimate, level="unit_head").status_code == 409


# ----------------------------------------------- withdrawal and resubmission


class TestWithdrawalAndResubmission:
    def test_withdrawing_returns_it_to_draft_and_keeps_the_approval_given(
        self,
        client: TestClient,
        api_prefix: str,
        requester: User,
        unit_head: User,
        manager: User,
        head_of_department: User,
        cost_centre_id: str,
    ) -> None:
        """ "The Unit Head approved this and then the requester changed the amount"
        is exactly what an auditor is looking for."""
        estimate = submitted_estimate(
            client,
            api_prefix,
            requester=requester,
            cost_centre_id=cost_centre_id,
            total_minor_units=LARGE,
        )
        sign_in(client, unit_head.email, api_prefix)
        approve(client, api_prefix, estimate, level="unit_head")

        sign_in(client, requester.email, api_prefix)
        response = client.post(
            f"{api_prefix}/estimates/{estimate['id']}/withdraw",
            json={"reason": "The vendor has revised the quotation."},
        )

        assert response.status_code == 200
        withdrawn = response.json()
        assert withdrawn["state"] == WorkflowState.draft
        # Back to being a draft, so it is on no route and is told again which one
        # its amount would take. The abandoned round is genuinely an earlier one.
        assert withdrawn["route"] is None
        assert [item["level"] for item in withdrawn["planned_route"]] == [
            "unit_head",
            "manager",
            "hod",
        ]
        closed = withdrawn["route_history"][0]
        assert closed["state"] == RouteState.withdrawn
        given = next(item for item in closed["steps"] if item["level"] == "unit_head")
        assert given["state"] == StepState.approved
        assert given["decided_by_label"] == "Ursula Head"
        untouched = next(item for item in closed["steps"] if item["level"] == "manager")
        assert untouched["state"] == StepState.withdrawn

    def test_resubmitting_opens_a_visibly_separate_attempt(
        self,
        client: TestClient,
        api_prefix: str,
        requester: User,
        unit_head: User,
        cost_centre_id: str,
    ) -> None:
        estimate = submitted_estimate(
            client, api_prefix, requester=requester, cost_centre_id=cost_centre_id
        )
        client.post(
            f"{api_prefix}/estimates/{estimate['id']}/withdraw",
            json={"reason": "The vendor has revised the quotation."},
        )

        again = client.post(f"{api_prefix}/estimates/{estimate['id']}/submit").json()

        assert again["route"]["attempt"] == 2
        assert [row["attempt"] for row in again["route_history"]] == [1]

    def test_an_approver_cannot_withdraw_somebody_else_s_estimate(
        self,
        client: TestClient,
        api_prefix: str,
        requester: User,
        unit_head: User,
        cost_centre_id: str,
    ) -> None:
        """They reject it, with a reason the requester can read. Quietly returning
        it to somebody's drafts is not a decision anyone is accountable for."""
        estimate = submitted_estimate(
            client, api_prefix, requester=requester, cost_centre_id=cost_centre_id
        )
        sign_in(client, unit_head.email, api_prefix)

        response = client.post(
            f"{api_prefix}/estimates/{estimate['id']}/withdraw",
            json={"reason": "I would rather it went away."},
        )

        assert response.status_code == 403

    def test_cancelling_closes_the_route_for_good(
        self,
        client: TestClient,
        api_prefix: str,
        requester: User,
        unit_head: User,
        cost_centre_id: str,
    ) -> None:
        estimate = submitted_estimate(
            client, api_prefix, requester=requester, cost_centre_id=cost_centre_id
        )

        response = client.post(
            f"{api_prefix}/estimates/{estimate['id']}/cancel",
            json={"reason": "The unit was repaired under warranty after all."},
        )

        assert response.status_code == 200
        cancelled = response.json()
        assert cancelled["state"] == WorkflowState.cancelled
        # The route it was on when it was abandoned, closed and kept. Not a plan
        # for a route it will now never take.
        assert cancelled["route"]["state"] == RouteState.withdrawn
        assert cancelled["planned_route"] is None
        assert cancelled["actions"] == {
            "may_edit": False,
            "may_submit": False,
            "may_withdraw": False,
            "may_cancel": False,
            "may_decide": False,
        }


# ------------------------------------------------------------------ the queue


class TestTheRegister:
    def test_a_requester_sees_only_their_own(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        requester: User,
    ) -> None:
        sign_in(client, requester.email, api_prefix)
        create_draft(client, api_prefix)

        make_user(
            db_session,
            email="rory.other@example.com",
            display_name="Rory Other",
            roles=[Role.requester],
        )
        sign_in(client, "rory.other@example.com", api_prefix)
        create_draft(client, api_prefix)

        page = client.get(f"{api_prefix}/estimates").json()

        assert page["total"] == 1
        assert page["items"][0]["requester_label"] == "Rory Other"

    def test_an_approver_queue_shows_only_what_they_can_action(
        self,
        client: TestClient,
        api_prefix: str,
        requester: User,
        unit_head: User,
        manager: User,
        head_of_department: User,
        cost_centre_id: str,
    ) -> None:
        """A queue that lists work an approver is forbidden to touch is a queue
        they learn to ignore."""
        submitted_estimate(
            client,
            api_prefix,
            requester=requester,
            cost_centre_id=cost_centre_id,
            total_minor_units=LARGE,
        )

        sign_in(client, manager.email, api_prefix)
        assert client.get(f"{api_prefix}/estimates?awaiting_me=true").json()["total"] == 0

        sign_in(client, unit_head.email, api_prefix)
        mine = client.get(f"{api_prefix}/estimates?awaiting_me=true").json()
        assert mine["total"] == 1
        assert mine["items"][0]["awaiting_me"] is True

    def test_the_register_can_be_searched_by_reference_and_vendor(
        self, client: TestClient, api_prefix: str, requester: User, cost_centre_id: str
    ) -> None:
        sign_in(client, requester.email, api_prefix)
        draft = create_draft(client, api_prefix)
        complete_draft(client, api_prefix, draft["id"], cost_centre_id=cost_centre_id)

        by_vendor = client.get(f"{api_prefix}/estimates?search=kingston").json()
        by_reference = client.get(
            f"{api_prefix}/estimates?search={draft['reference'].lower()}"
        ).json()
        by_nothing = client.get(f"{api_prefix}/estimates?search=zzzz").json()

        assert by_vendor["total"] == 1
        assert by_reference["total"] == 1
        assert by_nothing["total"] == 0

    def test_the_reference_data_endpoint_serves_the_selectors(
        self, client: TestClient, api_prefix: str, requester: User, cost_centre_id: str
    ) -> None:
        sign_in(client, requester.email, api_prefix)

        data = client.get(f"{api_prefix}/reference").json()

        assert [row["id"] for row in data["cost_centres"]] == [cost_centre_id]
        assert "JMD" in data["currencies"]


# ------------------------------------------------------------------- the trail


class TestTheAuditTrail:
    def test_every_act_on_an_estimate_is_recorded_with_the_amount(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        requester: User,
        unit_head: User,
        cost_centre_id: str,
    ) -> None:
        """An auditor asking "who approved spending this much" should not have to
        join their way to the answer."""
        estimate = submitted_estimate(
            client, api_prefix, requester=requester, cost_centre_id=cost_centre_id
        )
        sign_in(client, unit_head.email, api_prefix)
        approve(client, api_prefix, estimate, level="unit_head")

        entries = (
            db_session.execute(
                select(AuditEntryRow)
                .where(AuditEntryRow.subject_id == uuid.UUID(estimate["id"]))
                .order_by(AuditEntryRow.sequence)
            )
            .scalars()
            .all()
        )
        actions = [entry.action for entry in entries]

        assert AuditAction.record_created in actions
        assert AuditAction.approval_requested in actions
        assert AuditAction.approved in actions
        assert actions.count(AuditAction.state_changed) == 2

        approval = next(e for e in entries if e.action == AuditAction.approved)
        assert approval.detail["amount"] == "JMD 40,000.00"
        assert approval.detail["level_label"] == "Unit Head"
        assert approval.actor_label == "Ursula Head"
