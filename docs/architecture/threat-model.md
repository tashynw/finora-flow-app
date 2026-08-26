# Threat model

Scope: the Finora Flow platform, its mailbox intake path, document handling, AI
assistance and financial workflow. The external forwarding rule and the
corporate mail platform are outside this boundary.

## Assets

| Asset | Why it matters |
|---|---|
| Invoice, estimate and payment records | Direct financial exposure |
| Vendor bank and contact details | Prime target for payment redirection fraud |
| Raw messages and attachments | Evidence; also the untrusted input surface |
| Approval decisions and audit trail | Control effectiveness depends on integrity |
| Mailbox and SMTP credentials | Compromise enables both theft and forgery |
| Signed sign-off and vendor links | Bearer tokens granting a scoped action |

## Trust boundaries

Everything arriving by mail is untrusted data. Everything arriving from a
browser is untrusted until authorized server-side. AI output is untrusted until
schema-validated and, for anything material, human-reviewed.

## Threats and controls

### T1: Payment redirection through a forged invoice

An attacker forwards an invoice with altered bank details, or spoofs a known
vendor's `From` address.

Controls: outer and original sender stored separately and neither trusted; PO
and estimate matching; vendor master data as the authority for bank details
rather than the document; requester sign-off confirming goods or services were
received; segregation of duties between submission, approval and marking paid;
mandatory reason on any override.

Residual risk: a compromised legitimate vendor mailbox combined with a
matching PO. Mitigated by change detection on vendor bank details and a
separate approval for such changes.

Realised for invoices in Phase 5. No invoice reaches an approver until a named
person outside finance confirms the goods or services arrived, and an invoice
with nobody named to ask cannot be sent anywhere — it is reported as a validation
problem rather than left as a button that does nothing. Whoever recorded the
invoice cannot answer their own question, enforced in the service and not by
withholding a control. A second live invoice carrying the same number from the
same vendor is refused by a partial unique index, so two clerks racing are
separated by the database rather than by whichever of them read the register
last, and an amount over what the linked estimate or purchase order approved is
reported with a tolerance that defaults to zero.

The remaining exposure here is that a genuine, correctly received delivery at a
redirected bank account still passes both checks. Receipt confirmation answers
"did this arrive", not "is this account theirs"; vendor bank change detection is
the control for that and is outstanding.

### T2: Prompt injection through document or message content

A document contains text instructing the model to approve, to report a
different total, or to exfiltrate other records.

Controls: every value a model proposes is discarded unless its text can be
located in the document, so a successful injection can at most cause the model to
quote the attacker's own document back, which a reviewer then sees in place on the
page; content is passed to the model strictly as data inside a fence whose
delimiter is generated per request, never concatenated into an instruction
position; structured schema output only, with invalid output rejected rather than
repaired; a proposal is stored below the review threshold, so it is always
confirmed by a person before it means anything; text on a page addressed to an
automated reader raises `prompt_injection_suspected`, which must be acknowledged
by name before the reading can be accepted; AI cannot enact any financial
transition, enforced in the state machine by `AI_PROHIBITED_TARGETS` rather than
by prompt wording; the gateway receives only the minimum necessary fields and
holds no credentials; prompt-injection documents are part of the regression suite.

### T3: Malicious attachment

Malware, an archive bomb, a parser-crashing PDF, or a file whose MIME type
misrepresents its content.

Controls: scan before any parse or preview, failing closed when the scanner is
unavailable; content signature validation independent of the declared MIME type;
size, page, archive entry and decompression ratio limits; parser timeouts;
quarantine rather than deletion; sanitized preview with remote resource loading
blocked; HTML sanitized before display.

### T4: Broken object level authorization

A user alters a record identifier to reach an invoice, document or export
belonging to another department.

Controls: every record, document and export authorized server-side on each
request; no reliance on a client-supplied scope; signed download URLs are
short-lived and issued only after authorization; IDOR is an explicit test
category rather than an assumption.

### T5: Self-approval and privilege escalation

A user with several roles approves their own request, or an administrator grants
themselves transactional authority.

Controls: segregation of duties evaluated per record against the actions that
user has already taken on it, not merely per role; administrators hold
configuration rights but not approval, submission or mark-paid rights;
permission changes are audited; a break-glass path exists but is tightly
controlled and logged.

Realised for estimates in `application/approvals.py`. Whoever submitted a request
cannot decide any step on it, whatever roles they hold, and the check is against
the submitter recorded on the round rather than against the current user's role
set. A step whose turn has not come is refused even to a user entitled to decide
it eventually, so ordering cannot be skipped by calling the endpoint directly.

