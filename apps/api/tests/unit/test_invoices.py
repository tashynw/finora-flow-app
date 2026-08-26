"""An invoice is a demand for money, so most of these tests are about refusals.

The completeness rules are the same kind of thing as the estimate ones: a gap
that stops a person deciding. The three controls are not. A duplicate that gets
through pays a vendor twice, an overrun that gets through spends money on an
approval given for a smaller figure, and a missing purchase order spends it with
no order behind it at all. Each of those is a way real money leaves the
organisation wrongly, so each is tested on its own, at its boundary, and in the
combinations where one control could quietly mask another.

Two orderings in the module are load-bearing and easy to break without noticing:
a currency mismatch is reported *instead of* an overrun, because comparing two
currencies would be meaningless; and an amount in a currency the purchase-order
threshold is not stated in requires an order rather than being waved through.
Both are asserted here so a later tidy-up cannot reverse them silently.
"""

from __future__ import annotations

from datetime import date
from uuid import UUID

import pytest

from finora.domain.invoices import (
    AWAITING_SIGN_OFF_STATES,
    BLOCKING_PROBLEMS,
    EDITABLE_STATES,
    INVOICE_STATES,
    MIN_DESCRIPTION_LENGTH,
    NO_PURCHASE_ORDER_POLICY,
    NO_TOLERANCE,
    PROBLEM_EXPLANATIONS,
    PROBLEM_FIELDS,
    InvoiceDetails,
    InvoiceProblem,
    LinkedEstimate,
    LinkedPurchaseOrder,
    PurchaseOrderPolicy,
    TolerancePolicy,
    blocking,
    explain,
    is_ready,
    problems,
)
from finora.domain.money import Money
from finora.domain.workflow import ALLOWED_TRANSITIONS, WorkflowState

TODAY = date(2026, 8, 5)

JMD = "JMD"
USD = "USD"

VENDOR_ID = UUID("11111111-1111-1111-1111-111111111111")
OTHER_VENDOR_ID = UUID("22222222-2222-2222-2222-222222222222")
ESTIMATE_ID = UUID("33333333-3333-3333-3333-333333333333")
PURCHASE_ORDER_ID = UUID("44444444-4444-4444-4444-444444444444")

VENDOR_NAME = "Kingston Supplies Limited"
OTHER_VENDOR_NAME = "Montego Bay Freight Services"
DESCRIPTION = "Replacement air handling unit for the third floor"
INVOICE_NUMBER = "INV-20260801"
COST_CENTRE_ID = "cc-facilities"
REQUESTER_ID = "u-rina-requester"

INVOICE_DATE = date(2026, 8, 1)
DUE_DATE = date(2026, 8, 31)

INVOICE_TOTAL = Money(4_500_000, JMD)
APPROVED_TOTAL = Money(4_500_000, JMD)
ORDER_TOTAL = Money(4_500_000, JMD)
NOTHING_BILLED = Money(0, JMD)

#: A round figure used wherever a test needs to reason about a ceiling in its
#: head: one hundred units of currency, in minor units.
ONE_HUNDRED = Money(10_000, JMD)


def _details(
    *,
    vendor_name: str = VENDOR_NAME,
    vendor_id: UUID | None = VENDOR_ID,
    description: str = DESCRIPTION,
    invoice_number: str | None = INVOICE_NUMBER,
    invoice_date: date | None = INVOICE_DATE,
    total: Money | None = INVOICE_TOTAL,
    cost_centre_id: object | None = COST_CENTRE_ID,
    requester_id: object | None = REQUESTER_ID,
    due_date: date | None = DUE_DATE,
    estimate: LinkedEstimate | None = None,
    purchase_order: LinkedPurchaseOrder | None = None,
    is_duplicate: bool = False,
) -> InvoiceDetails:
    """A payable invoice, with one thing at a time taken away by each test."""
    return InvoiceDetails(
        vendor_name=vendor_name,
        description=description,
        invoice_number=invoice_number,
        invoice_date=invoice_date,
        total=total,
        cost_centre_id=cost_centre_id,
        requester_id=requester_id,
        vendor_id=vendor_id,
        due_date=due_date,
        estimate=estimate,
        purchase_order=purchase_order,
        is_duplicate=is_duplicate,
    )


def _estimate(
    *,
    state: WorkflowState = WorkflowState.approved,
    vendor_id: UUID | None = VENDOR_ID,
    vendor_name: str = VENDOR_NAME,
    approved_total: Money | None = APPROVED_TOTAL,
) -> LinkedEstimate:
    """An approved estimate that the default invoice draws on cleanly."""
    return LinkedEstimate(
        estimate_id=ESTIMATE_ID,
        state=state,
        vendor_id=vendor_id,
        vendor_name=vendor_name,
        approved_total=approved_total,
    )


def _order(
    *,
    is_open: bool = True,
    vendor_id: UUID = VENDOR_ID,
    total: Money = ORDER_TOTAL,
    billed_by_others: Money = NOTHING_BILLED,
) -> LinkedPurchaseOrder:
    """An open order with room on it for the default invoice."""
    return LinkedPurchaseOrder(
        purchase_order_id=PURCHASE_ORDER_ID,
        is_open=is_open,
        vendor_id=vendor_id,
        total=total,
        billed_by_others=billed_by_others,
    )


class TestAnInvoiceWithNothingWrong:
    def test_is_ready_and_reports_no_problems(self) -> None:
        assert problems(_details(), today=TODAY) == ()
        assert is_ready(_details(), today=TODAY)

    def test_needs_no_due_date(self) -> None:
        """Payment terms are often absent from the document, and demanding a due
        date here would teach clerks to invent one."""
        assert is_ready(_details(due_date=None), today=TODAY)

    def test_may_be_dated_today(self) -> None:
        assert is_ready(_details(invoice_date=TODAY), today=TODAY)

    def test_may_fall_due_on_the_day_it_was_raised(self) -> None:
        assert is_ready(_details(invoice_date=INVOICE_DATE, due_date=INVOICE_DATE), today=TODAY)

    def test_needs_neither_an_estimate_nor_a_purchase_order(self) -> None:
        assert is_ready(_details(estimate=None, purchase_order=None), today=TODAY)


