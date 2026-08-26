"""Chasing a sign-off, and getting the mail out.

No HTTP in this file. These are the parts of Phase 5 that run on a timer, and the
properties worth guarding are about what happens between polls rather than what a
request returns.

*A reminder is queued and the cursor moves, or neither happens.* Advancing first
would skip a reminder if composing failed; queueing first would re-send the same one
on every sweep. One transaction, both facts.

*Nothing is sent before the transaction that decided to send it commits.* The whole
reason there is an outbox. A rolled-back sign-off request must not leave a request
for confirmation in somebody's inbox.

*A dead mail server delays mail and stops nothing else.* Failures back off, retry,
and are eventually given up on in a way somebody can see — because an approver who
was never told is indistinguishable from one who is ignoring the request, and the
two need different interventions.

*Escalation adds a recipient rather than replacing one.* The person originally asked
still holds the task; redirecting it would leave them believing it was handled.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import delete, select
from sqlalchemy.orm import Session
from tests.conftest import (
    assign_approver,
    make_cost_centre,
    make_user,
    make_vendor,
    requires_db,
)

from finora.application.invoices import RECORD_TYPE, InvoiceDraft, InvoiceService
from finora.application.outbox import OutboxDrain, enqueue, pending_count
from finora.application.reminder_tasks import (
    Services,
    build_services,
    drain_outbox,
    load_purchase_order_policy,
    mail_domain,
    reminder_policy,
    sweep_reminders,
)
from finora.application.reminders import ReminderService, SweepResult, load_business_hours
from finora.config import get_settings
from finora.domain.audit import AuditAction
from finora.domain.money import Money
from finora.domain.notifications import (
    CLAIM_TIMEOUT,
    MessageKind,
    OutboxState,
    retry_delay,
)
from finora.domain.reminders import BusinessHours, ReminderPolicy, ReminderPurpose
from finora.domain.roles import ApprovalLevel, Role
from finora.domain.workflow import WorkflowState
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import (
    AuditEntryRow,
    BusinessCalendarDay,
    Invoice,
    OutboxMessage,
    PurchaseOrderThreshold,
    ReminderSchedule,
    User,
)
from finora.infrastructure.mailer import MailerError, build_message

pytestmark = [pytest.mark.integration, requires_db]

SMALL = 4_000_000

#: A Wednesday morning inside the configured working day, in the configured zone.
#: Every sweep in this file is run as at this instant rather than at whatever time
#: the suite happens to execute, because a reminder due outside business hours is
#: correctly suppressed and a test that passed only between nine and five would be
#: worse than no test at all.
KINGSTON = ZoneInfo("America/Jamaica")
WEDNESDAY = datetime(2026, 8, 5, 9, 0, tzinfo=KINGSTON)
#: An hour into the working day, so anything due "an hour ago" is still inside it.
MID_MORNING = WEDNESDAY.replace(hour=10)


# ------------------------------------------------------------------- doubles


@dataclass
class FakeMailer:
    """Accepts messages, or refuses them on demand.

    Counts rather than merely records, because the property that matters for the
    claim protocol is *how many times* one message was handed to a mail server.
    """

    sent: list[OutboxMessage] = field(default_factory=list)
    fail_with: Exception | None = None

    def send(self, message: OutboxMessage) -> None:
        if self.fail_with is not None:
            raise self.fail_with
        self.sent.append(message)

    @property
    def subjects(self) -> list[str]:
        return [message.subject for message in self.sent]


# ------------------------------------------------------------------ fixtures


@pytest.fixture
def finance(db_session: Session) -> User:
    return make_user(
        db_session,
        email="fiona.finance@example.com",
        display_name="Fiona Finance",
        roles=[Role.finance],
        department="Finance",
    )


@pytest.fixture
def requester(db_session: Session) -> User:
    return make_user(
        db_session,
        email="rita.requester@example.com",
        display_name="Rita Requester",
        roles=[Role.requester],
        department="Facilities",
    )


@pytest.fixture
def services(db_session: Session) -> Services:
    return build_services(db_session)


@pytest.fixture
def awaiting(db_session: Session, services: Services, finance: User, requester: User) -> Invoice:
    """An invoice sitting with its requester, with a live cycle chasing it."""
    vendor = make_vendor(db_session)
    centre = make_cost_centre(db_session)

    invoice = services.invoices.create_blank(creator=finance, correlation_id=uuid.uuid4())
    services.invoices.update(
        invoice,
        InvoiceDraft(
            vendor_name=vendor.name,
            description="Replacement air handling unit for the third floor",
            vendor_id=vendor.id,
            invoice_number="INV-8891",
            invoice_date=date(2026, 8, 1),
            total_minor_units=SMALL,
            currency="JMD",
            cost_centre_id=centre.id,
            requester_id=requester.id,
        ),
        actor=finance,
        correlation_id=uuid.uuid4(),
    )
    services.invoices.request_sign_off(invoice, actor=finance, correlation_id=uuid.uuid4())
    db_session.commit()
    db_session.refresh(invoice)
    return invoice


def schedule_of(session: Session, invoice: Invoice) -> ReminderSchedule:
    return session.execute(
        select(ReminderSchedule).where(
            ReminderSchedule.record_id == invoice.id,
            ReminderSchedule.stopped_at.is_(None),
        )
    ).scalar_one()


def queued(session: Session) -> list[OutboxMessage]:
    return list(
        session.execute(select(OutboxMessage).order_by(OutboxMessage.created_at)).scalars().all()
    )


def make_due(session: Session, schedule: ReminderSchedule, *, at: datetime | None = None) -> None:
    """Bring a cycle's next reminder forward, so a sweep will pick it up."""
    schedule.next_due_at = at or (MID_MORNING - timedelta(minutes=1))
    session.commit()