Two consequences worth stating, because they are what makes the control testable.
The browser is never the enforcement point: it renders the actions the server
reports for that person and that record, and the server re-derives them on every
request. And an amount no rule covers is refused rather than routed to an empty
set, which closes the escalation route of submitting an amount that lands outside
the matrix and so needs nobody's approval.

Verified with the requester and both approvers signed in simultaneously in
`estimate-flow.spec.ts`; a single-session test cannot demonstrate any of it.

The same per-record pattern landed on credit-card periods in Phase 9. Coding
writes `credit_card:code` against the period; closing needs
`credit_card:close_period` and refuses when this actor already holds the code
action on that period. Assistive suggestions are stored beside applied values and
never close anything — a model that froze a period would be inventing authority.

Accrual periods in Phase 10 follow the same shape. Editing a candidate writes
`accrual:edit` against the period; locking needs `accrual:lock_period` and
refuses when this actor already edited on that period. Generate, edit and
finalize never invent a lock, and an official export is refused until the period
is locked.

Phase 6 makes the matrix editable, which opens a quieter version of the same
attack: rather than approving their own request, somebody edits the rule so their
request needs nobody senior, or names themselves as cover for the person who would
otherwise have to decide. The controls are that editing the matrix and holding an
approval level are separate permissions held by different people, that every
change carries a mandatory reason and retires rather than overwrites its
predecessor, and that a route is frozen at submission — so a rule changed after a
request is in flight cannot retroactively shorten it.

Cover is bounded in `domain/delegation.py` for the same reason. It may not chain,
because A covering B covering C ends with a decision made by somebody neither A
nor the matrix chose; it may not name somebody who cannot decide, which would
route work into a dead end; and it may not name yourself. Arranging cover for
another person is an administrative act needing the matrix permission, not the
delegate permission, because it changes who can decide however kindly meant.

The residual risk was one person holding both `admin:approval_matrix` and
`approval:decide`. `SEGREGATION_OF_DUTIES` cannot express it: those pairs are
evaluated against the actions already taken on a particular record, and editing
the matrix is not an action on a record. Phase 11 closes that gap at role grant
time: `ROLE_COMPOSITION_CONFLICTS` in `domain/roles.py` refuses the pair when
accounts are created or roles are changed, and the users administration screen
states the rule before the checkboxes. Verified by `test_roles.py` and
`test_users_api.py`.

### T6: Forged sign-off or vendor confirmation link

An attacker guesses, replays or forwards a signed link.

Controls: links are signed with a server-held key and carry an expiry; they are
scoped to one record and one action; use is recorded with timestamp and
requesting context; a vendor confirmation records the vendor's claim only and
never itself transitions a record to Paid; replay is an explicit test case.

Realised for sign-off in `application/signed_links.py`, with the primary control
being that there is nothing to forge a way into: a link confers no authority at
all. It names a destination, and the action at the far end is authorised against
the recipient's own session exactly as it would be had they navigated from the
register. Interception, forwarding and archive leakage therefore all fail closed.

Around that: the token is 32 random bytes rather than a signed claim, so it is
not enumerable and, being a row rather than a self-contained assertion, it can be
revoked when the invoice moves on, spent once, and refused to anybody other than
the person it was issued to. It is stored only as a SHA-256 digest, so a database
read cannot be turned back into a working link. Issuing a new link revokes the
previous one for that record, purpose and person, so reminders move the window
rather than accumulating open ones.

Every refusal is answered with one message that does not say which refusal it
was, since distinguishing "expired" from "no such link" confirms the token
existed. Refusals are audited including for tokens that never existed, because a
run of misses from one account is what guessing looks like from the inside and is
invisible unless the misses are recorded as well as the hits.

The reasoning, including what is given up by requiring a sign-in, is in
[ADR 8](../adr/0008-signed-links-carry-no-authority.md).

Realised for supplier confirmation in Phase 8. The same row, digest storage,
expiry, revocation and one-message refusal apply, with two deliberate
differences documented in
[ADR 9](../adr/0009-a-vendor-link-records-a-claim.md): the token is spent when
the answer is recorded rather than when the page is opened, and it lives for
thirty days rather than three. The far end is an unauthenticated page that can
only write a claim. Concluding Paid or Outstanding is a separate act behind
`payment:mark_paid`, so forging, forwarding or replaying the link never closes
an invoice. Replay of a spent token, and answering through a revoked one, are
explicit cases in `test_vendor_check_ins_api.py`.

### T7: Mail loop and notification abuse

An auto-responder or misconfiguration generates unbounded mail.

Controls: automatic reply detection with suppression rather than response;
per-record and per-vendor rate limits; reminder maximum count; business-hours
suppression; dead-lettering of permanent failures with an operator-visible
exception.