class TestTheVendor:
    @pytest.mark.parametrize("vendor_name", ["", " ", "\t\n  "])
    def test_an_unnamed_vendor_is_reported(self, vendor_name: str) -> None:
        assert InvoiceProblem.vendor_missing in problems(
            _details(vendor_name=vendor_name), today=TODAY
        )

    def test_a_vendor_named_but_not_on_the_supplier_master_is_reported(self) -> None:
        # An estimate may name a supplier in free text because nothing is paid on
        # it. Money only ever moves to a recorded vendor with bank details behind
        # it, so the invoice is where a free-text name stops being acceptable.
        found = problems(_details(vendor_id=None), today=TODAY)

        assert InvoiceProblem.vendor_not_on_master in found

    def test_an_unnamed_vendor_is_not_also_reported_as_missing_from_the_master(self) -> None:
        # One gap, one message. Telling a clerk who has entered nothing that the
        # nothing they entered is not on the supplier master helps no one.
        found = problems(_details(vendor_name="  ", vendor_id=None), today=TODAY)

        assert InvoiceProblem.vendor_missing in found
        assert InvoiceProblem.vendor_not_on_master not in found

    def test_a_named_vendor_on_the_master_is_not_reported(self) -> None:
        found = problems(_details(), today=TODAY)

        assert InvoiceProblem.vendor_missing not in found
        assert InvoiceProblem.vendor_not_on_master not in found


class TestTheInvoiceNumber:
    @pytest.mark.parametrize("invoice_number", [None, "", "   "])
    def test_a_missing_invoice_number_is_reported(self, invoice_number: str | None) -> None:
        assert InvoiceProblem.invoice_number_missing in problems(
            _details(invoice_number=invoice_number), today=TODAY
        )

    def test_a_number_of_only_whitespace_is_treated_as_absent(self) -> None:
        # The number is the key the duplicate control turns on, so a value that is
        # blank once trimmed has to count as no number at all rather than as a
        # distinct one that nothing will ever match.
        assert InvoiceProblem.invoice_number_missing in problems(
            _details(invoice_number="   "), today=TODAY
        )


class TestDuplicateControl:
    def test_a_second_invoice_with_the_same_vendor_and_number_is_refused(self) -> None:
        # The single most expensive mistake an accounts payable function makes is
        # paying the same document twice, and vendors re-sending the same PDF is
        # ordinary rather than exceptional.
        assert InvoiceProblem.duplicate_invoice_number in problems(
            _details(is_duplicate=True), today=TODAY
        )

    def test_an_invoice_that_is_not_a_duplicate_is_not_reported(self) -> None:
        assert InvoiceProblem.duplicate_invoice_number not in problems(
            _details(is_duplicate=False), today=TODAY
        )

    def test_a_duplicate_with_no_number_is_reported_as_missing_a_number_instead(self) -> None:
        # Without a number there is nothing to have matched, so reporting a
        # duplicate would be asserting something the register cannot know.
        found = problems(_details(invoice_number=None, is_duplicate=True), today=TODAY)

        assert InvoiceProblem.invoice_number_missing in found
        assert InvoiceProblem.duplicate_invoice_number not in found

    def test_a_duplicate_stops_the_invoice_rather_than_merely_flagging_it(self) -> None:
        found = problems(_details(is_duplicate=True), today=TODAY)

        assert InvoiceProblem.duplicate_invoice_number in blocking(found)
        assert not is_ready(_details(is_duplicate=True), today=TODAY)


class TestTheInvoiceDate:
    def test_a_missing_invoice_date_is_reported(self) -> None:
        assert InvoiceProblem.invoice_date_missing in problems(
            _details(invoice_date=None), today=TODAY
        )

    def test_a_date_after_today_is_reported_as_in_the_future(self) -> None:
        assert InvoiceProblem.invoice_date_in_future in problems(
            _details(invoice_date=date(2026, 8, 6), due_date=None), today=TODAY
        )

    def test_a_date_of_today_is_not_in_the_future(self) -> None:
        assert InvoiceProblem.invoice_date_in_future not in problems(
            _details(invoice_date=TODAY), today=TODAY
        )

    def test_a_missing_date_is_not_also_reported_as_in_the_future(self) -> None:
        found = problems(_details(invoice_date=None), today=TODAY)

        assert InvoiceProblem.invoice_date_missing in found
        assert InvoiceProblem.invoice_date_in_future not in found

    def test_a_due_date_before_the_invoice_date_is_reported(self) -> None:
        assert InvoiceProblem.due_date_before_invoice_date in problems(
            _details(invoice_date=date(2026, 8, 1), due_date=date(2026, 7, 1)), today=TODAY
        )

    def test_a_due_date_equal_to_the_invoice_date_is_accepted(self) -> None:
        assert InvoiceProblem.due_date_before_invoice_date not in problems(
            _details(invoice_date=date(2026, 8, 1), due_date=date(2026, 8, 1)), today=TODAY
        )

    def test_a_due_date_with_no_invoice_date_to_compare_it_to_is_not_reported(self) -> None:
        # There is no ordering to judge, and inventing one would produce a second
        # complaint about a single missing field.
        found = problems(_details(invoice_date=None, due_date=date(2026, 1, 1)), today=TODAY)

        assert InvoiceProblem.due_date_before_invoice_date not in found


class TestTheAmount:
    def test_a_missing_amount_is_reported(self) -> None:
        assert InvoiceProblem.amount_missing in problems(_details(total=None), today=TODAY)

    def test_a_zero_amount_is_reported_as_not_positive(self) -> None:
        # Distinguished from a missing one: nothing entered and nought entered are
        # different mistakes, and a credit note belongs against the invoice it
        # credits rather than being recorded as an invoice of its own.
        found = problems(_details(total=Money(0, JMD)), today=TODAY)

        assert InvoiceProblem.amount_not_positive in found
        assert InvoiceProblem.amount_missing not in found

    def test_a_negative_amount_is_reported_as_not_positive(self) -> None:
        assert InvoiceProblem.amount_not_positive in problems(
            _details(total=Money(-1, JMD)), today=TODAY
        )

    def test_a_missing_amount_is_not_also_reported_as_not_positive(self) -> None:
        found = problems(_details(total=None), today=TODAY)

        assert InvoiceProblem.amount_missing in found
        assert InvoiceProblem.amount_not_positive not in found

    def test_the_smallest_positive_amount_is_accepted(self) -> None:
        found = problems(_details(total=Money(1, JMD)), today=TODAY)

        assert InvoiceProblem.amount_not_positive not in found


