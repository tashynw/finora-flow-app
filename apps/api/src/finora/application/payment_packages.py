"""Assembling approved invoices into one submission, and sending it.

Shorter than the estimate, invoice and order services, and deliberately. Those
three each run a record round a matrix of approvers; this one runs nothing round
anybody. Everything a package holds was approved before it could be added, so
the work here is gathering, checking and recording rather than deciding.

Three things it does that are worth knowing before reading.

*It moves other records' states, and none of its own.* Adding an invoice takes
it from `approved` to `ready_for_submission`; removing it puts it back;
submitting the package takes every one of them to `submitted`. The package
itself has no state — see the domain module for why — and its own history is a
handful of audit entries rather than rows in the transition table.

*It refuses one invoice at a time, and says why per invoice.* Adding thirty
invoices where two are no longer eligible adds twenty-eight and names the two.
An all-or-nothing add would make the caller find the offenders themselves, and
the offenders are exactly what the screen needs to show.

*What is submitted is frozen at the moment of submission.* The manifest is
rendered, hashed, and the digest written on the package inside the same
transaction that moves the invoices. Nothing in a submitted package can be
changed afterwards, so the file can be rebuilt later and checked against the
digest recorded at the time.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
from uuid import UUID

import structlog
from sqlalchemy import Sequence as SqlSequence
from sqlalchemy import select
from sqlalchemy.orm import Session

from finora.domain.audit import ActorType, AuditAction
from finora.domain.money import CurrencyError, Money
from finora.domain.payment_packages import (
    IN_PACKAGE_STATE,
    JOINABLE_STATE,
    PROBLEM_EXPLANATIONS,
    PROBLEM_FIELDS,
    JoinRefusal,
    Manifest,
    PackageDetails,
    PackageLine,
    PackageProblem,
    PackageStanding,
    PaymentMethod,
    explain_refusal,
    may_change,
    problems,
    render_manifest,
    standing,
    totals,
    validate_submission_reference,
    why_not_joinable,
)
from finora.domain.roles import Permission, assert_can_act
from finora.domain.workflow import STATE_LABELS, TransitionSource, WorkflowState, transition
from finora.infrastructure.audit_repository import AuditRepository
from finora.infrastructure.db.models import (
    Invoice,
    PaymentPackage,
    PaymentPackageLine,
    RecordActionRow,
    StateTransitionRow,
    User,
)

logger = structlog.get_logger(__name__)

#: How a package names itself to the audit trail. Not in the transition table:
#: a package has no states to move between.
RECORD_TYPE = "payment_package"

#: The record type of the things inside it, whose states this service does move.
INVOICE_RECORD_TYPE = "invoice"

REFERENCE_SEQUENCE = SqlSequence("payment_package_reference_seq")


class PaymentPackageError(Exception):
    """Base class for a refused action on a package."""


class NotOpenError(PaymentPackageError):
    def __init__(self, current: PackageStanding) -> None:
        self.standing = current
        super().__init__(
            "This package has already gone to the bank, so what it contains cannot change."
            if current is PackageStanding.submitted
            else "This package was cancelled, so nothing further can be done with it."
        )


class NotReadyError(PaymentPackageError):
    """The package is incomplete, or something in it stopped being payable."""

    def __init__(self, found: tuple[PackageProblem, ...]) -> None:
        self.problems = found
        super().__init__("This package is not ready to be submitted.")

    def as_detail(self) -> dict[str, object]:
        """The refusal in the shape the API returns problems everywhere else."""
        return {
            "message": str(self),
            "problems": [
                {
                    "problem": problem.value,
                    "field": PROBLEM_FIELDS[problem],
                    "explanation": PROBLEM_EXPLANATIONS[problem],
                }
                for problem in self.problems
            ],
        }


@dataclass(frozen=True, slots=True)
class Refused:
    """One invoice that could not be added, and the reason."""

    invoice_id: UUID
    #: Empty when the identifier matched nothing, which is the one refusal that
    #: cannot name the record it is about.
    reference: str
    refusal: JoinRefusal
    explanation: str


@dataclass(frozen=True, slots=True)
class AddOutcome:
    """What happened to a batch of invoices offered to a package."""

    added: tuple[PaymentPackageLine, ...]
    refused: tuple[Refused, ...]


@dataclass(frozen=True, slots=True)
class PackageDraft:
    """The editable face of a package."""

    description: str
    payment_method: PaymentMethod | None
    intended_payment_date: date | None


class PaymentPackageService:
    def __init__(
        self,
        *,
        session: Session,
        audit: AuditRepository,
        today: date | None = None,
    ) -> None:
        self._session = session
        self._audit = audit
        # Passed in for the same reason the domain takes it: a package validated
        # at three minutes to midnight must validate the same way in a test.
        self._today = today

    # ---------------------------------------------------------------- assembling

    def create(
        self,
        *,
        draft: PackageDraft | None = None,
        actor: User,
        correlation_id: UUID,
    ) -> PaymentPackage:
        assert_can_act(roles=actor.roles, permission=Permission.payment_package_manage)

        package = PaymentPackage(
            reference=self._next_reference(),
            created_by_id=actor.id,
            description=(draft.description.strip()[:500] if draft else ""),
            payment_method=(draft.payment_method if draft else None),
            intended_payment_date=(draft.intended_payment_date if draft else None),
        )
        self._session.add(package)
        self._session.flush()

        self._audit.append(
            action=AuditAction.record_created,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=package.id,
            correlation_id=correlation_id,
            detail={"reference": package.reference},
        )
        return package

    def update(
        self,
        package: PaymentPackage,
        draft: PackageDraft,
        *,
        actor: User,
        correlation_id: UUID,
    ) -> PaymentPackage:
        """Change how and when the money leaves, recording only what moved."""
        assert_can_act(roles=actor.roles, permission=Permission.payment_package_manage)
        self._assert_open(package)

        applied: dict[str, dict[str, str | None]] = {}

        def apply(field: str, value: object | None) -> None:
            before = getattr(package, field)
            if before == value:
                return
            setattr(package, field, value)
            applied[field] = {"from": _recorded(before), "to": _recorded(value)}

        apply("description", draft.description.strip()[:500])
        apply("payment_method", draft.payment_method)
        apply("intended_payment_date", draft.intended_payment_date)

        if not applied:
            return package

        self._session.flush()
        self._audit.append(
            action=AuditAction.record_updated,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=package.id,
            correlation_id=correlation_id,
            detail={"reference": package.reference, "changed": applied},
        )
        return package

    def add(
        self,
        package: PaymentPackage,
        *,
        invoice_ids: tuple[UUID, ...],
        actor: User,
        correlation_id: UUID,
    ) -> AddOutcome:
        """Put approved invoices into the package.

        Partial by design. Each invoice is judged on its own and the ones that
        cannot go in are returned with a reason, because a screen adding a page
        of search results needs to show what it could not take rather than
        refusing the lot over one stale row.
        """
        assert_can_act(roles=actor.roles, permission=Permission.payment_package_manage)
        self._assert_open(package)

        current = standing(submitted_at=package.submitted_at, cancelled_at=package.cancelled_at)
        added: list[PaymentPackageLine] = []
        refused: list[Refused] = []

        for invoice_id in dict.fromkeys(invoice_ids):
            invoice = self._session.get(Invoice, invoice_id)
            if invoice is None or invoice.archived_at is not None:
                refused.append(
                    Refused(
                        invoice_id=invoice_id,
                        reference="",
                        refusal=JoinRefusal.not_approved,
                        explanation=("That invoice is not on the system, or has been archived."),
                    )
                )
                continue

            refusal = why_not_joinable(
                invoice_state=invoice.state,
                total=_amount_or_none(invoice),
                in_another_package=self._is_in_a_package(invoice.id),
                package_standing=current,
            )
            if refusal is not None:
                refused.append(
                    Refused(
                        invoice_id=invoice.id,
                        reference=invoice.reference,
                        refusal=refusal,
                        explanation=explain_refusal(refusal),
                    )
                )
                continue

            added.append(self._attach(package, invoice, actor=actor, correlation_id=correlation_id))

        if added:
            self._session.flush()
            self._audit.append(
                action=AuditAction.record_updated,
                actor_type=ActorType.user,
                actor_id=actor.id,
                actor_label=actor.display_name,
                subject_type=RECORD_TYPE,
                subject_id=package.id,
                correlation_id=correlation_id,
                detail={
                    "reference": package.reference,
                    "added": [line.invoice_reference for line in added],
                },
            )

        return AddOutcome(added=tuple(added), refused=tuple(refused))

    def _attach(
        self,
        package: PaymentPackage,
        invoice: Invoice,
        *,
        actor: User,
        correlation_id: UUID,
    ) -> PaymentPackageLine:
        """One invoice into one package, with the state move that goes with it."""
        # Checked immediately above by `why_not_joinable`, which refuses an
        # invoice with no amount, so this cannot be None here.
        amount = _amount_or_none(invoice)
        assert amount is not None  # noqa: S101  guarded by why_not_joinable

        line = PaymentPackageLine(
            package_id=package.id,
            invoice_id=invoice.id,
            invoice_reference=invoice.reference,
            invoice_number=invoice.invoice_number,
            vendor_id=invoice.vendor_id,
            vendor_name=invoice.vendor.name if invoice.vendor is not None else invoice.vendor_name,
            currency=amount.currency,
            amount_minor_units=amount.minor_units,
            due_date=invoice.due_date,
            added_by_id=actor.id,
        )
        self._session.add(line)

        self._move_invoice(
            invoice,
            target=IN_PACKAGE_STATE,
            actor=actor,
            reason=f"Added to payment package {package.reference}.",
            correlation_id=correlation_id,
        )
        return line

    def remove(
        self,
        package: PaymentPackage,
        *,
        invoice_id: UUID,
        actor: User,
        correlation_id: UUID,
    ) -> PaymentPackage:
        """Take one invoice back out, returning it to approved and unpaid."""
        assert_can_act(roles=actor.roles, permission=Permission.payment_package_manage)
        self._assert_open(package)

        line = self._session.execute(
            select(PaymentPackageLine).where(
                PaymentPackageLine.package_id == package.id,
                PaymentPackageLine.invoice_id == invoice_id,
            )
        ).scalar_one_or_none()
        if line is None:
            raise PaymentPackageError("That invoice is not in this package.")

        reference = line.invoice_reference
        invoice = self._session.get(Invoice, invoice_id)

        self._session.delete(line)
        self._session.flush()

        # Only if it is still where the package put it. An invoice somebody
        # cancelled or sent to exception while it sat here has moved on for a
        # reason, and dragging it back to approved would undo that silently.
        if invoice is not None and invoice.state is IN_PACKAGE_STATE:
            self._move_invoice(
                invoice,
                target=JOINABLE_STATE,
                actor=actor,
                reason=f"Taken out of payment package {package.reference}.",
                correlation_id=correlation_id,
            )

        self._audit.append(
            action=AuditAction.record_updated,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=package.id,
            correlation_id=correlation_id,
            detail={"reference": package.reference, "removed": [reference]},
        )
        return package

    # ---------------------------------------------------------------- submitting

    def submit(
        self,
        package: PaymentPackage,
        *,
        submission_reference: str,
        actor: User,
        correlation_id: UUID,
    ) -> Manifest:
        """Send the package, freezing what went and what it came to.

        The manifest is rendered and hashed here rather than on download. A file
        regenerated later is only the same file if nothing about this code has
        changed since, which is a claim about the software; the digest taken now
        is evidence about the submission.
        """
        assert_can_act(
            roles=actor.roles,
            permission=Permission.payment_submit,
            already_exercised_on_record=self.actions_taken(package, user=actor),
        )
        self._assert_open(package)

        found = self.outstanding(package)
        if found:
            raise NotReadyError(found)

        reference = validate_submission_reference(submission_reference)

        # Narrowed by `outstanding` above, which reports both as problems.
        method = package.payment_method
        pay_date = package.intended_payment_date
        if method is None or pay_date is None:  # pragma: no cover - guarded above
            raise NotReadyError(
                (PackageProblem.payment_method_missing, PackageProblem.payment_date_missing)
            )

        lines = self._lines(package)
        manifest = render_manifest(
            package_reference=package.reference,
            payment_method=method,
            intended_payment_date=pay_date,
            lines=lines,
        )

        now = datetime.now(UTC)
        package.submitted_at = now
        package.submitted_by_id = actor.id
        package.submission_reference = reference
        package.manifest_sha256 = manifest.digest
        package.manifest_line_count = manifest.line_count

        for row in package.lines:
            invoice = self._session.get(Invoice, row.invoice_id)
            if invoice is None:  # pragma: no cover - foreign key forbids it
                continue
            self._move_invoice(
                invoice,
                target=WorkflowState.submitted,
                actor=actor,
                reason=(
                    f"Submitted to the bank in payment package {package.reference}, "
                    f"reference {reference}."
                ),
                correlation_id=correlation_id,
            )

        self._record_action(package, user=actor, permission=Permission.payment_submit)
        self._session.flush()

        self._audit.append(
            action=AuditAction.package_submitted,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=package.id,
            correlation_id=correlation_id,
            detail={
                "reference": package.reference,
                "submission_reference": reference,
                "method": method.value,
                "payment_date": pay_date.isoformat(),
                "invoices": manifest.line_count,
                "totals": {code: money.format() for code, money in totals(lines).items()},
                "manifest_sha256": manifest.digest,
            },
        )
        logger.info(
            "payment_package.submitted",
            payment_package_id=str(package.id),
            reference=package.reference,
            invoices=manifest.line_count,
            manifest_sha256=manifest.digest,
        )
        return manifest

    def cancel(
        self,
        package: PaymentPackage,
        *,
        reason: str,
        actor: User,
        correlation_id: UUID,
    ) -> PaymentPackage:
        """Abandon a package, returning everything in it to approved and unpaid."""
        assert_can_act(roles=actor.roles, permission=Permission.payment_package_manage)
        self._assert_open(package)

        if not reason.strip():
            raise PaymentPackageError("Give a reason for abandoning this package.")

        released = [line.invoice_reference for line in package.lines]
        for row in list(package.lines):
            invoice = self._session.get(Invoice, row.invoice_id)
            if invoice is not None and invoice.state is IN_PACKAGE_STATE:
                self._move_invoice(
                    invoice,
                    target=JOINABLE_STATE,
                    actor=actor,
                    reason=f"Payment package {package.reference} was abandoned.",
                    correlation_id=correlation_id,
                )
            self._session.delete(row)

        package.cancelled_at = datetime.now(UTC)
        package.cancelled_by_id = actor.id
        package.cancelled_reason = reason.strip()
        self._session.flush()

        self._audit.append(
            action=AuditAction.state_changed,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=RECORD_TYPE,
            subject_id=package.id,
            correlation_id=correlation_id,
            detail={
                "reference": package.reference,
                "from": PackageStanding.open.value,
                "to": PackageStanding.cancelled.value,
                "reason": package.cancelled_reason,
                "released": released,
            },
        )
        return package

    # --------------------------------------------------------------------- reads

    def standing_of(self, package: PaymentPackage) -> PackageStanding:
        return standing(submitted_at=package.submitted_at, cancelled_at=package.cancelled_at)

    def outstanding(self, package: PaymentPackage) -> tuple[PackageProblem, ...]:
        """Everything standing between this package and the bank."""
        return problems(
            PackageDetails(
                lines=self._lines(package),
                payment_method=package.payment_method,
                intended_payment_date=package.intended_payment_date,
                today=self._today or datetime.now(UTC).date(),
                standing=self.standing_of(package),
            )
        )

    def totals_of(self, package: PaymentPackage) -> dict[str, Money]:
        """What the package comes to, one figure per currency and never summed."""
        return totals(self._lines(package))

    def manifest(self, package: PaymentPackage) -> Manifest | None:
        """Rebuild the manifest for download.

        `None` for a package with no method or date yet, which is one that could
        not have been submitted and so has no manifest to show. For a submitted
        package the digest of what comes back should equal `manifest_sha256`;
        the API says so on the response so a reader can see the two agree rather
        than take it on trust.
        """
        if package.payment_method is None or package.intended_payment_date is None:
            return None
        return render_manifest(
            package_reference=package.reference,
            payment_method=package.payment_method,
            intended_payment_date=package.intended_payment_date,
            lines=self._lines(package),
        )

    def eligible_invoices(self, *, limit: int = 200) -> list[Invoice]:
        """Approved invoices that could go into a package, oldest due first.

        Ordered by due date so the ones closest to being late are the ones a
        coordinator sees first. Invoices already on a line are excluded by the
        subquery rather than filtered afterwards, so the limit counts things
        that can actually be added.
        """
        taken = select(PaymentPackageLine.invoice_id)
        return list(
            self._session.execute(
                select(Invoice)
                .where(
                    Invoice.state == JOINABLE_STATE,
                    Invoice.archived_at.is_(None),
                    Invoice.total_minor_units.is_not(None),
                    Invoice.currency.is_not(None),
                    Invoice.id.not_in(taken),
                )
                .order_by(Invoice.due_date.nulls_last(), Invoice.reference)
                .limit(limit)
            )
            .scalars()
            .all()
        )

    def actions_taken(self, package: PaymentPackage, *, user: User) -> frozenset[Permission]:
        """What this user has already done to this package.

        Read by the API so a control barred by segregation of duties is absent
        rather than present and refused on press. Phase 8's marking-as-paid
        resolves an invoice back to its package and asks this, which is how
        "submitted it" and "declared it paid" stay two people.
        """
        return frozenset(
            self._session.execute(
                select(RecordActionRow.permission).where(
                    RecordActionRow.record_type == RECORD_TYPE,
                    RecordActionRow.record_id == package.id,
                    RecordActionRow.user_id == user.id,
                )
            ).scalars()
        )

    # ----------------------------------------------------------------- internals

    def _lines(self, package: PaymentPackage) -> tuple[PackageLine, ...]:
        """The package's rows as the domain sees them.

        The invoice's *current* state travels with each line, not the state it
        was in when it was added, because the question the domain answers with it
        is whether this is still payable now.
        """
        return tuple(
            PackageLine(
                invoice_id=row.invoice_id,
                reference=row.invoice_reference,
                invoice_number=row.invoice_number,
                vendor_id=row.vendor_id,
                vendor_name=row.vendor_name,
                total=Money(row.amount_minor_units, row.currency),
                due_date=row.due_date,
                state=row.invoice.state,
            )
            for row in package.lines
        )

    def _is_in_a_package(self, invoice_id: UUID) -> bool:
        return (
            self._session.execute(
                select(PaymentPackageLine.id).where(PaymentPackageLine.invoice_id == invoice_id)
            ).first()
            is not None
        )

    def _assert_open(self, package: PaymentPackage) -> None:
        current = self.standing_of(package)
        if not may_change(current):
            raise NotOpenError(current)

    def _next_reference(self) -> str:
        value = self._session.execute(REFERENCE_SEQUENCE.next_value()).scalar_one()
        return f"PAY-{value:06d}"

    def _record_action(
        self, package: PaymentPackage, *, user: User, permission: Permission
    ) -> None:
        already = self._session.execute(
            select(RecordActionRow).where(
                RecordActionRow.record_type == RECORD_TYPE,
                RecordActionRow.record_id == package.id,
                RecordActionRow.user_id == user.id,
                RecordActionRow.permission == permission,
            )
        ).scalar_one_or_none()
        if already is not None:
            return
        self._session.add(
            RecordActionRow(
                record_type=RECORD_TYPE,
                record_id=package.id,
                user_id=user.id,
                permission=permission,
            )
        )
        self._session.flush()

    def _move_invoice(
        self,
        invoice: Invoice,
        *,
        target: WorkflowState,
        actor: User,
        reason: str,
        correlation_id: UUID,
    ) -> None:
        """Move one invoice through the shared machine and record it.

        Written against the invoice rather than the package: this is the
        invoice's history, and somebody looking at one wants to see that it went
        into a package on the twelfth without having to find the package first.
        """
        change = transition(
            record_id=invoice.id,
            current=invoice.state,
            target=target,
            source=TransitionSource.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            expected_version=invoice.version,
            actual_version=invoice.version,
            reason=reason,
            correlation_id=correlation_id,
        )
        invoice.state = target
        self._session.add(
            StateTransitionRow(
                record_type=INVOICE_RECORD_TYPE,
                record_id=invoice.id,
                from_state=change.from_state,
                to_state=change.to_state,
                source=change.source,
                actor_id=change.actor_id,
                actor_label=change.actor_label,
                reason=change.reason,
                correlation_id=change.correlation_id,
                occurred_at=change.occurred_at,
                context={"reference": invoice.reference},
            )
        )
        self._session.flush()

        self._audit.append(
            action=AuditAction.state_changed,
            actor_type=ActorType.user,
            actor_id=actor.id,
            actor_label=actor.display_name,
            subject_type=INVOICE_RECORD_TYPE,
            subject_id=invoice.id,
            correlation_id=correlation_id,
            detail={
                "reference": invoice.reference,
                "from": STATE_LABELS[change.from_state],
                "to": STATE_LABELS[change.to_state],
                "reason": reason,
            },
        )


def _amount_or_none(invoice: Invoice) -> Money | None:
    if invoice.total_minor_units is None or not invoice.currency:
        return None
    try:
        return Money(invoice.total_minor_units, invoice.currency)
    except CurrencyError:
        # A currency the platform cannot scale. Treated as no amount rather than
        # guessed at, which keeps it out of a package instead of into one at a
        # figure whose decimal places nothing knows.
        return None


def _recorded(value: object | None) -> str | None:
    """One edited value as the audit trail stores it."""
    if value is None:
        return None
    if isinstance(value, date):
        return value.isoformat()
    text = str(value)
    return text or None
