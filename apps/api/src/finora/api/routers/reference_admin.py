"""Vendor, GL account and cost-centre administration.

These catalogues feed every coding selector. Soft-deactivate is preferred over
hard delete so historical documents still resolve to a readable identity.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from finora.api.deps import (
    CorrelationDep,
    CurrentUserDep,
    ReferenceDataServiceDep,
    RequirePermission,
)
from finora.application.reference_data import (
    NotFoundError,
    ReferenceDataError,
    ValidationError,
)
from finora.domain.roles import Permission
from finora.infrastructure.db.models import CostCentre, GlAccount, Vendor

router = APIRouter(prefix="/admin/reference", tags=["reference-admin"])

_REF = Depends(RequirePermission(Permission.admin_reference_data))


class VendorOut(BaseModel):
    id: uuid.UUID
    code: str
    name: str
    email: str | None
    phone: str | None
    default_currency: str
    payment_terms_days: int | None
    is_active: bool


class VendorCreateRequest(BaseModel):
    code: str = Field(min_length=1, max_length=50)
    name: str = Field(min_length=1, max_length=300)
    email: str | None = Field(default=None, max_length=320)
    phone: str | None = Field(default=None, max_length=50)
    default_currency: str = Field(default="JMD", min_length=3, max_length=3)
    payment_terms_days: int | None = Field(default=None, ge=0)
    reason: str = Field(min_length=3, max_length=500)


class VendorUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=300)
    email: str | None = Field(default=None, max_length=320)
    phone: str | None = Field(default=None, max_length=50)
    default_currency: str | None = Field(default=None, min_length=3, max_length=3)
    payment_terms_days: int | None = Field(default=None, ge=0)
    reason: str = Field(min_length=3, max_length=500)


class GlAccountOut(BaseModel):
    id: uuid.UUID
    code: str
    name: str
    is_active: bool


class GlAccountCreateRequest(BaseModel):
    code: str = Field(min_length=1, max_length=50)
    name: str = Field(min_length=1, max_length=300)
    reason: str = Field(min_length=3, max_length=500)


class GlAccountUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=300)
    reason: str = Field(min_length=3, max_length=500)


class CostCentreOut(BaseModel):
    id: uuid.UUID
    code: str
    name: str
    department: str | None
    is_active: bool


class CostCentreCreateRequest(BaseModel):
    code: str = Field(min_length=1, max_length=50)
    name: str = Field(min_length=1, max_length=300)
    department: str | None = Field(default=None, max_length=200)
    reason: str = Field(min_length=3, max_length=500)


class CostCentreUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=300)
    department: str | None = Field(default=None, max_length=200)
    reason: str = Field(min_length=3, max_length=500)


class ActiveRequest(BaseModel):
    is_active: bool
    reason: str = Field(min_length=3, max_length=500)


def _vendor_out(row: Vendor) -> VendorOut:
    return VendorOut(
        id=row.id,
        code=row.code,
        name=row.name,
        email=row.email,
        phone=row.phone,
        default_currency=row.default_currency,
        payment_terms_days=row.payment_terms_days,
        is_active=row.is_active,
    )


def _gl_out(row: GlAccount) -> GlAccountOut:
    return GlAccountOut(
        id=row.id,
        code=row.code,
        name=row.name,
        is_active=row.is_active,
    )


def _centre_out(row: CostCentre) -> CostCentreOut:
    return CostCentreOut(
        id=row.id,
        code=row.code,
        name=row.name,
        department=row.department,
        is_active=row.is_active,
    )


def _refused(error: ReferenceDataError) -> HTTPException:
    if isinstance(error, NotFoundError):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error))
    if isinstance(error, ValidationError):
        return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error))
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error))


# -------------------------------------------------------------------- vendors


@router.get("/vendors", response_model=list[VendorOut], dependencies=[_REF])
def list_vendors(
    service: ReferenceDataServiceDep,
    include_inactive: Annotated[bool, Query()] = True,
) -> list[VendorOut]:
    return [_vendor_out(row) for row in service.list_vendors(include_inactive=include_inactive)]


@router.post(
    "/vendors",
    response_model=VendorOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[_REF],
)
def create_vendor(
    body: VendorCreateRequest,
    service: ReferenceDataServiceDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> VendorOut:
    try:
        row = service.create_vendor(
            actor=actor,
            code=body.code,
            name=body.name,
            email=body.email,
            phone=body.phone,
            default_currency=body.default_currency,
            payment_terms_days=body.payment_terms_days,
            reason=body.reason,
            correlation_id=correlation_id,
        )
    except ReferenceDataError as error:
        raise _refused(error) from error
    return _vendor_out(row)


@router.put("/vendors/{vendor_id}", response_model=VendorOut, dependencies=[_REF])
def update_vendor(
    vendor_id: uuid.UUID,
    body: VendorUpdateRequest,
    service: ReferenceDataServiceDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> VendorOut:
    try:
        row = service.update_vendor(
            actor=actor,
            vendor_id=vendor_id,
            name=body.name,
            email=body.email,
            phone=body.phone,
            default_currency=body.default_currency,
            payment_terms_days=body.payment_terms_days,
            reason=body.reason,
            correlation_id=correlation_id,
        )
    except ReferenceDataError as error:
        raise _refused(error) from error
    return _vendor_out(row)


@router.post("/vendors/{vendor_id}/active", response_model=VendorOut, dependencies=[_REF])
def set_vendor_active(
    vendor_id: uuid.UUID,
    body: ActiveRequest,
    service: ReferenceDataServiceDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> VendorOut:
    try:
        row = service.set_vendor_active(
            actor=actor,
            vendor_id=vendor_id,
            is_active=body.is_active,
            reason=body.reason,
            correlation_id=correlation_id,
        )
    except ReferenceDataError as error:
        raise _refused(error) from error
    return _vendor_out(row)


# ---------------------------------------------------------------- GL accounts


@router.get("/gl-accounts", response_model=list[GlAccountOut], dependencies=[_REF])
def list_gl_accounts(
    service: ReferenceDataServiceDep,
    include_inactive: Annotated[bool, Query()] = True,
) -> list[GlAccountOut]:
    return [_gl_out(row) for row in service.list_gl_accounts(include_inactive=include_inactive)]


@router.post(
    "/gl-accounts",
    response_model=GlAccountOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[_REF],
)
def create_gl_account(
    body: GlAccountCreateRequest,
    service: ReferenceDataServiceDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> GlAccountOut:
    try:
        row = service.create_gl_account(
            actor=actor,
            code=body.code,
            name=body.name,
            reason=body.reason,
            correlation_id=correlation_id,
        )
    except ReferenceDataError as error:
        raise _refused(error) from error
    return _gl_out(row)


@router.put("/gl-accounts/{account_id}", response_model=GlAccountOut, dependencies=[_REF])
def update_gl_account(
    account_id: uuid.UUID,
    body: GlAccountUpdateRequest,
    service: ReferenceDataServiceDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> GlAccountOut:
    try:
        row = service.update_gl_account(
            actor=actor,
            account_id=account_id,
            name=body.name,
            reason=body.reason,
            correlation_id=correlation_id,
        )
    except ReferenceDataError as error:
        raise _refused(error) from error
    return _gl_out(row)


@router.post(
    "/gl-accounts/{account_id}/active",
    response_model=GlAccountOut,
    dependencies=[_REF],
)
def set_gl_account_active(
    account_id: uuid.UUID,
    body: ActiveRequest,
    service: ReferenceDataServiceDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> GlAccountOut:
    try:
        row = service.set_gl_account_active(
            actor=actor,
            account_id=account_id,
            is_active=body.is_active,
            reason=body.reason,
            correlation_id=correlation_id,
        )
    except ReferenceDataError as error:
        raise _refused(error) from error
    return _gl_out(row)


# --------------------------------------------------------------- cost centres


@router.get("/cost-centres", response_model=list[CostCentreOut], dependencies=[_REF])
def list_cost_centres(
    service: ReferenceDataServiceDep,
    include_inactive: Annotated[bool, Query()] = True,
) -> list[CostCentreOut]:
    return [
        _centre_out(row) for row in service.list_cost_centres(include_inactive=include_inactive)
    ]


@router.post(
    "/cost-centres",
    response_model=CostCentreOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[_REF],
)
def create_cost_centre(
    body: CostCentreCreateRequest,
    service: ReferenceDataServiceDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> CostCentreOut:
    try:
        row = service.create_cost_centre(
            actor=actor,
            code=body.code,
            name=body.name,
            department=body.department,
            reason=body.reason,
            correlation_id=correlation_id,
        )
    except ReferenceDataError as error:
        raise _refused(error) from error
    return _centre_out(row)


@router.put(
    "/cost-centres/{centre_id}",
    response_model=CostCentreOut,
    dependencies=[_REF],
)
def update_cost_centre(
    centre_id: uuid.UUID,
    body: CostCentreUpdateRequest,
    service: ReferenceDataServiceDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> CostCentreOut:
    try:
        row = service.update_cost_centre(
            actor=actor,
            centre_id=centre_id,
            name=body.name,
            department=body.department,
            reason=body.reason,
            correlation_id=correlation_id,
        )
    except ReferenceDataError as error:
        raise _refused(error) from error
    return _centre_out(row)


@router.post(
    "/cost-centres/{centre_id}/active",
    response_model=CostCentreOut,
    dependencies=[_REF],
)
def set_cost_centre_active(
    centre_id: uuid.UUID,
    body: ActiveRequest,
    service: ReferenceDataServiceDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> CostCentreOut:
    try:
        row = service.set_cost_centre_active(
            actor=actor,
            centre_id=centre_id,
            is_active=body.is_active,
            reason=body.reason,
            correlation_id=correlation_id,
        )
    except ReferenceDataError as error:
        raise _refused(error) from error
    return _centre_out(row)
