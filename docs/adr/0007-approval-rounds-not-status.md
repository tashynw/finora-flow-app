# 7. An approval is a round on a record, not a status field

Date: 2026-08-05

Status: Accepted

## Context

An estimate goes to one or more approvers, who say yes or no. The obvious model is
a status on the estimate and a column for who approved it, moved along as each
approver acts.

That model cannot answer the questions this platform exists to answer. A request
does not always go round once. It is approved by a Unit Head, the requester
notices the amount is wrong and withdraws it, they correct it, and it goes round
again — possibly to a different set of approvers, because the route is derived
from the amount and the amount is what changed. With a status field and an
approver column, the first approval is overwritten. The Unit Head's decision, made
in good faith on a figure that no longer exists, disappears from the record.

An auditor asks precisely about that case. So does anyone investigating why a
payment was made. "Who approved this, on what figure, and what happened next" has
to be answerable years later, and it has to be answerable about decisions that
were subsequently made irrelevant.

There is a second problem with a status field. Approvals are not always a single
sequence. Two approvers at the same level may be alternatives to each other, where
either one satisfies the step, while a third at a higher level must wait for the
step below to be met. A single "current approver" cannot express that.

## Decision

Each submission opens an *approval round*: a numbered record holding the amount
that was submitted, the route derived for it, and a step per approval required.
A decision is recorded against a step, carrying the identity of whoever made it
and the time they made it.

Rounds are append-only. Withdrawing or rejecting closes the round in a terminal
state and leaves every decision inside it exactly as it was. Resubmitting opens a
new round beneath the old one. Nothing is ever edited in place and nothing is
deleted, so the record reads as a history rather than as a current position.

The route for a round is derived from stored rules — amount bands per currency,
narrowable by department — at the moment of submission, then frozen. Rules that
change afterwards do not alter a round already in flight. Steps sharing an order
are parallel and any one satisfies the order; different orders are sequential and
a later order is closed until the earlier one is met.

Two refusals are deliberate and neither has a fallback:

- An amount that no rule covers is refused at submission, and so is a rule naming
  a level with nobody assigned to it. The request does not enter a route.
- Whoever submitted a round cannot decide any step on it, whatever roles they
  hold, and a step whose order is not yet open cannot be decided early.

## Consequences

- The record can state that an approval was given, by name, on a figure that was
  later changed, and that the request went round again. This is the whole point
  and it is not achievable with a mutable status.
- Reading "where is this now" costs a query rather than a column read. The current
  round is the latest one, and whether it is open is a property of its steps. The
  cost is paid on the read side, which is the side that can afford it, and a
  denormalised `current_step_order` on the round keeps an approver's queue cheap
  without making it the source of truth.
- An estimate still has a workflow state, and the two are not independent
  judgements. The round decides the outcome; that outcome then moves the estimate
  through the state machine in the same transaction, so the estimate's state is a
  consequence of the round rather than a second opinion about it. Nothing assigns
  an estimate's state directly.
- Refusing an uncovered amount means an incompletely configured matrix blocks
  submissions instead of silently passing them. That is the intended direction of
  failure: an unrouted request that nobody is waiting on would read as approved by
  virtue of nothing having objected, and silence must never mean approval.
- The rules are data from the first day, before Phase 6 provides a screen to edit
  them, so they are seeded by migration and changed in SQL until then. The
  alternative — a threshold constant replaced later — would leave every approval
  recorded in Phase 4 unexplainable against the rules in force when it was given.
- Rounds generalise to invoices and payments without change, because nothing in
  them is specific to what is being approved. That is why `approvals` is a module
  beside `estimates` rather than part of it.
