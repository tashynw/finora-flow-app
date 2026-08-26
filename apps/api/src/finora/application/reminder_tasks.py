"""The composition root for chasing and for sending.

Two entry points a worker loop calls on a timer: `sweep_reminders` decides who
needs chasing and writes the messages, and `drain_outbox` sends what is written.
They are separate because they fail differently. A mail server that is down must
not stop the platform working out that an invoice is overdue, and a bug in the
chasing logic must not stop already-composed messages going out.

Neither raises. Both are called from a loop where an exception has nowhere useful
to go, and each individual failure is already recorded against the record it
concerns.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from uuid import UUID, uuid4

import structlog
from sqlalchemy import select
from sqlalchemy.orm import Session

from finora.application.approvals import ApprovalService
from finora.application.invoices import RECORD_TYPE as INVOICE_RECORD_TYPE
from finora.application.invoices import InvoiceService
from finora.application.outbox import DrainResult, OutboxDrain
from finora.application.reminders import (
    Recipients,
    ReminderService,
    SweepResult,
    load_business_hours,
)
from finora.application.signed_links import SignedLinkService
from finora.config import Settings, WorkflowSettings, get_settings
from finora.domain.invoices import PurchaseOrderPolicy, TolerancePolicy
from finora.domain.money import CurrencyError, Money
from finora.domain.reminders import ReminderPolicy, ReminderPurpose, Suppression
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import Invoice, PurchaseOrderThreshold, ReminderSchedule
from finora.infrastructure.db.session import session_scope
from finora.infrastructure.mailer import SmtpMailer

logger = structlog.get_logger(__name__)


class _Outcome(StrEnum):
    """What happened to one schedule during a sweep."""

    sent = "sent"
    suppressed = "suppressed"
    stopped = "stopped"


@dataclass(frozen=True, slots=True)
class Services:
    """The invoice and reminder services, wired against one session.

    Returned together because chasing needs both and they must share a session:
    the reminder cursor and the queued message are one transaction, and two
    sessions would make that impossible to guarantee.
    """

    session: Session
    invoices: InvoiceService
    reminders: ReminderService
    links: SignedLinkService


def reminder_policy(workflow: WorkflowSettings) -> ReminderPolicy:
    return ReminderPolicy(
        interval_hours=workflow.reminder_interval_hours,
        max_reminders=workflow.reminder_max_count,
        escalate_every=workflow.reminder_escalate_every,
        max_escalation_level=workflow.reminder_max_escalation_level,
        send_outside_business_hours=not workflow.suppress_outside_business_hours,
    )


def build_services(session: Session, *, settings: Settings | None = None) -> Services:
    """Wire the invoice and reminder services against one session.

    Shared by the sweep, the API layer and the tests, so a threshold or a calendar
    configured in one place cannot be quietly different in another.
    """
    resolved = settings or get_settings()
    workflow = resolved.workflow
    audit = AuditRepository(session)

    hours = load_business_hours(
        session,
        timezone=workflow.display_timezone,
        start_hour=workflow.business_hours_start,
        end_hour=workflow.business_hours_end,
        days=workflow.business_days,
    )
    reminders = ReminderService(
        session=session,
        audit=audit,
        hours=hours,
        policy=reminder_policy(workflow),
    )
    links = SignedLinkService(
        session=session,
        audit=audit,
        web_base_url=resolved.web_base_url,
        ttl_hours=workflow.sign_off_link_ttl_hours,
    )
    invoices = InvoiceService(
        session=session,
        approvals=ApprovalService(session=session, audit=audit),
        audit=audit,
        links=links,
        reminders=reminders,
        purchase_orders=load_purchase_order_policy(session),
        tolerance=tolerance(workflow),
        mail_domain=mail_domain(resolved.smtp.from_address),
    )
    return Services(session=session, invoices=invoices, reminders=reminders, links=links)


def sweep_reminders(
    *,
    correlation_id: UUID | None = None,
    limit: int = 50,
    now: datetime | None = None,
) -> SweepResult:
    """Chase everything that has come due.

    A backlog after an outage is worked off oldest first, which
    `ReminderService.due` arranges.

    `now` is the instant the sweep is reasoning about, and defaults to this one.
    Passed rather than read from the clock throughout, so every schedule in a batch
    is judged against the same moment: a sweep that read the clock per record could
    decide the office was open for the first invoice and shut for the last.
    """
    run = correlation_id or uuid4()
    tally: dict[_Outcome, int] = {outcome: 0 for outcome in _Outcome}
    considered = 0
    moment = now or datetime.now(UTC)

    try:
        with session_scope() as session:
            services = build_services(session)

            for schedule in services.reminders.due(now=moment, limit=limit):
                considered += 1
                tally[_chase(services, schedule, now=moment, correlation_id=run)] += 1
    except Exception:
        logger.exception("reminders.sweep_failed", correlation_id=str(run))
        return SweepResult(considered=0, sent=0, suppressed=0, stopped=0)

    result = SweepResult(
        considered=considered,
        sent=tally[_Outcome.sent],
        suppressed=tally[_Outcome.suppressed],
        stopped=tally[_Outcome.stopped],
    )
    if considered:
        logger.info(
            "reminders.swept",
            correlation_id=str(run),
            considered=result.considered,
            sent=result.sent,
            suppressed=result.suppressed,
            stopped=result.stopped,
        )
    return result


def _chase(
    services: Services,
    schedule: ReminderSchedule,
    *,
    now: datetime,
    correlation_id: UUID,
) -> _Outcome:
    """Handle one due schedule."""
    if schedule.purpose is not ReminderPurpose.sign_off:
        # Approval chasing arrives with the approval matrix work. Until then a
        # schedule of that kind is left alone rather than half-handled.
        return _Outcome.suppressed

    if schedule.record_type != INVOICE_RECORD_TYPE:
        logger.warning(
            "reminders.unknown_record_type",
            record_type=schedule.record_type,
            record_id=str(schedule.record_id),
        )
        return _Outcome.suppressed

    invoice = services.session.get(Invoice, schedule.record_id)
    if invoice is None:
        _stop(services, schedule, reason="The record being chased no longer exists.")
        return _Outcome.stopped

    still_waiting = services.invoices.is_still_awaiting_sign_off(invoice)
    decision = services.reminders.consider(schedule, now=now, still_waiting=still_waiting)

    if isinstance(decision, Suppression):
        if not still_waiting:
            # The record moved on without the cycle being told. `consider` already
            # refused to send; stopping the cycle is what keeps it from being
            # reconsidered on every future sweep.
            _stop(
                services,
                schedule,
                reason="The invoice is no longer waiting on receipt confirmation.",
            )
            return _Outcome.stopped
        return _Outcome.suppressed

    _queue(services, invoice, schedule, decision, correlation_id=correlation_id, now=now)
    return _Outcome.sent


def _stop(services: Services, schedule: ReminderSchedule, *, reason: str) -> None:
    services.reminders.stop(
        record_type=schedule.record_type,
        record_id=schedule.record_id,
        purpose=schedule.purpose,
        reason=reason,
    )


def _queue(
    services: Services,
    invoice: Invoice,
    schedule: ReminderSchedule,
    recipients: Recipients,
    *,
    correlation_id: UUID,
    now: datetime,
) -> None:
    """Write the reminder and advance the cursor, in one transaction.

    Both or neither. Advancing first risks skipping a reminder if composing fails;
    queueing without advancing risks sending the same one on every sweep.
    """
    number = schedule.sent_count + 1
    escalated = bool(recipients.cc)

    services.invoices.queue_sign_off_reminder(
        invoice,
        requester=recipients.to,
        cc_addresses=recipients.cc_addresses,
        reminder_number=number,
        escalated=escalated,
        correlation_id=correlation_id,
    )
    services.reminders.record_sent(
        schedule,
        recipients=recipients,
        escalated=escalated,
        now=now,
        correlation_id=correlation_id,
    )


def drain_outbox(*, batch_size: int = 20) -> DrainResult:
    """Send what is queued.

    The drain commits per message, so a batch that fails halfway leaves the
    messages it already sent recorded as sent rather than replaying them.
    """
    settings = get_settings()
    try:
        with session_scope() as session:
            drain = OutboxDrain(
                session=session,
                mailer=SmtpMailer(settings.smtp),
                audit=AuditRepository(session),
                max_attempts=settings.smtp.max_send_attempts,
            )
            return drain.run_once(batch_size=batch_size)
    except Exception:
        logger.exception("outbox.drain_failed")
        return DrainResult(attempted=0, sent=0, failed=0, abandoned=0)


def load_purchase_order_policy(session: Session) -> PurchaseOrderPolicy:
    """Read the thresholds above which an invoice must name a purchase order.

    Read per request rather than cached. It is a handful of rows on a table only
    an administrator writes to, and a control that keeps enforcing yesterday's
    figure until a process restarts is worse than the query.

    A row in a currency the platform cannot scale is skipped with a loud log. It
    cannot be compared against anything, and dropping it leaves that currency
    with no threshold — which, once any threshold exists, requires an order.
    Failing towards the control rather than around it.
    """
    rows = session.execute(
        select(PurchaseOrderThreshold).where(PurchaseOrderThreshold.is_active)
    ).scalars()

    thresholds: dict[str, Money] = {}
    for row in rows:
        try:
            thresholds[row.currency.upper()] = Money(row.applies_above_minor_units, row.currency)
        except CurrencyError:
            logger.error("workflow.po_threshold_currency_unknown", currency=row.currency)

    return PurchaseOrderPolicy(thresholds=thresholds)


def tolerance(workflow: WorkflowSettings) -> TolerancePolicy:
    return TolerancePolicy(
        percent=max(workflow.invoice_tolerance_percent, 0),
        minor_units=max(workflow.invoice_tolerance_minor_units, 0),
    )


def mail_domain(from_address: str) -> str:
    """The domain to build Message-IDs from.

    Taken from the configured sender, so a reply-correlated message identifier
    belongs to a domain the organisation actually controls.
    """
    _, _, domain = from_address.partition("@")
    return domain or "finora.invalid"
