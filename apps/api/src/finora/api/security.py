"""Session and signed-link security primitives.

Sessions are signed, expiring tokens carried in an HttpOnly cookie. Signed links
are separate: they authorize exactly one action on exactly one record, are
time-limited, and are never accepted as authorization for anything else.
"""

from __future__ import annotations

import hmac
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from finora.config import Settings
from finora.domain.roles import Permission, Role, permissions_for

_SESSION_SALT = "finora.session.v1"
# A distinct salt means a session cookie can never be replayed as a sign-off
# link, or the reverse, even though both use the same signing key.
_LINK_SALT = "finora.actionlink.v1"


class SecurityError(Exception):
    """Base class for authentication and token failures."""


class InvalidTokenError(SecurityError):
    pass


class ExpiredTokenError(SecurityError):
    pass


@dataclass(frozen=True, slots=True)
class Principal:
    """The authenticated subject of a request."""

    user_id: uuid.UUID
    email: str
    display_name: str
    roles: frozenset[Role]
    session_id: uuid.UUID

    @property
    def permissions(self) -> frozenset[Permission]:
        return permissions_for(self.roles)

    def has(self, permission: Permission) -> bool:
        return permission in self.permissions


@dataclass(frozen=True, slots=True)
class ActionLink:
    """A one-action, one-record capability delivered by email."""

    record_type: str
    record_id: uuid.UUID
    action: str
    recipient: str
    issued_for: uuid.UUID | None = None


class TokenService:
    def __init__(self, settings: Settings) -> None:
        key = settings.auth.link_signing_key.get_secret_value()
        if not key:
            raise SecurityError("A link signing key is required. Set FINORA_AUTH_LINK_SIGNING_KEY.")
        self._settings = settings
        self._sessions = URLSafeTimedSerializer(key, salt=_SESSION_SALT)
        self._links = URLSafeTimedSerializer(key, salt=_LINK_SALT)

    # --------------------------------------------------------------- sessions

    def issue_session(
        self,
        *,
        user_id: uuid.UUID,
        email: str,
        display_name: str,
        roles: frozenset[Role],
    ) -> tuple[str, uuid.UUID]:
        session_id = uuid.uuid4()
        token = self._sessions.dumps(
            {
                "sid": str(session_id),
                "uid": str(user_id),
                "email": email,
                "name": display_name,
                "roles": sorted(str(r) for r in roles),
            }
        )
        return token, session_id

    def read_session(self, token: str) -> Principal:
        try:
            payload = self._sessions.loads(token, max_age=self._settings.auth.session_ttl_seconds)
        except SignatureExpired as exc:
            raise ExpiredTokenError("Your session has expired. Sign in again.") from exc
        except BadSignature as exc:
            raise InvalidTokenError("Session could not be verified.") from exc

        try:
            return Principal(
                user_id=uuid.UUID(payload["uid"]),
                email=payload["email"],
                display_name=payload["name"],
                roles=frozenset(Role(r) for r in payload["roles"]),
                session_id=uuid.UUID(payload["sid"]),
            )
        except (KeyError, ValueError) as exc:
            # A structurally wrong but correctly signed payload means the token
            # format changed; treat it as invalid rather than crashing.
            raise InvalidTokenError("Session contents were not recognised.") from exc

    # ----------------------------------------------------------- action links

    def issue_action_link(self, link: ActionLink) -> str:
        return self._links.dumps(
            {
                "rt": link.record_type,
                "rid": str(link.record_id),
                "act": link.action,
                "to": link.recipient,
                "for": str(link.issued_for) if link.issued_for else None,
            }
        )

    def read_action_link(
        self, token: str, *, expected_action: str, expected_record_type: str
    ) -> ActionLink:
        """Validate a signed link.

        The expected action and record type are supplied by the endpoint, so a
        link issued for one purpose cannot be presented to another.
        """
        try:
            payload = self._links.loads(token, max_age=self._settings.auth.link_ttl_seconds)
        except SignatureExpired as exc:
            raise ExpiredTokenError("This link has expired. Request a new one.") from exc
        except BadSignature as exc:
            raise InvalidTokenError("This link could not be verified.") from exc

        try:
            record_type = payload["rt"]
            action = payload["act"]
        except KeyError as exc:
            raise InvalidTokenError("This link is not valid.") from exc

        # Constant-time comparison avoids leaking which field mismatched.
        if not hmac.compare_digest(action, expected_action) or not hmac.compare_digest(
            record_type, expected_record_type
        ):
            raise InvalidTokenError("This link is not valid for this action.")

        try:
            return ActionLink(
                record_type=record_type,
                record_id=uuid.UUID(payload["rid"]),
                action=action,
                recipient=payload["to"],
                issued_for=uuid.UUID(payload["for"]) if payload.get("for") else None,
            )
        except (KeyError, ValueError) as exc:
            raise InvalidTokenError("This link is not valid.") from exc


def utc_now() -> datetime:
    return datetime.now(UTC)
