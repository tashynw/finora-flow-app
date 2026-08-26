"""Health and readiness behaviour."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from tests.conftest import requires_db

pytestmark = [pytest.mark.integration, requires_db]


class TestLiveness:
    def test_liveness_reports_alive(self, client: TestClient, api_prefix: str) -> None:
        response = client.get(f"{api_prefix}/health/live")
        assert response.status_code == 200
        assert response.json()["status"] == "alive"

    def test_liveness_requires_no_authentication(self, client: TestClient, api_prefix: str) -> None:
        assert client.get(f"{api_prefix}/health/live").status_code == 200


class TestReadiness:
    def test_reports_dependencies(self, client: TestClient, api_prefix: str) -> None:
        body = client.get(f"{api_prefix}/health/ready").json()
        names = {d["name"] for d in body["dependencies"]}
        assert {
            "postgresql",
            "redis",
            "malware_scanner",
            "object_storage",
            "imap",
            "smtp",
            "ai_gateway",
        } <= names

    def test_ready_when_database_is_up(self, client: TestClient, api_prefix: str) -> None:
        body = client.get(f"{api_prefix}/health/ready").json()
        postgres = next(d for d in body["dependencies"] if d["name"] == "postgresql")
        assert postgres["state"] == "up"
        assert body["ready"] is True


class TestSecurityHeaders:
    def test_security_headers_present(self, client: TestClient, api_prefix: str) -> None:
        headers = client.get(f"{api_prefix}/health/live").headers
        assert headers["x-content-type-options"] == "nosniff"
        assert headers["x-frame-options"] == "DENY"
        assert "frame-ancestors 'none'" in headers["content-security-policy"]
        assert "object-src 'none'" in headers["content-security-policy"]

    def test_correlation_id_is_echoed(self, client: TestClient, api_prefix: str) -> None:
        supplied = "3f1a4c9e-0000-4000-8000-000000000001"
        response = client.get(f"{api_prefix}/health/live", headers={"x-correlation-id": supplied})
        assert response.headers["x-correlation-id"] == supplied

    def test_malformed_correlation_id_is_replaced(
        self, client: TestClient, api_prefix: str
    ) -> None:
        """A client-supplied value must not be trusted to be a UUID."""
        response = client.get(
            f"{api_prefix}/health/live", headers={"x-correlation-id": "not-a-uuid"}
        )
        assert response.headers["x-correlation-id"] != "not-a-uuid"
        assert len(response.headers["x-correlation-id"]) == 36
