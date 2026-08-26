"""What a package has to satisfy before money leaves, and what it leaves behind.

Three things are worth stating about what is tested here.

The first is that a package has no workflow state. "Open", "Submitted" and
"Abandoned" are read off two timestamps, the same way an order's "Closed" is, and
the tests below pin that reading rather than a fourth lifecycle nobody wrote.

The second is that eligibility gives one reason and not a list. Unlike the gaps
in a draft, each of these is final on its own, and the tests check the order they
are reported in, because the reason a reader is shown is the one they will act on.

The third is the manifest. It is evidence, so the property that matters is not
that it looks right but that it is the same file every time: same bytes, same
digest, whatever order somebody assembled the package in and whatever machine
they pressed submit on.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from uuid import uuid4

import pytest

from finora.domain.money import Money
from finora.domain.payment_packages import (
    BLOCKING_PROBLEMS,
    MANIFEST_COLUMNS,
    PROBLEM_EXPLANATIONS,
    PROBLEM_FIELDS,
    JoinRefusal,
    PackageDetails,
    PackageLine,
    PackageProblem,
    PackageStanding,
    PaymentMethod,
    blocking,
    is_ready,
    manifest_filename,
    may_change,
    problems,
    render_manifest,
    standing,
    totals,
    validate_submission_reference,
    vendor_count,
    why_not_joinable,
)
from finora.domain.workflow import WorkflowState

JMD = "JMD"
USD = "USD"

VENDOR = uuid4()
OTHER_VENDOR = uuid4()

TODAY = date(2026, 5, 11)
SOON = date(2026, 5, 14)
SUBMITTED_AT = datetime(2026, 5, 12, 14, 30, tzinfo=UTC)
CANCELLED_AT = datetime(2026, 5, 12, 15, 0, tzinfo=UTC)


def line(
    *,
    reference: str = "INV-000001",
    invoice_number: str | None = "A-1",
    vendor_id: object | None = VENDOR,
    vendor_name: str = "Kingston Supplies Limited",
    total: Money | None = None,
    due_date: date | None = SOON,
    state: WorkflowState = WorkflowState.ready_for_submission,
) -> PackageLine:
    return PackageLine(
        invoice_id=uuid4(),
        reference=reference,
        invoice_number=invoice_number,
        vendor_id=vendor_id,
        vendor_name=vendor_name,
        total=total if total is not None else Money(25_000, JMD),
        due_date=due_date,
        state=state,
    )


def details(
    *,
    lines: tuple[PackageLine, ...] | None = None,
    payment_method: PaymentMethod | None = PaymentMethod.bank_transfer,
    intended_payment_date: date | None = SOON,
    today: date = TODAY,
    standing: PackageStanding = PackageStanding.open,
) -> PackageDetails:
    return PackageDetails(
        lines=lines if lines is not None else (line(),),
        payment_method=payment_method,
        intended_payment_date=intended_payment_date,
        today=today,
        standing=standing,
    )


class TestStanding:
    def test_a_package_nobody_has_finished_is_open(self) -> None:
        assert standing(submitted_at=None, cancelled_at=None) is PackageStanding.open

    def test_submission_closes_it(self) -> None:
        assert standing(submitted_at=SUBMITTED_AT, cancelled_at=None) is PackageStanding.submitted

    def test_cancellation_closes_it(self) -> None:
        assert standing(submitted_at=None, cancelled_at=CANCELLED_AT) is PackageStanding.cancelled

    def test_having_gone_to_the_bank_outranks_having_been_cancelled(self) -> None:
        # Money that moved, moved. A row carrying both is already wrong, and the
        # reading that describes a real payment as an abandoned one is the worse
        # of the two ways to be wrong about it.
        assert (
            standing(submitted_at=SUBMITTED_AT, cancelled_at=CANCELLED_AT)
            is PackageStanding.submitted
        )

    def test_only_an_open_package_can_be_changed(self) -> None:
        assert may_change(PackageStanding.open)
        assert not may_change(PackageStanding.submitted)
        assert not may_change(PackageStanding.cancelled)


class TestJoining:
    def test_an_approved_invoice_with_an_amount_can_join(self) -> None:
        assert (
            why_not_joinable(
                invoice_state=WorkflowState.approved,
                total=Money(1000, JMD),
                in_another_package=False,
                package_standing=PackageStanding.open,
            )
            is None
        )

    @pytest.mark.parametrize(
        "state",
        [
            WorkflowState.draft,
            WorkflowState.pending_sign_off,
            WorkflowState.pending_approval,
            WorkflowState.rejected,
            WorkflowState.exception,
            WorkflowState.paid,
        ],
    )
    def test_nothing_but_approved_can_join(self, state: WorkflowState) -> None:
        assert (
            why_not_joinable(
                invoice_state=state,
                total=Money(1000, JMD),
                in_another_package=False,
                package_standing=PackageStanding.open,
            )
            is JoinRefusal.not_approved
        )

    def test_an_invoice_already_in_a_package_cannot_join_a_second(self) -> None:
        # The whole reason the check exists: two packages holding one invoice is
        # how a supplier is paid twice for one debt.
        assert (
            why_not_joinable(
                invoice_state=WorkflowState.approved,
                total=Money(1000, JMD),
                in_another_package=True,
                package_standing=PackageStanding.open,
            )
            is JoinRefusal.already_in_a_package
        )

    @pytest.mark.parametrize("amount", [None, Money(0, JMD), Money(-500, JMD)])
    def test_there_has_to_be_something_to_send(self, amount: Money | None) -> None:
        assert (
            why_not_joinable(
                invoice_state=WorkflowState.approved,
                total=amount,
                in_another_package=False,
                package_standing=PackageStanding.open,
            )
            is JoinRefusal.no_amount
        )

    @pytest.mark.parametrize("closed", [PackageStanding.submitted, PackageStanding.cancelled])
    def test_a_closed_package_refuses_before_it_looks_at_the_invoice(
        self, closed: PackageStanding
    ) -> None:
        # Reported first even though the invoice is also ineligible. What the
        # reader can act on is the package, and telling them about the invoice
        # sends them to fix something that would change nothing.
        assert (
            why_not_joinable(
                invoice_state=WorkflowState.draft,
                total=None,
                in_another_package=True,
                package_standing=closed,
            )
            is JoinRefusal.package_is_closed
        )


class TestProblems:
    def test_a_complete_package_has_none(self) -> None:
        assert problems(details()) == ()
        assert is_ready(details())

    def test_an_empty_package_says_so(self) -> None:
        assert PackageProblem.nothing_in_it in problems(details(lines=()))

    def test_the_method_and_the_date_are_both_required(self) -> None:
        found = problems(details(payment_method=None, intended_payment_date=None))
        assert PackageProblem.payment_method_missing in found
        assert PackageProblem.payment_date_missing in found

    def test_a_date_that_has_gone_by_is_a_problem_rather_than_a_missing_one(self) -> None:
        found = problems(details(intended_payment_date=date(2026, 5, 10)))
        assert PackageProblem.payment_date_in_the_past in found
        assert PackageProblem.payment_date_missing not in found

    def test_today_is_not_in_the_past(self) -> None:
        assert problems(details(intended_payment_date=TODAY)) == ()

    def test_an_invoice_that_moved_on_after_it_was_added_stops_the_package(self) -> None:
        found = problems(
            details(
                lines=(
                    line(invoice_number="A-1"),
                    line(invoice_number="A-2", state=WorkflowState.exception),
                )
            )
        )
        assert PackageProblem.line_no_longer_payable in found

    def test_that_one_is_a_control_rather_than_a_gap(self) -> None:
        assert PackageProblem.line_no_longer_payable in BLOCKING_PROBLEMS
        assert PackageProblem.payment_method_missing not in BLOCKING_PROBLEMS

    def test_blocking_reports_only_the_controls(self) -> None:
        found = problems(
            details(
                lines=(
                    line(invoice_number="A-1"),
                    line(invoice_number="A-2", state=WorkflowState.exception),
                ),
                payment_method=None,
            )
        )
        assert blocking(found) == (PackageProblem.line_no_longer_payable,)

    @pytest.mark.parametrize("closed", [PackageStanding.submitted, PackageStanding.cancelled])
    def test_a_package_that_can_no_longer_change_reports_none(
        self, closed: PackageStanding
    ) -> None:
        # Submitting is what moves the invoices past `approved`, so on a sent
        # package the "moved on since" control would fire on every line and tell
        # the reader to take them out of a package nothing can be taken out of.
        found = problems(
            details(
                lines=(
                    line(invoice_number="A-1", state=WorkflowState.submitted),
                    line(invoice_number="A-1", state=WorkflowState.submitted),
                ),
                payment_method=None,
                intended_payment_date=None,
                standing=closed,
            )
        )
        assert found == ()

    def test_every_problem_has_an_explanation_and_a_field(self) -> None:
        for problem in PackageProblem:
            assert PROBLEM_EXPLANATIONS[problem].strip()
            assert PROBLEM_FIELDS[problem].strip()


class TestRepeatedInvoiceNumbers:
    def test_one_supplier_twice_under_one_number_is_flagged(self) -> None:
        found = problems(
            details(
                lines=(
                    line(reference="INV-000001", invoice_number="A-1"),
                    line(reference="INV-000002", invoice_number="A-1"),
                )
            )
        )
        assert PackageProblem.repeated_invoice_number in found

    def test_case_and_padding_do_not_hide_it(self) -> None:
        found = problems(
            details(
                lines=(
                    line(reference="INV-000001", invoice_number="a-1"),
                    line(reference="INV-000002", invoice_number="  A-1 "),
                )
            )
        )
        assert PackageProblem.repeated_invoice_number in found

    def test_two_suppliers_numbering_from_one_is_ordinary(self) -> None:
        # Invoice numbering is each supplier's own business. Flagging this would
        # fire on most packages and teach the reader to click past it.
        found = problems(
            details(
                lines=(
                    line(reference="INV-000001", invoice_number="1", vendor_id=VENDOR),
                    line(
                        reference="INV-000002",
                        invoice_number="1",
                        vendor_id=OTHER_VENDOR,
                        vendor_name="Portmore Electrical",
                    ),
                )
            )
        )
        assert PackageProblem.repeated_invoice_number not in found

    def test_two_invoices_with_no_number_are_not_a_match(self) -> None:
        found = problems(
            details(
                lines=(
                    line(reference="INV-000001", invoice_number=None),
                    line(reference="INV-000002", invoice_number=""),
                )
            )
        )
        assert PackageProblem.repeated_invoice_number not in found


class TestTotals:
    def test_one_currency_totals_to_one_figure(self) -> None:
        assert totals((line(total=Money(25_000, JMD)), line(total=Money(75_000, JMD)))) == {
            JMD: Money(100_000, JMD)
        }

    def test_currencies_are_never_added_together(self) -> None:
        assert totals((line(total=Money(25_000, JMD)), line(total=Money(4_000, USD)))) == {
            JMD: Money(25_000, JMD),
            USD: Money(4_000, USD),
        }

    def test_an_empty_package_totals_to_nothing_rather_than_zero_of_something(self) -> None:
        assert totals(()) == {}

    def test_suppliers_are_counted_once_however_many_invoices_they_sent(self) -> None:
        assert (
            vendor_count(
                (
                    line(reference="INV-000001"),
                    line(reference="INV-000002"),
                    line(
                        reference="INV-000003",
                        vendor_id=OTHER_VENDOR,
                        vendor_name="Portmore Electrical",
                    ),
                )
            )
            == 2
        )

    def test_a_supplier_who_is_only_a_name_still_counts_as_one(self) -> None:
        assert (
            vendor_count(
                (
                    line(reference="INV-000001", vendor_id=None, vendor_name="Cash Hardware"),
                    line(reference="INV-000002", vendor_id=None, vendor_name="Cash Hardware"),
                )
            )
            == 1
        )


class TestSubmissionReference:
    def test_it_comes_back_tidied(self) -> None:
        assert validate_submission_reference("  BATCH   4471 ") == "BATCH 4471"

    @pytest.mark.parametrize("given", ["", "   ", "ab"])
    def test_something_too_short_to_find_anything_by_is_refused(self, given: str) -> None:
        with pytest.raises(ValueError, match="reference the bank returned"):
            validate_submission_reference(given)

    def test_an_absurd_one_is_refused(self) -> None:
        with pytest.raises(ValueError, match="cannot be longer"):
            validate_submission_reference("x" * 200)


class TestManifest:
    def rendered(self, lines: tuple[PackageLine, ...]) -> str:
        return render_manifest(
            package_reference="PKG-000007",
            payment_method=PaymentMethod.bank_transfer,
            intended_payment_date=SOON,
            lines=lines,
        ).content

    def test_it_starts_with_the_fixed_header(self) -> None:
        first = self.rendered((line(),)).split("\n")[0]
        assert first == ",".join(MANIFEST_COLUMNS)

    def test_every_row_carries_the_same_columns(self) -> None:
        content = self.rendered((line(total=Money(25_000, JMD)), line(total=Money(4_000, USD))))
        rows = [row for row in content.split("\n") if row]
        assert {len(row.split(",")) for row in rows} == {len(MANIFEST_COLUMNS)}

    def test_the_totals_are_in_the_file(self) -> None:
        # A truncated manifest that carries its own control total is a truncated
        # manifest somebody notices.
        content = self.rendered((line(total=Money(25_000, JMD)), line(total=Money(75_000, JMD))))
        assert "Total,PKG-000007,2026-05-14,Bank transfer,,,,,JMD,1000.00" in content

    def test_one_total_per_currency(self) -> None:
        content = self.rendered((line(total=Money(25_000, JMD)), line(total=Money(4_000, USD))))
        totals_rows = [row for row in content.split("\n") if row.startswith("Total,")]
        assert len(totals_rows) == 2

    def test_amounts_carry_no_thousands_separator(self) -> None:
        # A grouping comma inside a CSV field is how a manifest turns into a
        # payment for a hundredth of what was meant.
        content = self.rendered((line(total=Money(1_234_567_89, JMD)),))
        assert "123456789" not in content
        assert ",JMD,1234567.89" in content

    def test_the_amount_never_carries_the_currency_twice(self) -> None:
        content = self.rendered((line(total=Money(25_000, JMD)),))
        assert "JMD 250.00" not in content

    def test_the_order_lines_are_written_in_does_not_change_the_file(self) -> None:
        one = line(reference="INV-000001", vendor_name="Zenith Cooling")
        two = line(reference="INV-000002", vendor_name="Arawak Plumbing", vendor_id=OTHER_VENDOR)

        first = render_manifest(
            package_reference="PKG-000007",
            payment_method=PaymentMethod.bank_transfer,
            intended_payment_date=SOON,
            lines=(one, two),
        )
        second = render_manifest(
            package_reference="PKG-000007",
            payment_method=PaymentMethod.bank_transfer,
            intended_payment_date=SOON,
            lines=(two, one),
        )
        assert first.content == second.content
        assert first.digest == second.digest

    def test_lines_come_out_by_supplier(self) -> None:
        content = self.rendered(
            (
                line(reference="INV-000001", vendor_name="Zenith Cooling"),
                line(
                    reference="INV-000002",
                    vendor_name="Arawak Plumbing",
                    vendor_id=OTHER_VENDOR,
                ),
            )
        )
        assert content.index("Arawak Plumbing") < content.index("Zenith Cooling")

    def test_the_line_endings_do_not_follow_the_machine(self) -> None:
        # A digest that changes with the operating system of whoever pressed
        # submit is not evidence of anything.
        assert "\r\n" not in self.rendered((line(),))

    def test_the_digest_is_of_what_is_in_the_file(self) -> None:
        import hashlib

        manifest = render_manifest(
            package_reference="PKG-000007",
            payment_method=PaymentMethod.bank_transfer,
            intended_payment_date=SOON,
            lines=(line(),),
        )
        assert manifest.digest == hashlib.sha256(manifest.content.encode("utf-8")).hexdigest()

    def test_changing_one_amount_changes_the_digest(self) -> None:
        before = render_manifest(
            package_reference="PKG-000007",
            payment_method=PaymentMethod.bank_transfer,
            intended_payment_date=SOON,
            lines=(line(total=Money(25_000, JMD)),),
        )
        after = render_manifest(
            package_reference="PKG-000007",
            payment_method=PaymentMethod.bank_transfer,
            intended_payment_date=SOON,
            lines=(line(total=Money(25_001, JMD)),),
        )
        assert before.digest != after.digest

    def test_an_invoice_with_no_number_leaves_the_column_empty(self) -> None:
        content = self.rendered((line(invoice_number=None, due_date=None),))
        assert ",,," in content

    def test_the_count_is_of_invoices_rather_than_rows(self) -> None:
        manifest = render_manifest(
            package_reference="PKG-000007",
            payment_method=PaymentMethod.bank_transfer,
            intended_payment_date=SOON,
            lines=(line(total=Money(25_000, JMD)), line(total=Money(4_000, USD))),
        )
        assert manifest.line_count == 2

    def test_the_file_is_named_after_the_package(self) -> None:
        assert manifest_filename("PKG-000007") == "PKG-000007-manifest.csv"
