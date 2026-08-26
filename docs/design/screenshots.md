# Screenshot index

Every screen this build has shipped, with the approved image for each. The images
are the visual regression baselines themselves rather than copies, so this index
cannot drift from what the gate actually compares against.

They are produced by driving the real application against a real API, database,
object store and malware scanner, on a database rebuilt for the run. See
[ADR 5](../adr/0005-visual-regression-against-the-real-stack.md) for why, and for
what the constraints of that choice are.

## Reading the file names

`<screen>-<project>-<platform>.png`, for example `intake-queue-tablet-win32.png`.

| Project | Viewport | Covers |
| --- | --- | --- |
| `desktop` | 1440 × 900 | The primary working width |
| `tablet` | 768 × 1024 | The breakpoint where the sidebar collapses |
| `mobile` | 390 × 844 | The narrowest supported width |
| `flows` | 1440 × 900 | Screens reached only by uploading a document |
| `review` | 1440 × 900 | Screens reached only by a document having been read |
| `estimates` | 1440 × 900 | Screens reached only by an estimate being raised and decided |
| `invoices` | 1440 × 900 | Screens reached only by an invoice being recorded, confirmed and decided |
| `payments` | 1440 × 900 | Screens reached only by approved invoices being packaged and sent |

The platform suffix is not decoration. Font rasterisation differs between
operating systems, so a baseline is only valid for the platform that produced it.
Regenerate the set for yours; do not replace someone else's.

Hidden areas in an image are deliberate. Anything marked `data-visual-volatile`
— timestamps, and the digest of a message built at the moment it arrives — is
hidden for the screenshot while keeping its space, so its position is still
checked and its content cannot fail a baseline for having moved on.

Panes marked `data-visual-sticky`, the top bar and the document viewer, are
returned to the normal flow for the photograph. A full-page screenshot is taken by
scrolling, and a sticky pane follows that scroll, so it would otherwise be drawn
across the middle of the image over the content it is meant to sit beside.

## Phase 2 — intake

Baselines live in `apps/web/tests/visual/baselines/`.

| Screen | Role | Baselines |
| --- | --- | --- |
| Intake queue, nothing received yet | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/intake.spec.ts-snapshots/intake-queue-desktop-win32.png), [tablet](../../apps/web/tests/visual/baselines/intake.spec.ts-snapshots/intake-queue-tablet-win32.png), [mobile](../../apps/web/tests/visual/baselines/intake.spec.ts-snapshots/intake-queue-mobile-win32.png) |
| Upload dialog | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/intake.spec.ts-snapshots/intake-upload-dialog-desktop-win32.png), [tablet](../../apps/web/tests/visual/baselines/intake.spec.ts-snapshots/intake-upload-dialog-tablet-win32.png), [mobile](../../apps/web/tests/visual/baselines/intake.spec.ts-snapshots/intake-upload-dialog-mobile-win32.png) |
| Upload accepted, scanned clean | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/upload.spec.ts-snapshots/upload-accepted-flows-win32.png) |
| Intake queue with a record | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/upload.spec.ts-snapshots/intake-queue-populated-flows-win32.png) |
| Message detail, attachments and provenance | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/upload.spec.ts-snapshots/message-detail-flows-win32.png) |
| Intake health, worker never run | Operations | [desktop](../../apps/web/tests/visual/baselines/intake.spec.ts-snapshots/intake-health-desktop-win32.png), [tablet](../../apps/web/tests/visual/baselines/intake.spec.ts-snapshots/intake-health-tablet-win32.png), [mobile](../../apps/web/tests/visual/baselines/intake.spec.ts-snapshots/intake-health-mobile-win32.png) |

Each screen is photographed as the role that owns it, not as an administrator who
can see everything. A screenshot taken as a user who could not actually reach the
page would hide a wrong permission rather than reveal it, which is why there are
two saved sessions and not one.

