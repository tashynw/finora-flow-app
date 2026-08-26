"""Application factory."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Final

import structlog
from fastapi import FastAPI, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from finora import __version__
from finora.api.routers import (
    accruals,
    administration,
    approvals,
    audit,
    auth,
    credit_cards,
    documents,
    estimates,
    health,
    intake,
    invoices,
    operational_settings,
    overview,
    payment_packages,
    purchase_orders,
    reference_admin,
    retention,
    saved_views,
    search,
    thresholds,
    users,
    vendor_check_ins,
    work,
)
from finora.config import Settings, get_settings
from finora.domain.roles import AuthorizationError, SegregationOfDutiesError
from finora.domain.workflow import (
    AiAuthorityError,
    CommentRequiredError,
    ConcurrencyError,
    IllegalTransitionError,
    TransitionError,
)
from finora.infrastructure.ai_gateway import effective_kill_switch
from finora.log_config import configure_logging

logger = structlog.get_logger(__name__)

CORRELATION_HEADER = "x-correlation-id"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = get_settings()
    # Fails fast on a misconfigured production deployment rather than serving
    # financial workflows with a development placeholder in place.
    settings.assert_production_ready()
    logger.info(
        "finora.startup",
        version=__version__,
        environment=str(settings.environment),
        ai_enabled=settings.ai.enabled
        and not effective_kill_switch(settings.ai.kill_switch_engaged),
    )
    yield
    logger.info("finora.shutdown")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    # Before anything else, so a failure during construction is logged through a
    # stream that can represent the message rather than one that raises on it.
    configure_logging(
        environment=settings.environment,
        level="DEBUG" if settings.debug else "INFO",
    )

    app = FastAPI(
        title="Finora Flow API",
        description=(
            "Unified Invoice and Estimate Automation Platform. "
            "Reads a controlled mailbox over IMAPS; never connects to "
            "Microsoft Graph or Outlook."
        ),
        version=__version__,
        lifespan=lifespan,
        docs_url=None if settings.is_production else "/docs",
        redoc_url=None,
        openapi_url=None if settings.is_production else "/openapi.json",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
        allow_headers=["content-type", "authorization", CORRELATION_HEADER],
        expose_headers=[CORRELATION_HEADER],
    )

    @app.middleware("http")
    async def correlation_and_security_headers(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        supplied = request.headers.get(CORRELATION_HEADER)
        try:
            correlation_id = uuid.UUID(supplied) if supplied else uuid.uuid4()
        except ValueError:
            correlation_id = uuid.uuid4()

        structlog.contextvars.bind_contextvars(
            correlation_id=str(correlation_id),
            path=request.url.path,
            method=request.method,
        )
        try:
            response = await call_next(request)
        finally:
            structlog.contextvars.clear_contextvars()

        response.headers[CORRELATION_HEADER] = str(correlation_id)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        # Documents are rendered by PDF.js from an object URL, so no remote
        # frames, objects or scripts are needed.
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' data: blob:; "
            "style-src 'self' 'unsafe-inline'; font-src 'self' data:; "
            "connect-src 'self'; frame-ancestors 'none'; object-src 'none'; "
            "base-uri 'self'; form-action 'self'"
        )
        if settings.is_production:
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        return response

    _register_exception_handlers(app)

    app.include_router(health.router, prefix=settings.api_prefix)
    app.include_router(auth.router, prefix=settings.api_prefix)
    app.include_router(intake.router, prefix=settings.api_prefix)
    app.include_router(documents.router, prefix=settings.api_prefix)
    app.include_router(estimates.router, prefix=settings.api_prefix)
    app.include_router(estimates.reference_router, prefix=settings.api_prefix)
    app.include_router(invoices.router, prefix=settings.api_prefix)
    app.include_router(invoices.link_router, prefix=settings.api_prefix)
    app.include_router(purchase_orders.router, prefix=settings.api_prefix)
    app.include_router(payment_packages.router, prefix=settings.api_prefix)
    app.include_router(vendor_check_ins.router, prefix=settings.api_prefix)
    # The one router with no authentication behind it. Registered on its own
    # line, and last among the payment routes, so it is visible here rather than
    # discovered later by somebody reading the access log.
    app.include_router(vendor_check_ins.public_router, prefix=settings.api_prefix)
    app.include_router(credit_cards.router, prefix=settings.api_prefix)
    app.include_router(accruals.router, prefix=settings.api_prefix)
    app.include_router(approvals.router, prefix=settings.api_prefix)
    app.include_router(work.router, prefix=settings.api_prefix)
    app.include_router(overview.router, prefix=settings.api_prefix)
    app.include_router(search.router, prefix=settings.api_prefix)
    app.include_router(saved_views.router, prefix=settings.api_prefix)
    app.include_router(administration.router, prefix=settings.api_prefix)
    app.include_router(users.router, prefix=settings.api_prefix)
    app.include_router(reference_admin.router, prefix=settings.api_prefix)
    app.include_router(thresholds.router, prefix=settings.api_prefix)
    app.include_router(operational_settings.router, prefix=settings.api_prefix)
    app.include_router(retention.router, prefix=settings.api_prefix)
    app.include_router(audit.router, prefix=settings.api_prefix)

    return app


def _problem(
    status_code: int, detail: str, *, code: str, extra: dict[str, object] | None = None
) -> JSONResponse:
    """Error responses carry a stable machine code plus human-readable detail.

    Internal exception text is never echoed, so a stack trace or SQL fragment
    cannot leak through an error path.
    """
    body: dict[str, object] = {"code": code, "detail": detail}
    if extra:
        body.update(extra)
    return JSONResponse(status_code=status_code, content=body)


#: The machine code for a refusal raised as an `HTTPException`. Derived from the
#: status because these are the platform's own refusals, not a taxonomy of their
#: own: the sentence in `detail` is what a person reads, and the code is what a
#: client branches on.
#:
#: The two constants Starlette has renamed are spelled the new way here. The
#: older spellings elsewhere in this file emit a deprecation warning when read,
#: and a table read at import time would emit one on every start.
_CODE_BY_STATUS: Final[dict[int, str]] = {
    status.HTTP_401_UNAUTHORIZED: "unauthenticated",
    status.HTTP_403_FORBIDDEN: "forbidden",
    status.HTTP_404_NOT_FOUND: "not_found",
    status.HTTP_409_CONFLICT: "conflict",
    status.HTTP_413_CONTENT_TOO_LARGE: "too_large",
    status.HTTP_415_UNSUPPORTED_MEDIA_TYPE: "unsupported_media_type",
    status.HTTP_422_UNPROCESSABLE_CONTENT: "unprocessable",
    status.HTTP_429_TOO_MANY_REQUESTS: "rate_limited",
    status.HTTP_503_SERVICE_UNAVAILABLE: "unavailable",
}


def _register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        """Put every refusal in the same envelope as every other error.

        FastAPI's own handler answers `{"detail": ...}` with no code, and when an
        endpoint raises a structured refusal it answers with `detail` as an object.
        A client then has to look in two shapes for the sentence to show a user,
        and the one place it is most needed — a refusal explaining what is
        outstanding — is the shape that breaks it.

        A structured refusal is flattened instead: its `message` becomes the
        detail, and everything else it carries sits beside it.
        """
        # Read through `object`: Starlette types `detail` as `str`, while FastAPI
        # documents and accepts any JSON-serialisable value, and the structured
        # refusals this handler exists for are dictionaries.
        detail: object = exc.detail
        extra: dict[str, object] | None = None
        if isinstance(detail, dict):
            message = str(detail.get("message", "This action could not be completed."))
            extra = {key: value for key, value in detail.items() if key != "message"}
        else:
            message = str(detail)

        return _problem(
            exc.status_code,
            message,
            code=_CODE_BY_STATUS.get(exc.status_code, "request_refused"),
            extra=extra,
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        fields = [
            {
                "field": ".".join(str(p) for p in err["loc"][1:]) or "body",
                "message": err["msg"],
            }
            for err in exc.errors()
        ]
        return _problem(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Some values need attention before this can be saved.",
            code="validation_failed",
            extra={"fields": fields},
        )

    @app.exception_handler(ConcurrencyError)
    async def concurrency_error(request: Request, exc: ConcurrencyError) -> JSONResponse:
        return _problem(status.HTTP_409_CONFLICT, str(exc), code="stale_record")

    @app.exception_handler(CommentRequiredError)
    async def comment_required(request: Request, exc: CommentRequiredError) -> JSONResponse:
        return _problem(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc), code="reason_required")

    @app.exception_handler(AiAuthorityError)
    async def ai_authority(request: Request, exc: AiAuthorityError) -> JSONResponse:
        return _problem(status.HTTP_403_FORBIDDEN, str(exc), code="ai_not_authorized")

    @app.exception_handler(IllegalTransitionError)
    async def illegal_transition(request: Request, exc: IllegalTransitionError) -> JSONResponse:
        return _problem(
            status.HTTP_409_CONFLICT,
            str(exc),
            code="illegal_transition",
            extra={"current_state": str(exc.current), "requested_state": str(exc.target)},
        )

    @app.exception_handler(TransitionError)
    async def transition_error(request: Request, exc: TransitionError) -> JSONResponse:
        return _problem(status.HTTP_409_CONFLICT, str(exc), code="transition_refused")

    @app.exception_handler(SegregationOfDutiesError)
    async def segregation_error(request: Request, exc: SegregationOfDutiesError) -> JSONResponse:
        return _problem(status.HTTP_409_CONFLICT, str(exc), code="segregation_of_duties")

    @app.exception_handler(AuthorizationError)
    async def authorization_error(request: Request, exc: AuthorizationError) -> JSONResponse:
        return _problem(status.HTTP_403_FORBIDDEN, str(exc), code="forbidden")

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception) -> JSONResponse:
        try:
            logger.exception("finora.unhandled_error", error_type=exc.__class__.__name__)
        except Exception:  # noqa: S110 - see below
            # This handler exists to turn a failure into an answer, so it must not
            # be able to fail itself. If logging is what breaks, the caller still
            # gets a response rather than a dropped connection, which is otherwise
            # indistinguishable from the server having died. There is nowhere left
            # to report this: the reporting channel is the thing that failed.
            pass
        return _problem(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "Something went wrong on our side and the action was not completed. "
            "Nothing was saved. Please try again, and contact support if it "
            "keeps happening.",
            code="internal_error",
        )


app = create_app()
