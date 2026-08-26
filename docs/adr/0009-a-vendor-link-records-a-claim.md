# 9. A supplier's link opens an unauthenticated page, because a claim is not an action

Date: 2026-08-06

Status: Accepted

## Context

[ADR 8](0008-signed-links-carry-no-authority.md) settled that a link in an email
is a destination and never a credential: following one leads to a page that
requires signing in, and the action at the far end is authorised against that
session. It closes with the observation that Phase 8 would need the same
machinery for suppliers, "with one difference already designed for". This record
is that difference, written down properly, because it is the point where the rule
as stated stops being applicable and has to be restated rather than bent.

A supplier is being asked one question: did our payment reach you. They are the
only party who can answer it — nothing inside the platform can see their bank
account, and a payment package submitted to the bank is an instruction recorded,
not money confirmed to have moved.

They also have no account here, and will not be getting one. Suppliers number in
the hundreds, turn over staff, and are being asked a favour about a payment we
may well have failed to send. Any scheme that begins "first, the supplier
registers" ends with nobody answering, at which point the platform has a
confirmation feature that confirms nothing and a Paid column that means "we
stopped asking".

So the rule from ADR 8 cannot be applied as written. There is no session to check
the link against. Three ways out present themselves.

**Give the link authority after all** — the supplier's click marks the invoices
paid. This is the whole thing ADR 8 exists to refuse, and it is worse here than
internally, because the recipient is outside the organisation and the specific
fraud is easy to describe: a forged confirmation closes out an invoice that was
never paid, and the supplier's genuine chase three months later meets a record
saying they were settled.

**Issue the supplier an account.** Correct on paper, unusable in practice, and it
imports every problem of external identity management — password resets for
people at other companies, offboarding we never hear about, a support burden on a
finance team — in exchange for authenticating an answer we were never going to
treat as authoritative anyway.

**Change what is at the far end.** Keep the link authority-free and make the page
it opens incapable of needing any.

## Decision

A supplier's link opens a page with no sign-in, and that page records a claim.
Nothing there moves a record, changes a state, or releases a payment. The
invariant from ADR 8 is preserved by making the destination harmless rather than
by making the token stronger:

> A link never carries authority, and where there is no session behind it there
> is nothing at the far end that would need any.

A supplier saying "yes, it arrived" writes a row containing their answer, the
name they typed for themselves, the time, and which link it came through. Moving
the invoices to Paid is a separate act, by a named person inside the organisation
holding `payment:mark_paid`, who can read the claim and is not bound by it. The
platform never adopts the supplier's answer as its own finding; it files it as
evidence and shows it to a reviewer.

The link is the same database row as an internal one, with the recipient in a
different column and a check constraint insisting on exactly one of the two.
Sharing the row means expiry, revocation, single use, digest-only storage and the
audit of every refusal are one implementation. Two implementations would
eventually differ, and the weaker one would be this one.

Two settings differ from the internal path, each for a stated reason:

- **The token is spent when the answer is recorded, not when the page is
  opened.** A colleague follows their link and is looking at the record a second
  later. A supplier opens theirs, reads it, goes to check their bank, and comes
  back. Burning the token on first view would teach them the platform's links do
  not work.
- **It lives for thirty days rather than three.** A supplier is doing us a
  favour, may be one person handling the post, and is being asked about a payment
  that itself takes days to clear. The longer window costs little because the
  page takes no action.

Correlating a reply uses a **separate, non-secret tag**, never the link token.
The tag travels in the `Reply-To` address and the subject line, where it will be
quoted into every downstream forward of the thread; a credential must not travel
there. The tag identifies a conversation and opens nothing, so the worst somebody
who learns one can do is cause an email of their choosing to be filed where a
person will read it.

## Consequences

- Anybody holding the URL can record a claim, and the platform cannot tell
  whether that is the supplier, their colleague, or somebody the email was
  forwarded to. This is accepted rather than mitigated: the claim is unverified
  by construction, is labelled as unverified everywhere it appears, and is worth
  exactly what a phone call from the same party would be worth. The reviewer is
  the control, and no wording on the page changes who that is.
- The page is the only route into the platform reachable without a session. It is
  therefore the one place where rate limiting, enumeration resistance and refusal
  auditing are not defence in depth but the entire defence. Refusals are recorded
  even for tokens that never existed, because a run of misses is the only signal
  that somebody is working through the space.
- The platform can never say "Paid" on the strength of a supplier's answer, so a
  supplier who confirms promptly still waits for a reviewer. That is slower than
  auto-confirming and it is the intended trade: the design standard forbids a
  green Paid state before the review condition is met, and this is that condition
  having teeth rather than being a label.
- Silence has to be handled as its own case. An unanswered check-in must not drift
  into looking settled, so once the chasing is exhausted the suggestion becomes
  Outstanding with silence named as the reason. It is the one suggestion drawn
  from an absence of evidence, and therefore the one that has to say so out loud.
- Two identifiers now exist per conversation, the link token and the correlation
  tag, and they must not be confused. They are different lengths, different
  alphabets and different types at every boundary, which is deliberate: the cheap
  version of this design reused one identifier for both jobs and put a credential
  in a subject line.
