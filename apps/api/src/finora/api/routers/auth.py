"""Authentication.

Two paths exist. The OIDC path is the production path and is provider-neutral.
The local path exists only for development and integration tests; it is refused
outright unless explicitly enabled, and `Settings.assert_production_ready`
prevents it from ever being enabled in production.
"""

from __future__ import annotations

import secrets
from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import select

from finora.api.deps import (
    AuditDep,
    CorrelationDep,
    PrincipalDep,
    SessionDep,
    SettingsDep,
    TokenServiceDep,
)
from finora.api.security import utc_now
from finora.domain.audit import ActorType, AuditAction
from finora.domain.roles import Role
from finora.infrastructure.db.models import User

router = APIRouter(prefix="/auth", tags=["auth"])


class SignInRequest(BaseModel):
    email: EmailStr


class CurrentUserResponse(BaseModel):
    id: str
    email: str
    display_name: str
    department: str | None
    roles: list[str]
    permissions: list[str]


class AuthMethodsResponse(BaseModel):
    oidc_enabled: bool
    oidc_authorize_url: str | None
    local_accounts_enabled: bool
    environment: str


def _set_session_cookie(response: Response, *, settings: SettingsDep, token: str) -> None:
    response.set_cookie(
        key=settings.auth.session_cookie_name,
        value=token,
        max_age=settings.auth.session_ttl_seconds,
        # Not readable by script, so an XSS foothold cannot steal the session.
        httponly=True,
        # Plain HTTP is only ever acceptable on a developer machine.
        secure=settings.is_production,
        # Lax still permits the top-level navigation used by signed email links
        # while blocking cross-site form posts.
        samesite="lax",
        path="/",
    )


@router.get("/methods", response_model=AuthMethodsResponse)
def auth_methods(request: Request, settings: SettingsDep) -> AuthMethodsResponse:
    """What sign-in options this deployment offers.

    The login screen renders from this rather than hard-coding a provider.
    """
    authorize_url: str | None = None
    if settings.auth.oidc_issuer and settings.auth.oidc_client_id:
        # This state is not yet bound to anything the callback can verify,
        # because the callback is not implemented. Single-use state storage and
        # PKCE land together with the code exchange; until then the OIDC path
        # refuses rather than completing an unverified sign-in.
        state = secrets.token_urlsafe(24)
        query = urlencode(
            {
                "client_id": settings.auth.oidc_client_id,
                "response_type": "code",
                "scope": settings.auth.oidc_scopes,
                "redirect_uri": str(request.url_for("oidc_callback")),
                "state": state,
            }
        )
        authorize_url = f"{settings.auth.oidc_issuer.rstrip('/')}/authorize?{query}"

    return AuthMethodsResponse(
        oidc_enabled=bool(settings.auth.oidc_issuer),
        oidc_authorize_url=authorize_url,
        local_accounts_enabled=settings.auth.allow_local_accounts,
        environment=str(settings.environment),
    )


@router.get("/oidc/callback", name="oidc_callback")
def oidc_callback(settings: SettingsDep) -> None:
    """OIDC redirect handler.

    Deliberately unimplemented rather than faked. The authorization-code
    exchange requires a chosen provider, its JWKS endpoint and a registered
    redirect URI, none of which are decided yet. Returning a fabricated session
    here would create exactly the kind of fake success the release bar forbids.
    """
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail=(
            "OIDC sign-in is not yet configured for this deployment. "
            "An identity provider and redirect URI must be registered first."
        ),
    )


@router.post("/local/sign-in", response_model=CurrentUserResponse)
def local_sign_in(
    payload: SignInRequest,
    response: Response,
    request: Request,
    settings: SettingsDep,
    session: SessionDep,
    tokens: TokenServiceDep,
    audit: AuditDep,
    correlation_id: CorrelationDep,
) -> CurrentUserResponse:
    """Development and test sign-in by email, with no password.

    This is safe only because it cannot be enabled in production: startup fails
    if `allow_local_accounts` is true there.
    """
    if not settings.auth.allow_local_accounts:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Local sign-in is disabled. Use single sign-on.",
        )

    user = session.execute(
        select(User).where(User.email == payload.email.lower())
    ).scalar_one_or_none()

    if user is None or not user.is_active or user.archived_at is not None:
        # Committed rather than flushed: the refusal below rolls the request
        # transaction back, and a failed sign-in that leaves no trace is exactly
        # the record an investigator needs.
        audit.append_and_commit(
            action=AuditAction.sign_in_failed,
            actor_type=ActorType.anonymous,
            actor_label=payload.email,
            subject_type="session",
            correlation_id=correlation_id,
            detail={"reason": "unknown or inactive account"},
            source_ip=request.client.host if request.client else None,
        )
        # Identical message whether the account is absent or disabled, so the
        # endpoint cannot be used to enumerate valid users.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sign-in failed. Check the address and try again.",
        )

    token, session_id = tokens.issue_session(
        user_id=user.id,
        email=user.email,
        display_name=user.display_name,
        roles=user.roles,
    )
    user.last_sign_in_at = utc_now()

    audit.append(
        action=AuditAction.sign_in,
        actor_type=ActorType.user,
        actor_id=user.id,
        actor_label=user.display_name,
        subject_type="session",
        subject_id=session_id,
        correlation_id=correlation_id,
        detail={"method": "local", "roles": sorted(str(r) for r in user.roles)},
        source_ip=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )

    _set_session_cookie(response, settings=settings, token=token)
    return _current_user_payload(user)


@router.post("/sign-out", status_code=status.HTTP_204_NO_CONTENT)
def sign_out(
    response: Response,
    principal: PrincipalDep,
    settings: SettingsDep,
    audit: AuditDep,
    correlation_id: CorrelationDep,
) -> None:
    audit.append(
        action=AuditAction.sign_out,
        actor_type=ActorType.user,
        actor_id=principal.user_id,
        actor_label=principal.display_name,
        subject_type="session",
        subject_id=principal.session_id,
        correlation_id=correlation_id,
    )
    response.delete_cookie(settings.auth.session_cookie_name, path="/")


def _current_user_payload(user: User) -> CurrentUserResponse:
    from finora.domain.roles import permissions_for

    roles: frozenset[Role] = user.roles
    return CurrentUserResponse(
        id=str(user.id),
        email=user.email,
        display_name=user.display_name,
        department=user.department,
        roles=sorted(str(r) for r in roles),
        permissions=sorted(p.value for p in permissions_for(roles)),
    )


@router.get("/me", response_model=CurrentUserResponse)
def current_user(principal: PrincipalDep, session: SessionDep) -> CurrentUserResponse:
    """Who the caller is, and precisely what they may do.

    The frontend uses the permission list to decide what to render, but every
    endpoint re-checks server-side; this is a convenience, not the control.
    """
    user = session.get(User, principal.user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sign in to continue.")
    return _current_user_payload(user)