The two queue images are both kept on purpose. The empty one is what a clerk sees
on a quiet morning, and it has to explain that nothing arriving is not the same as
nothing working; the populated one is the row layout, which the empty state cannot
show.

## Phase 3 — reading and review

| Screen | Role | Baselines |
| --- | --- | --- |
| Document queue, nothing needing review | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/documents.spec.ts-snapshots/documents-queue-desktop-win32.png), [tablet](../../apps/web/tests/visual/baselines/documents.spec.ts-snapshots/documents-queue-tablet-win32.png), [mobile](../../apps/web/tests/visual/baselines/documents.spec.ts-snapshots/documents-queue-mobile-win32.png) |
| Document queue with a reading to check | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/review.spec.ts-snapshots/documents-queue-populated-review-win32.png) |
| Review workspace, before acceptance | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/review.spec.ts-snapshots/document-review-review-win32.png) |
| Review workspace, accepted and locked | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/review.spec.ts-snapshots/document-accepted-review-win32.png) |

The two workspace images are the phase in one picture. Before acceptance, the
vendor is amber because it was inferred from the letterhead rather than read from
a label, the bank details on the document are raised as a warning that has to be
answered by a person, and the accept button is disabled with the reasons listed
above it. After acceptance the same values carry a person's name, the editing
controls are gone, and the evidence links remain so the reading can still be
traced a year later.

The document in them is built byte by byte from readable source in
`apps/web/tests/visual/pdf-fixture.ts`. A committed binary would have done as
well for the test and would have left nobody able to see what the test document
says, or to review a change to its wording.

## Phase 4 — estimates and approval

| Screen | Role | Baselines |
| --- | --- | --- |
| Estimate register, nothing raised yet | Requester | [desktop](../../apps/web/tests/visual/baselines/estimates.spec.ts-snapshots/estimates-register-empty-desktop-win32.png), [tablet](../../apps/web/tests/visual/baselines/estimates.spec.ts-snapshots/estimates-register-empty-tablet-win32.png), [mobile](../../apps/web/tests/visual/baselines/estimates.spec.ts-snapshots/estimates-register-empty-mobile-win32.png) |
| Estimate register, nothing awaiting a decision | Unit Head | [desktop](../../apps/web/tests/visual/baselines/estimates.spec.ts-snapshots/estimates-register-approver-desktop-win32.png), [tablet](../../apps/web/tests/visual/baselines/estimates.spec.ts-snapshots/estimates-register-approver-tablet-win32.png), [mobile](../../apps/web/tests/visual/baselines/estimates.spec.ts-snapshots/estimates-register-approver-mobile-win32.png) |
| Blank draft, nothing filled in yet | Requester | [desktop](../../apps/web/tests/visual/baselines/estimate-flow.spec.ts-snapshots/estimate-draft-new-estimates-win32.png) |
| Completed draft, route shown before sending | Requester | [desktop](../../apps/web/tests/visual/baselines/estimate-flow.spec.ts-snapshots/estimate-draft-complete-estimates-win32.png) |
| Sent for approval, form closed | Requester | [desktop](../../apps/web/tests/visual/baselines/estimate-flow.spec.ts-snapshots/estimate-pending-estimates-win32.png) |
| Register filtered to what is theirs to decide | Unit Head | [desktop](../../apps/web/tests/visual/baselines/estimate-flow.spec.ts-snapshots/estimates-waiting-on-me-estimates-win32.png) |
| Open for a decision | Unit Head | [desktop](../../apps/web/tests/visual/baselines/estimate-flow.spec.ts-snapshots/estimate-decision-estimates-win32.png) |
| Fully approved | Requester | [desktop](../../apps/web/tests/visual/baselines/estimate-flow.spec.ts-snapshots/estimate-approved-estimates-win32.png) |
| Withdrawn, with the abandoned round kept | Requester | [desktop](../../apps/web/tests/visual/baselines/estimate-flow.spec.ts-snapshots/estimate-withdrawn-estimates-win32.png) |
| Rejected, with the reason on the record | Requester | [desktop](../../apps/web/tests/visual/baselines/estimate-flow.spec.ts-snapshots/estimate-rejected-estimates-win32.png) |
| Estimate register with rows | Requester | [desktop](../../apps/web/tests/visual/baselines/estimate-flow.spec.ts-snapshots/estimates-register-populated-estimates-win32.png) |