Realised for reminders in Phase 5. The interval is counted in working hours and
the maximum count is enforced, which together are what stop a chaser becoming a
flood: three wall-clock hours would put eight reminders inside a weekend, and the
recipient's answer to that is a filter, after which the control is decorative. A
reminder that comes due while the organisation is shut waits for the next opening
rather than being rescheduled on each poll, so it cannot drift later each evening
until it is never quite due.

Sending is idempotent per record, purpose and point in the cycle, enforced by a
unique index, so running the sweep twice — by two schedulers, or by a retry —
produces one email. Escalation is bounded in depth as well as count. Permanent
failures are abandoned after bounded retries and audited as having been given up
on, which is what makes "nobody answered" distinguishable from "nobody was ever
told".

Not yet built: nothing. Automatic reply detection and per-vendor rate limiting
arrived with Phase 8. `domain/mail_correlation.py` classifies automatic replies
from Precedence, Auto-Submitted and common subject markers, and the check-in
service suppresses a chase rather than answering them. Asking and chasing a
supplier are rate-limited per vendor so a month-end run cannot become forty
emails to one accounts desk. Correlated human replies are branched out of
document intake onto the check-in as evidence, which is what stops a supplier's
"got it, thanks" becoming a new invoice draft.

### T8: Audit tampering

An actor edits or deletes history to conceal an action.

Controls: append-only audit with hash chaining so a modified or removed row
breaks verification; no hard delete of financial or audit records; corrections
are new versions; auditor role is read-only by construction and tested to be so.

### T9: Credential compromise

Mailbox, SMTP, database or object storage credentials leak.

Controls: secrets only from the configured secret store, never from the
repository; `.gitignore` excludes environment files and secret scanning runs in
CI; production startup refuses development placeholders; separate IMAP and SMTP
permissions where the provider supports it; credential rotation is a tested
operation rather than an untried procedure.

### T10: Export leakage

A permitted export includes rows or columns the requester may not see.

Controls: exports are generated server-side under the requester's permissions,
column visibility is permission-aware, and every export is audited with its
scope recorded.

The first real export arrived with Phase 7: the payment manifest, behind
`payment:view` and rendered server-side from the package rather than from
anything the caller sends. Phase 11 closes the audit gap: downloading the
manifest appends `export_generated`, so the list of everybody who took a copy of
the organisation's outgoing payments is on the trail. Accrual CSV/XLSX exports
are versioned the same way. The reports hub at `/reports` points at those
surfaces without inventing a second export path.

### T11: Paying the same bill twice, or paying without authority

An invoice reaches the bank in two packages, or a package is sent by somebody who
should only have been assembling it.

Controls: only an `approved` invoice can enter a package, and entering one moves
it to `ready_for_submission`, so a second package attempting the same invoice is
refused on state rather than on a uniqueness check somebody could forget to
write. Removing it returns it to `approved` and abandoning a package returns
everything in it, so the two paths out leave no invoice stranded in a state that
looks spoken for. Both moves go through the state machine and both are recorded.

Assembling, sending and marking paid are three permissions rather than one.
`payment:package_manage` builds a package, `payment:submit` sends it, and
`payment:mark_paid` — Phase 8 — records the money as arrived;
`SEGREGATION_OF_DUTIES` forbids the last two to one person, and submission is
additionally checked against what that person has already done to that package.
A submitted package is immutable: every mutating route refuses on standing before
it reaches the domain, so a line cannot be swapped after the file went.

The manifest digest is the evidence that the file the bank received is the file
this package describes. It is taken at submission inside the transaction that
moves the invoices, and any later rebuild is compared against it.

Two residual exposures. The same supplier appearing twice under one invoice
number is *reported* rather than refused, because two legitimate rows can carry
one number after a cancellation frees it and the platform cannot tell which case
it is looking at — so it names the collision and requires a person to decide. And
nothing here reconciles against the bank: a package can be submitted, the file
never uploaded, and the platform would still read as sent. Vendor confirmation
is the control for that gap. Asking the suppliers is deliberate rather than
automatic on submit; what they answer is filed as a claim; only a person holding
`payment:mark_paid` who did not submit the package may conclude Paid or
Outstanding. "Submitted" still means an instruction was recorded — "Paid" is the
word that money moved, and it is never spoken by the supplier's click.

## Web application controls

HTTPS with HSTS, secure and `HttpOnly` cookies, CSRF protection on state-changing
requests, a restrictive Content Security Policy, output encoding, parameterized
data access throughout, rate limiting, and error responses that do not disclose
internal detail.

## Assurance activities

SAST, dependency, container and infrastructure-as-code scanning, secret
scanning, and SBOM generation, all as release gates rather than advisory checks.
Test categories that must exist: IDOR, privilege escalation, upload attack,
injection, XSS, CSRF, replay, export leakage, duplicate payment, mail loop abuse
and credential compromise.
