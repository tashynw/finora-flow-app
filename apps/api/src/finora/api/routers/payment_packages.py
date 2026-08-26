"""Payment package endpoints.

Two things here differ from every other register in the platform.

*Totals are a list, never a number.* A package may hold invoices in more than
one currency, and there is no rate at which they add up. Every response that
reports what a package comes to reports one figure per currency, so a screen
cannot accidentally render a sum that means nothing.

*A package has a standing rather than a state.* Open, submitted and cancelled
are derived from two timestamps — the domain module explains why a package is
not on the workflow state machine — and are returned as `standing` so nothing
mistakes them for the states the invoices inside are moving through.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.sql.elements import ColumnElement

from finora.api.deps import (
    AuditDep,
    CorrelationDep,
    CurrentUserDep,
    PaymentPackageServiceDep,
    RequirePermission,
    SessionDep,
)
from finora.api.security import Principal
from finora.application.payment_packages import (
    RECORD_TYPE,
    NotOpenError,
    NotReadyError,
    PackageDraft,
    PaymentPackageError,
    PaymentPackageService,
)
from finora.domain.audit import ActorType, AuditAction
from finora.domain.money import Money
from finora.domain.payment_packages import (
    BLOCKING_PROBLEMS,
    PAYMENT_METHOD_LABELS,
    PROBLEM_EXPLANATIONS,
    PROBLEM_FIELDS,
    STANDING_DESCRIPTIONS,
    STANDING_LABELS,
    JoinRefusal,
    PackageProblem,
    PackageStanding,
    PaymentMethod,
    manifest_filename,
)
from finora.domain.roles import (
    AuthorizationError,
    Permission,
    SegregationOfDutiesError,
    permissions_for,
)
from finora.domain.workflow import STATE_LABELS, TransitionError, WorkflowState
from finora.infrastructure.db.models import PaymentPackage

router = APIRouter(prefix="/payment-packages", tags=["payments"])

_VIEW = Depends(RequirePermission(Permission.payment_view))
_MANAGE = Depends(RequirePermission(Permission.payment_package_manage))


# ------------------------------------------------------------------------- models


class MoneyOut(BaseModel):
    """One amount, always with the currency it is denominated in."""

    currency: str
    minor_units: int
    formatted: str


class PackageProblemOut(BaseModel):
    problem: PackageProblem
    field: str
    explanation: str
    #: Whether a control has fired rather than a form being half-filled.
    is_blocking: bool


class PackageLineOut(BaseModel):
    invoice_id: uuid.UUID
    invoice_reference: str
    invoice_number: str | None
    vendor_name: str
    amount: MoneyOut
    due_date: date | None
    #: The invoice's state now, which may not be the state it was added in. A
    #: line showing anything other than Ready for submission is what
    #: `line_no_longer_payable` is reporting.
    invoice_state: WorkflowState
    invoice_state_label: str
    is_still_payable: bool


class PaymentPackageSummary(BaseModel):
    id: uuid.UUID
    reference: str
    description: str
    standing: PackageStanding
    standing_label: str
    payment_method: PaymentMethod | None
    payment_method_label: str | None
    intended_payment_date: date | None
    invoice_count: int
    vendor_count: int
    #: One per currency, never summed.
    totals: list[MoneyOut]
    submitted_at: datetime | None
    submission_reference: str | None
    created_at: datetime
    blocker_count: int


class PaymentPackagePage(BaseModel):
    rows: list[PaymentPackageSummary]
    total: int
    page: int
    page_size: int


class ManifestOut(BaseModel):
    """The manifest as it stands, and how it compares with what was sent."""

    content: str
    digest: str
    line_count: int
    filename: str
    #: What was recorded at submission. Null on a package that has not gone.
    submitted_digest: str | None
    #: Whether the file rebuilt now is the file that went. False on a submitted
    #: package is a finding, not a display detail: it means something the
    #: manifest is built from has changed since.
    matches_submitted: bool | None


class PaymentPackageDetail(BaseModel):
    id: uuid.UUID
    reference: str
    description: str
    version: int

    standing: PackageStanding
    standing_label: str
    standing_description: str

    payment_method: PaymentMethod | None
    payment_method_label: str | None
    intended_payment_date: date | None

    lines: list[PackageLineOut]
    totals: list[MoneyOut]
    vendor_count: int

    problems: list[PackageProblemOut]
    blockers: list[PackageProblemOut]

    created_by_label: str
    created_at: datetime
    submitted_at: datetime | None
    submitted_by_label: str | None
    submission_reference: str | None
    manifest_sha256: str | None
    manifest_line_count: int | None
    cancelled_at: datetime | None
    cancelled_reason: str | None

    #: Server-decided controls. A button the caller may not press is absent
    #: rather than present and refused.
    can_edit: bool
    can_submit: bool
    can_cancel: bool


class EligibleInvoiceOut(BaseModel):
    """An approved invoice that could go into a package."""

    id: uuid.UUID
    reference: str
    invoice_number: str | None
    vendor_name: str
    amount: MoneyOut
    due_date: date | None
    department: str | None


class PackageDraftRequest(BaseModel):
    description: str = Field(default="", max_length=500)
    payment_method: PaymentMethod | None = None
    intended_payment_date: date | None = None


class AddLinesRequest(BaseModel):
    invoice_ids: list[uuid.UUID] = Field(min_length=1, max_length=500)


class RefusedOut(BaseModel):
    invoice_id: uuid.UUID
    invoice_reference: str
    refusal: JoinRefusal
    explanation: str


class AddLinesResponse(BaseModel):
    """What went in and what did not, with the package as it now stands."""

    added: list[uuid.UUID]
    refused: list[RefusedOut]
    package: PaymentPackageDetail


class PackageSubmitRequest(BaseModel):
    submission_reference: str = Field(min_length=1, max_length=120)


class PackageSubmitResponse(BaseModel):
    package: PaymentPackageDetail
    manifest: ManifestOut


class PackageReasonRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


# -------------------------------------------------------------------- conversions


def _money_out(amount: Money) -> MoneyOut:
    return MoneyOut(
        currency=amount.currency,
        minor_units=amount.minor_units,
        formatted=amount.format(),
    )


def _totals_out(totals: dict[str, Money]) -> list[MoneyOut]:
    """Per-currency totals in a stable order.

    Sorted by currency code so a package holding JMD and USD renders the same
    way on every load. Order matters here more than it looks: two figures that
    swap places between renders read as two different answers.
    """
    return [_money_out(totals[code]) for code in sorted(totals)]


def _problem_out(problem: PackageProblem) -> PackageProblemOut:
    return PackageProblemOut(
        problem=problem,
        field=PROBLEM_FIELDS[problem],
        explanation=PROBLEM_EXPLANATIONS[problem],
        is_blocking=problem in BLOCKING_PROBLEMS,
    )


def _summary(package: PaymentPackage, *, packages: PaymentPackageService) -> PaymentPackageSummary:
    current = packages.standing_of(package)
    found = packages.outstanding(package)
    return PaymentPackageSummary(
        id=package.id,
        reference=package.reference,
        description=package.description or "",
        standing=current,
        standing_label=STANDING_LABELS[current],
        payment_method=package.payment_method,
        payment_method_label=(
            PAYMENT_METHOD_LABELS[package.payment_method]
            if package.payment_method is not None
            else None
        ),
        intended_payment_date=package.intended_payment_date,
        invoice_count=len(package.lines),
        vendor_count=len({line.vendor_name for line in package.lines}),
        totals=_totals_out(packages.totals_of(package)),
        submitted_at=package.submitted_at,
        submission_reference=package.submission_reference,
        created_at=package.created_at,
        blocker_count=len([p for p in found if p in BLOCKING_PROBLEMS]),
    )


def _detail(
    package: PaymentPackage,
    *,
    packages: PaymentPackageService,
    permissions: frozenset[Permission],
) -> PaymentPackageDetail:
    current = packages.standing_of(package)
    found = packages.outstanding(package)
    open_now = current is PackageStanding.open
    may_manage = Permission.payment_package_manage in permissions

    return PaymentPackageDetail(
        id=package.id,
        reference=package.reference,
        description=package.description or "",
        version=package.version,
        standing=current,
        standing_label=STANDING_LABELS[current],
        standing_description=STANDING_DESCRIPTIONS[current],
        payment_method=package.payment_method,
        payment_method_label=(
            PAYMENT_METHOD_LABELS[package.payment_method]
            if package.payment_method is not None
            else None
        ),
        intended_payment_date=package.intended_payment_date,
        lines=[
            PackageLineOut(
                invoice_id=line.invoice_id,
                invoice_reference=line.invoice_reference,
                invoice_number=line.invoice_number,
                vendor_name=line.vendor_name,
                amount=_money_out(Money(line.amount_minor_units, line.currency)),
                due_date=line.due_date,
                invoice_state=line.invoice.state,
                invoice_state_label=STATE_LABELS[line.invoice.state],
                is_still_payable=line.invoice.state
                in {WorkflowState.ready_for_submission, WorkflowState.submitted},
            )
            for line in package.lines
        ],
        totals=_totals_out(packages.totals_of(package)),
        vendor_count=len({line.vendor_name for line in package.lines}),
        problems=[_problem_out(problem) for problem in found],
        blockers=[_problem_out(problem) for problem in found if problem in BLOCKING_PROBLEMS],
        created_by_label=(
            package.created_by.display_name if package.created_by is not None else ""
        ),
        created_at=package.created_at,
        submitted_at=package.submitted_at,
        submitted_by_label=(
            package.submitted_by.display_name if package.submitted_by is not None else None
        ),
        submission_reference=package.submission_reference,
        manifest_sha256=package.manifest_sha256,
        manifest_line_count=package.manifest_line_count,
        cancelled_at=package.cancelled_at,
        cancelled_reason=package.cancelled_reason,
        can_edit=open_now and may_manage,
        can_submit=open_now and not found and Permission.payment_submit in permissions,
        can_cancel=open_now and may_manage,
    )


def _manifest_out(package: PaymentPackage, *, packages: PaymentPackageService) -> ManifestOut:
    manifest = packages.manifest(package)
    if manifest is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "This package has no payment method or date yet, so there is no "
                "manifest to produce."
            ),
        )
    recorded = package.manifest_sha256
    return ManifestOut(
        content=manifest.content,
        digest=manifest.digest,
        line_count=manifest.line_count,
        filename=manifest_filename(package.reference),
        submitted_digest=recorded,
        matches_submitted=(manifest.digest == recorded) if recorded is not None else None,
    )


def _load(session: SessionDep, package_id: uuid.UUID) -> PaymentPackage:
    package = session.get(PaymentPackage, package_id)
    if package is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="No such payment package."
        )
    return package


def _refused(error: PaymentPackageError) -> HTTPException:
    if isinstance(error, NotReadyError):
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=error.as_detail()
        )
    if isinstance(error, NotOpenError):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error))
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error))


# ---------------------------------------------------------------------- endpoints


@router.get("/eligible-invoices", response_model=list[EligibleInvoiceOut], dependencies=[_VIEW])
def eligible_invoices(
    packages: PaymentPackageServiceDep,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> list[EligibleInvoiceOut]:
    """Approved invoices not yet in any package, soonest due first."""
    return [
        EligibleInvoiceOut(
            id=invoice.id,
            reference=invoice.reference,
            invoice_number=invoice.invoice_number,
            vendor_name=(
                invoice.vendor.name if invoice.vendor is not None else invoice.vendor_name
            ),
            # Both are non-null in the query behind this, which filters out
            # invoices with no amount.
            amount=_money_out(Money(invoice.total_minor_units or 0, invoice.currency or "JMD")),
            due_date=invoice.due_date,
            department=invoice.department,
        )
        for invoice in packages.eligible_invoices(limit=limit)
    ]


@router.get("", response_model=PaymentPackagePage, dependencies=[_VIEW])
def list_packages(
    session: SessionDep,
    packages: PaymentPackageServiceDep,
    standing: Annotated[list[PackageStanding] | None, Query()] = None,
    search: Annotated[str | None, Query(max_length=200)] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 25,
) -> PaymentPackagePage:
    """The package register.

    Filtered on standing rather than on a state column, because there is no
    state column: each of the three is a condition on the two timestamps.
    """
    conditions: list[ColumnElement[bool]] = []
    if standing:
        wanted = set(standing)
        clauses: list[ColumnElement[bool]] = []
        if PackageStanding.open in wanted:
            clauses.append(
                PaymentPackage.submitted_at.is_(None) & PaymentPackage.cancelled_at.is_(None)
            )
        if PackageStanding.submitted in wanted:
            clauses.append(PaymentPackage.submitted_at.is_not(None))
        if PackageStanding.cancelled in wanted:
            clauses.append(
                PaymentPackage.submitted_at.is_(None) & PaymentPackage.cancelled_at.is_not(None)
            )
        conditions.append(or_(*clauses))
    if search:
        pattern = f"%{search.strip()}%"
        conditions.append(
            or_(
                PaymentPackage.reference.ilike(pattern),
                PaymentPackage.description.ilike(pattern),
                PaymentPackage.submission_reference.ilike(pattern),
            )
        )

    total = session.execute(
        select(func.count()).select_from(PaymentPackage).where(*conditions)
    ).scalar_one()
    rows = (
        session.execute(
            select(PaymentPackage)
            .where(*conditions)
            .order_by(PaymentPackage.created_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        .scalars()
        .all()
    )

    return PaymentPackagePage(
        rows=[_summary(row, packages=packages) for row in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post(
    "",
    response_model=PaymentPackageDetail,
    status_code=status.HTTP_201_CREATED,
    dependencies=[_MANAGE],
)
def create_package(
    body: PackageDraftRequest,
    session: SessionDep,
    packages: PaymentPackageServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> PaymentPackageDetail:
    """Open an empty package and give it its reference."""
    try:
        package = packages.create(
            draft=PackageDraft(
                description=body.description,
                payment_method=body.payment_method,
                intended_payment_date=body.intended_payment_date,
            ),
            actor=user,
            correlation_id=correlation_id,
        )
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error

    session.commit()
    session.refresh(package)
    return _detail(package, packages=packages, permissions=permissions_for(user.roles))


@router.get("/{package_id}", response_model=PaymentPackageDetail, dependencies=[_VIEW])
def read_package(
    package_id: uuid.UUID,
    session: SessionDep,
    packages: PaymentPackageServiceDep,
    user: CurrentUserDep,
) -> PaymentPackageDetail:
    package = _load(session, package_id)
    return _detail(package, packages=packages, permissions=permissions_for(user.roles))


@router.put("/{package_id}", response_model=PaymentPackageDetail, dependencies=[_MANAGE])
def update_package(
    package_id: uuid.UUID,
    body: PackageDraftRequest,
    session: SessionDep,
    packages: PaymentPackageServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> PaymentPackageDetail:
    package = _load(session, package_id)
    try:
        packages.update(
            package,
            PackageDraft(
                description=body.description,
                payment_method=body.payment_method,
                intended_payment_date=body.intended_payment_date,
            ),
            actor=user,
            correlation_id=correlation_id,
        )
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except PaymentPackageError as error:
        raise _refused(error) from error

    session.commit()
    session.refresh(package)
    return _detail(package, packages=packages, permissions=permissions_for(user.roles))


@router.post("/{package_id}/lines", response_model=AddLinesResponse, dependencies=[_MANAGE])
def add_lines(
    package_id: uuid.UUID,
    body: AddLinesRequest,
    session: SessionDep,
    packages: PaymentPackageServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> AddLinesResponse:
    """Add approved invoices, taking the ones that can go and naming the rest.

    Deliberately not all-or-nothing. Somebody adding a page of search results
    needs to see which two of thirty were already spoken for, and a refusal of
    the whole batch would leave them to work that out themselves.
    """
    package = _load(session, package_id)
    try:
        outcome = packages.add(
            package,
            invoice_ids=tuple(body.invoice_ids),
            actor=user,
            correlation_id=correlation_id,
        )
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except PaymentPackageError as error:
        raise _refused(error) from error
    except TransitionError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    session.commit()
    session.refresh(package)
    return AddLinesResponse(
        added=[line.invoice_id for line in outcome.added],
        refused=[
            RefusedOut(
                invoice_id=item.invoice_id,
                invoice_reference=item.reference,
                refusal=item.refusal,
                explanation=item.explanation,
            )
            for item in outcome.refused
        ],
        package=_detail(package, packages=packages, permissions=permissions_for(user.roles)),
    )


@router.delete(
    "/{package_id}/lines/{invoice_id}",
    response_model=PaymentPackageDetail,
    dependencies=[_MANAGE],
)
def remove_line(
    package_id: uuid.UUID,
    invoice_id: uuid.UUID,
    session: SessionDep,
    packages: PaymentPackageServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> PaymentPackageDetail:
    """Take one invoice out, returning it to approved and unpaid."""
    package = _load(session, package_id)
    try:
        packages.remove(package, invoice_id=invoice_id, actor=user, correlation_id=correlation_id)
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except PaymentPackageError as error:
        raise _refused(error) from error
    except TransitionError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    session.commit()
    session.refresh(package)
    return _detail(package, packages=packages, permissions=permissions_for(user.roles))


@router.get("/{package_id}/manifest", response_model=ManifestOut, dependencies=[_VIEW])
def read_manifest(
    package_id: uuid.UUID,
    session: SessionDep,
    packages: PaymentPackageServiceDep,
) -> ManifestOut:
    """The manifest as a value, for previewing before submission.

    On a submitted package this also reports whether the file rebuilt now still
    hashes to what was recorded at the time, which is the check that makes the
    stored digest worth storing.
    """
    package = _load(session, package_id)
    return _manifest_out(package, packages=packages)


@router.get("/{package_id}/manifest.csv")
def download_manifest(
    package_id: uuid.UUID,
    session: SessionDep,
    packages: PaymentPackageServiceDep,
    audit: AuditDep,
    correlation_id: CorrelationDep,
    principal: Annotated[Principal, Depends(RequirePermission(Permission.payment_view))],
) -> Response:
    """The manifest as a file, which is what actually goes to the bank.

    Taking a copy of the organisation's outgoing payments is an export, so it
    is recorded as one — the same action accruals use when a period file leaves.
    """
    package = _load(session, package_id)
    manifest = _manifest_out(package, packages=packages)
    audit.append(
        action=AuditAction.export_generated,
        actor_type=ActorType.user,
        actor_id=principal.user_id,
        actor_label=principal.display_name,
        subject_type=RECORD_TYPE,
        subject_id=package.id,
        correlation_id=correlation_id,
        detail={
            "reference": package.reference,
            "format": "csv",
            "filename": manifest.filename,
            "sha256": manifest.digest,
            "rows": manifest.line_count,
        },
    )
    session.commit()
    return Response(
        content=manifest.content,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{manifest.filename}"',
            # So a recipient can check the file against what the package says
            # was sent without opening the application.
            "X-Manifest-Sha256": manifest.digest,
        },
    )


@router.post("/{package_id}/submit", response_model=PackageSubmitResponse)
def submit_package(
    package_id: uuid.UUID,
    body: PackageSubmitRequest,
    session: SessionDep,
    packages: PaymentPackageServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
    _principal: Annotated[object, Depends(RequirePermission(Permission.payment_submit))],
) -> PackageSubmitResponse:
    """Send the package, recording the bank's reference and the manifest digest.

    Guarded by `payment:submit` rather than `payment:package_manage`. Assembling
    a package and sending it are different authorities on purpose: the person
    who chose what goes out is not necessarily the person entitled to send it.
    """
    package = _load(session, package_id)
    try:
        manifest = packages.submit(
            package,
            submission_reference=body.submission_reference,
            actor=user,
            correlation_id=correlation_id,
        )
    except SegregationOfDutiesError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except ValueError as error:
        # The submission reference, refused by the domain with its own wording.
        if isinstance(error, PaymentPackageError):  # pragma: no cover - disjoint types
            raise _refused(error) from error
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
        ) from error
    except PaymentPackageError as error:
        raise _refused(error) from error
    except TransitionError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    session.commit()
    session.refresh(package)
    return PackageSubmitResponse(
        package=_detail(package, packages=packages, permissions=permissions_for(user.roles)),
        manifest=ManifestOut(
            content=manifest.content,
            digest=manifest.digest,
            line_count=manifest.line_count,
            filename=manifest_filename(package.reference),
            submitted_digest=package.manifest_sha256,
            matches_submitted=manifest.digest == package.manifest_sha256,
        ),
    )


@router.post("/{package_id}/cancel", response_model=PaymentPackageDetail, dependencies=[_MANAGE])
def cancel_package(
    package_id: uuid.UUID,
    body: PackageReasonRequest,
    session: SessionDep,
    packages: PaymentPackageServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> PaymentPackageDetail:
    """Abandon a package, returning everything in it to approved and unpaid."""
    package = _load(session, package_id)
    try:
        packages.cancel(package, reason=body.reason, actor=user, correlation_id=correlation_id)
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except PaymentPackageError as error:
        raise _refused(error) from error
    except TransitionError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    session.commit()
    session.refresh(package)
    return _detail(package, packages=packages, permissions=permissions_for(user.roles))
