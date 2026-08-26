"""Approval matrix, level assignments and delegation, end to end.

The matrix endpoints are the only place in the platform where a user changes what
the platform will refuse. Three properties follow from that, and each is checked
here because losing any of them is quiet rather than loud.

*A rule is never edited in place.* Superseding writes a new row and retires the
old one, so an approval given last month can still be explained by the rule that
was live when it was given.

*Every write answers with what the matrix now does.* Gaps and unstaffed levels
come back on success, not as errors, because the moment after a change is the
only moment somebody is reliably looking.

*An incoherent matrix is refused; an incomplete one is reported.* Two levels
approving the same band twice is a contradiction and cannot be saved. An amount
nothing covers is a hole, which is a normal state part-way through configuring a
matrix and must not block the next rule.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from tests.conftest import (
    assign_approver,
    make_user,
    requires_db,
    sign_in,
)

from finora.domain.roles import ApprovalLevel, Role
from finora.infrastructure.db.models import ApprovalRule, User

pytestmark = [pytest.mark.integration, requires_db]


# ------------------------------------------------------------------- fixtures


@pytest.fixture
def administrator(db_session: Session) -> User:
    return make_user(
        db_session,
        email="ada.admin@example.com",
        display_name="Ada Admin",
        roles=[Role.administrator],
        department="Finance",
    )


@pytest.fixture
def approver(db_session: Session) -> User:
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
def second_approver(db_session: Session) -> User:
    return make_user(
        db_session,
        email="marcus.manager@example.com",
        display_name="Marcus Manager",
        roles=[Role.approver],
        department="Facilities",
    )


@pytest.fixture
def onlooker(db_session: Session) -> User:
    """Can read records and configure nothing."""
    return make_user(
        db_session,
        email="alan.auditor@example.com",
        display_name="Alan Auditor",
        roles=[Role.auditor],
        department="Finance",
    )


# -------------------------------------------------------------------- helpers


def rule_payload(
    *,
    name: str = "Estimates, Unit Head band",
    record_type: str = "estimate",
    level: ApprovalLevel = ApprovalLevel.unit_head,
    step_order: int = 1,
    minimum: int = 0,
    maximum: int | None = 5_000_000,
    currency: str = "JMD",
    department: str | None = None,
    is_parallel: bool = False,
    reason: str = "Agreed at the finance committee on the 3rd.",
    supersedes_id: str | None = None,
) -> dict[str, Any]:
    return {
        "name": name,
        "record_type": record_type,
        "level": level.value,
        "step_order": step_order,
        "min_amount_minor_units": minimum,
        "max_amount_minor_units": maximum,
        "currency": currency,
        "department": department,
        "is_parallel": is_parallel,
        "reason": reason,
        "supersedes_id": supersedes_id,
    }


def clear_matrix(session: Session, *, by: User, record_type: str = "estimate") -> None:
    """Retire the seeded rules so a test starts from a matrix it wrote itself.

    Retired rather than deleted, and named to an actor, because the table will
    not hold a rule that stopped applying without saying who stopped it.
    """
    rows = session.query(ApprovalRule).filter(ApprovalRule.record_type == record_type).all()
    for row in rows:
        row.is_active = False
        row.retired_at = datetime.now(UTC)
        row.retired_by_id = by.id
    session.commit()


# ------------------------------------------------------------------ the matrix


class TestReadingTheMatrix:
    def test_the_seeded_matrix_is_returned_with_a_reading_of_what_it_does(
        self, client: TestClient, api_prefix: str, administrator: User
    ) -> None:
        sign_in(client, administrator.email, api_prefix)

        response = client.get(f"{api_prefix}/admin/matrix/estimate")

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["record_type_label"]
        assert body["rules"]
        # Every rule carries its band as a sentence, because "0 to 5000000" is
        # not a figure anybody reads correctly at a glance.
        assert all(rule["band_label"] for rule in body["rules"])
        assert body["audit"]["readings"]

    def test_a_record_type_with_no_matrix_is_named_rather_than_guessed(
        self, client: TestClient, api_prefix: str, administrator: User
    ) -> None:
        sign_in(client, administrator.email, api_prefix)

        response = client.get(f"{api_prefix}/admin/matrix/biscuits")

        assert response.status_code == 404
        # The refusal lists what would have worked, so the caller does not have
        # to guess a second time.
        assert "estimate" in response.json()["detail"]

    def test_retired_rules_are_out_of_the_way_unless_asked_for(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        administrator: User,
    ) -> None:
        sign_in(client, administrator.email, api_prefix)
        live = client.get(f"{api_prefix}/admin/matrix/estimate").json()["rules"]
        target = live[0]

        client.post(
            f"{api_prefix}/admin/matrix/rules/{target['id']}/retire",
            json={"reason": "This band moved to the new schedule."},
        )

        after = client.get(f"{api_prefix}/admin/matrix/estimate").json()["rules"]
        assert target["id"] not in {rule["id"] for rule in after}

        with_history = client.get(
            f"{api_prefix}/admin/matrix/estimate", params={"include_retired": True}
        ).json()["rules"]
        retired = next(rule for rule in with_history if rule["id"] == target["id"])
        assert retired["is_active"] is False
        assert retired["retired_at"] is not None


class TestWritingARule:
    def test_a_rule_is_added_and_the_whole_matrix_comes_back(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        administrator: User,
    ) -> None:
        clear_matrix(db_session, by=administrator)
        sign_in(client, administrator.email, api_prefix)

        response = client.post(f"{api_prefix}/admin/matrix/rules", json=rule_payload())

        assert response.status_code == 201, response.text
        body = response.json()
        assert len(body["rules"]) == 1
        # Answering with the matrix rather than the row means the reading of
        # what it now does arrives without a second call.
        assert body["audit"]["readings"]

    def test_a_rule_that_is_wrong_on_its_own_terms_is_refused_against_its_field(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        administrator: User,
    ) -> None:
        clear_matrix(db_session, by=administrator)
        sign_in(client, administrator.email, api_prefix)

        refused = client.post(
            f"{api_prefix}/admin/matrix/rules",
            json=rule_payload(minimum=5_000_000, maximum=1_000_000),
        )

        assert refused.status_code == 422
        problems = refused.json()["problems"]
        assert problems
        # Pointed at an input rather than at the form, so a screen can put the
        # message where the mistake is.
        assert all(problem["field"] for problem in problems)

    def test_a_rule_that_overlaps_a_live_one_is_refused(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        administrator: User,
    ) -> None:
        clear_matrix(db_session, by=administrator)
        sign_in(client, administrator.email, api_prefix)
        client.post(f"{api_prefix}/admin/matrix/rules", json=rule_payload())

        refused = client.post(
            f"{api_prefix}/admin/matrix/rules",
            json=rule_payload(name="Overlapping band", minimum=4_000_000, maximum=9_000_000),
        )

        assert refused.status_code == 422
        assert refused.json()["problems"]

    def test_a_reason_is_required_because_the_rows_only_show_what_it_became(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        administrator: User,
    ) -> None:
        clear_matrix(db_session, by=administrator)
        sign_in(client, administrator.email, api_prefix)

        refused = client.post(f"{api_prefix}/admin/matrix/rules", json=rule_payload(reason=""))

        # Caught by the request model before it reaches the service, which is
        # the same refusal a screen would show against the field.
        assert refused.status_code == 422

    def test_a_gap_is_reported_on_success_rather_than_refused(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        administrator: User,
    ) -> None:
        # A matrix covering nothing above five million is incomplete, not
        # incoherent. Refusing it would make it impossible to build one rule at
        # a time.
        clear_matrix(db_session, by=administrator)
        sign_in(client, administrator.email, api_prefix)

        response = client.post(f"{api_prefix}/admin/matrix/rules", json=rule_payload())

        assert response.status_code == 201
        assert response.json()["audit"]["gaps"]


class TestSupersedingRatherThanEditing:
    def test_replacing_a_rule_retires_the_old_one_and_points_back_at_it(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        administrator: User,
    ) -> None:
        clear_matrix(db_session, by=administrator)
        sign_in(client, administrator.email, api_prefix)
        first = client.post(f"{api_prefix}/admin/matrix/rules", json=rule_payload()).json()
        original = first["rules"][0]

        response = client.post(
            f"{api_prefix}/admin/matrix/rules",
            json=rule_payload(
                name="Estimates, Unit Head band (revised)",
                maximum=8_000_000,
                reason="The band was widened in April.",
                supersedes_id=original["id"],
            ),
        )

        assert response.status_code == 201, response.text
        live = response.json()["rules"]
        assert len(live) == 1
        assert live[0]["supersedes_id"] == original["id"]
        # The old rule is still there to explain approvals given under it.
        history = client.get(
            f"{api_prefix}/admin/matrix/estimate", params={"include_retired": True}
        ).json()["rules"]
        assert {rule["id"] for rule in history} >= {original["id"], live[0]["id"]}

    def test_replacing_a_rule_that_is_already_retired_is_refused(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        administrator: User,
    ) -> None:
        clear_matrix(db_session, by=administrator)
        sign_in(client, administrator.email, api_prefix)
        original = client.post(f"{api_prefix}/admin/matrix/rules", json=rule_payload()).json()[
            "rules"
        ][0]
        client.post(
            f"{api_prefix}/admin/matrix/rules/{original['id']}/retire",
            json={"reason": "Withdrawn."},
        )

        refused = client.post(
            f"{api_prefix}/admin/matrix/rules",
            json=rule_payload(maximum=8_000_000, supersedes_id=original["id"]),
        )

        assert refused.status_code == 409
        assert "already been retired" in refused.json()["detail"]


class TestPreviewingARoute:
    def test_the_preview_names_the_steps_an_amount_would_go_through(
        self, client: TestClient, api_prefix: str, administrator: User, approver: User
    ) -> None:
        sign_in(client, administrator.email, api_prefix)

        response = client.get(
            f"{api_prefix}/admin/matrix/estimate/preview",
            params={"amount_minor_units": 4_000_000, "currency": "JMD"},
        )

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["steps"]
        assert body["unreachable"] is None
        # Formatted, because the point of a preview is to be read.
        assert body["amount_formatted"]

    def test_an_amount_nothing_can_route_says_so_instead_of_answering_empty(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        administrator: User,
    ) -> None:
        # An empty list of steps and "no approval is needed" are the same shape
        # and opposite facts, so the unreachable case has to be named.
        clear_matrix(db_session, by=administrator)
        sign_in(client, administrator.email, api_prefix)

        response = client.get(
            f"{api_prefix}/admin/matrix/estimate/preview",
            params={"amount_minor_units": 9_000_000, "currency": "JMD"},
        )

        assert response.status_code == 200
        assert response.json()["steps"] == []
        assert response.json()["unreachable"]

    def test_an_unknown_currency_is_refused_rather_than_priced(
        self, client: TestClient, api_prefix: str, administrator: User
    ) -> None:
        sign_in(client, administrator.email, api_prefix)

        refused = client.get(
            f"{api_prefix}/admin/matrix/estimate/preview",
            params={"amount_minor_units": 1_000, "currency": "ZZZ"},
        )

        assert refused.status_code == 422


# ---------------------------------------------------------------------- people


class TestWhoCanBeChosen:
    def test_everybody_with_an_open_account_is_offered(
        self,
        client: TestClient,
        api_prefix: str,
        administrator: User,
        approver: User,
        onlooker: User,
    ) -> None:
        sign_in(client, administrator.email, api_prefix)

        response = client.get(f"{api_prefix}/admin/people")

        assert response.status_code == 200, response.text
        emails = {row["email"] for row in response.json()}
        assert {approver.email, onlooker.email} <= emails

    def test_somebody_who_cannot_approve_is_marked_rather_than_hidden(
        self,
        client: TestClient,
        api_prefix: str,
        administrator: User,
        approver: User,
        onlooker: User,
    ) -> None:
        """An absent name answers nothing. "Alan cannot approve" is a fact an
        administrator can act on, by giving him the role or choosing somebody else."""
        sign_in(client, administrator.email, api_prefix)

        people = {row["email"]: row for row in client.get(f"{api_prefix}/admin/people").json()}

        assert people[approver.email]["may_decide"] is True
        assert people[onlooker.email]["may_decide"] is False

    def test_a_closed_account_is_left_out_entirely(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        administrator: User,
        second_approver: User,
    ) -> None:
        # Not merely marked: anything routed to a closed account waits forever,
        # so offering the name is offering a way to stop a queue.
        second_approver.is_active = False
        db_session.commit()
        sign_in(client, administrator.email, api_prefix)

        emails = {row["email"] for row in client.get(f"{api_prefix}/admin/people").json()}

        assert second_approver.email not in emails

    def test_somebody_with_neither_permission_cannot_read_the_list(
        self, client: TestClient, api_prefix: str, onlooker: User
    ) -> None:
        sign_in(client, onlooker.email, api_prefix)

        assert client.get(f"{api_prefix}/admin/people").status_code == 403


# ------------------------------------------------------------------ assignments


class TestWhoHoldsALevel:
    def test_assigning_somebody_returns_the_new_list(
        self,
        client: TestClient,
        api_prefix: str,
        administrator: User,
        second_approver: User,
    ) -> None:
        sign_in(client, administrator.email, api_prefix)

        response = client.post(
            f"{api_prefix}/admin/assignments",
            json={"user_id": str(second_approver.id), "level": ApprovalLevel.manager.value},
        )

        assert response.status_code == 201, response.text
        holders = response.json()
        assert str(second_approver.id) in {row["user_id"] for row in holders}

    def test_assigning_somebody_who_cannot_approve_is_refused(
        self,
        client: TestClient,
        api_prefix: str,
        administrator: User,
        onlooker: User,
    ) -> None:
        # The level would look staffed and answer nothing, which presents to
        # everybody else as a queue that has stopped for no visible reason.
        sign_in(client, administrator.email, api_prefix)

        refused = client.post(
            f"{api_prefix}/admin/assignments",
            json={"user_id": str(onlooker.id), "level": ApprovalLevel.manager.value},
        )

        assert refused.status_code == 409
        assert "cannot record approvals" in refused.json()["detail"]

    def test_assigning_the_same_person_twice_is_refused_rather_than_duplicated(
        self,
        client: TestClient,
        api_prefix: str,
        administrator: User,
        approver: User,
    ) -> None:
        sign_in(client, administrator.email, api_prefix)

        refused = client.post(
            f"{api_prefix}/admin/assignments",
            json={"user_id": str(approver.id), "level": ApprovalLevel.unit_head.value},
        )

        assert refused.status_code == 409
        assert "already holds" in refused.json()["detail"]

    def test_removing_an_assignment_keeps_the_row_for_the_history(
        self,
        client: TestClient,
        api_prefix: str,
        administrator: User,
        approver: User,
    ) -> None:
        sign_in(client, administrator.email, api_prefix)
        holders = client.get(f"{api_prefix}/admin/assignments").json()
        held = next(row for row in holders if row["user_id"] == str(approver.id))

        response = client.delete(f"{api_prefix}/admin/assignments/{held['id']}")

        assert response.status_code == 200, response.text
        after = next(row for row in response.json() if row["id"] == held["id"])
        # Still listed, marked inactive: it is part of the explanation for
        # approvals given while it was held.
        assert after["is_active"] is False

    def test_removing_the_same_assignment_twice_is_refused(
        self,
        client: TestClient,
        api_prefix: str,
        administrator: User,
        approver: User,
    ) -> None:
        sign_in(client, administrator.email, api_prefix)
        held = next(
            row
            for row in client.get(f"{api_prefix}/admin/assignments").json()
            if row["user_id"] == str(approver.id)
        )
        client.delete(f"{api_prefix}/admin/assignments/{held['id']}")

        refused = client.delete(f"{api_prefix}/admin/assignments/{held['id']}")

        assert refused.status_code == 409


# ------------------------------------------------------------------- delegation


class TestArrangingCover:
    def test_an_approver_can_arrange_their_own(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        approver: User,
        second_approver: User,
    ) -> None:
        assign_approver(db_session, user=second_approver, level=ApprovalLevel.manager)
        sign_in(client, approver.email, api_prefix)
        until = datetime.now(UTC) + timedelta(days=5)

        response = client.put(
            f"{api_prefix}/admin/delegations/{approver.id}",
            json={
                "delegate_to_id": str(second_approver.id),
                "out_of_office_until": until.isoformat(),
            },
        )

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["delegate_to_id"] == str(second_approver.id)
        assert body["is_in_effect"] is True

    def test_arranging_somebody_elses_needs_administration(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        approver: User,
        second_approver: User,
    ) -> None:
        # Arranging cover for another approver changes who can decide, which is
        # an administrative act however kindly meant.
        assign_approver(db_session, user=second_approver, level=ApprovalLevel.manager)
        sign_in(client, second_approver.email, api_prefix)

        refused = client.put(
            f"{api_prefix}/admin/delegations/{approver.id}",
            json={
                "delegate_to_id": str(second_approver.id),
                "out_of_office_until": (datetime.now(UTC) + timedelta(days=2)).isoformat(),
            },
        )

        assert refused.status_code == 403

    def test_delegating_to_yourself_is_refused_against_the_field(
        self, client: TestClient, api_prefix: str, approver: User
    ) -> None:
        sign_in(client, approver.email, api_prefix)

        refused = client.put(
            f"{api_prefix}/admin/delegations/{approver.id}",
            json={
                "delegate_to_id": str(approver.id),
                "out_of_office_until": (datetime.now(UTC) + timedelta(days=2)).isoformat(),
            },
        )

        assert refused.status_code == 422
        assert refused.json()["problems"]

    def test_delegating_to_somebody_who_cannot_decide_is_refused(
        self,
        client: TestClient,
        api_prefix: str,
        approver: User,
        onlooker: User,
    ) -> None:
        sign_in(client, approver.email, api_prefix)

        refused = client.put(
            f"{api_prefix}/admin/delegations/{approver.id}",
            json={
                "delegate_to_id": str(onlooker.id),
                "out_of_office_until": (datetime.now(UTC) + timedelta(days=2)).isoformat(),
            },
        )

        assert refused.status_code == 422
        assert refused.json()["problems"]

    def test_a_return_date_in_the_past_is_refused(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        approver: User,
        second_approver: User,
    ) -> None:
        assign_approver(db_session, user=second_approver, level=ApprovalLevel.manager)
        sign_in(client, approver.email, api_prefix)

        refused = client.put(
            f"{api_prefix}/admin/delegations/{approver.id}",
            json={
                "delegate_to_id": str(second_approver.id),
                "out_of_office_until": (datetime.now(UTC) - timedelta(days=1)).isoformat(),
            },
        )

        assert refused.status_code == 422

    def test_coming_back_clears_the_arrangement(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        approver: User,
        second_approver: User,
    ) -> None:
        assign_approver(db_session, user=second_approver, level=ApprovalLevel.manager)
        sign_in(client, approver.email, api_prefix)
        client.put(
            f"{api_prefix}/admin/delegations/{approver.id}",
            json={
                "delegate_to_id": str(second_approver.id),
                "out_of_office_until": (datetime.now(UTC) + timedelta(days=5)).isoformat(),
            },
        )

        response = client.put(
            f"{api_prefix}/admin/delegations/{approver.id}",
            json={"delegate_to_id": None, "out_of_office_until": None},
        )

        assert response.status_code == 200, response.text
        assert response.json()["delegate_to_id"] is None
        assert response.json()["is_in_effect"] is False

    def test_an_expired_arrangement_is_still_listed(
        self,
        client: TestClient,
        api_prefix: str,
        db_session: Session,
        administrator: User,
        approver: User,
        second_approver: User,
    ) -> None:
        # The commonest reason a queue has silently stopped moving, and invisible
        # on a screen that lists only what is working.
        approver.delegate_to_id = second_approver.id
        approver.out_of_office_until = datetime.now(UTC) - timedelta(days=1)
        db_session.commit()
        sign_in(client, administrator.email, api_prefix)

        listed = client.get(f"{api_prefix}/admin/delegations").json()

        arrangement = next(row for row in listed if row["user_id"] == str(approver.id))
        assert arrangement["is_in_effect"] is False
        assert arrangement["delegate_to_name"] == second_approver.display_name


# ------------------------------------------------------------------ permissions


class TestWhoCanConfigureWhat:
    def test_an_onlooker_cannot_read_the_matrix(
        self, client: TestClient, api_prefix: str, onlooker: User
    ) -> None:
        sign_in(client, onlooker.email, api_prefix)

        assert client.get(f"{api_prefix}/admin/matrix/estimate").status_code == 403

    def test_an_approver_cannot_write_a_rule(
        self, client: TestClient, api_prefix: str, approver: User
    ) -> None:
        sign_in(client, approver.email, api_prefix)

        refused = client.post(f"{api_prefix}/admin/matrix/rules", json=rule_payload())

        assert refused.status_code == 403

    def test_an_approver_cannot_change_who_holds_a_level(
        self, client: TestClient, api_prefix: str, approver: User, second_approver: User
    ) -> None:
        sign_in(client, approver.email, api_prefix)

        refused = client.post(
            f"{api_prefix}/admin/assignments",
            json={"user_id": str(second_approver.id), "level": ApprovalLevel.manager.value},
        )

        assert refused.status_code == 403