The blank draft is in the set for a reason that is easy to lose. It shows a form
that lists all six outstanding items in one panel and marks none of them against
the boxes themselves, because a form that opens with every field red is accusing
the requester of mistakes they have not had the chance to make. The gaps are
marked from the moment they first save or send, and the guidance under each box
stays visible even then.

The three decision images cannot be produced from one session. The requester, the
Unit Head and the Manager are signed in at the same time on the same records,
which is the only way to photograph an approval carrying the name of whoever gave
it, and the only way to show that the Manager's step is closed to them until the
Unit Head has acted.

Withdrawn and rejected are both kept because they are different endings that are
easy to conflate. Withdrawn returns the estimate to its author with the earlier
round preserved underneath; rejected ends it, and the reason the approver typed is
on the page rather than in a log.

## Phase 5 — invoices and receipt confirmation

| Screen | Role | Baselines |
| --- | --- | --- |
| Invoice register, nothing recorded yet | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/invoices.spec.ts-snapshots/invoices-register-empty-desktop-win32.png), [tablet](../../apps/web/tests/visual/baselines/invoices.spec.ts-snapshots/invoices-register-empty-tablet-win32.png), [mobile](../../apps/web/tests/visual/baselines/invoices.spec.ts-snapshots/invoices-register-empty-mobile-win32.png) |
| Register, nothing waiting to be confirmed | Requester | [desktop](../../apps/web/tests/visual/baselines/invoices.spec.ts-snapshots/invoices-register-requester-desktop-win32.png), [tablet](../../apps/web/tests/visual/baselines/invoices.spec.ts-snapshots/invoices-register-requester-tablet-win32.png), [mobile](../../apps/web/tests/visual/baselines/invoices.spec.ts-snapshots/invoices-register-requester-mobile-win32.png) |
| Register, nothing awaiting a decision | Unit Head | [desktop](../../apps/web/tests/visual/baselines/invoices.spec.ts-snapshots/invoices-register-approver-desktop-win32.png), [tablet](../../apps/web/tests/visual/baselines/invoices.spec.ts-snapshots/invoices-register-approver-tablet-win32.png), [mobile](../../apps/web/tests/visual/baselines/invoices.spec.ts-snapshots/invoices-register-approver-mobile-win32.png) |
| A link from a reminder that no longer works | Requester | [desktop](../../apps/web/tests/visual/baselines/invoices.spec.ts-snapshots/invoices-dead-link-desktop-win32.png), [tablet](../../apps/web/tests/visual/baselines/invoices.spec.ts-snapshots/invoices-dead-link-tablet-win32.png), [mobile](../../apps/web/tests/visual/baselines/invoices.spec.ts-snapshots/invoices-dead-link-mobile-win32.png) |
| Blank draft, nothing filled in yet | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/invoice-flow.spec.ts-snapshots/invoice-draft-new-invoices-win32.png) |
| Completed draft, naming who will confirm it | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/invoice-flow.spec.ts-snapshots/invoice-draft-complete-invoices-win32.png) |
| Sent for confirmation, form closed | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/invoice-flow.spec.ts-snapshots/invoice-pending-sign-off-invoices-win32.png) |
| Register filtered to what is theirs to confirm | Requester | [desktop](../../apps/web/tests/visual/baselines/invoice-flow.spec.ts-snapshots/invoices-waiting-to-confirm-invoices-win32.png) |
| Open to confirm receipt | Requester | [desktop](../../apps/web/tests/visual/baselines/invoice-flow.spec.ts-snapshots/invoice-confirm-receipt-invoices-win32.png) |
| Open for a decision, receipt already confirmed | Unit Head | [desktop](../../apps/web/tests/visual/baselines/invoice-flow.spec.ts-snapshots/invoice-decision-invoices-win32.png) |
| Approved | Unit Head | [desktop](../../apps/web/tests/visual/baselines/invoice-flow.spec.ts-snapshots/invoice-approved-invoices-win32.png) |
| Stopped as a duplicate of a live invoice | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/invoice-flow.spec.ts-snapshots/invoice-duplicate-blocked-invoices-win32.png) |
| Receipt declined, with the reason | Requester | [desktop](../../apps/web/tests/visual/baselines/invoice-flow.spec.ts-snapshots/invoice-declined-invoices-win32.png) |
| The same decline, as finance sees it | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/invoice-flow.spec.ts-snapshots/invoice-declined-for-finance-invoices-win32.png) |
| Invoice register with rows | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/invoice-flow.spec.ts-snapshots/invoices-register-populated-invoices-win32.png) |

