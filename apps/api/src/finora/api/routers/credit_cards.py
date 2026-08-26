"""Credit-card statement endpoints.

A period has a standing rather than a workflow state. Coding and closing are
separate permissions, and a suggestion endpoint never closes anything.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Annotated, Any, cast

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, Field

from finora.api.deps import (
    CorrelationDep,
    CreditCardServiceDep,
    CurrentUserDep,
    RequirePermission,
    SessionDep,
)
from finora.application.credit_cards import (
    ConflictError,
    CreditCardError,
    CreditCardService,
    NotFoundError,
    ValidationError,
)
from finora.domain.credit_cards import (
    CODING_STANDING_LABELS,
    PERIOD_STANDING_DESCRIPTIONS,
    PERIOD_STANDING_LABELS,
    RECEIPT_STATUS_LABELS,
    CodingStanding,
    PeriodStanding,
    ReceiptStatus,
    SuggestionDisposition,
    coding_standing,
    period_standing,
    receipt_status,
)
from finora.domain.money import Money
from finora.domain.roles import Permission, SegregationOfDutiesError
from finora.infrastructure.db.models import (
    CreditCardAccount,
    CreditCardPeriod,
    CreditCardTransaction,
)

router = APIRouter(prefix="/credit-cards", tags=["credit-cards"])


class CreditCardSummary(BaseModel):
    id: uuid.UUID
    label: str
    last_four: str
    cardholder_name: str
    currency: str
    is_active: bool


class CreditCardCreate(BaseModel):
    label: str = Field(min_length=1, max_length=200)
    last_four: str = Field(min_length=4, max_length=4)
    cardholder_name: str = Field(min_length=1, max_length=120)
    currency: str = Field(default="JMD", min_length=3, max_length=3)


class CreditCardMoneyOut(BaseModel):
    minor_units: int
    currency: str
    formatted: str


class CreditCardPeriodSummary(BaseModel):
    id: uuid.UUID
    reference: str
    card: CreditCardSummary
    period_start: date
    period_end: date
    statement_date: date
    currency: str
    standing: PeriodStanding
    standing_label: str
    standing_description: str
    transaction_count: int
    uncoded_count: int
    missing_receipt_count: int
    closed_at: datetime | None
    source_filename: str


class CreditCardReferenceRef(BaseModel):
    id: uuid.UUID
    code: str
    name: str


class CreditCardTransactionOut(BaseModel):
    id: uuid.UUID
    source_row: int
    posted_on: date
    merchant: str
    cardholder: str
    description: str | None
    external_reference: str | None
    amount: CreditCardMoneyOut
    category: str | None
    coding_standing: CodingStanding
    coding_label: str
    gl_account: CreditCardReferenceRef | None
    cost_centre: CreditCardReferenceRef | None
    exception_reason: str | None
    receipt_status: ReceiptStatus
    receipt_label: str
    receipt_document_id: uuid.UUID | None
    receipt_waived: bool
    receipt_waiver_reason: str | None
    receipt_match_confidence: float | None
    suggestion_disposition: SuggestionDisposition | None
    suggested_gl_account_id: uuid.UUID | None
    suggested_cost_centre_id: uuid.UUID | None
    suggestion_evidence: dict[str, Any] | None
    version: int


class CreditCardPeriodDetail(CreditCardPeriodSummary):
    transactions: list[CreditCardTransactionOut]
    close_reason: str | None
    actions: dict[str, bool]


class CreditCardCodeBody(BaseModel):
    gl_account_id: uuid.UUID | None = None
    cost_centre_id: uuid.UUID | None = None
    category: str | None = Field(default=None, max_length=120)
    exception_reason: str | None = Field(default=None, max_length=2000)
    expected_version: int | None = None


class CreditCardReceiptBody(BaseModel):
    document_id: uuid.UUID | None = None
    waived: bool = False
    waiver_reason: str | None = Field(default=None, max_length=2000)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)


class CreditCardSuggestionBody(BaseModel):
    gl_account_id: uuid.UUID | None = None
    cost_centre_id: uuid.UUID | None = None
    receipt_document_id: uuid.UUID | None = None
    evidence: dict[str, Any] = Field(default_factory=dict)


class CreditCardDisposeBody(BaseModel):
    disposition: SuggestionDisposition


class CreditCardCloseBody(BaseModel):
    reason: str = Field(min_length=3, max_length=2000)


class CreditCardProblemOut(BaseModel):
    code: str
    field: str
    message: str


def _money(amount: Money) -> CreditCardMoneyOut:
    return CreditCardMoneyOut(
        minor_units=amount.minor_units,
        currency=amount.currency,
        formatted=amount.format(),
    )


def _card(card: CreditCardAccount) -> CreditCardSummary:
    return CreditCardSummary(
        id=card.id,
        label=card.label,
        last_four=card.last_four,
        cardholder_name=card.cardholder_name,
        currency=card.currency,
        is_active=card.is_active,
    )


def _ref(row: Any | None) -> CreditCardReferenceRef | None:
    if row is None:
        return None
    return CreditCardReferenceRef(id=row.id, code=row.code, name=row.name)


def _transaction(row: CreditCardTransaction) -> CreditCardTransactionOut:
    standing = coding_standing(
        gl_account_id=row.gl_account_id,
        cost_centre_id=row.cost_centre_id,
        exception_reason=row.exception_reason,
    )
    status_value = receipt_status(document_id=row.receipt_document_id, waived=row.receipt_waived)
    return CreditCardTransactionOut(
        id=row.id,
        source_row=row.source_row,
        posted_on=row.posted_on,
        merchant=row.merchant,
        cardholder=row.cardholder,
        description=row.description,
        external_reference=row.external_reference,
        amount=_money(Money(row.amount_minor_units, row.currency)),
        category=row.category,
        coding_standing=standing,
        coding_label=CODING_STANDING_LABELS[standing],
        gl_account=_ref(row.gl_account),
        cost_centre=_ref(row.cost_centre),
        exception_reason=row.exception_reason,
        receipt_status=status_value,
        receipt_label=RECEIPT_STATUS_LABELS[status_value],
        receipt_document_id=row.receipt_document_id,
        receipt_waived=row.receipt_waived,
        receipt_waiver_reason=row.receipt_waiver_reason,
        receipt_match_confidence=row.receipt_match_confidence,
        suggestion_disposition=row.suggestion_disposition,
        suggested_gl_account_id=row.suggested_gl_account_id,
        suggested_cost_centre_id=row.suggested_cost_centre_id,
        suggestion_evidence=row.suggestion_evidence,
        version=row.version,
    )


def _as_int(value: object) -> int:
    return int(cast(int, value))


def _period_summary(
    period: CreditCardPeriod, *, service: CreditCardService
) -> CreditCardPeriodSummary:
    standing = period_standing(closed_at=period.closed_at)
    summary = service.period_summary(period)
    return CreditCardPeriodSummary(
        id=period.id,
        reference=period.reference,
        card=_card(period.card),
        period_start=period.period_start,
        period_end=period.period_end,
        statement_date=period.statement_date,
        currency=period.currency,
        standing=standing,
        standing_label=PERIOD_STANDING_LABELS[standing],
        standing_description=PERIOD_STANDING_DESCRIPTIONS[standing],
        transaction_count=_as_int(summary["transaction_count"]),
        uncoded_count=_as_int(summary["uncoded_count"]),
        missing_receipt_count=_as_int(summary["missing_receipt_count"]),
        closed_at=period.closed_at,
        source_filename=period.source_filename,
    )


def _period_detail(
    period: CreditCardPeriod,
    *,
    service: CreditCardService,
    user: Any,
) -> CreditCardPeriodDetail:
    from finora.domain.roles import has_permission

    summary = _period_summary(period, service=service)
    taken = service.actions_taken(period, user=user)
    may_code = has_permission(user.roles, Permission.credit_card_code)
    may_close = has_permission(user.roles, Permission.credit_card_close_period)
    if Permission.credit_card_close_period in taken:
        may_code = False
    if Permission.credit_card_code in taken:
        may_close = False
    open_period = period.closed_at is None
    return CreditCardPeriodDetail(
        **summary.model_dump(),
        transactions=[_transaction(row) for row in period.transactions],
        close_reason=period.close_reason,
        actions={
            "code": may_code and open_period,
            "close": may_close and open_period and summary.uncoded_count == 0,
            "import_again": False,
        },
    )


def _refused(error: CreditCardError) -> HTTPException:
    if isinstance(error, NotFoundError):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error))
    if isinstance(error, ConflictError):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=error.message)
    if isinstance(error, ValidationError):
        first = error.problems[0] if error.problems else None
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "message": first.message if first else str(error),
                "code": str(first.code) if first else "unprocessable",
                "problems": [
                    {"code": str(item.code), "field": item.field, "message": item.message}
                    for item in error.problems
                ],
            },
        )
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error))


@router.get("/cards", response_model=list[CreditCardSummary])
def list_cards(
    service: CreditCardServiceDep,
    _: Annotated[None, Depends(RequirePermission(Permission.credit_card_view))],
) -> list[CreditCardSummary]:
    return [_card(card) for card in service.list_cards()]


@router.post("/cards", response_model=CreditCardSummary, status_code=status.HTTP_201_CREATED)
def create_card(
    body: CreditCardCreate,
    service: CreditCardServiceDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
    _: Annotated[None, Depends(RequirePermission(Permission.credit_card_code))],
) -> CreditCardSummary:
    try:
        card = service.create_card(
            label=body.label,
            last_four=body.last_four,
            cardholder_name=body.cardholder_name,
            currency=body.currency,
            actor=actor,
            correlation_id=correlation_id,
        )
    except CreditCardError as error:
        raise _refused(error) from error
    return _card(card)


@router.get("/periods", response_model=list[CreditCardPeriodSummary])
def list_periods(
    service: CreditCardServiceDep,
    _: Annotated[None, Depends(RequirePermission(Permission.credit_card_view))],
    card_id: uuid.UUID | None = None,
    standing: PeriodStanding | None = None,
) -> list[CreditCardPeriodSummary]:
    periods = service.list_periods(card_id=card_id, standing=standing)
    return [_period_summary(period, service=service) for period in periods]


@router.get("/periods/{period_id}", response_model=CreditCardPeriodDetail)
def get_period(
    period_id: uuid.UUID,
    service: CreditCardServiceDep,
    actor: CurrentUserDep,
    _: Annotated[None, Depends(RequirePermission(Permission.credit_card_view))],
) -> CreditCardPeriodDetail:
    try:
        period = service.get_period(period_id)
    except CreditCardError as error:
        raise _refused(error) from error
    return _period_detail(period, service=service, user=actor)


@router.post(
    "/cards/{card_id}/statements",
    response_model=CreditCardPeriodDetail,
    status_code=status.HTTP_201_CREATED,
)
async def import_statement(
    card_id: uuid.UUID,
    service: CreditCardServiceDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
    _: Annotated[None, Depends(RequirePermission(Permission.credit_card_code))],
    file: UploadFile = File(...),
    period_start: date = Form(...),
    period_end: date = Form(...),
    statement_date: date = Form(...),
) -> CreditCardPeriodDetail:
    try:
        card = service.get_card(card_id)
        raw = await file.read()
        text = raw.decode("utf-8-sig")
        result = service.import_statement(
            card,
            csv_text=text,
            filename=file.filename or "statement.csv",
            period_start=period_start,
            period_end=period_end,
            statement_date=statement_date,
            actor=actor,
            correlation_id=correlation_id,
        )
    except UnicodeDecodeError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="The statement file must be UTF-8 text.",
        ) from error
    except CreditCardError as error:
        raise _refused(error) from error
    return _period_detail(result.period, service=service, user=actor)


@router.post("/transactions/{transaction_id}/code", response_model=CreditCardTransactionOut)
def code_transaction(
    transaction_id: uuid.UUID,
    body: CreditCardCodeBody,
    service: CreditCardServiceDep,
    session: SessionDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
    _: Annotated[None, Depends(RequirePermission(Permission.credit_card_code))],
) -> CreditCardTransactionOut:
    transaction = session.get(CreditCardTransaction, transaction_id)
    if transaction is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found.")
    try:
        updated = service.code_transaction(
            transaction,
            gl_account_id=body.gl_account_id,
            cost_centre_id=body.cost_centre_id,
            category=body.category,
            exception_reason=body.exception_reason,
            actor=actor,
            correlation_id=correlation_id,
            expected_version=body.expected_version,
        )
    except SegregationOfDutiesError as error:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(error),
        ) from error
    except CreditCardError as error:
        raise _refused(error) from error
    session.refresh(updated, attribute_names=["gl_account", "cost_centre"])
    return _transaction(updated)


@router.post("/transactions/{transaction_id}/receipt", response_model=CreditCardTransactionOut)
def match_receipt(
    transaction_id: uuid.UUID,
    body: CreditCardReceiptBody,
    service: CreditCardServiceDep,
    session: SessionDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
    _: Annotated[None, Depends(RequirePermission(Permission.credit_card_code))],
) -> CreditCardTransactionOut:
    transaction = session.get(CreditCardTransaction, transaction_id)
    if transaction is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found.")
    try:
        updated = service.match_receipt(
            transaction,
            document_id=body.document_id,
            waived=body.waived,
            waiver_reason=body.waiver_reason,
            confidence=body.confidence,
            actor=actor,
            correlation_id=correlation_id,
        )
    except SegregationOfDutiesError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except CreditCardError as error:
        raise _refused(error) from error
    return _transaction(updated)


@router.post("/transactions/{transaction_id}/suggestion", response_model=CreditCardTransactionOut)
def record_suggestion(
    transaction_id: uuid.UUID,
    body: CreditCardSuggestionBody,
    service: CreditCardServiceDep,
    session: SessionDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
    _: Annotated[None, Depends(RequirePermission(Permission.credit_card_code))],
) -> CreditCardTransactionOut:
    transaction = session.get(CreditCardTransaction, transaction_id)
    if transaction is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found.")
    try:
        updated = service.record_suggestion(
            transaction,
            gl_account_id=body.gl_account_id,
            cost_centre_id=body.cost_centre_id,
            receipt_document_id=body.receipt_document_id,
            evidence=body.evidence,
            actor=actor,
            correlation_id=correlation_id,
        )
    except CreditCardError as error:
        raise _refused(error) from error
    return _transaction(updated)


@router.post(
    "/transactions/{transaction_id}/suggestion/dispose",
    response_model=CreditCardTransactionOut,
)
def dispose_suggestion(
    transaction_id: uuid.UUID,
    body: CreditCardDisposeBody,
    service: CreditCardServiceDep,
    session: SessionDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
    _: Annotated[None, Depends(RequirePermission(Permission.credit_card_code))],
) -> CreditCardTransactionOut:
    transaction = session.get(CreditCardTransaction, transaction_id)
    if transaction is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found.")
    try:
        updated = service.dispose_suggestion(
            transaction,
            disposition=body.disposition,
            actor=actor,
            correlation_id=correlation_id,
        )
    except SegregationOfDutiesError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except CreditCardError as error:
        raise _refused(error) from error
    session.refresh(updated, attribute_names=["gl_account", "cost_centre"])
    return _transaction(updated)


@router.post("/periods/{period_id}/close", response_model=CreditCardPeriodDetail)
def close_period(
    period_id: uuid.UUID,
    body: CreditCardCloseBody,
    service: CreditCardServiceDep,
    actor: CurrentUserDep,
    correlation_id: CorrelationDep,
    _: Annotated[None, Depends(RequirePermission(Permission.credit_card_close_period))],
) -> CreditCardPeriodDetail:
    try:
        period = service.get_period(period_id)
        closed = service.close_period(
            period,
            reason=body.reason,
            actor=actor,
            correlation_id=correlation_id,
        )
    except SegregationOfDutiesError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except CreditCardError as error:
        raise _refused(error) from error
    return _period_detail(closed, service=service, user=actor)