def sweep() -> SweepResult:
    """Sweep as at the fixed working-hours instant this file reasons about."""
    return sweep_reminders(now=MID_MORNING)


# -------------------------------------------------------------- the outbox


class TestQueueingMail:
    def test_nothing_is_visible_until_the_transaction_commits(
        self, db_session: Session, finance: User
    ) -> None:
        """The whole reason the outbox exists. A worker in another session must not
        be able to send a message whose business change has not landed."""
        record_id = uuid.uuid4()
        enqueue(
            db_session,
            kind=MessageKind.sign_off_request,
            idempotency_key=f"invoice:{record_id}:sign_off:0",
            record_type=RECORD_TYPE,
            record_id=record_id,
            to_address=finance.email,
            to_name=finance.display_name,
            subject="Confirm receipt",
            body_text="Body",
        )

        drain = drain_outbox()

        assert drain.attempted == 0
        db_session.rollback()
        assert queued(db_session) == []

    def test_the_same_message_is_only_queued_once(self, db_session: Session, finance: User) -> None:
        """What makes a scheduler safe to run twice: a repeat is a no-op rather
        than a second email to somebody already annoyed."""
        record_id = uuid.uuid4()
        key = f"invoice:{record_id}:sign_off:1"

        def attempt() -> OutboxMessage | None:
            return enqueue(
                db_session,
                kind=MessageKind.sign_off_reminder,
                idempotency_key=key,
                record_type=RECORD_TYPE,
                record_id=record_id,
                to_address=finance.email,
                to_name=finance.display_name,
                subject="Reminder",
                body_text="Body",
            )

        assert attempt() is not None
        db_session.commit()
        assert attempt() is None
        db_session.commit()

        assert len(queued(db_session)) == 1

    def test_every_message_carries_an_identifier_a_reply_can_be_matched_to(
        self, db_session: Session, finance: User
    ) -> None:
        """Correlating a reply by subject line is how mail threads get confused
        between two invoices from the same supplier."""
        record_id = uuid.uuid4()
        message = enqueue(
            db_session,
            kind=MessageKind.sign_off_request,
            idempotency_key=f"invoice:{record_id}:sign_off:0",
            record_type=RECORD_TYPE,
            record_id=record_id,
            to_address=finance.email,
            to_name=finance.display_name,
            subject="Confirm receipt",
            body_text="Body",
            domain="finance.example.com",
        )
        db_session.commit()

        assert message is not None
        assert message.message_id.startswith("<")
        assert message.message_id.endswith("@finance.example.com>")