class TestTheDescription:
    def test_a_description_one_character_short_of_the_floor_is_reported(self) -> None:
        short = "x" * (MIN_DESCRIPTION_LENGTH - 1)

        assert InvoiceProblem.description_missing in problems(
            _details(description=short), today=TODAY
        )

    def test_a_description_exactly_at_the_floor_is_accepted(self) -> None:
        exact = "x" * MIN_DESCRIPTION_LENGTH

        assert InvoiceProblem.description_missing not in problems(
            _details(description=exact), today=TODAY
        )

    def test_whitespace_does_not_count_towards_the_floor(self) -> None:
        # The description exists so the person confirming receipt recognises what
        # arrived, and a line of spaces tells them nothing however long it is.
        padded = " " * (MIN_DESCRIPTION_LENGTH + 10)

        assert InvoiceProblem.description_missing in problems(
            _details(description=padded), today=TODAY
        )

    def test_surrounding_whitespace_is_trimmed_before_measuring(self) -> None:
        exact = "  " + ("x" * MIN_DESCRIPTION_LENGTH) + "  "

        assert InvoiceProblem.description_missing not in problems(
            _details(description=exact), today=TODAY
        )


class TestTheCostCentre:
    def test_a_missing_cost_centre_is_reported(self) -> None:
        assert InvoiceProblem.cost_centre_missing in problems(
            _details(cost_centre_id=None), today=TODAY
        )

    def test_a_cost_centre_of_any_identifier_type_satisfies_the_rule(self) -> None:
        # The field is deliberately untyped here so the domain does not learn what
        # the persistence layer uses for a key.
        assert InvoiceProblem.cost_centre_missing not in problems(
            _details(cost_centre_id=PURCHASE_ORDER_ID), today=TODAY
        )


class TestThePersonWhoConfirmsReceipt:
    def test_an_invoice_with_nobody_to_confirm_it_is_reported(self) -> None:
        # Receipt confirmation is the control that keeps finance from paying for
        # goods nobody received, so an invoice with nobody to ask is not merely
        # untidy: it cannot be sent anywhere.
        assert InvoiceProblem.requester_missing in problems(
            _details(requester_id=None), today=TODAY
        )

    def test_naming_somebody_satisfies_the_rule(self) -> None:
        assert InvoiceProblem.requester_missing not in problems(_details(), today=TODAY)


class TestReportingAllOfThemAtOnce:
    def test_an_empty_invoice_reports_every_gap_rather_than_the_first(self) -> None:
        # A clerk discovering the remaining work one refusal at a time is the
        # failure the collection return type was chosen to avoid.
        found = problems(
            InvoiceDetails(
                vendor_name="",
                description="",
                invoice_number=None,
                invoice_date=None,
                total=None,
                cost_centre_id=None,
            ),
            today=TODAY,
        )

        assert set(found) == {
            InvoiceProblem.vendor_missing,
            InvoiceProblem.invoice_number_missing,
            InvoiceProblem.invoice_date_missing,
            InvoiceProblem.amount_missing,
            InvoiceProblem.description_missing,
            InvoiceProblem.cost_centre_missing,
            InvoiceProblem.requester_missing,
        }

    def test_gaps_and_fired_controls_are_reported_together(self) -> None:
        found = problems(
            _details(
                description="x",
                invoice_date=date(2026, 9, 1),
                due_date=date(2026, 8, 1),
                total=Money(5_000_000, JMD),
                cost_centre_id=None,
                is_duplicate=True,
                estimate=_estimate(state=WorkflowState.draft, approved_total=Money(1_000_000, JMD)),
                purchase_order=_order(is_open=False, total=Money(1_000_000, JMD)),
            ),
            today=TODAY,
        )

        assert set(found) == {
            InvoiceProblem.invoice_date_in_future,
            InvoiceProblem.due_date_before_invoice_date,
            InvoiceProblem.description_missing,
            InvoiceProblem.cost_centre_missing,
            InvoiceProblem.duplicate_invoice_number,
            InvoiceProblem.estimate_not_approved,
            InvoiceProblem.exceeds_estimate,
            InvoiceProblem.purchase_order_not_open,
            InvoiceProblem.exceeds_purchase_order,
        }

    def test_no_problem_is_reported_twice(self) -> None:
        found = problems(
            _details(vendor_name="", description="", total=None, cost_centre_id=None),
            today=TODAY,
        )

        assert len(found) == len(set(found))