Three registers are photographed empty rather than one, because the same route
opens on a different question for each of them. Finance sees what they have not
finished recording, the requester sees what is waiting on them to confirm, and the
Unit Head sees what is waiting on a decision. A single image would have proved
none of that, and an empty register that opened on the wrong tab would look
identical to a correct one.

The duplicate image is the phase's most important picture. It is the second copy
of an invoice already approved, saved rather than refused — the person who spotted
it needs both records in front of them — with the control stated in red above the
form and again against the number itself, and the send button unavailable. What it
records is that the draft survives while the transition does not.

Declined is kept from both sides for the reason the pair exists. The requester
said the goods did not arrive as billed and gave a reason; finance must then see
that they answered, not that they are still being waited on. A panel still reading
"waiting on the requester" after the requester has replied sends finance to chase
somebody who already did their part, which is the specific regression these two
images exist to catch.

## Phase 6 — approval rules, cover and purchase orders

| Screen | Role | Baselines |
| --- | --- | --- |
| Approval matrix, with the verdict on it | Administrator | [desktop](../../apps/web/tests/visual/baselines/administration.spec.ts-snapshots/administration-matrix-desktop-win32.png), [tablet](../../apps/web/tests/visual/baselines/administration.spec.ts-snapshots/administration-matrix-tablet-win32.png), [mobile](../../apps/web/tests/visual/baselines/administration.spec.ts-snapshots/administration-matrix-mobile-win32.png) |
| Adding a rule, refused without a reason | Administrator | [desktop](../../apps/web/tests/visual/baselines/administration.spec.ts-snapshots/administration-rule-dialog-desktop-win32.png), [tablet](../../apps/web/tests/visual/baselines/administration.spec.ts-snapshots/administration-rule-dialog-tablet-win32.png), [mobile](../../apps/web/tests/visual/baselines/administration.spec.ts-snapshots/administration-rule-dialog-mobile-win32.png) |
| Who holds each level, including the empty ones | Administrator | [desktop](../../apps/web/tests/visual/baselines/administration.spec.ts-snapshots/administration-assignments-desktop-win32.png), [tablet](../../apps/web/tests/visual/baselines/administration.spec.ts-snapshots/administration-assignments-tablet-win32.png), [mobile](../../apps/web/tests/visual/baselines/administration.spec.ts-snapshots/administration-assignments-mobile-win32.png) |
| Cover while away, everybody who can decide | Administrator | [desktop](../../apps/web/tests/visual/baselines/administration.spec.ts-snapshots/administration-cover-admin-desktop-win32.png), [tablet](../../apps/web/tests/visual/baselines/administration.spec.ts-snapshots/administration-cover-admin-tablet-win32.png), [mobile](../../apps/web/tests/visual/baselines/administration.spec.ts-snapshots/administration-cover-admin-mobile-win32.png) |
| Cover while away, their own only | Unit Head | [desktop](../../apps/web/tests/visual/baselines/administration.spec.ts-snapshots/administration-cover-approver-desktop-win32.png), [tablet](../../apps/web/tests/visual/baselines/administration.spec.ts-snapshots/administration-cover-approver-tablet-win32.png), [mobile](../../apps/web/tests/visual/baselines/administration.spec.ts-snapshots/administration-cover-approver-mobile-win32.png) |
| Approvals queue, nothing waiting | Unit Head | [desktop](../../apps/web/tests/visual/baselines/approvals.spec.ts-snapshots/approvals-queue-empty-desktop-win32.png), [tablet](../../apps/web/tests/visual/baselines/approvals.spec.ts-snapshots/approvals-queue-empty-tablet-win32.png), [mobile](../../apps/web/tests/visual/baselines/approvals.spec.ts-snapshots/approvals-queue-empty-mobile-win32.png) |
| Approvals queue with something in it | Unit Head | [desktop](../../apps/web/tests/visual/baselines/estimate-flow.spec.ts-snapshots/approvals-queue-populated-estimates-win32.png) |
| Purchase orders, still taking invoices | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/purchase-orders.spec.ts-snapshots/purchase-orders-register-desktop-win32.png), [tablet](../../apps/web/tests/visual/baselines/purchase-orders.spec.ts-snapshots/purchase-orders-register-tablet-win32.png), [mobile](../../apps/web/tests/visual/baselines/purchase-orders.spec.ts-snapshots/purchase-orders-register-mobile-win32.png) |
| Purchase orders, every standing at once | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/purchase-orders.spec.ts-snapshots/purchase-orders-register-everything-desktop-win32.png), [tablet](../../apps/web/tests/visual/baselines/purchase-orders.spec.ts-snapshots/purchase-orders-register-everything-tablet-win32.png), [mobile](../../apps/web/tests/visual/baselines/purchase-orders.spec.ts-snapshots/purchase-orders-register-everything-mobile-win32.png) |
| Purchase orders, nothing awaiting a decision | Unit Head | [desktop](../../apps/web/tests/visual/baselines/purchase-orders.spec.ts-snapshots/purchase-orders-register-approver-desktop-win32.png), [tablet](../../apps/web/tests/visual/baselines/purchase-orders.spec.ts-snapshots/purchase-orders-register-approver-tablet-win32.png), [mobile](../../apps/web/tests/visual/baselines/purchase-orders.spec.ts-snapshots/purchase-orders-register-approver-mobile-win32.png) |
| One order: committed, billed, still available | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/purchase-orders.spec.ts-snapshots/purchase-order-detail-desktop-win32.png), [tablet](../../apps/web/tests/visual/baselines/purchase-orders.spec.ts-snapshots/purchase-order-detail-tablet-win32.png), [mobile](../../apps/web/tests/visual/baselines/purchase-orders.spec.ts-snapshots/purchase-order-detail-mobile-win32.png) |