class TestDrainingTheQueue:
    def drain(self, session: Session, mailer: FakeMailer, **kwargs: int) -> OutboxDrain:
        return OutboxDrain(
            session=session,
            mailer=mailer,
            audit=AuditRepository(session),
            **kwargs,
        )

    def queue_one(self, session: Session, *, to: User) -> OutboxMessage:
        message = enqueue(
            session,
            kind=MessageKind.sign_off_request,
            idempotency_key=f"invoice:{uuid.uuid4()}:sign_off:0",
            record_type=RECORD_TYPE,
            record_id=uuid.uuid4(),
            to_address=to.email,
            to_name=to.display_name,
            subject="Confirm receipt of INV-000001",
            body_text="Body",
        )
        assert message is not None
        session.commit()
        return message

    def test_a_sent_message_is_recorded_as_sent_and_written_to_the_trail(
        self, db_session: Session, finance: User
    ) -> None:
        message = self.queue_one(db_session, to=finance)
        mailer = FakeMailer()

        result = self.drain(db_session, mailer).run_once()

        assert result.sent == 1
        db_session.refresh(message)
        assert message.state is OutboxState.sent
        assert message.sent_at is not None
        assert mailer.subjects == ["Confirm receipt of INV-000001"]

        trail = (
            db_session.execute(
                select(AuditEntryRow).where(AuditEntryRow.action == AuditAction.mail_sent)
            )
            .scalars()
            .all()
        )
        assert [entry.detail["to"] for entry in trail] == [finance.email]

    def test_a_failure_backs_off_and_stays_retryable(
        self, db_session: Session, finance: User
    ) -> None:
        message = self.queue_one(db_session, to=finance)
        mailer = FakeMailer(fail_with=MailerError("Connection refused"))
        before = datetime.now(UTC)

        result = self.drain(db_session, mailer).run_once()

        assert result.failed == 1
        db_session.refresh(message)
        assert message.state is OutboxState.failed
        assert message.attempts == 1
        assert "Connection refused" in (message.last_error or "")
        # Backed off rather than retried immediately, so a mail server that is down
        # is not hammered once per poll for as long as it stays down.
        assert message.available_at >= before + retry_delay(1)

    def test_a_message_backing_off_is_not_claimed_again_yet(
        self, db_session: Session, finance: User
    ) -> None:
        self.queue_one(db_session, to=finance)
        failing = FakeMailer(fail_with=MailerError("Connection refused"))
        self.drain(db_session, failing).run_once()

        recovered = FakeMailer()
        second = self.drain(db_session, recovered).run_once()

        assert second.attempted == 0
        assert recovered.sent == []

    def test_it_gives_up_out_loud_after_enough_attempts(
        self, db_session: Session, finance: User
    ) -> None:
        """A silent stop would make an approver who was never told look identical
        to one who is ignoring the request."""
        message = self.queue_one(db_session, to=finance)
        mailer = FakeMailer(fail_with=MailerError("No such mailbox"))
        drain = self.drain(db_session, mailer, max_attempts=2)

        drain.run_once()
        message.available_at = datetime.now(UTC) - timedelta(seconds=1)
        db_session.commit()
        result = drain.run_once()

        assert result.abandoned == 1
        db_session.refresh(message)
        assert message.state is OutboxState.abandoned
        # And it stays abandoned: nothing picks it up again.
        assert self.drain(db_session, FakeMailer()).run_once().attempted == 0

        # Ordered by the chain's own sequence rather than left to whatever order
        # the rows come back in, since the claim being made is about which attempt
        # gave up and that is a claim about their order.
        given_up = (
            db_session.execute(
                select(AuditEntryRow)
                .where(AuditEntryRow.action == AuditAction.mail_failed)
                .order_by(AuditEntryRow.sequence)
            )
            .scalars()
            .all()
        )
        assert [entry.detail["given_up"] for entry in given_up] == [False, True]

    def test_a_message_a_dead_worker_claimed_is_recovered_by_age(
        self, db_session: Session, finance: User
    ) -> None:
        """A worker that crashed mid-send left this row claimed, and nothing else
        will ever release it. Recovered on a timer rather than by a person."""
        message = self.queue_one(db_session, to=finance)
        message.state = OutboxState.sending
        message.claimed_at = datetime.now(UTC) - CLAIM_TIMEOUT - timedelta(minutes=1)
        db_session.commit()

        mailer = FakeMailer()
        result = self.drain(db_session, mailer).run_once()

        assert result.sent == 1

    def test_a_message_a_live_worker_is_holding_is_left_alone(
        self, db_session: Session, finance: User
    ) -> None:
        message = self.queue_one(db_session, to=finance)
        message.state = OutboxState.sending
        message.claimed_at = datetime.now(UTC)
        db_session.commit()

        result = self.drain(db_session, FakeMailer()).run_once()

        assert result.attempted == 0

    def test_what_is_waiting_can_be_counted_for_the_health_screen(
        self, db_session: Session, finance: User
    ) -> None:
        self.queue_one(db_session, to=finance)
        assert pending_count(db_session) == 1

        self.drain(db_session, FakeMailer()).run_once()
        assert pending_count(db_session) == 0


