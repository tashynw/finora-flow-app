# Finora Flow — feature inventory for redesign

Internal finance workflow. Work arrives by forwarded email (or a manual upload), is read from the document, and then moves through estimate approval, invoice validation, requester sign-off, purchase orders, payment packages, vendor confirmation, credit-card reconciliation, and month-end accruals. Every decision is written to an append-only audit trail.

This document lists every shipped screen, who can open it, what they can do there, and which screenshot in the zip shows it. Detail pages exist for most registers; the zip covers the sign-in page and each top-level screen, not every record detail.

Currency in the seeded demo is JMD. Amounts are stored per currency and are never added across currencies.

## How to walk the product

Local sign-in is email only (no password) at `http://localhost:5173`.

| Email | Person | Role | Best screens |
|---|---|---|---|
| `approver@finora.example` | Ana Approver | Approver | Dashboard, My work, Approvals, Cover while away |
| `clerk@finora.example` | Casey Clerk | Finance | Invoices, Estimates, Documents, Credit cards, Accruals, Purchase orders |
| `admin@finora.example` | Alex Administrator | Administrator | Users, Reference data, Thresholds, Retention, Operational settings, Approval matrix, Who approves what |
| `payments@finora.example` | Paula Payments | Payment coordinator | Payment packages, Vendor confirmations |
| `requester@finora.example` | Rina Requester | Requester | Estimates, receipt sign-off, Inbox upload |
| `ops@finora.example` | Omar Operations | Operations | System health, Intake health, Inbox |
| `auditor@finora.example` | Ada Auditor | Auditor (read-only) | Audit trail, plus read access to registers |
| `manager@finora.example` | Marcus Manager | Second-level approver | Approvals |
| `closer@finora.example` | Chris Closer | Finance period close | Credit-card period close |

The sidebar only shows sections the signed-in role can open. Hiding a link is not the security control; the API authorizes every request.

## Application shell (on every signed-in screen)

Visible in every screenshot after sign-in.

- **Sidebar.** Grouped navigation: Overview, Intake, Workflow, Payments, Finance, Administration. Active item is a soft pill with a left accent bar. Collapses to icons on desktop. Off-canvas drawer below 768px.
- **Count badges.** Live counts on My work, Inbox, Documents, Approvals, and System health. The number is work the person can go and clear.
- **Command bar.** Centred field, “Search or type a command…”, shortcut Ctrl/Cmd+K. Opens one search palette across estimates, invoices, purchase orders, and related records. Choosing a hit opens that record.
- **Ask Finora AI.** Gradient pill in the top bar. Opens the same command palette. AI is assistive: it never approves, pays, marks paid, or changes configuration. Every workflow still completes with AI switched off.
- **Notifications.** Bell links to My work. Badge is the same “my work” total.
- **User menu.** Signed-in name, role, sign out.
- **Skip link and single main landmark.** Keyboard users land in the page content.

## Roles and segregation of duties

| Role | What they are for |
|---|---|
| Requester | Raise estimates, upload documents, confirm goods or services were received |
| Approver | Decide estimates, invoices, and purchase orders routed to them; arrange cover while away |
| Payment coordinator | Assemble and submit payment packages; review vendor confirmations |
| Finance | Record and code invoices, manage purchase orders, mark paid, code credit cards, close periods, prepare and lock accruals, export |
| Administrator | Users, roles, reference data, thresholds, retention, AI kill switch, approval matrix. Does not approve spend |
| Operations | Mailbox and pipeline health, retries, quarantine |
| Auditor | Read the record. Cannot change it |

A person must not do both sides of one record: raise and approve it, confirm receipt and approve it, submit a payment and mark it paid, code a card transaction and close that period, or edit an accrual and lock it. Editing the approval matrix and approving spend cannot sit with the same person at all.

## Workflow states

Records move through one state machine. Terminal states (Paid, Rejected, Cancelled) cannot be reopened; a correction is a new record linked to the old one.

Draft → Pending sign-off → Pending approval → Approved → Ready for submission → Submitted → Paid.

Side states: Outstanding, Exception, Accrual needed, Rejected, Cancelled.

Status is always a labelled pill, never colour alone. Some transitions require a written reason.

## Screen catalog

### Sign-in — `00-sign-in.png`

Route: `/sign-in`. No shell.