class TestAgainstTheApprovedEstimate:
    @pytest.mark.parametrize(
        "state",
        [
            WorkflowState.draft,
            WorkflowState.pending_sign_off,
            WorkflowState.pending_approval,
            WorkflowState.rejected,
            WorkflowState.cancelled,
            WorkflowState.exception,
        ],
    )
    def test_an_estimate_that_has_not_been_approved_is_reported(self, state: WorkflowState) -> None:
        # Drawing on an estimate that nobody approved is spending against a
        # permission that was never granted, whatever stage the request reached.
        assert InvoiceProblem.estimate_not_approved in problems(
            _details(estimate=_estimate(state=state)), today=TODAY
        )

    def test_an_approved_estimate_raises_nothing(self) -> None:
        assert problems(_details(estimate=_estimate()), today=TODAY) == ()

    def test_an_estimate_for_a_different_vendor_by_identifier_is_reported(self) -> None:
        # An approval belongs to the supplier it was granted for. Letting another
        # vendor bill against it spends an approval nobody gave them.
        assert InvoiceProblem.estimate_vendor_mismatch in problems(
            _details(estimate=_estimate(vendor_id=OTHER_VENDOR_ID)), today=TODAY
        )

    def test_a_different_vendor_name_is_reported_when_neither_side_has_an_identifier(
        self,
    ) -> None:
        found = problems(
            _details(
                vendor_id=None,
                estimate=_estimate(vendor_id=None, vendor_name=OTHER_VENDOR_NAME),
            ),
            today=TODAY,
        )

        assert InvoiceProblem.estimate_vendor_mismatch in found

    @pytest.mark.parametrize(
        "estimate_vendor_name",
        [VENDOR_NAME, VENDOR_NAME.upper(), VENDOR_NAME.lower(), f"  {VENDOR_NAME}  "],
    )
    def test_the_same_name_differently_cased_or_padded_is_not_a_mismatch(
        self, estimate_vendor_name: str
    ) -> None:
        found = problems(
            _details(
                vendor_id=None,
                estimate=_estimate(vendor_id=None, vendor_name=estimate_vendor_name),
            ),
            today=TODAY,
        )

        assert InvoiceProblem.estimate_vendor_mismatch not in found

    def test_matching_identifiers_settle_the_question_even_when_the_names_differ(self) -> None:
        # A vendor that has been renamed since the estimate was approved is still
        # the same vendor. Comparing names once identifiers exist would break a
        # valid link and send a correct invoice back for no reason.
        found = problems(
            _details(estimate=_estimate(vendor_name=OTHER_VENDOR_NAME)),
            today=TODAY,
        )

        assert InvoiceProblem.estimate_vendor_mismatch not in found

    def test_an_invoice_for_more_than_was_approved_is_reported(self) -> None:
        # The approval covers the smaller figure, so the difference has been
        # approved by nobody and needs a fresh decision rather than a payment.
        assert InvoiceProblem.exceeds_estimate in problems(
            _details(
                total=Money(4_500_001, JMD),
                estimate=_estimate(approved_total=Money(4_500_000, JMD)),
            ),
            today=TODAY,
        )

    def test_an_invoice_for_exactly_the_approved_figure_is_accepted(self) -> None:
        assert (
            problems(
                _details(
                    total=Money(4_500_000, JMD),
                    estimate=_estimate(approved_total=Money(4_500_000, JMD)),
                ),
                today=TODAY,
            )
            == ()
        )

    def test_an_invoice_below_the_approved_figure_is_accepted(self) -> None:
        assert (
            problems(
                _details(
                    total=Money(1_000_000, JMD),
                    estimate=_estimate(approved_total=Money(4_500_000, JMD)),
                ),
                today=TODAY,
            )
            == ()
        )

    def test_an_estimate_in_another_currency_is_reported_as_a_mismatch(self) -> None:
        assert InvoiceProblem.estimate_currency_mismatch in problems(
            _details(
                total=Money(4_500_000, JMD),
                estimate=_estimate(approved_total=Money(30_000, USD)),
            ),
            today=TODAY,
        )

    def test_an_estimate_in_another_currency_is_never_also_an_overrun(self) -> None:
        # Thirty thousand of one currency against four and a half million of
        # another is not a comparison, it is two unrelated numbers. Reporting an
        # overrun here would put a figure on a difference that does not exist,
        # so the mismatch is raised instead and the comparison never happens.
        found = problems(
            _details(
                total=Money(4_500_000, JMD),
                estimate=_estimate(approved_total=Money(30_000, USD)),
            ),
            today=TODAY,
        )

        assert InvoiceProblem.estimate_currency_mismatch in found
        assert InvoiceProblem.exceeds_estimate not in found

    def test_an_estimate_with_no_approved_figure_supports_no_comparison(self) -> None:
        found = problems(_details(estimate=_estimate(approved_total=None)), today=TODAY)

        assert InvoiceProblem.exceeds_estimate not in found
        assert InvoiceProblem.estimate_currency_mismatch not in found

    def test_an_invoice_with_no_amount_supports_no_comparison(self) -> None:
        found = problems(_details(total=None, estimate=_estimate()), today=TODAY)

        assert InvoiceProblem.exceeds_estimate not in found
        assert InvoiceProblem.estimate_currency_mismatch not in found

    def test_an_unlinked_invoice_raises_no_estimate_problems(self) -> None:
        found = problems(_details(estimate=None), today=TODAY)

        assert not set(found) & {
            InvoiceProblem.estimate_not_approved,
            InvoiceProblem.estimate_vendor_mismatch,
            InvoiceProblem.estimate_currency_mismatch,
            InvoiceProblem.exceeds_estimate,
        }

    def test_several_estimate_problems_are_reported_together(self) -> None:
        found = problems(
            _details(
                total=Money(9_000_000, JMD),
                estimate=_estimate(
                    state=WorkflowState.pending_approval,
                    vendor_id=OTHER_VENDOR_ID,
                    approved_total=Money(4_500_000, JMD),
                ),
            ),
            today=TODAY,
        )

        assert set(found) == {
            InvoiceProblem.estimate_not_approved,
            InvoiceProblem.estimate_vendor_mismatch,
            InvoiceProblem.exceeds_estimate,
        }


#: One million Jamaican cents, above which an order is required. Only JMD is
#: configured, which is the point of several tests below: a currency with no
#: figure of its own is not silently exempt.
JMD_ONLY = PurchaseOrderPolicy(thresholds={JMD: Money(1_000_000, JMD)})