Cover is photographed from both sides because the two are different screens
rather than one screen with a row hidden. An administrator sees everybody who can
decide anything, including the people who arranged nothing, since the approver
who left without arranging cover is the reason the screen exists. An approver
sees their own arrangement and no one else's; who else is away is not their
business, and the alternative is a directory of the organisation's absences.

The order register is kept twice, filtered and unfiltered, for what the second
one shows: a closed order carries one standing rather than two. "Approved"
beside "Closed" states the workflow state and the label for the same fact, and on
an order that opened under the threshold without anybody approving it, the first
of the two is not true.

## Phase 7 — payment packages

| Screen | Role | Baselines |
| --- | --- | --- |
| Package register, nothing being assembled | Payments coordinator | [desktop](../../apps/web/tests/visual/baselines/payments.spec.ts-snapshots/payments-register-empty-desktop-win32.png), [tablet](../../apps/web/tests/visual/baselines/payments.spec.ts-snapshots/payments-register-empty-tablet-win32.png), [mobile](../../apps/web/tests/visual/baselines/payments.spec.ts-snapshots/payments-register-empty-mobile-win32.png) |
| The same register, readable but with nothing to press | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/payments.spec.ts-snapshots/payments-register-finance-desktop-win32.png), [tablet](../../apps/web/tests/visual/baselines/payments.spec.ts-snapshots/payments-register-finance-tablet-win32.png), [mobile](../../apps/web/tests/visual/baselines/payments.spec.ts-snapshots/payments-register-finance-mobile-win32.png) |
| A package just opened, with nothing in it | Payments coordinator | [desktop](../../apps/web/tests/visual/baselines/payment-flow.spec.ts-snapshots/payment-package-empty-payments-win32.png) |
| Choosing which approved invoices go in | Payments coordinator | [desktop](../../apps/web/tests/visual/baselines/payment-flow.spec.ts-snapshots/payment-package-add-invoices-payments-win32.png) |
| Ready to go, two currencies, manifest previewed | Payments coordinator | [desktop](../../apps/web/tests/visual/baselines/payment-flow.spec.ts-snapshots/payment-package-ready-payments-win32.png) |
| Confirming the send, with the bank's reference | Payments coordinator | [desktop](../../apps/web/tests/visual/baselines/payment-flow.spec.ts-snapshots/payment-package-submit-payments-win32.png) |
| Sent, and now unchangeable | Payments coordinator | [desktop](../../apps/web/tests/visual/baselines/payment-flow.spec.ts-snapshots/payment-package-submitted-payments-win32.png) |
| Register holding one sent package and one abandoned | Payments coordinator | [desktop](../../apps/web/tests/visual/baselines/payment-flow.spec.ts-snapshots/payments-register-populated-payments-win32.png) |

