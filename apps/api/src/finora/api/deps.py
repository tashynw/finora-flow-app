"""Request dependencies: identity, authorization and audit context.

Authorization is deny by default. An endpoint without an explicit permission
dependency has no authenticated principal available to it, so it cannot
accidentally serve protected data.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from finora.api.security import (
    ExpiredTokenError,
    InvalidTokenError,
    Principal,
    SecurityError,
    TokenService,
)
from finora.application.accruals import AccrualService
from finora.application.administration import AdministrationService
from finora.application.approvals import ApprovalService
from finora.application.credit_cards import CreditCardService
from finora.application.document_pipeline import DocumentPipeline
from finora.application.estimates import EstimateService
from finora.application.intake import IntakeService
from finora.application.payment_packages import PaymentPackageService
from finora.application.purchase_orders import PurchaseOrderService
from finora.application.reference_data import ReferenceDataService
from finora.application.reminder_tasks import Services, build_services, mail_domain
from finora.application.reply_routing import ReplyRouter
from finora.application.retention import RetentionService
from finora.application.saved_views import SavedViewsService
from finora.application.search import SearchService
from finora.application.signed_links import SignedLinkService
from finora.application.thresholds import ThresholdService
from finora.application.users import UsersService
from finora.application.vendor_check_ins import VendorCheckInService
from finora.application.work import WorkService
from finora.config import Settings, get_settings
from finora.domain.audit import ActorType, AuditAction
from finora.domain.intake import AttachmentLimits
from finora.domain.roles import (
    AuthorizationError,
    Permission,
    SegregationOfDutiesError,
)
from finora.domain.vendor_confirmation import FollowUpPolicy
from finora.infrastructure.ai_gateway import AiGateway, get_ai_gateway
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import User
from finora.infrastructure.db.session import get_db_session
from finora.infrastructure.object_store import ObjectStore, get_object_store
from finora.infrastructure.scanner import MalwareScanner, get_scanner

SettingsDep = Annotated[Settings, Depends(get_settings)]
SessionDep = Annotated[Session, Depends(get_db_session)]


@lru_cache
def _token_service() -> TokenService:
    return TokenService(get_settings())


def get_token_service() -> TokenService:
    return _token_service()


TokenServiceDep = Annotated[TokenService, Depends(get_token_service)]


def get_correlation_id(request: Request) -> uuid.UUID:
    """Correlation identifier for this unit of work.

    Accepts an inbound header so a browser action can be traced through queues
    and outbound mail, but generates one when absent or malformed rather than
    trusting client input to be a UUID.
    """
    supplied = request.headers.get("x-correlation-id")
    if supplied:
        try:
            return uuid.UUID(supplied)
        except ValueError:
            pass
    return uuid.uuid4()


CorrelationDep = Annotated[uuid.UUID, Depends(get_correlation_id)]


def get_audit(session: SessionDep) -> AuditRepository:
    return AuditRepository(session)


AuditDep = Annotated[AuditRepository, Depends(get_audit)]


def get_principal(request: Request, settings: SettingsDep, tokens: TokenServiceDep) -> Principal:
    token = request.cookies.get(settings.auth.session_cookie_name)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sign in to continue.",
        )
    try:
        return tokens.read_session(token)
    except ExpiredTokenError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    except (InvalidTokenError, SecurityError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sign in to continue.",
        ) from exc


PrincipalDep = Annotated[Principal, Depends(get_principal)]


class RequirePermission:
    """Dependency factory enforcing a single permission.

    Usage:
        @router.get("/invoices", dependencies=[Depends(RequirePermission(Permission.invoice_view))])
    """

    def __init__(self, permission: Permission) -> None:
        self.permission = permission

    def __call__(
        self,
        principal: PrincipalDep,
        audit: AuditDep,
        request: Request,
        correlation_id: CorrelationDep,
    ) -> Principal:
        if principal.has(self.permission):
            return principal

        # A denial is itself security-relevant: repeated denials are how probing
        # shows up in the trail. Committed immediately because the 403 below
        # rolls the request transaction back. Safe here because dependencies run
        # before the endpoint body, so no business data has been written.
        audit.append_and_commit(
            action=AuditAction.permission_denied,
            actor_type=ActorType.user,
            actor_id=principal.user_id,
            actor_label=principal.display_name,
            subject_type="endpoint",
            correlation_id=correlation_id,
            detail={
                "permission": self.permission.value,
                "path": request.url.path,
                "method": request.method,
            },
            source_ip=request.client.host if request.client else None,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "You do not have permission to perform this action. "
                "Contact an administrator if you believe this is incorrect."
            ),
        )


class RequireAnyPermission:
    """Dependency factory for an endpoint two different roles legitimately reach.

    Delegation is the case this exists for: an approver arranges their own cover
    with `approval:delegate`, and an administrator arranges somebody else's with
    `admin:approval_matrix` — which is what has to happen when the approver is
    already away and did not set it up. Neither role holds the other's
    permission, so demanding either one alone locks out half the people the
    screen is for. Which of the two acts is permitted on which record is decided
    below this, in the service, where the target is known.
    """

    def __init__(self, *permissions: Permission) -> None:
        if not permissions:
            raise ValueError("Name at least one permission.")
        self.permissions = permissions

    def __call__(
        self,
        principal: PrincipalDep,
        audit: AuditDep,
        request: Request,
        correlation_id: CorrelationDep,
    ) -> Principal:
        if any(principal.has(permission) for permission in self.permissions):
            return principal

        audit.append_and_commit(
            action=AuditAction.permission_denied,
            actor_type=ActorType.user,
            actor_id=principal.user_id,
            actor_label=principal.display_name,
            subject_type="endpoint",
            correlation_id=correlation_id,
            detail={
                "permission": " or ".join(p.value for p in self.permissions),
                "path": request.url.path,
                "method": request.method,
            },
            source_ip=request.client.host if request.client else None,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "You do not have permission to perform this action. "
                "Contact an administrator if you believe this is incorrect."
            ),
        )


def enforce_segregation(
    *,
    session: Session,
    principal: Principal,
    permission: Permission,
    record_type: str,
    record_id: uuid.UUID,
) -> None:
    """Refuse an action the same user is barred from combining on this record.

    Checked against actions actually taken on this record, not against role
    membership, because holding two roles is legitimate while using both on one
    record is not.
    """
    from sqlalchemy import select

    from finora.domain.roles import assert_can_act
    from finora.infrastructure.db.models import RecordActionRow

    already = set(
        session.execute(
            select(RecordActionRow.permission).where(
                RecordActionRow.record_type == record_type,
                RecordActionRow.record_id == record_id,
                RecordActionRow.user_id == principal.user_id,
            )
        ).scalars()
    )
    try:
        assert_can_act(
            roles=principal.roles,
            permission=permission,
            already_exercised_on_record=already,
        )
    except SegregationOfDutiesError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except AuthorizationError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc


def record_action(
    *,
    session: Session,
    principal: Principal,
    permission: Permission,
    record_type: str,
    record_id: uuid.UUID,
) -> None:
    """Remember that this user exercised this permission on this record."""
    from sqlalchemy.dialects.postgresql import insert

    from finora.infrastructure.db.models import RecordActionRow

    statement = (
        insert(RecordActionRow)
        .values(
            record_type=record_type,
            record_id=record_id,
            user_id=principal.user_id,
            permission=permission,
        )
        # Repeating the same action is not a new fact, so the first occurrence
        # is kept and its timestamp preserved.
        .on_conflict_do_nothing(constraint="uq_record_actions_unique_action")
    )
    session.execute(statement)


def get_current_user(principal: PrincipalDep, session: SessionDep) -> User:
    """The signed-in user's own row.

    Needed wherever an action depends on something the token does not carry, such
    as an approval assignment or a delegation that may have been changed since the
    session began. Re-checking `is_active` here is the point: a token stays valid
    until it expires, and someone who has left should stop being able to act
    before then.
    """
    user = session.get(User, principal.user_id)
    if user is None or not user.is_active or user.archived_at is not None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sign in to continue.",
        )
    return user


CurrentUserDep = Annotated[User, Depends(get_current_user)]


def get_object_store_dep() -> ObjectStore:
    return get_object_store()


ObjectStoreDep = Annotated[ObjectStore, Depends(get_object_store_dep)]


def get_scanner_dep() -> MalwareScanner:
    return get_scanner()


ScannerDep = Annotated[MalwareScanner, Depends(get_scanner_dep)]


def get_ai_gateway_dep() -> AiGateway:
    return get_ai_gateway()


AiGatewayDep = Annotated[AiGateway, Depends(get_ai_gateway_dep)]


def get_document_pipeline(
    session: SessionDep,
    store: ObjectStoreDep,
    gateway: AiGatewayDep,
    audit: AuditDep,
    settings: SettingsDep,
) -> DocumentPipeline:
    return DocumentPipeline(
        session=session,
        object_store=store,
        gateway=gateway,
        audit=audit,
        settings=settings.extraction,
    )


DocumentPipelineDep = Annotated[DocumentPipeline, Depends(get_document_pipeline)]


def get_approval_service(session: SessionDep, audit: AuditDep) -> ApprovalService:
    return ApprovalService(session=session, audit=audit)


ApprovalServiceDep = Annotated[ApprovalService, Depends(get_approval_service)]


def get_work_service(session: SessionDep, approvals: ApprovalServiceDep) -> WorkService:
    return WorkService(session, approvals=approvals)


WorkServiceDep = Annotated[WorkService, Depends(get_work_service)]


def get_users_service(session: SessionDep, audit: AuditDep) -> UsersService:
    return UsersService(session, audit=audit)


UsersServiceDep = Annotated[UsersService, Depends(get_users_service)]


def get_reference_data_service(session: SessionDep, audit: AuditDep) -> ReferenceDataService:
    return ReferenceDataService(session, audit=audit)


ReferenceDataServiceDep = Annotated[ReferenceDataService, Depends(get_reference_data_service)]


def get_threshold_service(session: SessionDep, audit: AuditDep) -> ThresholdService:
    return ThresholdService(session, audit=audit)


ThresholdServiceDep = Annotated[ThresholdService, Depends(get_threshold_service)]


def get_retention_service(session: SessionDep, audit: AuditDep) -> RetentionService:
    return RetentionService(session, audit=audit)


RetentionServiceDep = Annotated[RetentionService, Depends(get_retention_service)]


def get_search_service(session: SessionDep) -> SearchService:
    return SearchService(session)


SearchServiceDep = Annotated[SearchService, Depends(get_search_service)]


def get_saved_views_service(session: SessionDep) -> SavedViewsService:
    return SavedViewsService(session)


SavedViewsServiceDep = Annotated[SavedViewsService, Depends(get_saved_views_service)]


def get_administration_service(
    session: SessionDep,
    approvals: ApprovalServiceDep,
    audit: AuditDep,
) -> AdministrationService:
    return AdministrationService(session=session, approvals=approvals, audit=audit)


AdministrationServiceDep = Annotated[AdministrationService, Depends(get_administration_service)]


def get_purchase_order_service(
    session: SessionDep,
    approvals: ApprovalServiceDep,
    audit: AuditDep,
) -> PurchaseOrderService:
    return PurchaseOrderService(session=session, approvals=approvals, audit=audit)


PurchaseOrderServiceDep = Annotated[PurchaseOrderService, Depends(get_purchase_order_service)]


def get_payment_package_service(
    session: SessionDep,
    audit: AuditDep,
) -> PaymentPackageService:
    # No approval service, unlike every other record service here. A package
    # asks nobody to decide anything: what it holds was approved before it could
    # be added.
    return PaymentPackageService(session=session, audit=audit)


PaymentPackageServiceDep = Annotated[PaymentPackageService, Depends(get_payment_package_service)]


def get_credit_card_service(
    session: SessionDep,
    audit: AuditDep,
) -> CreditCardService:
    return CreditCardService(session=session, audit=audit)


CreditCardServiceDep = Annotated[CreditCardService, Depends(get_credit_card_service)]


def get_accrual_service(
    session: SessionDep,
    audit: AuditDep,
) -> AccrualService:
    return AccrualService(session=session, audit=audit)


AccrualServiceDep = Annotated[AccrualService, Depends(get_accrual_service)]


def get_vendor_check_in_service(
    session: SessionDep,
    audit: AuditDep,
    settings: SettingsDep,
) -> VendorCheckInService:
    return VendorCheckInService(
        session=session,
        audit=audit,
        links=SignedLinkService(
            session=session,
            audit=audit,
            web_base_url=settings.web_base_url,
            vendor_ttl_hours=settings.workflow.vendor_check_in_link_ttl_hours,
        ),
        reply_address_base=settings.smtp.reply_to_address or settings.smtp.from_address,
        mail_domain=mail_domain(settings.smtp.from_address),
        policy=FollowUpPolicy(
            interval_days=settings.workflow.vendor_check_in_interval_days,
            max_follow_ups=settings.workflow.vendor_check_in_max_follow_ups,
            vendor_daily_limit=settings.workflow.vendor_daily_mail_limit,
        ),
    )


VendorCheckInServiceDep = Annotated[VendorCheckInService, Depends(get_vendor_check_in_service)]


def get_reply_router(
    session: SessionDep,
    audit: AuditDep,
    check_ins: VendorCheckInServiceDep,
) -> ReplyRouter:
    return ReplyRouter(session=session, audit=audit, check_ins=check_ins)


ReplyRouterDep = Annotated[ReplyRouter, Depends(get_reply_router)]


def get_intake_service(
    session: SessionDep,
    store: ObjectStoreDep,
    scanner: ScannerDep,
    audit: AuditDep,
    settings: SettingsDep,
    replies: ReplyRouterDep,
) -> IntakeService:
    return IntakeService(
        session=session,
        object_store=store,
        scanner=scanner,
        audit=audit,
        # Limits come from configuration rather than the call site, so one
        # endpoint cannot quietly accept a file another would refuse.
        limits=AttachmentLimits(
            max_bytes=settings.scanner.max_attachment_bytes,
            max_archive_entries=settings.scanner.max_archive_entries,
            max_archive_expansion_ratio=settings.scanner.max_archive_expansion_ratio,
        ),
        # Wired in even on the manual upload path. Somebody forwarding a
        # supplier's reply by hand, because it landed in their own inbox rather
        # than the shared one, should have it land on the check-in exactly as it
        # would have done had it arrived directly.
        replies=replies,
    )


IntakeServiceDep = Annotated[IntakeService, Depends(get_intake_service)]


def get_estimate_service(
    session: SessionDep,
    approvals: ApprovalServiceDep,
    audit: AuditDep,
) -> EstimateService:
    return EstimateService(session=session, approvals=approvals, audit=audit)


EstimateServiceDep = Annotated[EstimateService, Depends(get_estimate_service)]


def get_invoice_services(session: SessionDep) -> Services:
    """The invoice and reminder services, built the same way the worker builds them.

    Deliberately routed through `reminder_tasks.build_services` rather than
    assembled here. The sweep and the API must agree about the purchase order
    threshold, the tolerance and the business calendar, and two construction sites
    is how they stop agreeing.
    """
    return build_services(session)


InvoiceServicesDep = Annotated[Services, Depends(get_invoice_services)]


def optional_principal(
    request: Request, settings: SettingsDep, tokens: TokenServiceDep
) -> Iterator[Principal | None]:
    """For endpoints reachable both signed in and through a signed link."""
    token = request.cookies.get(settings.auth.session_cookie_name)
    if not token:
        yield None
        return
    try:
        yield tokens.read_session(token)
    except SecurityError:
        yield None
