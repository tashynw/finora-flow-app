"""Credit-card statements end to end.

Four behaviours matter here, and each is somewhere a wrong platform costs money
or invents authority.

*A statement file imports once.* The same bytes against the same card are
refused the second time, so a double-click at month-end does not double charges.

*Coding and closing are different people.* Segregation of duties keeps the
person who coded lines from closing the period.

*A suggestion never closes.* An assistive proposal can be stored and accepted,
and none of that path freezes the period.

*Uncoded lines block close.* A period with anything still needing a GL or an
exception cannot be closed, reason or no reason.
"""

from __future__ import annotations

from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from tests.conftest import make_user, requires_db, sign_in

from finora.domain.roles import Role
from finora.infrastructure.db.models import CostCentre, GlAccount, User

pytestmark = [pytest.mark.integration, requires_db]

STATEMENT = """date,merchant,amount,cardholder,category
2026-05-02,Kingston Office Depot,125.50,A. Reid,Supplies
2026-05-03,Caribbean Airlines,450.00,A. Reid,Travel
"""


@pytest.fixture
def coder(db_session: Session) -> User:
    return make_user(
        db_session,
        email="cara.coder@example.com",
        display_name="Cara Coder",
        roles=[Role.finance],
        department="Finance",
    )


@pytest.fixture
def closer(db_session: Session) -> User:
    return make_user(
        db_session,
        email="colin.closer@example.com",
        display_name="Colin Closer",
        roles=[Role.finance],
        department="Finance",
    )


@pytest.fixture
def gl(db_session: Session) -> GlAccount:
    row = GlAccount(code="6100", name="Office supplies", is_active=True)
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)
    return row


@pytest.fixture
def cost_centre(db_session: Session) -> CostCentre:
    row = CostCentre(code="CC-100", name="Facilities", department="Operations", is_active=True)
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)
    return row


def _create_card(client: TestClient, api_prefix: str) -> str:
    response = client.post(
        f"{api_prefix}/credit-cards/cards",
        json={
            "label": "Facilities Mastercard",
            "last_four": "4412",
            "cardholder_name": "A. Reid",
            "currency": "JMD",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _import(
    client: TestClient,
    api_prefix: str,
    card_id: str,
    *,
    csv_text: str = STATEMENT,
    filename: str = "may.csv",
) -> dict:
    response = client.post(
        f"{api_prefix}/credit-cards/cards/{card_id}/statements",
        data={
            "period_start": "2026-05-01",
            "period_end": "2026-05-31",
            "statement_date": "2026-06-01",
        },
        files={"file": (filename, BytesIO(csv_text.encode("utf-8")), "text/csv")},
    )
    assert response.status_code == 201, response.text
    return response.json()


class TestCreditCardsApi:
    def test_import_code_and_close_across_two_people(
        self,
        client: TestClient,
        api_prefix: str,
        coder: User,
        closer: User,
        gl: GlAccount,
        cost_centre: CostCentre,
    ) -> None:
        sign_in(client, coder.email, api_prefix)
        card_id = _create_card(client, api_prefix)
        period = _import(client, api_prefix, card_id)

        assert period["standing"] == "open"
        assert period["transaction_count"] == 2
        assert period["uncoded_count"] == 2
        assert period["actions"]["code"] is True
        assert period["actions"]["close"] is False

        for row in period["transactions"]:
            coded = client.post(
                f"{api_prefix}/credit-cards/transactions/{row['id']}/code",
                json={
                    "gl_account_id": str(gl.id),
                    "cost_centre_id": str(cost_centre.id),
                    "category": row["category"],
                },
            )
            assert coded.status_code == 200, coded.text
            assert coded.json()["coding_standing"] == "coded"

            waived = client.post(
                f"{api_prefix}/credit-cards/transactions/{row['id']}/receipt",
                json={"waived": True, "waiver_reason": "Issuer fee, no receipt issued."},
            )
            assert waived.status_code == 200, waived.text
            assert waived.json()["receipt_status"] == "waived"

        refused = client.post(
            f"{api_prefix}/credit-cards/periods/{period['id']}/close",
            json={"reason": "Month-end complete."},
        )
        assert refused.status_code == 403, refused.text

        sign_in(client, closer.email, api_prefix)
        closed = client.post(
            f"{api_prefix}/credit-cards/periods/{period['id']}/close",
            json={"reason": "Month-end review complete."},
        )
        assert closed.status_code == 200, closed.text
        body = closed.json()
        assert body["standing"] == "closed"
        assert body["actions"]["code"] is False
        assert body["actions"]["close"] is False

    def test_the_same_file_cannot_be_imported_twice(
        self, client: TestClient, api_prefix: str, coder: User
    ) -> None:
        sign_in(client, coder.email, api_prefix)
        card_id = _create_card(client, api_prefix)
        _import(client, api_prefix, card_id)
        again = client.post(
            f"{api_prefix}/credit-cards/cards/{card_id}/statements",
            data={
                "period_start": "2026-05-01",
                "period_end": "2026-05-31",
                "statement_date": "2026-06-01",
            },
            files={"file": ("may.csv", BytesIO(STATEMENT.encode("utf-8")), "text/csv")},
        )
        assert again.status_code == 409, again.text

    def test_uncoded_lines_block_close(
        self, client: TestClient, api_prefix: str, coder: User, closer: User
    ) -> None:
        sign_in(client, coder.email, api_prefix)
        card_id = _create_card(client, api_prefix)
        period = _import(client, api_prefix, card_id)

        sign_in(client, closer.email, api_prefix)
        refused = client.post(
            f"{api_prefix}/credit-cards/periods/{period['id']}/close",
            json={"reason": "Trying too early."},
        )
        assert refused.status_code == 422, refused.text
        body = refused.json()
        assert body["code"] == "uncoded_transactions" or any(
            item.get("code") == "uncoded_transactions" for item in body.get("problems", [])
        )

    def test_a_suggestion_does_not_close_the_period(
        self,
        client: TestClient,
        api_prefix: str,
        coder: User,
        gl: GlAccount,
        cost_centre: CostCentre,
    ) -> None:
        sign_in(client, coder.email, api_prefix)
        card_id = _create_card(client, api_prefix)
        period = _import(client, api_prefix, card_id)
        txn_id = period["transactions"][0]["id"]

        suggested = client.post(
            f"{api_prefix}/credit-cards/transactions/{txn_id}/suggestion",
            json={
                "gl_account_id": str(gl.id),
                "cost_centre_id": str(cost_centre.id),
                "evidence": {"merchant_match": "Kingston Office Depot → 6100"},
            },
        )
        assert suggested.status_code == 200, suggested.text
        assert suggested.json()["suggestion_disposition"] == "pending"
        assert suggested.json()["coding_standing"] == "uncoded"

        detail = client.get(f"{api_prefix}/credit-cards/periods/{period['id']}")
        assert detail.json()["standing"] == "open"
        assert detail.json()["uncoded_count"] == 2