class TestWhenAPurchaseOrderIsRequired:
    def test_spend_above_the_threshold_without_an_order_is_reported(self) -> None:
        assert InvoiceProblem.purchase_order_required in problems(
            _details(total=Money(4_500_000, JMD)),
            today=TODAY,
            purchase_orders=JMD_ONLY,
        )

    def test_spend_exactly_at_the_threshold_needs_no_order(self) -> None:
        assert (
            problems(
                _details(total=Money(1_000_000, JMD)),
                today=TODAY,
                purchase_orders=JMD_ONLY,
            )
            == ()
        )

    def test_spend_below_the_threshold_needs_no_order(self) -> None:
        assert (
            problems(
                _details(total=Money(999_999, JMD)),
                today=TODAY,
                purchase_orders=JMD_ONLY,
            )
            == ()
        )

    def test_an_amount_in_a_currency_with_no_threshold_of_its_own_requires_an_order(
        self,
    ) -> None:
        # Ten thousand US cents is far below a million Jamaican cents at any rate,
        # but no rate is recorded here and inventing one would decide a spending
        # control by guesswork. Requiring the order is the answer that fails
        # towards the control: a person is asked, rather than a threshold being
        # silently cleared by an assumed exchange rate.
        assert InvoiceProblem.purchase_order_required in problems(
            _details(total=Money(10_000, USD)),
            today=TODAY,
            purchase_orders=JMD_ONLY,
        )

    def test_a_currency_with_its_own_threshold_is_judged_against_that_one(self) -> None:
        policy = PurchaseOrderPolicy(
            thresholds={JMD: Money(1_000_000, JMD), USD: Money(50_000, USD)}
        )

        assert (
            problems(_details(total=Money(10_000, USD)), today=TODAY, purchase_orders=policy) == ()
        )
        assert InvoiceProblem.purchase_order_required in problems(
            _details(total=Money(60_000, USD)), today=TODAY, purchase_orders=policy
        )

    def test_no_configured_threshold_never_requires_an_order(self) -> None:
        assert InvoiceProblem.purchase_order_required not in problems(
            _details(total=Money(999_999_999, JMD)),
            today=TODAY,
            purchase_orders=NO_PURCHASE_ORDER_POLICY,
        )

    def test_an_invoice_with_no_amount_does_not_require_an_order(self) -> None:
        # The amount is already being reported as missing. A second complaint
        # about an order that may turn out not to be needed is noise.
        found = problems(_details(total=None), today=TODAY, purchase_orders=JMD_ONLY)

        assert InvoiceProblem.purchase_order_required not in found

    def test_a_linked_order_satisfies_the_threshold(self) -> None:
        assert (
            problems(
                _details(total=Money(4_500_000, JMD), purchase_order=_order()),
                today=TODAY,
                purchase_orders=JMD_ONLY,
            )
            == ()
        )

    def test_a_required_order_stops_the_invoice(self) -> None:
        found = problems(_details(), today=TODAY, purchase_orders=JMD_ONLY)

        assert InvoiceProblem.purchase_order_required in blocking(found)


class TestAgainstThePurchaseOrder:
    def test_an_order_that_is_closed_or_cancelled_is_reported(self) -> None:
        assert InvoiceProblem.purchase_order_not_open in problems(
            _details(purchase_order=_order(is_open=False)), today=TODAY
        )

    def test_an_open_order_is_not_reported(self) -> None:
        assert InvoiceProblem.purchase_order_not_open not in problems(
            _details(purchase_order=_order(is_open=True)), today=TODAY
        )

    def test_an_order_raised_for_a_different_vendor_is_reported(self) -> None:
        # Billing one supplier's invoice against another's order both pays the
        # wrong commitment and hides how much of the right one is left.
        assert InvoiceProblem.purchase_order_vendor_mismatch in problems(
            _details(purchase_order=_order(vendor_id=OTHER_VENDOR_ID)), today=TODAY
        )

    def test_no_vendor_identifier_on_the_invoice_supports_no_vendor_comparison(self) -> None:
        found = problems(
            _details(vendor_id=None, purchase_order=_order(vendor_id=OTHER_VENDOR_ID)),
            today=TODAY,
        )

        assert InvoiceProblem.purchase_order_vendor_mismatch not in found
        assert InvoiceProblem.vendor_not_on_master in found

    def test_an_order_in_another_currency_is_reported_as_a_mismatch(self) -> None:
        found = problems(
            _details(
                total=Money(4_500_000, JMD),
                purchase_order=_order(total=Money(30_000, USD), billed_by_others=Money(0, USD)),
            ),
            today=TODAY,
        )

        assert InvoiceProblem.purchase_order_currency_mismatch in found

    def test_an_order_in_another_currency_is_never_also_an_overrun(self) -> None:
        # As with the estimate, comparing across currencies without a recorded
        # rate would produce a refusal built on an invented number.
        found = problems(
            _details(
                total=Money(4_500_000, JMD),
                purchase_order=_order(total=Money(30_000, USD), billed_by_others=Money(0, USD)),
            ),
            today=TODAY,
        )

        assert InvoiceProblem.exceeds_purchase_order not in found

    def test_amounts_already_billed_in_another_currency_are_reported_as_a_mismatch(self) -> None:
        # The order agrees with the invoice but the running total does not, so the
        # cumulative sum cannot be formed and the control cannot be evaluated.
        found = problems(
            _details(
                total=Money(1_000_000, JMD),
                purchase_order=_order(
                    total=Money(4_500_000, JMD), billed_by_others=Money(300, USD)
                ),
            ),
            today=TODAY,
        )

        assert InvoiceProblem.purchase_order_currency_mismatch in found
        assert InvoiceProblem.exceeds_purchase_order not in found

    def test_an_invoice_within_what_is_left_on_the_order_is_accepted(self) -> None:
        assert (
            problems(
                _details(
                    total=Money(2_000, JMD),
                    purchase_order=_order(total=ONE_HUNDRED, billed_by_others=Money(7_000, JMD)),
                ),
                today=TODAY,
            )
            == ()
        )

    def test_an_invoice_that_exactly_fills_the_order_is_accepted(self) -> None:
        assert (
            problems(
                _details(
                    total=Money(3_000, JMD),
                    purchase_order=_order(total=ONE_HUNDRED, billed_by_others=Money(7_000, JMD)),
                ),
                today=TODAY,
            )
            == ()
        )

    def test_an_order_already_billed_cannot_take_an_invoice_that_fits_it_alone(self) -> None:
        # An order of a hundred with seventy already billed against it has thirty
        # left, and forty does not fit in thirty. Judging each invoice against the
        # order's face value instead would let four invoices of forty draw a
        # hundred and sixty from a hundred, none of them individually over it.
        found = problems(
            _details(
                total=Money(4_000, JMD),
                purchase_order=_order(total=ONE_HUNDRED, billed_by_others=Money(7_000, JMD)),
            ),
            today=TODAY,
        )

        assert InvoiceProblem.exceeds_purchase_order in found

    def test_an_invoice_larger_than_the_whole_order_is_reported(self) -> None:
        assert InvoiceProblem.exceeds_purchase_order in problems(
            _details(
                total=Money(10_001, JMD),
                purchase_order=_order(total=ONE_HUNDRED, billed_by_others=NOTHING_BILLED),
            ),
            today=TODAY,
        )

    def test_an_order_with_nothing_billed_against_it_takes_its_full_value(self) -> None:
        assert (
            problems(
                _details(
                    total=ONE_HUNDRED,
                    purchase_order=_order(total=ONE_HUNDRED, billed_by_others=NOTHING_BILLED),
                ),
                today=TODAY,
            )
            == ()
        )

    def test_an_invoice_with_no_amount_supports_no_comparison_against_the_order(self) -> None:
        found = problems(_details(total=None, purchase_order=_order()), today=TODAY)

        assert InvoiceProblem.exceeds_purchase_order not in found
        assert InvoiceProblem.purchase_order_currency_mismatch not in found

    def test_several_order_problems_are_reported_together(self) -> None:
        found = problems(
            _details(
                total=Money(10_001, JMD),
                purchase_order=_order(
                    is_open=False,
                    vendor_id=OTHER_VENDOR_ID,
                    total=ONE_HUNDRED,
                    billed_by_others=NOTHING_BILLED,
                ),
            ),
            today=TODAY,
        )

        assert set(found) == {
            InvoiceProblem.purchase_order_not_open,
            InvoiceProblem.purchase_order_vendor_mismatch,
            InvoiceProblem.exceeds_purchase_order,
        }

    def test_an_unlinked_invoice_raises_no_order_problems(self) -> None:
        found = problems(_details(purchase_order=None), today=TODAY)

        assert not set(found) & {
            InvoiceProblem.purchase_order_not_open,
            InvoiceProblem.purchase_order_vendor_mismatch,
            InvoiceProblem.purchase_order_currency_mismatch,
            InvoiceProblem.exceeds_purchase_order,
        }