class TestTheMessageItself:
    def test_it_is_addressed_and_threaded_and_asks_for_no_auto_reply(
        self, db_session: Session, finance: User
    ) -> None:
        """Auto-reply suppression is not politeness. An out-of-office bouncing off
        a reminder cycle produces mail loops."""
        record_id = uuid.uuid4()
        message = enqueue(
            db_session,
            kind=MessageKind.sign_off_reminder,
            idempotency_key=f"invoice:{record_id}:sign_off:2",
            record_type=RECORD_TYPE,
            record_id=record_id,
            to_address="rita.requester@example.com",
            to_name="Rita Requester",
            subject="Reminder: confirm receipt",
            body_text="Body",
            cc_addresses=["ursula.head@example.com"],
        )
        assert message is not None
        db_session.commit()

        built = build_message(message, settings=get_settings().smtp)

        assert built["To"] == "Rita Requester <rita.requester@example.com>"
        assert built["Cc"] == "ursula.head@example.com"
        assert built["Message-ID"] == message.message_id
        assert built["Auto-Submitted"] == "auto-generated"
        assert built["X-Auto-Response-Suppress"]


# ----------------------------------------------------------- chasing a record


class TestTheChasingCycle:
    def test_requesting_sign_off_starts_a_cycle_due_three_working_hours_later(
        self, db_session: Session, awaiting: Invoice
    ) -> None:
        schedule = schedule_of(db_session, awaiting)

        assert schedule.purpose is ReminderPurpose.sign_off
        assert schedule.sent_count == 0
        assert schedule.next_due_at is not None
        assert schedule.next_due_at > schedule.started_at

    def test_a_second_start_does_not_double_the_chasing(
        self, db_session: Session, services: Services, awaiting: Invoice, requester: User
    ) -> None:
        """Two live cycles on one record double every reminder, which is exactly
        what trains people to filter them."""
        again = services.reminders.start(
            record_type=RECORD_TYPE,
            record_id=awaiting.id,
            purpose=ReminderPurpose.sign_off,
            recipient=requester,
        )
        db_session.commit()

        assert again is None
        assert len(list(db_session.execute(select(ReminderSchedule)).scalars().all())) == 1

    def test_a_sweep_queues_a_reminder_and_advances_the_cursor_together(
        self, db_session: Session, awaiting: Invoice, requester: User
    ) -> None:
        schedule = schedule_of(db_session, awaiting)
        make_due(db_session, schedule)

        result = sweep()

        assert (result.considered, result.sent) == (1, 1)
        db_session.expire_all()
        schedule = schedule_of(db_session, awaiting)
        assert schedule.sent_count == 1
        assert schedule.last_sent_at is not None
        # Moved on, not left due. Otherwise the next sweep sends the same one.
        assert schedule.next_due_at is not None
        # Moved on by the interval, so the next sweep does not send a second copy.
        assert schedule.next_due_at == MID_MORNING + timedelta(hours=3)

        reminders = [
            message
            for message in queued(db_session)
            if message.kind is not MessageKind.sign_off_request
        ]
        assert [message.to_address for message in reminders] == [requester.email]

    def test_a_sweep_that_finds_nothing_due_sends_nothing(
        self, db_session: Session, awaiting: Invoice
    ) -> None:
        make_due(db_session, schedule_of(db_session, awaiting), at=MID_MORNING + timedelta(hours=3))

        result = sweep()

        assert result.considered == 0
        assert schedule_of(db_session, awaiting).sent_count == 0

    def test_every_reminder_carries_a_fresh_link_and_kills_the_previous_one(
        self, db_session: Session, awaiting: Invoice
    ) -> None:
        """Otherwise an eight-reminder cycle leaves eight working links in a
        mailbox: each reminder would widen the window rather than moving it."""
        from finora.infrastructure.db.models import SignedLink

        make_due(db_session, schedule_of(db_session, awaiting))
        sweep()

        db_session.expire_all()
        links = (
            db_session.execute(select(SignedLink).where(SignedLink.record_id == awaiting.id))
            .scalars()
            .all()
        )
        assert len(links) == 2
        assert sum(1 for link in links if link.revoked_at is None and link.used_at is None) == 1

    def test_signing_off_stops_the_chasing_before_the_scheduler_notices(
        self, db_session: Session, services: Services, awaiting: Invoice, requester: User
    ) -> None:
        """Between a resolution and the next poll there is a window, and a reminder
        sent inside it chases somebody about work they have just done."""
        assign_approver(db_session, user=requester, level=ApprovalLevel.unit_head)
        approver = make_user(
            db_session,
            email="ursula.head@example.com",
            display_name="Ursula Head",
            roles=[Role.approver],
            department="Facilities",
        )
        assign_approver(db_session, user=approver, level=ApprovalLevel.unit_head)

        services.invoices.sign_off(
            awaiting, actor=requester, note=None, correlation_id=uuid.uuid4()
        )
        db_session.commit()

        result = sweep()

        assert result.sent == 0
        assert (
            db_session.execute(
                select(ReminderSchedule).where(
                    ReminderSchedule.record_id == awaiting.id,
                    ReminderSchedule.stopped_at.is_(None),
                )
            ).scalar_one_or_none()
            is None
        )

    def test_a_record_that_moved_on_without_telling_us_stops_being_chased(
        self, db_session: Session, awaiting: Invoice
    ) -> None:
        """The scheduler's own check, which is a second line of defence rather than
        the mechanism. Simulated by moving the state behind the service's back."""
        awaiting.state = WorkflowState.approved
        make_due(db_session, schedule_of(db_session, awaiting))

        result = sweep()

        assert (result.stopped, result.sent) == (1, 0)
        db_session.expire_all()
        stopped = db_session.execute(
            select(ReminderSchedule).where(ReminderSchedule.record_id == awaiting.id)
        ).scalar_one()
        assert stopped.stopped_at is not None
        assert stopped.next_due_at is None

    def test_chasing_somebody_who_has_left_stops_rather_than_continuing(
        self, db_session: Session, awaiting: Invoice, requester: User
    ) -> None:
        """Mail into a void leaves the record looking attended to. Stopping is
        visible; an unanswered cycle is not."""
        requester.is_active = False
        make_due(db_session, schedule_of(db_session, awaiting))

        result = sweep()

        assert result.sent == 0
        db_session.expire_all()
        stopped = db_session.execute(
            select(ReminderSchedule).where(ReminderSchedule.record_id == awaiting.id)
        ).scalar_one()
        assert stopped.stopped_at is not None
        assert "active account" in (stopped.stopped_reason or "")

    def test_the_cycle_stops_after_the_configured_number_of_reminders(
        self, db_session: Session, awaiting: Invoice
    ) -> None:
        """A cycle that chases forever is one people mute, and a muted cycle is
        worse than none because it looks like the record is being pursued."""
        maximum = get_settings().workflow.reminder_max_count

        for _ in range(maximum + 2):
            live = db_session.execute(
                select(ReminderSchedule).where(
                    ReminderSchedule.record_id == awaiting.id,
                    ReminderSchedule.stopped_at.is_(None),
                )
            ).scalar_one_or_none()
            if live is None or live.next_due_at is None:
                break
            make_due(db_session, live)
            sweep()
            db_session.expire_all()

        final = db_session.execute(
            select(ReminderSchedule).where(ReminderSchedule.record_id == awaiting.id)
        ).scalar_one()
        assert final.sent_count == maximum
        assert final.next_due_at is None