The empty register is photographed twice for the reason the phase exists. The
coordinator sees a button that starts a package; finance sees the identical
screen with no button on it, because finance holds `payment:mark_paid` and the
one pair segregation of duties most exists to keep apart is sending money and
confirming it arrived. A single image would have proved that the page renders,
and nothing about who may act on it. The requester is checked in the same spec
and has no baseline: they are refused the section outright, and there is nothing
to photograph.

The ready and submitted pair is the phase in two pictures. Before submission the
package holds a JMD invoice and a USD one, and the totals card carries two
figures rather than one — there is no rate at which they add up, and a screen
that summed them would produce a number denominated in nothing. After submission
the same two totals are still separate, the editing controls are gone, and the
evidence card carries the bank's reference, who sent it, and the SHA-256 of the
file that went.

That digest is the one hash in the set left visible rather than hidden, because
it is not volatile. The manifest is rendered deterministically and the run starts
from a rebuilt database, so the same package produces the same file and the same
sixty-four characters every time. If a change to the columns, the row ordering or
the number formatting ever made it stop doing that, this image is what says so.

The populated register keeps a sent package beside an abandoned one because the
two are easy to conflate into "finished". Abandoned means every invoice in it
went back to being approved and unpaid, and is still waiting to be paid by
somebody; sent means the instruction has gone and cannot be recalled here.

## Phase 8 — vendor confirmation

