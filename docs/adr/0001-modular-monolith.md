# ADR 0001: Secure modular monolith with replaceable adapters

- **Status** Accepted
- **Date** 2026-08-04

## Context

The platform spans fifteen business modules that share a single financial
lifecycle. A record moves from intake through extraction, approval, payment and
possibly accrual, and almost every step needs the audit trail, the state machine
and the money type.

## Decision

Build a modular monolith: one API deployable plus separate worker processes,
internally divided into `domain`, `application` and `infrastructure` layers with
a strict inward dependency rule. Infrastructure is reached only through ports
declared in the application layer.

## Consequences

Transactional integrity across modules is straightforward, which matters when a
single approval must update a record, write audit rows and enqueue mail
atomically. A distributed design would need a saga for that and would make the
audit trail harder to prove.

The scale-out path stays open because each module already talks to ports. A
module can be extracted behind its existing port without touching business code.

The cost is that a fault in one module shares a process with the others. This is
mitigated by moving all long-running work (scanning, extraction, sending) out of
the API into workers, so the request path stays thin.