class TestEscalation:
    def test_it_copies_in_the_next_tier_without_dropping_the_original_recipient(
        self, db_session: Session, awaiting: Invoice, requester: User
    ) -> None:
        """The person originally asked still holds the task. Redirecting it would
        leave them believing it was handled."""
        head = make_user(
            db_session,
            email="ursula.head@example.com",
            display_name="Ursula Head",
            roles=[Role.approver],
            department="Facilities",
        )
        assign_approver(db_session, user=head, level=ApprovalLevel.unit_head)

        schedule = schedule_of(db_session, awaiting)
        every = get_settings().workflow.reminder_escalate_every
        # Wound forward to the point the ladder's first rung applies, rather than
        # sweeping there one reminder at a time.
        schedule.sent_count = every
        schedule.escalation_level = 1
        make_due(db_session, schedule)

        assert sweep().sent == 1

        db_session.expire_all()
        escalated = [
            message
            for message in queued(db_session)
            if message.kind is MessageKind.sign_off_escalation
        ]
        assert len(escalated) == 1
        assert escalated[0].to_address == requester.email
        assert escalated[0].cc_addresses == [head.email]

    def test_an_escalation_with_nobody_above_still_reaches_the_person_asked(
        self, db_session: Session, awaiting: Invoice, requester: User
    ) -> None:
        """An escalation with no destination must not become a reminder with no
        destination."""
        schedule = schedule_of(db_session, awaiting)
        schedule.sent_count = get_settings().workflow.reminder_escalate_every
        schedule.escalation_level = 1
        make_due(db_session, schedule)

        assert sweep().sent == 1

        db_session.expire_all()
        chased = [
            message
            for message in queued(db_session)
            if message.kind is not MessageKind.sign_off_request
        ]
        assert [message.to_address for message in chased] == [requester.email]
        assert chased[0].cc_addresses == []

    def test_escalating_is_a_distinct_event_in_the_trail(
        self, db_session: Session, awaiting: Invoice
    ) -> None:
        """ "We escalated this twice" is a question somebody asks, and a reminder
        and an escalation answer it differently."""
        head = make_user(
            db_session,
            email="ursula.head@example.com",
            display_name="Ursula Head",
            roles=[Role.approver],
            department="Facilities",
        )
        assign_approver(db_session, user=head, level=ApprovalLevel.unit_head)

        schedule = schedule_of(db_session, awaiting)
        schedule.sent_count = get_settings().workflow.reminder_escalate_every
        schedule.escalation_level = 1
        make_due(db_session, schedule)
        sweep()

        actions = [
            entry.action
            for entry in db_session.execute(
                select(AuditEntryRow).where(
                    AuditEntryRow.action.in_([AuditAction.reminder_sent, AuditAction.escalated])
                )
            )
            .scalars()
            .all()
        ]
        assert actions == [AuditAction.escalated]