| Screen | Role | Baselines |
| --- | --- | --- |
| Confirmations queue, nothing asked yet | Payments coordinator | [desktop](../../apps/web/tests/visual/baselines/vendor-confirmation-flow.spec.ts-snapshots/vendor-confirmations-empty-confirmations-win32.png) |
| Out with suppliers, two check-ins unasked | Payments coordinator | [desktop](../../apps/web/tests/visual/baselines/vendor-confirmation-flow.spec.ts-snapshots/vendor-confirmations-awaiting-confirmations-win32.png) |
| Check-in before anybody has been emailed | Payments coordinator | [desktop](../../apps/web/tests/visual/baselines/vendor-confirmation-flow.spec.ts-snapshots/vendor-check-in-not-asked-confirmations-win32.png) |
| Asked, waiting, silence labelled as silence | Payments coordinator | [desktop](../../apps/web/tests/visual/baselines/vendor-confirmation-flow.spec.ts-snapshots/vendor-check-in-awaiting-confirmations-win32.png) |
| The supplier's question page, no shell | Supplier (no account) | [desktop](../../apps/web/tests/visual/baselines/vendor-confirmation-flow.spec.ts-snapshots/vendor-page-question-confirmations-win32.png) |
| Thanked, and told nothing is closed | Supplier (no account) | [desktop](../../apps/web/tests/visual/baselines/vendor-confirmation-flow.spec.ts-snapshots/vendor-page-answered-confirmations-win32.png) |
| Claim filed, nothing green, no conclude for the sender | Payments coordinator | [desktop](../../apps/web/tests/visual/baselines/vendor-confirmation-flow.spec.ts-snapshots/vendor-check-in-answered-confirmations-win32.png) |
| Finance weighing the claim | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/vendor-confirmation-flow.spec.ts-snapshots/vendor-check-in-review-confirmations-win32.png) |
| Settled as Paid by the reviewer | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/vendor-confirmation-flow.spec.ts-snapshots/vendor-check-in-paid-confirmations-win32.png) |
| Writing down a telephoned claim | Payments coordinator | [desktop](../../apps/web/tests/visual/baselines/vendor-confirmation-flow.spec.ts-snapshots/vendor-check-in-record-answer-confirmations-win32.png) |
| Concluding against what the supplier said | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/vendor-confirmation-flow.spec.ts-snapshots/vendor-check-in-disagreement-confirmations-win32.png) |
| Reviewed as still outstanding | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/vendor-confirmation-flow.spec.ts-snapshots/vendor-check-in-outstanding-confirmations-win32.png) |
| Queue of concluded check-ins, Paid beside Outstanding | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/vendor-confirmation-flow.spec.ts-snapshots/vendor-confirmations-concluded-confirmations-win32.png) |
| A link that cannot be opened | Any (including signed-in) | [desktop](../../apps/web/tests/visual/baselines/vendor-confirmation-flow.spec.ts-snapshots/vendor-page-refused-confirmations-win32.png) |

The empty queue and the answered check-in are the phase's two claims in pictures.
Until somebody has been paid there is nothing to ask, and the default view says
so rather than listing finished conversations. After a supplier answers "yes",
the page that holds their claim still says the payment is not settled, and the
person who released the money has no Conclude button on it — segregation of
duties made visible rather than explained in a caption.

The supplier's own pages are photographed without a session on purpose. A
baseline taken under a colleague's storage state would prove the wrong product:
the public endpoints refuse credentials, and a page that only worked when signed
in would pass here and fail for every real supplier.

## Phase 9 — credit cards

| Screen | Role | Baselines |
| --- | --- | --- |
| Register, nothing imported yet | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/credit-cards.spec.ts-snapshots/credit-cards-register-empty-desktop-win32.png) · [tablet](../../apps/web/tests/visual/baselines/credit-cards.spec.ts-snapshots/credit-cards-register-empty-tablet-win32.png) · [mobile](../../apps/web/tests/visual/baselines/credit-cards.spec.ts-snapshots/credit-cards-register-empty-mobile-win32.png) |
| One open period, two lines still uncoded | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/credit-card-flow.spec.ts-snapshots/credit-cards-register-open-creditcards-win32.png) |
| Period before any coding | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/credit-card-flow.spec.ts-snapshots/credit-card-period-uncoded-creditcards-win32.png) |
| Coded and receipt-waived, ready to close | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/credit-card-flow.spec.ts-snapshots/credit-card-period-coded-creditcards-win32.png) |
| Closed by somebody else | Finance closer | [desktop](../../apps/web/tests/visual/baselines/credit-card-flow.spec.ts-snapshots/credit-card-period-closed-creditcards-win32.png) |