Light page. Left column: wordmark, “Smarter finance, beautifully orchestrated.”, four feature points (AI-assisted workflows, real-time visibility, enterprise security, experience). Right: signature-blue panel titled “Welcome back” with a white form.

- Work email (local development accounts).
- Single sign-on when the deployment has an identity provider. The API decides which methods appear.
- Empty state when no sign-in method is configured.

### Dashboard — `01-dashboard.png`

Route: `/`. Permission: `report:view`.

Executive home for anyone who can see reports.

- Greeting with first name and a Customize control that reveals extra charts.
- Four headline cards from live aggregates: Total spend (paid invoices), Approved amount, Pending approvals, Open items. Month-over-month chips appear only when last month has a real baseline.
- Activity overview: invoices and estimates recorded over the last six months.
- Finora AI card: one sentence computed from overdue and waiting work, plus “Start a conversation” (opens search).
- Recent activity, top vendors by spend (primary currency), approval performance (average decision time and approval rate across decided routes).
- Customize reveals invoices by state and payment aging.
- People without `report:view` see their own queue (“What needs you”), platform health, and the sections they can open.

### My work — `02-work-queue.png`

Route: `/work`. Permission: `report:view`.

One queue for everything waiting on this person, oldest first, not reorderable.

Kinds: Approvals, Receipt confirmations, Document reviews, Vendor confirmations. Filters subtract kinds. Named saved views keep a filter between visits. Each row opens the record where the evidence is. Empty state when nothing is waiting.

### Reports — `03-reports.png`

Route: `/reports`. Permission: `report:view`.

A hub of links, not a second analytics dashboard. Cards the person cannot open are hidden.

- Audit trail
- Payment packages / manifests
- Accrual exports
- My work queue
- Credit-card periods

### Approvals — `04-approvals.png`

Route: `/approvals`. Permission: `approval:view`. Decide requires `approval:decide`.

Queue of estimates, invoices, and purchase orders whose current step is this approver. Oldest first. Type filters subtract. Each row shows reference, counterparty, amount, how long it has waited, and the step. The decision itself (approve, reject, send back, with a reason where required) happens on the record, not in the queue.

### Estimates — `05-estimates.png`

Route: `/estimates`. View: `estimate:view`. Create/edit/submit: requester rights.

A quotation someone wants permission to spend against. Vendor may be named in text before they exist on the vendor master.

Views: Waiting on me, My drafts, Mine awaiting approval, Everything I raised, Everything. Search. Create opens a new draft. Rows show reference, vendor, amount, state, and what the record is waiting on.

Detail `/estimates/:estimateId` (not in the zip): edit draft fields, attach the source document, submit into the approval matrix, withdraw, and read the route.

### Invoices — `06-invoices.png`

Route: `/invoices`. View: `invoice:view`. Create/edit/submit: finance. Receipt sign-off: `invoice:sign_off`.

A demand for money. Once it leaves draft it must name a vendor on the master, an invoice number (unique per vendor while live), dates, amount, cost centre, and a requester.

Views: Waiting on me to confirm, Waiting on my approval, Past due, My drafts, Everything. Search. Create. Stat band from the whole register (count, value, status mix), not just the current page. Columnar table with status pills.

Detail `/invoices/:invoiceId` (not in the zip): coding, link to estimate and purchase order, receipt sign-off with a note, submit, and the approval route. Duplicate live invoice numbers are refused.

### Purchase orders — `07-purchase-orders.png`

Route: `/purchase-orders`. View: `purchase_order:view`. Manage: `purchase_order:manage`.

Commitment a supplier can still bill against.

Views: Open, Waiting on my approval, Drafts, Everything. Search. Create. Rows show remaining capacity against invoices already matched.

Detail `/purchase-orders/:orderId` (not in the zip): amend, submit, decide, close. Invoices draw down the open amount.

### Payment packages — `08-payments.png`

Route: `/payments`. View: `payment:view`. Assemble: `payment:package_manage`. Submit: `payment:submit`. Mark paid: `payment:mark_paid` (a different person from the one who submitted).

A batch of approved invoices prepared for the bank.

Views: Being assembled, Sent, Everything. Search. Create. Totals stay split by currency.

Detail `/payments/:packageId` (not in the zip): add eligible invoices, remove lines, download the manifest, submit, cancel. Marking paid is a separate act with its own permission.

### Credit cards — `09-credit-cards.png`

