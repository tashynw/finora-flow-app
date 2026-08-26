# 8. A link in an email is a destination, not a credential

Date: 2026-08-05

Status: Accepted

## Context

An invoice cannot move until somebody outside finance says the goods or services
arrived. That person is chased by email every three working hours, and the email
has to get them to the right record. There are perhaps two hundred invoices in
flight; telling a warehouse manager to "find INV-000418 in the register" is how a
control becomes a thing people work around.

So the reminder carries a link. The question this record answers is what that
link is allowed to do, because the obvious answer is the dangerous one.

The obvious answer is a self-contained signed token — a JWT or an HMAC over
`invoice_id + action + expiry` — where following the link *is* the sign-off, or
where following it authenticates the holder into a scoped session. It is one
click for the recipient, it needs no session, and it is what most "approve by
email" features do.

It also makes the mailbox the authentication system. Email is forwarded, quoted
into ticketing systems, archived to shared drives, synchronised to devices nobody
inventoried, and scanned by security appliances that follow links to check them.
Any of those turns possession of a URL into a receipt confirmation on a payment.
The master prompt is explicit that email replies cannot enact internal financial
actions, and a link that signs off on possession alone is exactly that with the
click moved to a browser.

A self-contained token has a second problem independent of authority. Nothing
consults it, so nothing can withdraw it. It is valid until it expires, which
means it cannot be revoked when the invoice is signed off by other means, cannot
be made single-use, and cannot notice that it was presented by the wrong person.

## Decision

A signed link names a destination and proves the platform issued it. It confers
no authority whatsoever.

Following one leads to a page that requires signing in. The action at the far end
is authorised against that session exactly as it would be if the person had
navigated from the register. The link's entire contribution is that the recipient
lands on the record somebody is chasing them about instead of hunting for it.

The token is 32 random bytes, not a signature over claims, and the row it
corresponds to is the source of truth. Storing a row is what buys the four
properties a self-contained token cannot have:

- **Revocability.** Issuing a new link for the same record, purpose and person
  revokes the previous one, so a reminder moves the window rather than widening
  it. Signing off revokes every live link for the record.
- **Single use.** A second use is more likely to be somebody who should not have
  the link than the intended recipient clicking twice, who by then has the record
  open anyway.
- **Attribution.** The link records who it was issued to and refuses anybody
  else. A colleague it was forwarded to may well be entitled to see the invoice;
  they are not entitled to see it *as the answer to somebody else's chaser*.
- **Expiry that can be reasoned about**, held beside the record rather than
  inside the bearer's copy.

The token is stored only as a SHA-256 digest, as a password would be, so a read
of the database cannot be turned back into a working link.

Every refusal — unknown, expired, spent, revoked, wrong recipient — is recorded
with which one it was and answered with a single message that says none of them.
Telling a holder that a token was valid but expired confirms the token existed.

## Consequences

- The recipient signs in. This is a real cost, paid on every reminder by the
  person we are already chasing, and it is the price of the link not being a
  credential. It is mitigated by the session outliving the click: a person
  already signed in follows the link straight through.
- Because the token is not self-contained, resolving one is a database read.
  This is a lookup by unique digest on a table that holds only live links plus
  recently spent ones, and it happens once per reminder followed.
- A signed link is useless to an attacker who cannot also authenticate as the
  person it was issued to. Interception, forwarding and archive leakage all fail
  closed, which is what makes the mail path safe to use for chasing at all.
- Recording refusals against an account, including for tokens that never existed,
  means a run of misses from one session is visible. Guessing and replay are
  invisible unless the misses are written down as well as the hits.
- The same machinery is what Phase 8 needs for vendor payment confirmation, with
  one difference already designed for: a vendor has no account here, so their
  link records a claim rather than authorising a transition. That the link
  authorises nothing is what makes it reusable for a party outside the
  organisation without a second security model.