The empty register and the closed period are the phase's two claims in pictures.
Until a statement is imported there is nothing to code, and the default view says
so. After every line is coded, the person who wrote those codes has no Close
button — segregation of duties on the period, made visible rather than explained
in a caption. Closing is photographed as a second finance account for the same
reason the payment screens photograph a coordinator and a clerk separately.

## Phase 10 — accruals

| Screen | Role | Baselines |
| --- | --- | --- |
| Register, nothing opened yet | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/accruals.spec.ts-snapshots/accruals-register-empty-desktop-win32.png) · [tablet](../../apps/web/tests/visual/baselines/accruals.spec.ts-snapshots/accruals-register-empty-tablet-win32.png) · [mobile](../../apps/web/tests/visual/baselines/accruals.spec.ts-snapshots/accruals-register-empty-mobile-win32.png) |
| One open period, no candidates yet | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/accrual-flow.spec.ts-snapshots/accruals-register-open-accruals-win32.png) |
| Candidates proposed from unpaid invoices | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/accrual-flow.spec.ts-snapshots/accrual-period-proposed-accruals-win32.png) |
| Candidates finalized, ready to lock | Finance clerk | [desktop](../../apps/web/tests/visual/baselines/accrual-flow.spec.ts-snapshots/accrual-period-finalized-accruals-win32.png) |
| Locked by somebody else | Finance closer | [desktop](../../apps/web/tests/visual/baselines/accrual-flow.spec.ts-snapshots/accrual-period-locked-accruals-win32.png) |

The empty register and the locked period are the phase's two claims in pictures.
Until a period is opened there is nothing to generate, and the default view says
so. After every candidate is finalized, the person who edited has no Lock
button — segregation of duties on the period, made visible rather than explained
in a caption. Locking is photographed as a second finance account for the same
reason the credit-card screens photograph a coder and a closer separately.

## Phase 11 — Dashboards, search, audit and administration

| Screen | Role | Notes |
| --- | --- | --- |
| My work | Approver | `phase11` project — `work-queue` |
| Reports hub | Finance clerk | `reports-hub` |
| Search palette | Finance clerk | `search-palette` |
| Audit trail | Auditor | `audit-trail` |
| Users and roles | Administrator | `users-and-roles` |
| Reference data | Administrator | `reference-data` |
| Retention | Administrator | `retention-policies` |
| Operational settings | Administrator | `operational-settings` |

Baselines are written under `phase11.spec.ts-snapshots/` when the `phase11`
Playwright project runs (after accruals). Regenerate with:

```bash
pnpm --filter @finora/web exec playwright test --project=phase11 --update-snapshots
```

## Regenerating

```bash
docker compose -f deploy/containers/docker-compose.dev.yml --env-file deploy/containers/env/dev.env up -d
pnpm --filter @finora/web test:visual
```

A missing baseline is written and reported as a failure, so a new screen fails
once, is reviewed, and is committed. An existing baseline that differs fails and
is never overwritten automatically. To accept an intended change, delete the
baseline and re-run, then review the replacement before committing it.

Deleting one baseline out of a flow spec is not enough. Writing a missing
baseline fails the test at that point, so the rest of that spec's screenshots are
never reached and one run produces one image. A flow whose baselines have all
been deleted is regenerated in a single pass with
`--update-snapshots=all --retries=0`, and every image reviewed afterwards. Never
point `--update-snapshots=all` at the whole suite: it rewrites every baseline to
whatever the build currently draws, which is the one thing this gate exists to
prevent.

A difference is measured against both an absolute count and a ratio, whichever is
stricter. The ratio alone was too weak to be a gate: one per cent of a full-page
screenshot is thousands of pixels and grows with the page, so the longest screens
were checked the least. Under it, three buttons changing from filled to outlined
passed as no change at all, and a hash that differed on every run sat inside an
approved image for two phases.