Route: `/credit-cards`. View: `credit_card:view`. Code: `credit_card:code`. Close period: `credit_card:close_period` (not the same person who coded).

Statement periods for company cards.

Views: Open, Closed, Everything. Register a card. Import a statement file into an open period.

Detail `/credit-cards/:periodId` (not in the zip): code each line to a cost centre and GL account, then close the period.

### Accruals — `10-accruals.png`

Route: `/accruals`. View: `accrual:view`. Edit: `accrual:edit`. Finalize: `accrual:finalize`. Lock: `accrual:lock_period` (not the editor). Export: `accrual:export`.

Month-end accrual periods.

Views: Open, Locked, Everything. Open a new period (start, end, label).

Detail `/accruals/:periodId` (not in the zip): generate candidates from outstanding commitments, edit lines, finalize, lock, export the pack.

### Vendor confirmations — `11-vendor-confirmations.png`

Route: `/vendor-confirmations`. Permission: `vendor:confirmation_review`.

After a payment goes out, the supplier is asked to confirm. A row is never shown as paid just because the supplier said so. “Paid” appears only after someone here concludes it.

Views: Needs a decision, Out with suppliers, Concluded, Everything. Search. Currency totals.

Detail `/vendor-confirmations/:checkInId` (not in the zip): the supplier’s reply and a conclude action when `can_review` is true. Public check-in for the supplier is a separate unauthenticated page.

### Documents — `12-documents.png`

Route: `/documents`. Permission: `extraction:view` (seeing what was read, which is stricter than merely knowing a file exists).

Queue of documents extracted from intake. Filters by extraction status (including needs review). Confidence is shown as a number, not only a colour. “Read pending” starts extraction.

Detail `/documents/:documentId` (not in the zip): field-by-field review. A person can correct a field, accept the reading, and raise an estimate or invoice from it. Suggestions stay reviewable.

### Inbox — `13-intake-queue.png`

Route: `/intake`. Permission: `intake:view`. Upload: `intake:upload`.

Mailbox the platform reads over IMAP, plus manual upload. The product does not connect to Outlook or Microsoft 365; mail is forwarded into a mailbox the platform controls.

Filters: Everything, Ready to review, Quarantined, Needs attention, Scanning. Rows show source, received time (absolute and relative), attachment count, and status. Upload dialog for a file dropped in by hand.

Detail `/intake/:messageId` (not in the zip): the message, attachments, scan result, and link into the document that was read from it. Malware scan runs before any parser or preview.

### System health — `14-operations-health.png`

Route: `/operations`. Permission: `operations:view`.

Whether the platform is accepting work. Each dependency (database, queue, object storage, mail, scanner) is Working, Degraded, or Down, with a label, not colour alone. Retry where `operations:retry` is held.

### Intake health — `15-operations-intake.png`

Route: `/operations/intake`. Permission: `operations:view`.

Mailbox checkpoint, last successful poll, failures, and retries. Operations can see raw headers (`intake:view_raw_headers`) and requeue failed intake.

### Audit trail — `16-audit-trail.png`

Route: `/audit`. Permission: `audit:view`.

Append-only log of decisions, exports, and configuration changes. Oldest first so it reads in the order it was written. Filters by actor, action, and record. A separate “verify chain” action proves the rows were not rewritten. Auditors cannot edit from this screen.

### Approval matrix — `17-settings-approval-matrix.png`

Route: `/settings/approval-matrix`. Permission: `admin:approval_matrix`.

Rules per record type (estimate, invoice, purchase order): amount bands in a currency, and which level must approve (Unit Head, Manager, Head of Department, COO). Add and retire rules; retiring requires a reason. A scenario panel shows the route an amount would take, so a gap in the bands is visible before it is used.

### Who approves what — `18-settings-approvers.png`

Route: `/settings/approvers`. Permission: `admin:approval_matrix`.

People assigned to each approval level, and the scope they cover. Add and remove assignments. This is who fills a level; the matrix screen is which level a given amount needs.

### Users and roles — `19-settings-users.png`

Route: `/settings/users`. Permission: `admin:users` (role grants also need `admin:roles`).

Accounts: name, email, roles, status, last seen. Create an account, grant or revoke roles, deactivate. The screen refuses role combinations that break segregation (for example matrix admin plus approver).

### Reference data — `20-settings-reference-data.png`