class TestTheToleranceCeiling:
    def test_no_tolerance_allows_nothing_above_the_approved_figure(self) -> None:
        assert NO_TOLERANCE.ceiling(ONE_HUNDRED) == ONE_HUNDRED

    def test_a_percentage_is_taken_of_the_approved_figure(self) -> None:
        assert TolerancePolicy(percent=10).ceiling(ONE_HUNDRED) == Money(11_000, JMD)

    def test_an_absolute_allowance_is_added_to_the_approved_figure(self) -> None:
        assert TolerancePolicy(minor_units=500).ceiling(ONE_HUNDRED) == Money(10_500, JMD)

    def test_the_larger_of_the_two_allowances_applies(self) -> None:
        # A percentage alone is worthless on a small invoice, where a few cents of
        # rounding is a larger proportion than any sane percentage; an absolute
        # allowance alone is either meaningless or reckless depending on the size
        # of the invoice. Taking the larger is what makes both usable at once.
        both = TolerancePolicy(percent=10, minor_units=500)

        assert both.ceiling(ONE_HUNDRED) == Money(11_000, JMD)
        assert both.ceiling(Money(1_000, JMD)) == Money(1_500, JMD)

    def test_a_fraction_of_a_minor_unit_is_never_allowed(self) -> None:
        # Ten per cent of a hundred and five is ten and a half minor units, and
        # rounding a control upwards hands out an allowance nobody configured.
        assert TolerancePolicy(percent=10).ceiling(Money(105, JMD)) == Money(115, JMD)

    def test_the_ceiling_stays_in_the_currency_it_was_given(self) -> None:
        assert TolerancePolicy(percent=10).ceiling(Money(30_000, USD)).currency == USD


class TestToleranceAgainstTheEstimate:
    def test_the_default_policy_tolerates_nothing(self) -> None:
        # A tolerance is a deliberate decision by whoever configures the platform.
        # Reaching for a default would hand out an allowance nobody agreed to.
        assert InvoiceProblem.exceeds_estimate in problems(
            _details(total=Money(10_001, JMD), estimate=_estimate(approved_total=ONE_HUNDRED)),
            today=TODAY,
        )

    def test_an_overrun_inside_a_percentage_allowance_is_not_reported(self) -> None:
        assert (
            problems(
                _details(total=Money(10_500, JMD), estimate=_estimate(approved_total=ONE_HUNDRED)),
                today=TODAY,
                tolerance=TolerancePolicy(percent=10),
            )
            == ()
        )

    def test_an_overrun_inside_an_absolute_allowance_is_not_reported(self) -> None:
        assert (
            problems(
                _details(total=Money(10_400, JMD), estimate=_estimate(approved_total=ONE_HUNDRED)),
                today=TODAY,
                tolerance=TolerancePolicy(minor_units=500),
            )
            == ()
        )

    @pytest.mark.parametrize(
        ("tolerance", "ceiling_minor_units"),
        [
            (TolerancePolicy(percent=10), 11_000),
            (TolerancePolicy(minor_units=500), 10_500),
            (TolerancePolicy(percent=10, minor_units=500), 11_000),
            (TolerancePolicy(percent=1, minor_units=900), 10_900),
        ],
    )
    def test_an_invoice_exactly_at_the_ceiling_clears(
        self, tolerance: TolerancePolicy, ceiling_minor_units: int
    ) -> None:
        assert (
            problems(
                _details(
                    total=Money(ceiling_minor_units, JMD),
                    estimate=_estimate(approved_total=ONE_HUNDRED),
                ),
                today=TODAY,
                tolerance=tolerance,
            )
            == ()
        )

    @pytest.mark.parametrize(
        ("tolerance", "ceiling_minor_units"),
        [
            (TolerancePolicy(percent=10), 11_000),
            (TolerancePolicy(minor_units=500), 10_500),
            (TolerancePolicy(percent=10, minor_units=500), 11_000),
            (TolerancePolicy(percent=1, minor_units=900), 10_900),
        ],
    )
    def test_one_minor_unit_above_the_ceiling_does_not_clear(
        self, tolerance: TolerancePolicy, ceiling_minor_units: int
    ) -> None:
        # The boundary is where a tolerance either works or quietly becomes an
        # off-by-one that lets every invoice through at one unit over.
        assert InvoiceProblem.exceeds_estimate in problems(
            _details(
                total=Money(ceiling_minor_units + 1, JMD),
                estimate=_estimate(approved_total=ONE_HUNDRED),
            ),
            today=TODAY,
            tolerance=tolerance,
        )

    def test_a_zero_tolerance_reports_the_smallest_possible_overrun(self) -> None:
        assert InvoiceProblem.exceeds_estimate in problems(
            _details(total=Money(10_001, JMD), estimate=_estimate(approved_total=ONE_HUNDRED)),
            today=TODAY,
            tolerance=NO_TOLERANCE,
        )


