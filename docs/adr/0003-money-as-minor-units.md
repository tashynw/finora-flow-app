# ADR 0003: Money as integer minor units with explicit currency

- **Status** Accepted
- **Date** 2026-08-04

## Context

The platform totals invoices, allocates tax, splits costs across cost centres
and produces accrual figures that feed the general ledger. Any representation
error compounds across those operations.

## Decision

Money is an immutable value object holding an integer count of minor units plus
an ISO 4217 currency code. Currency exponents come from an explicit table;
unknown currencies raise rather than defaulting to two decimal places.
Arithmetic between different currencies raises. Rounding is half-up. Splitting
uses a remainder-distributing `allocate` so parts always sum back to the whole.

Persistence uses `BIGINT` for minor units and `CHAR(3)` for currency. No
floating point type appears anywhere near an amount.

## Consequences

Representation error is eliminated rather than merely made unlikely: 0.1 + 0.2
has no opportunity to become 0.30000000000000004.

Mixed-currency mistakes surface as an exception at the point of the error
instead of as a wrong total downstream. Payment packages consequently must
present per-currency subtotals, which the design standard already requires.

Half-up rounding was chosen over banker's rounding because it matches what
finance staff see on vendor documents; banker's rounding would disagree with the
supplier's own invoice on a .005 case and cause avoidable reconciliation
queries.

Unknown currencies failing loudly is a deliberate inconvenience. Guessing an
exponent silently corrupts totals for three-decimal currencies such as KWD and
zero-decimal currencies such as JPY.