class TestBusinessHours:
    """The reason "three hours" is not `timedelta(hours=3)`.

    A request that arrives at half past four does not become urgent at half past
    seven in the evening. These check the wiring between the configured calendar and
    the arithmetic; the arithmetic itself is covered in the domain tests.
    """

    def test_a_configured_closure_is_treated_as_a_non_working_day(
        self, db_session: Session
    ) -> None:
        thursday = date(2026, 8, 6)
        db_session.add(
            BusinessCalendarDay(
                calendar_date=thursday,
                is_working_day=False,
                description="Independence Day",
            )
        )
        db_session.commit()

        hours = load_business_hours(
            db_session,
            timezone="America/Jamaica",
            start_hour=8,
            end_hour=17,
            days="mon,tue,wed,thu,fri",
            from_date=thursday,
        )

        assert not hours.is_working_day(thursday)
        assert hours.is_working_day(date(2026, 8, 5))

    def test_a_reminder_due_after_hours_waits_for_the_office_to_open(
        self, db_session: Session, awaiting: Invoice, requester: User
    ) -> None:
        schedule = schedule_of(db_session, awaiting)
        reminders = ReminderService(
            session=db_session,
            audit=AuditRepository(db_session),
            hours=BusinessHours(
                timezone="America/Jamaica",
                start_hour=8,
                end_hour=17,
                days=frozenset({0, 1, 2, 3, 4}),
            ),
            policy=ReminderPolicy(interval_hours=3, max_reminders=8, escalate_every=2),
        )
        # Due at nine in the evening on a working day.
        schedule.next_due_at = WEDNESDAY.replace(hour=21)

        outcome = reminders.consider(schedule, now=WEDNESDAY.replace(hour=21, minute=30))

        assert outcome.__class__.__name__ == "Suppression"
        # And moved to the next opening rather than left where it was, so it goes
        # out first thing rather than being reconsidered all night.
        assert schedule.next_due_at is not None
        assert schedule.next_due_at.astimezone(KINGSTON).hour == 8

    def test_suppression_outside_hours_can_be_switched_off_by_configuration(
        self, db_session: Session, awaiting: Invoice
    ) -> None:
        """Some finance functions want the mail waiting when people arrive; others
        want it sent when it comes due. It is a policy, not a law."""
        schedule = schedule_of(db_session, awaiting)
        reminders = ReminderService(
            session=db_session,
            audit=AuditRepository(db_session),
            hours=BusinessHours(
                timezone="America/Jamaica",
                start_hour=8,
                end_hour=17,
                days=frozenset({0, 1, 2, 3, 4}),
            ),
            policy=ReminderPolicy(
                interval_hours=3,
                max_reminders=8,
                escalate_every=2,
                send_outside_business_hours=True,
            ),
        )
        schedule.next_due_at = WEDNESDAY.replace(hour=21)

        outcome = reminders.consider(schedule, now=WEDNESDAY.replace(hour=21, minute=30))

        assert outcome.__class__.__name__ == "Recipients"