Route: `/settings/reference`. Permission: `admin:reference_data`.

Three tabs:

- **Vendors** — the only counterparties money can be paid to. Code, name, category, status.
- **GL accounts**
- **Cost centres**

Add, edit, and retire. Empty states explain how to add the first row.

### PO thresholds — `21-settings-thresholds.png`

Route: `/settings/thresholds`. Permission: `admin:thresholds`.

One threshold per currency: the amount above which a purchase order is required before an invoice can proceed. Editing is per currency so mixed-currency deployments are not given one meaningless number.

### Retention — `22-settings-retention.png`

Route: `/settings/retention`. Permission: `admin:retention`.

How long each record class is kept. One row per class. Changes are audited. This screen sets policy; it does not delete the audit trail.

### Operational settings — `23-settings-operational.png`

Route: `/settings/operations`. Permission: `admin:ai_config`.

AI kill switch, with a reason, so extraction assistance can be turned off without taking the workflow down. Read-only snapshot of workflow configuration beside it.

### Cover while away — `24-settings-cover.png`

Route: `/settings/cover`. Permission: `approval:delegate` (an approver’s own screen; an administrator is not required).

An approver names who decides in their place, and for which dates. Arranging cover is not an administrative act. The delegate still cannot approve a record they themselves raised.

## Screens with no screenshot in the zip

| Route | What it is |
|---|---|
| `/estimates/:estimateId` | Estimate detail, edit, submit, route |
| `/invoices/:invoiceId` | Invoice detail, coding, sign-off, submit, route |
| `/purchase-orders/:orderId` | Purchase order detail, amend, close |
| `/payments/:packageId` | Package lines, manifest download, submit |
| `/credit-cards/:periodId` | Statement lines and period close |
| `/accruals/:periodId` | Candidates, finalize, lock, export |
| `/vendor-confirmations/:checkInId` | Supplier reply and conclude |
| `/documents/:documentId` | Field review and raise-from-document |
| `/intake/:messageId` | Message, attachments, scan result |
| `/link/:token` | Signed link that lands on the record the token names; the record’s own permission still applies |
| Vendor check-in (public) | Supplier confirms a payment without an account |
| `/forbidden` and unknown routes | Access denied, and page not found |

## Cross-cutting behaviour a redesign should keep

- **One queue, oldest first.** My work and Approvals do not let the reader reorder, so an awkward item cannot be sorted to the bottom.
- **Views, not a wall of statuses.** Registers lead with the job (“waiting on me”, “past due”, “being assembled”) rather than the twelve workflow states.
- **Search on registers and a global palette.** Two characters minimum in the palette.
- **Empty states say what to do next**, including where to go (documents, show everything, clear search).
- **Money always names its currency.** Totals that mix currencies stay as separate figures.
- **Reasons on destructive or exceptional moves** (reject, retire a rule, kill switch, cancel).
- **AI off is a supported mode.** Operational settings can disable it; the same screens still work.
- **Audit everything that changes money, access, or configuration.**

## Screenshot index

| File | Screen |
|---|---|
| `00-sign-in.png` | Sign-in |
| `01-dashboard.png` | Dashboard |
| `02-work-queue.png` | My work |
| `03-reports.png` | Reports |
| `04-approvals.png` | Approvals |
| `05-estimates.png` | Estimates |
| `06-invoices.png` | Invoices |
| `07-purchase-orders.png` | Purchase orders |
| `08-payments.png` | Payment packages |
| `09-credit-cards.png` | Credit cards |
| `10-accruals.png` | Accruals |
| `11-vendor-confirmations.png` | Vendor confirmations |
| `12-documents.png` | Documents |
| `13-intake-queue.png` | Inbox |
| `14-operations-health.png` | System health |
| `15-operations-intake.png` | Intake health |
| `16-audit-trail.png` | Audit trail |
| `17-settings-approval-matrix.png` | Approval matrix |
| `18-settings-approvers.png` | Who approves what |
| `19-settings-users.png` | Users and roles |
| `20-settings-reference-data.png` | Reference data |
| `21-settings-thresholds.png` | PO thresholds |
| `22-settings-retention.png` | Retention |
| `23-settings-operational.png` | Operational settings |
| `24-settings-cover.png` | Cover while away |

Captured at 1440×900, light colour scheme, from the running local app. Animations were frozen so the frame is the settled layout.
