"""Vendor payment check-in endpoints, in two routers that must not be confused.

`router` is the ordinary one: signed in, permission-checked, and where the
review that actually moves an invoice happens.

`public_router` is the other kind, and it is the only unauthenticated,
state-changing surface in the platform. A supplier has no account here, arrives
holding a link from an email, and answers one question. Three rules apply to
everything under it and nothing under it may break them:

*It authorises nothing.* The only write it permits is recording a claim, which
moves no record and releases no money. Paid and Outstanding live on the
authenticated router behind `payment:mark_paid`. See ADR 9.

*It says as little as possible.* A refused token gets one sentence that does not
say whether the token existed. The payload for a valid token names the
supplier's own invoice numbers and the amounts — what they need to answer — and
nothing about our workflow, our references for other suppliers, or who works
here.

*It records every refusal.* This is the one door an unauthenticated stranger can
knock on, so a run of misses is the only signal that somebody is working through
the token space, and a miss that goes unrecorded is a probe nobody can see.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.sql.elements import ColumnElement

from finora.api.deps import (
    CorrelationDep,
    CurrentUserDep,
    RequirePermission,
    SessionDep,
    VendorCheckInServiceDep,
)
from finora.api.routers.payment_packages import MoneyOut
from finora.application.signed_links import VENDOR_REFUSAL_MESSAGE, LinkRefusal
from finora.application.vendor_check_ins import (
    NoAddressError,
    NotAskableError,
    VendorCheckInError,
    VendorCheckInService,
    WrongStandingError,
)
from finora.domain.money import Money
from finora.domain.reminders import ReminderPurpose
from finora.domain.roles import (
    AuthorizationError,
    Permission,
    SegregationOfDutiesError,
    permissions_for,
)
from finora.domain.vendor_confirmation import (
    CHANNEL_LABELS,
    CLAIM_DESCRIPTIONS,
    CLAIM_LABELS,
    MAX_NOTE_LENGTH,
    MAX_RESPONDENT_LENGTH,
    REVIEW_LABELS,
    STANDING_DESCRIPTIONS,
    STANDING_LABELS,
    CheckInStanding,
    ClaimChannel,
    ClaimOutcome,
    ReviewOutcome,
)
from finora.domain.workflow import STATE_LABELS, TransitionError, WorkflowState
from finora.infrastructure.db.models import PaymentPackage, VendorCheckIn

router = APIRouter(prefix="/vendor-check-ins", tags=["vendor confirmation"])

#: Deliberately not under `/vendor-check-ins`. A path of its own is what lets the
#: unauthenticated surface be recognised at a glance in the router, in a reverse
#: proxy rule and in an access log.
public_router = APIRouter(prefix="/payment-check-in", tags=["vendor confirmation"])

_REVIEW = Depends(RequirePermission(Permission.vendor_confirmation_review))


# ------------------------------------------------------------------------- models


class CheckInLineOut(BaseModel):
    invoice_reference: str
    invoice_number: str | None
    amount: MoneyOut
    due_date: date | None
    invoice_state: WorkflowState
    invoice_state_label: str


class SuggestionOut(BaseModel):
    """What the evidence looks like, and why. Never applied by anything.

    Carried as `outcome` plus `because` rather than as a pre-selected value on
    the form, so a reviewer has to choose. A radio button arriving already
    filled in is a decision the platform made and attributed to a person.
    """

    outcome: ReviewOutcome | None
    outcome_label: str | None
    because: str


class CheckInSummary(BaseModel):
    id: uuid.UUID
    reference: str
    package_reference: str
    vendor_name: str
    vendor_email: str | None
    standing: CheckInStanding
    standing_label: str
    invoice_count: int
    totals: list[MoneyOut]
    sent_at: datetime | None
    answered_at: datetime | None
    claim: ClaimOutcome | None
    claim_label: str | None
    reviewed_at: datetime | None
    review_outcome: ReviewOutcome | None
    review_outcome_label: str | None


class CheckInPage(BaseModel):
    rows: list[CheckInSummary]
    total: int
    page: int
    page_size: int


class CheckInDetailOut(BaseModel):
    id: uuid.UUID
    reference: str
    version: int

    package_id: uuid.UUID
    package_reference: str
    package_submitted_at: datetime | None
    submission_reference: str | None

    vendor_name: str
    vendor_email: str | None

    standing: CheckInStanding
    standing_label: str
    standing_description: str

    lines: list[CheckInLineOut]
    totals: list[MoneyOut]

    sent_at: datetime | None

    answered_at: datetime | None
    claim: ClaimOutcome | None
    claim_label: str | None
    claim_description: str | None
    claim_channel: ClaimChannel | None
    claim_channel_label: str | None
    respondent_name: str | None
    respondent_note: str | None

    reviewed_at: datetime | None
    reviewed_by_label: str | None
    review_outcome: ReviewOutcome | None
    review_outcome_label: str | None
    review_note: str | None

    suggestion: SuggestionOut

    #: The one condition under which a screen may render this in green. Not
    #: "the supplier said yes" and not "the suggestion says paid": every invoice
    #: concerned is actually in `paid`, which only a review brings about.
    confirmed_paid: bool

    can_send: bool
    can_record_answer: bool
    can_review: bool


class RaiseRequest(BaseModel):
    package_id: uuid.UUID


class RaiseResponse(BaseModel):
    raised: list[CheckInSummary]
    #: Suppliers in the package who already had a check-in. Named rather than
    #: silently skipped, because "nothing happened" and "nothing needed to
    #: happen" look identical otherwise.
    already_raised: list[str]


class RecordAnswerRequest(BaseModel):
    """A member of staff writing down what a supplier told them another way."""

    claim: ClaimOutcome
    respondent_name: str = Field(min_length=1, max_length=MAX_RESPONDENT_LENGTH)
    note: str = Field(default="", max_length=MAX_NOTE_LENGTH)


class CheckInReviewRequest(BaseModel):
    """Named for the thing it reviews.

    A plain `ReviewRequest` collides with the document reader's, and the schema
    generator resolves a collision by qualifying both with their module paths —
    which quietly renames a type the web app already imports. Distinct names
    here keep the generated contract readable.
    """

    outcome: ReviewOutcome
    note: str = Field(default="", max_length=MAX_NOTE_LENGTH)


# --------------------------------------------------------------- public models


class VendorLineOut(BaseModel):
    invoice_number: str | None
    our_reference: str
    amount: MoneyOut
    due_date: date | None


class VendorQuestionOut(BaseModel):
    """What a supplier sees. Everything here is theirs already.

    No internal reference, no workflow state, no name of anybody here, and
    nothing about any other supplier. A page reachable without signing in should
    disclose only what the person holding the link was already sent.
    """

    reference: str
    #: Ours, and shown only so they can quote it back in a phone call.
    vendor_name: str
    paid_on: datetime | None
    lines: list[VendorLineOut]
    totals: list[MoneyOut]
    #: True once an answer is on file, so the page can say "we have this
    #: already" rather than silently accepting a second one.
    already_answered: bool
    answered_at: datetime | None


class VendorAnswerRequest(BaseModel):
    claim: ClaimOutcome
    respondent_name: str = Field(min_length=1, max_length=MAX_RESPONDENT_LENGTH)
    note: str = Field(default="", max_length=MAX_NOTE_LENGTH)


class VendorAnswerResponse(BaseModel):
    recorded: bool
    #: Said back to the supplier in plain words, because what happens next is not
    #: obvious and a page that just says "thank you" implies the matter is
    #: closed.
    message: str


ANSWER_RECORDED = (
    "Thank you — we have recorded your answer. Somebody in our accounts team "
    "will check it against our records. If anything does not add up we will be "
    "in touch."
)


# -------------------------------------------------------------------- conversions


def _money_out(amount: Money) -> MoneyOut:
    return MoneyOut(
        currency=amount.currency,
        minor_units=amount.minor_units,
        formatted=amount.format(),
    )


def _totals_out(totals: dict[str, Money]) -> list[MoneyOut]:
    """One figure per currency, in a stable order and never summed."""
    return [_money_out(totals[code]) for code in sorted(totals)]


def _summary(check_in: VendorCheckIn, *, service: VendorCheckInService) -> CheckInSummary:
    details = service.details(check_in)
    return CheckInSummary(
        id=check_in.id,
        reference=check_in.reference,
        package_reference=check_in.package.reference,
        vendor_name=check_in.vendor_name,
        vendor_email=check_in.vendor_email,
        standing=details.standing,
        standing_label=STANDING_LABELS[details.standing],
        invoice_count=len(details.lines),
        totals=_totals_out(details.totals),
        sent_at=check_in.sent_at,
        answered_at=check_in.answered_at,
        claim=check_in.claim,
        claim_label=CLAIM_LABELS[check_in.claim] if check_in.claim else None,
        reviewed_at=check_in.reviewed_at,
        review_outcome=check_in.review_outcome,
        review_outcome_label=(
            REVIEW_LABELS[check_in.review_outcome] if check_in.review_outcome else None
        ),
    )


def _detail(
    check_in: VendorCheckIn,
    *,
    service: VendorCheckInService,
    permissions: frozenset[Permission],
) -> CheckInDetailOut:
    details = service.details(check_in)
    current = details.standing
    may_review_now = Permission.payment_mark_paid in permissions
    may_ask = Permission.vendor_confirmation_review in permissions

    return CheckInDetailOut(
        id=check_in.id,
        reference=check_in.reference,
        version=check_in.version,
        package_id=check_in.package_id,
        package_reference=check_in.package.reference,
        package_submitted_at=check_in.package.submitted_at,
        submission_reference=check_in.package.submission_reference,
        vendor_name=check_in.vendor_name,
        vendor_email=check_in.vendor_email,
        standing=current,
        standing_label=STANDING_LABELS[current],
        standing_description=STANDING_DESCRIPTIONS[current],
        lines=[
            CheckInLineOut(
                invoice_reference=item.reference,
                invoice_number=item.invoice_number,
                amount=_money_out(item.total),
                due_date=item.due_date,
                invoice_state=item.state,
                invoice_state_label=STATE_LABELS[item.state],
            )
            for item in details.lines
        ],
        totals=_totals_out(details.totals),
        sent_at=check_in.sent_at,
        answered_at=check_in.answered_at,
        claim=check_in.claim,
        claim_label=CLAIM_LABELS[check_in.claim] if check_in.claim else None,
        claim_description=CLAIM_DESCRIPTIONS[check_in.claim] if check_in.claim else None,
        claim_channel=check_in.claim_channel,
        claim_channel_label=(
            CHANNEL_LABELS[check_in.claim_channel] if check_in.claim_channel else None
        ),
        respondent_name=check_in.respondent_name,
        respondent_note=check_in.respondent_note,
        reviewed_at=check_in.reviewed_at,
        reviewed_by_label=(
            check_in.reviewed_by.display_name if check_in.reviewed_by is not None else None
        ),
        review_outcome=check_in.review_outcome,
        review_outcome_label=(
            REVIEW_LABELS[check_in.review_outcome] if check_in.review_outcome else None
        ),
        review_note=check_in.review_note,
        suggestion=SuggestionOut(
            outcome=details.suggestion.outcome,
            outcome_label=(
                REVIEW_LABELS[details.suggestion.outcome] if details.suggestion.outcome else None
            ),
            because=details.suggestion.because,
        ),
        confirmed_paid=details.confirmed_paid,
        can_send=may_ask and current is CheckInStanding.not_sent and bool(check_in.vendor_email),
        can_record_answer=may_ask
        and current in {CheckInStanding.awaiting_vendor, CheckInStanding.vendor_answered},
        can_review=may_review_now
        and current in {CheckInStanding.awaiting_vendor, CheckInStanding.vendor_answered},
    )


def _load(session: SessionDep, check_in_id: uuid.UUID) -> VendorCheckIn:
    check_in = session.get(VendorCheckIn, check_in_id)
    if check_in is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such check-in.")
    return check_in


def _refused(error: VendorCheckInError) -> HTTPException:
    if isinstance(error, WrongStandingError | NotAskableError):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error))
    if isinstance(error, NoAddressError):
        return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error))
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error))


# ------------------------------------------------------------- authenticated routes


@router.get("", response_model=CheckInPage, dependencies=[_REVIEW])
def list_check_ins(
    session: SessionDep,
    service: VendorCheckInServiceDep,
    standing: Annotated[list[CheckInStanding] | None, Query()] = None,
    search: Annotated[str | None, Query(max_length=200)] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 25,
) -> CheckInPage:
    """The review queue.

    Ordered so the ones needing a person come first: answered and unreviewed at
    the top, then those still waiting, oldest first within each. A queue sorted
    by creation date buries the work under the things that have not happened
    yet.
    """
    conditions: list[ColumnElement[bool]] = []
    if standing:
        wanted = set(standing)
        clauses: list[ColumnElement[bool]] = []
        if CheckInStanding.not_sent in wanted:
            clauses.append(VendorCheckIn.sent_at.is_(None))
        if CheckInStanding.awaiting_vendor in wanted:
            clauses.append(
                VendorCheckIn.sent_at.is_not(None)
                & VendorCheckIn.answered_at.is_(None)
                & VendorCheckIn.reviewed_at.is_(None)
            )
        if CheckInStanding.vendor_answered in wanted:
            clauses.append(
                VendorCheckIn.answered_at.is_not(None) & VendorCheckIn.reviewed_at.is_(None)
            )
        if CheckInStanding.reviewed in wanted:
            clauses.append(VendorCheckIn.reviewed_at.is_not(None))
        conditions.append(or_(*clauses))
    if search:
        pattern = f"%{search.strip()}%"
        conditions.append(
            or_(
                VendorCheckIn.reference.ilike(pattern),
                VendorCheckIn.vendor_name.ilike(pattern),
            )
        )

    total = session.execute(
        select(func.count()).select_from(VendorCheckIn).where(*conditions)
    ).scalar_one()
    rows = (
        session.execute(
            select(VendorCheckIn)
            .where(*conditions)
            .order_by(
                VendorCheckIn.reviewed_at.is_not(None),
                VendorCheckIn.answered_at.is_(None),
                VendorCheckIn.sent_at.asc().nullsfirst(),
            )
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        .scalars()
        .all()
    )

    return CheckInPage(
        rows=[_summary(row, service=service) for row in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post(
    "",
    response_model=RaiseResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[_REVIEW],
)
def raise_check_ins(
    body: RaiseRequest,
    session: SessionDep,
    service: VendorCheckInServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> RaiseResponse:
    """Open one question per supplier in a submitted package."""
    package = session.get(PaymentPackage, body.package_id)
    if package is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="No such payment package."
        )

    try:
        outcome = service.raise_for_package(package, actor=user, correlation_id=correlation_id)
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except VendorCheckInError as error:
        raise _refused(error) from error

    session.commit()
    return RaiseResponse(
        raised=[_summary(row, service=service) for row in outcome.raised],
        already_raised=list(outcome.already_raised),
    )


@router.get("/{check_in_id}", response_model=CheckInDetailOut, dependencies=[_REVIEW])
def read_check_in(
    check_in_id: uuid.UUID,
    session: SessionDep,
    service: VendorCheckInServiceDep,
    user: CurrentUserDep,
) -> CheckInDetailOut:
    check_in = _load(session, check_in_id)
    return _detail(check_in, service=service, permissions=permissions_for(user.roles))


@router.post("/{check_in_id}/send", response_model=CheckInDetailOut, dependencies=[_REVIEW])
def send_check_in(
    check_in_id: uuid.UUID,
    session: SessionDep,
    service: VendorCheckInServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> CheckInDetailOut:
    """Email the supplier the question and a link to answer it."""
    check_in = _load(session, check_in_id)
    try:
        service.send(check_in, actor=user, correlation_id=correlation_id)
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except VendorCheckInError as error:
        raise _refused(error) from error

    session.commit()
    session.refresh(check_in)
    return _detail(check_in, service=service, permissions=permissions_for(user.roles))


@router.post("/{check_in_id}/answer", response_model=CheckInDetailOut, dependencies=[_REVIEW])
def record_answer(
    check_in_id: uuid.UUID,
    body: RecordAnswerRequest,
    session: SessionDep,
    service: VendorCheckInServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> CheckInDetailOut:
    """Write down what a supplier said by phone, or in a mail nobody could parse.

    Recorded as a claim like any other, with the channel saying a member of
    staff typed it. It is not a review and it moves nothing: the person who
    takes the call is very often not the person allowed to conclude.
    """
    check_in = _load(session, check_in_id)
    try:
        service.record_claim(
            check_in,
            claim=body.claim,
            channel=ClaimChannel.recorded_by_staff,
            respondent_name=body.respondent_name,
            note=body.note,
            actor=user,
            correlation_id=correlation_id,
        )
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except VendorCheckInError as error:
        raise _refused(error) from error

    session.commit()
    session.refresh(check_in)
    return _detail(check_in, service=service, permissions=permissions_for(user.roles))


@router.post("/{check_in_id}/review", response_model=CheckInDetailOut)
def review_check_in(
    check_in_id: uuid.UUID,
    body: CheckInReviewRequest,
    session: SessionDep,
    service: VendorCheckInServiceDep,
    user: CurrentUserDep,
    correlation_id: CorrelationDep,
) -> CheckInDetailOut:
    """Conclude, and move the invoices.

    The only route in the platform to `paid`. Guarded by `payment:mark_paid`
    inside the service rather than by a dependency here, so the permission is
    enforced in one place whether the call arrives from this endpoint or from
    anywhere else.
    """
    check_in = _load(session, check_in_id)
    try:
        service.review(
            check_in,
            outcome=body.outcome,
            note=body.note,
            actor=user,
            correlation_id=correlation_id,
        )
    except SegregationOfDutiesError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except AuthorizationError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except TransitionError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except VendorCheckInError as error:
        raise _refused(error) from error

    session.commit()
    session.refresh(check_in)
    return _detail(check_in, service=service, permissions=permissions_for(user.roles))


# -------------------------------------------------------------------- public routes


def _resolve_or_refuse(
    token: str,
    *,
    session: SessionDep,
    service: VendorCheckInService,
    correlation_id: uuid.UUID,
    spend: bool,
) -> VendorCheckIn:
    """Turn a supplier's token into their check-in, or refuse identically.

    Every refusal — unknown, expired, spent, revoked, issued to a colleague
    rather than a supplier — is one 404 and one sentence. Distinguishing them
    would tell a holder which tokens are real, and this is the door with no
    session behind it.

    The refusal is committed. An audit entry that rolls itself back is a probe
    nobody can see, and a run of these is the only evidence that somebody is
    working through the token space.
    """
    outcome = service.resolve_vendor_link(token, correlation_id=correlation_id, spend=spend)
    session.commit()

    if isinstance(outcome, LinkRefusal):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=VENDOR_REFUSAL_MESSAGE)
    return outcome


@public_router.get("/{token}", response_model=VendorQuestionOut)
def vendor_question(
    token: str,
    session: SessionDep,
    service: VendorCheckInServiceDep,
    correlation_id: CorrelationDep,
) -> VendorQuestionOut:
    """What the supplier is being asked. No session, and no token spent.

    Opening the page does not consume the link. A supplier reads it, goes to
    check their bank, and comes back; burning the token on the first view would
    teach them our links do not work. It is spent when they answer.
    """
    check_in = _resolve_or_refuse(
        token,
        session=session,
        service=service,
        correlation_id=correlation_id,
        spend=False,
    )
    details = service.details(check_in)

    return VendorQuestionOut(
        reference=check_in.reference,
        vendor_name=check_in.vendor_name,
        paid_on=check_in.package.submitted_at,
        lines=[
            VendorLineOut(
                invoice_number=item.invoice_number,
                our_reference=item.reference,
                amount=_money_out(item.total),
                due_date=item.due_date,
            )
            for item in details.lines
        ],
        totals=_totals_out(details.totals),
        already_answered=check_in.answered_at is not None,
        answered_at=check_in.answered_at,
    )


@public_router.post("/{token}", response_model=VendorAnswerResponse)
def vendor_answer(
    token: str,
    body: VendorAnswerRequest,
    session: SessionDep,
    service: VendorCheckInServiceDep,
    correlation_id: CorrelationDep,
) -> VendorAnswerResponse:
    """Record what the supplier says. Moves nothing, releases nothing.

    The token is spent here rather than on the page view, so a supplier gets one
    answer per link — a correction goes through the same channel their original
    answer did, by writing to us, and reaches a person.
    """
    check_in = _resolve_or_refuse(
        token,
        session=session,
        service=service,
        correlation_id=correlation_id,
        spend=True,
    )

    try:
        service.record_claim(
            check_in,
            claim=body.claim,
            channel=ClaimChannel.signed_link,
            respondent_name=body.respondent_name,
            note=body.note,
            actor=None,
            correlation_id=correlation_id,
        )
    except VendorCheckInError as error:
        # The token has already been spent by the resolution above and stays
        # spent. A refusal here means somebody here reviewed the check-in
        # between the page loading and the answer arriving, which is a real
        # race and not the supplier's fault — so it is committed and reported
        # plainly rather than left looking like a broken link.
        session.commit()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    session.commit()
    return VendorAnswerResponse(recorded=True, message=ANSWER_RECORDED)


#: Named so the router module can be read without chasing the enum. Both public
#: routes serve exactly one purpose and nothing else may be reached with a
#: supplier's token.
PUBLIC_PURPOSE = ReminderPurpose.payment_check_in
