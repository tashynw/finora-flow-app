# Design standard deviations

Section 2 of the Executive Signature Flow standard requires deviations to be
documented before coding. Each entry records what the standard asks for, what
was built instead, and why.

## D-001: Product name is Finora Flow, not Fluxora

**Standard** Section 20 recommends Fluxora as the strongest premium standalone
name, or NexLedger where financial credibility matters most.

**Built** Finora Flow, which was option 3 in the same section.

**Reason** Finished logo assets already exist in the repository reading
"Finora Flow" (a blue-to-violet gradient F mark plus wordmark). Rebuilding
brand assets to match a different name would discard approved design work.

**Outstanding** Section 20 still requires domain, company-name and trademark
clearance before adoption. That sits outside this build.

## D-002: Greenmail rather than Mailpit for the mail test server

**Standard** Not specified by the design standard; the master prompt requires a
containerized IMAP and SMTP server for integration testing.

**Built** Greenmail.

**Reason** Mailpit serves SMTP with a web interface but does not implement
IMAP. The mailbox worker's core logic is IMAP UID and UIDVALIDITY
checkpointing, which cannot be tested without a real IMAP server. Greenmail
provides IMAP, IMAPS, SMTP and SMTPS in one container.

## D-003: `UV_SYSTEM_CERTS` required on the development machine

**Standard** Not addressed.

**Built** Setup instructions include setting `UV_SYSTEM_CERTS=1`.

**Reason** The original development machine sits behind a TLS-inspecting proxy.
Without reading the operating system trust store, `uv` fails to download the
pinned Python toolchain with `invalid peer certificate: UnknownIssuer`. This is
an environment accommodation, not a change to the security posture: certificate
validation stays enabled and simply uses the OS trust store.

## D-004: Drafts are saved when asked, not automatically

**Standard** Section 10.5 requires a mandatory unsaved-change warning, and says
auto-saved drafts must display their last-save state.

**Built** An explicit Save draft, with the mandatory unsaved-change warning
covering both in-app navigation and closing the tab, and the time of the last save
shown after it happens. No auto-save.

**Reason** The two bullets describe alternatives and only the warning is
mandatory. Auto-saving was rejected for what an estimate is: a request for money
that a person composes and then decides to commit. A form that writes itself to
the server as it is typed gives a requester no moment at which they chose to
record a figure, and no way to abandon a line of thought without it having been
saved. It also makes the mandatory warning meaningless, because there is nothing
unsaved to warn about.

The gap auto-save exists to close — losing typed work — is closed by the warning
instead. `lib/use-unsaved-changes.ts` blocks in-app navigation with a dialog in
the product's own words, and registers `beforeunload` for reload and tab close,
which the router cannot see.

**Outstanding** None. If the requirements later ask for auto-save, the last-save
display is already built.

## D-005: A field shows its guidance and its error together

**Standard** Section 10.5 asks for helper text that explains policy or format, and
for validation to appear close to the field. It does not say which wins when both
apply.

**Built** Both, with the error above the guidance.

**Reason** They answer different questions — what this box wants, and what is
wrong with what is in it — and a field is flagged exactly when the reader most
needs the format and the policy still in front of them. Replacing "figures only,
in the form 1234.56" with "enter the total amount" removes the sentence that would
have prevented the next attempt failing too.

A related consequence is recorded here because it is a visible design choice: a
draft nobody has typed into is not marked as wrong. The outstanding items are
listed in one panel above the form, and the boxes themselves are flagged from the
first time the requester saves or sends. A form that opens with every required
field red is accusing somebody of mistakes they have not had the chance to make.