class TestToleranceAgainstThePurchaseOrder:
    def test_an_overrun_inside_the_allowance_is_not_reported(self) -> None:
        # Thirty left on the order plus ten of headroom, so forty clears where it
        # would otherwise be refused as a cumulative overrun.
        assert (
            problems(
                _details(
                    total=Money(4_000, JMD),
                    purchase_order=_order(total=ONE_HUNDRED, billed_by_others=Money(7_000, JMD)),
                ),
                today=TODAY,
                tolerance=TolerancePolicy(percent=10),
            )
            == ()
        )

    def test_one_minor_unit_above_the_allowance_is_reported(self) -> None:
        assert InvoiceProblem.exceeds_purchase_order in problems(
            _details(
                total=Money(4_001, JMD),
                purchase_order=_order(total=ONE_HUNDRED, billed_by_others=Money(7_000, JMD)),
            ),
            today=TODAY,
            tolerance=TolerancePolicy(percent=10),
        )

    def test_the_allowance_is_measured_against_the_order_not_what_is_left_of_it(self) -> None:
        # Ten per cent of the order is a hundred minor units of headroom whether
        # the order is untouched or nearly exhausted, so a tolerance cannot be
        # multiplied by splitting one invoice into several.
        found = problems(
            _details(
                total=Money(1_100, JMD),
                purchase_order=_order(total=ONE_HUNDRED, billed_by_others=Money(9_000, JMD)),
            ),
            today=TODAY,
            tolerance=TolerancePolicy(percent=1),
        )

        assert found == ()

    def test_an_absolute_allowance_applies_to_the_order_as_well(self) -> None:
        assert (
            problems(
                _details(
                    total=Money(3_500, JMD),
                    purchase_order=_order(total=ONE_HUNDRED, billed_by_others=Money(7_000, JMD)),
                ),
                today=TODAY,
                tolerance=TolerancePolicy(minor_units=500),
            )
            == ()
        )


class TestWhatToleranceMustNeverExcuse:
    @pytest.mark.parametrize(
        ("details", "expected"),
        [
            (
                _details(is_duplicate=True),
                InvoiceProblem.duplicate_invoice_number,
            ),
            (
                _details(estimate=_estimate(state=WorkflowState.draft)),
                InvoiceProblem.estimate_not_approved,
            ),
            (
                _details(estimate=_estimate(vendor_id=OTHER_VENDOR_ID)),
                InvoiceProblem.estimate_vendor_mismatch,
            ),
            (
                _details(purchase_order=_order(is_open=False)),
                InvoiceProblem.purchase_order_not_open,
            ),
            (
                _details(cost_centre_id=None),
                InvoiceProblem.cost_centre_missing,
            ),
        ],
    )
    def test_a_generous_allowance_only_ever_forgives_an_overrun(
        self, details: InvoiceDetails, expected: InvoiceProblem
    ) -> None:
        # A tolerance is a statement about how large a difference is worth a
        # person's attention. Letting it suppress anything else would turn one
        # configured number into a way of switching the controls off.
        assert expected in problems(
            details, today=TODAY, tolerance=TolerancePolicy(percent=1_000, minor_units=10**9)
        )

    def test_an_invoice_with_no_amount_is_unaffected_by_a_tolerance(self) -> None:
        found = problems(
            _details(total=None, estimate=_estimate()),
            today=TODAY,
            tolerance=TolerancePolicy(percent=10),
        )

        assert InvoiceProblem.amount_missing in found

    def test_a_currency_mismatch_is_not_forgiven_by_an_allowance(self) -> None:
        # There is no ceiling to compare against across two currencies, so a
        # tolerance has nothing to say and must leave the mismatch standing.
        found = problems(
            _details(
                total=Money(4_500_000, JMD),
                estimate=_estimate(approved_total=Money(30_000, USD)),
            ),
            today=TODAY,
            tolerance=TolerancePolicy(percent=1_000, minor_units=10**9),
        )

        assert InvoiceProblem.estimate_currency_mismatch in found


class TestWhichProblemsStopAPayment:
    def test_an_incomplete_draft_is_not_blocked(self) -> None:
        # An unfinished draft is the requester's ordinary work in progress. Showing
        # it in the register beside a duplicate or an overrun would bury the
        # handful of records where a control has actually fired.
        found = problems(
            InvoiceDetails(
                vendor_name="",
                description="",
                invoice_number=None,
                invoice_date=None,
                total=None,
                cost_centre_id=None,
            ),
            today=TODAY,
        )

        assert found != ()
        assert blocking(found) == ()

    def test_only_the_controls_are_returned(self) -> None:
        found = problems(
            _details(cost_centre_id=None, description="x", is_duplicate=True), today=TODAY
        )

        assert blocking(found) == (InvoiceProblem.duplicate_invoice_number,)

    def test_nothing_reported_means_nothing_blocking(self) -> None:
        assert blocking(()) == ()

    def test_every_returned_problem_is_a_blocking_one(self) -> None:
        assert set(blocking(tuple(InvoiceProblem))) == set(BLOCKING_PROBLEMS)

    def test_the_order_problems_were_reported_in_is_preserved(self) -> None:
        # The register lists them in the order the rules ran, so a re-ordering
        # here would silently change what a reviewer reads first.
        found = problems(
            _details(
                description="x",
                is_duplicate=True,
                total=Money(10_001, JMD),
                estimate=_estimate(state=WorkflowState.draft, approved_total=ONE_HUNDRED),
            ),
            today=TODAY,
        )

        assert blocking(found) == (
            InvoiceProblem.duplicate_invoice_number,
            InvoiceProblem.estimate_not_approved,
            InvoiceProblem.exceeds_estimate,
        )

    @pytest.mark.parametrize(
        "problem",
        [
            InvoiceProblem.vendor_missing,
            InvoiceProblem.vendor_not_on_master,
            InvoiceProblem.invoice_number_missing,
            InvoiceProblem.invoice_date_missing,
            InvoiceProblem.invoice_date_in_future,
            InvoiceProblem.amount_missing,
            InvoiceProblem.amount_not_positive,
            InvoiceProblem.due_date_before_invoice_date,
            InvoiceProblem.description_missing,
            InvoiceProblem.cost_centre_missing,
            InvoiceProblem.requester_missing,
        ],
    )
    def test_an_ordinary_gap_is_not_a_control(self, problem: InvoiceProblem) -> None:
        assert problem not in BLOCKING_PROBLEMS

    @pytest.mark.parametrize(
        "problem",
        [
            InvoiceProblem.duplicate_invoice_number,
            InvoiceProblem.estimate_not_approved,
            InvoiceProblem.estimate_vendor_mismatch,
            InvoiceProblem.estimate_currency_mismatch,
            InvoiceProblem.exceeds_estimate,
            InvoiceProblem.purchase_order_required,
            InvoiceProblem.purchase_order_not_open,
            InvoiceProblem.purchase_order_vendor_mismatch,
            InvoiceProblem.purchase_order_currency_mismatch,
            InvoiceProblem.exceeds_purchase_order,
        ],
    )
    def test_every_control_is_treated_as_blocking(self, problem: InvoiceProblem) -> None:
        assert problem in BLOCKING_PROBLEMS