# ------------------------------------------------------- worker configuration


class TestHowTheWorkerIsWired:
    def test_the_api_and_the_sweep_build_the_same_services(self, db_session: Session) -> None:
        """Two construction sites is how a threshold configured in one place stops
        matching the one enforced in the other."""
        built = build_services(db_session)

        assert isinstance(built.invoices, InvoiceService)
        assert isinstance(built.reminders, ReminderService)
        assert built.session is db_session

    def test_no_configured_threshold_turns_the_purchase_order_control_off(
        self, db_session: Session
    ) -> None:
        db_session.execute(delete(PurchaseOrderThreshold))
        db_session.commit()

        assert load_purchase_order_policy(db_session).is_in_use is False

    def test_a_retired_threshold_is_not_enforced(self, db_session: Session) -> None:
        db_session.execute(delete(PurchaseOrderThreshold))
        db_session.add(
            PurchaseOrderThreshold(
                currency="JMD", applies_above_minor_units=5_000_000, is_active=False
            )
        )
        db_session.commit()

        assert load_purchase_order_policy(db_session).is_in_use is False

    def test_a_threshold_in_an_unknown_currency_is_dropped_rather_than_guessed(
        self, db_session: Session
    ) -> None:
        """Comparing against a currency nothing can scale would decide a control by
        accident. The row is dropped, which leaves that currency with no threshold
        and therefore always requiring an order: towards the control, not around it."""
        db_session.execute(delete(PurchaseOrderThreshold))
        db_session.add(
            PurchaseOrderThreshold(currency="ZZZ", applies_above_minor_units=1, is_active=True)
        )
        db_session.commit()

        policy = load_purchase_order_policy(db_session)
        assert policy.threshold_for("ZZZ") is None
        assert policy.is_in_use is False

    def test_a_configured_threshold_only_binds_its_own_currency(self, db_session: Session) -> None:
        db_session.execute(delete(PurchaseOrderThreshold))
        db_session.add(
            PurchaseOrderThreshold(
                currency="JMD", applies_above_minor_units=5_000_000, is_active=True
            )
        )
        db_session.commit()

        policy = load_purchase_order_policy(db_session)
        assert policy.threshold_for("JMD") == Money(5_000_000, "JMD")
        assert policy.threshold_for("USD") is None
        # Above, not at: the control is stated as applying above the figure.
        assert policy.requires_order(Money(5_000_000, "JMD")) is False
        assert policy.requires_order(Money(5_000_001, "JMD")) is True
        # A currency with no figure of its own, while the control is switched on
        # somewhere, requires an order at any amount rather than none.
        assert policy.requires_order(Money(1, "USD")) is True

    def test_the_policy_follows_the_configured_business_hours_setting(self) -> None:
        suppressing = get_settings().workflow.model_copy(
            update={"suppress_outside_business_hours": True}
        )
        assert reminder_policy(suppressing).send_outside_business_hours is False

        always = get_settings().workflow.model_copy(
            update={"suppress_outside_business_hours": False}
        )
        assert reminder_policy(always).send_outside_business_hours is True

    def test_message_identifiers_belong_to_the_configured_sender_domain(self) -> None:
        """A Message-ID on a domain the organisation does not control is a
        correlation key that cannot be trusted."""
        assert mail_domain("finora@finance.example.com") == "finance.example.com"
        assert mail_domain("not-an-address") == "finora.invalid"

    def test_a_sweep_that_hits_an_unexpected_failure_reports_no_work_rather_than_raising(
        self, db_session: Session, awaiting: Invoice, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The worker loop has nowhere useful to put an exception, and one bad
        record must not stop the timer."""
        monkeypatch.setattr(
            "finora.application.reminder_tasks.build_services",
            lambda session, **kwargs: (_ for _ in ()).throw(RuntimeError("boom")),
        )

        result = sweep()

        assert result.considered == 0