class TestWhenAnInvoiceIsReady:
    def test_readiness_means_nothing_at_all_was_reported(self) -> None:
        assert is_ready(_details(), today=TODAY) is True

    @pytest.mark.parametrize(
        "details",
        [
            _details(vendor_name=""),
            _details(vendor_id=None),
            _details(invoice_number=None),
            _details(invoice_date=None),
            _details(total=None),
            _details(total=Money(0, JMD)),
            _details(description="x"),
            _details(cost_centre_id=None),
            _details(is_duplicate=True),
            _details(estimate=_estimate(state=WorkflowState.draft)),
            _details(purchase_order=_order(is_open=False)),
        ],
    )
    def test_a_single_gap_or_control_is_enough_to_hold_it(self, details: InvoiceDetails) -> None:
        # Readiness is not a score. One unanswered question is enough, because the
        # next step after this is money leaving the organisation.
        assert is_ready(details, today=TODAY) is False

    def test_readiness_takes_the_threshold_into_account(self) -> None:
        assert is_ready(_details(), today=TODAY, purchase_orders=JMD_ONLY) is False

    def test_readiness_takes_the_tolerance_into_account(self) -> None:
        over = _details(total=Money(10_500, JMD), estimate=_estimate(approved_total=ONE_HUNDRED))

        assert is_ready(over, today=TODAY) is False
        assert is_ready(over, today=TODAY, tolerance=TolerancePolicy(percent=10)) is True


class TestEveryProblemCanBeExplainedAndPointedAt:
    def test_each_problem_has_an_explanation(self) -> None:
        """A control that fires with no words is a screen saying something is
        wrong and not what, which is how a refusal becomes a support call."""
        assert set(PROBLEM_EXPLANATIONS) == set(InvoiceProblem)

    def test_each_problem_names_the_field_to_send_the_user_to(self) -> None:
        assert set(PROBLEM_FIELDS) == set(InvoiceProblem)

    @pytest.mark.parametrize("problem", list(InvoiceProblem))
    def test_no_explanation_is_empty(self, problem: InvoiceProblem) -> None:
        assert PROBLEM_EXPLANATIONS[problem].strip()

    @pytest.mark.parametrize("problem", list(InvoiceProblem))
    def test_no_field_is_empty(self, problem: InvoiceProblem) -> None:
        assert PROBLEM_FIELDS[problem].strip()

    @pytest.mark.parametrize("problem", list(InvoiceProblem))
    def test_explain_returns_the_recorded_wording(self, problem: InvoiceProblem) -> None:
        assert explain(problem) == PROBLEM_EXPLANATIONS[problem]

    def test_every_blocking_problem_is_a_known_problem(self) -> None:
        assert BLOCKING_PROBLEMS <= frozenset(InvoiceProblem)


class TestTheStatesAnInvoiceUses:
    def test_an_invoice_runs_the_whole_workflow(self) -> None:
        """Unlike an estimate, an invoice goes all the way to money leaving the
        organisation, so every state in the machine is one it can occupy."""
        assert INVOICE_STATES == frozenset(WorkflowState)

    def test_editing_stops_before_anyone_signs_off(self) -> None:
        # Sign-off is a decision about a specific figure. If the amount could
        # still change afterwards, the person who confirmed receipt would have
        # confirmed something other than what is paid.
        assert EDITABLE_STATES == frozenset({WorkflowState.draft, WorkflowState.exception})
        assert WorkflowState.pending_sign_off not in EDITABLE_STATES
        assert WorkflowState.pending_approval not in EDITABLE_STATES

    def test_a_paid_invoice_can_never_be_edited(self) -> None:
        assert WorkflowState.paid not in EDITABLE_STATES

    def test_only_one_state_waits_on_a_person_to_confirm_receipt(self) -> None:
        assert AWAITING_SIGN_OFF_STATES == frozenset({WorkflowState.pending_sign_off})

    @pytest.mark.parametrize("states", [EDITABLE_STATES, AWAITING_SIGN_OFF_STATES])
    def test_each_subset_is_drawn_from_the_states_an_invoice_can_occupy(
        self, states: frozenset[WorkflowState]
    ) -> None:
        assert states <= INVOICE_STATES

    def test_every_invoice_state_is_reachable_through_the_state_machine(self) -> None:
        """A state an invoice may occupy but the transition rules cannot reach is
        a record that could only be put there by writing to the database."""
        reachable = {WorkflowState.draft}
        frontier = [WorkflowState.draft]
        while frontier:
            for target in ALLOWED_TRANSITIONS[frontier.pop()]:
                if target in INVOICE_STATES and target not in reachable:
                    reachable.add(target)
                    frontier.append(target)

        assert reachable == set(INVOICE_STATES)
