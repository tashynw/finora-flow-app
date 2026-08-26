# Implementation plan

Thirteen phases. Phases 1 to 12 follow the master prompt's build sequence; phase
0 covers scaffolding. The design standard's own sequence is folded in, so
tokens, the application shell and the primitive component system land in phase 1
before any business screen exists.

## Definition of done, every phase

A phase closes only when all of the following hold. These come from section 18.3
of the design standard and the release bar in the master prompt.

1. **Functional** real data and real actions, no mocked success.
2. **Security** permissions and sensitive data handling verified.
3. **Layout** spacing, alignment and density from tokens.
4. **Visual** colour, radius, shadow and type from tokens.
5. **Interaction** hover, focus, loading, success and error states present.
6. **Responsive** every required viewport usable.
7. **Accessibility** keyboard, screen reader, contrast and 200% zoom checked.
8. **Visual regression** screenshots reviewed against approved baselines.

Additionally: no hard-coded production-like sample data on a critical path, no
placeholder screen on a production route, no non-functional primary action, no
TODO gate, traceability updated, and screenshots indexed.

## Phases

### Phase 0: Scaffold

Git repository, pnpm workspace, `uv` with pinned Python 3.12, dependency
containers (PostgreSQL, Redis, MinIO, ClamAV, Greenmail), governance
documentation, traceability matrix, architecture documents and initial ADRs.

Domain primitives land here because everything else depends on them: the money
value object, the workflow state machine, and the roles and permissions model
with segregation of duties.

### Phase 1: Foundation

OIDC authentication and session handling. RBAC enforced server-side on every
endpoint. PostgreSQL schema with Alembic migrations. Append-only audit with hash
chaining. The full design token set, application shell, responsive navigation
and primitive component system. Health and readiness endpoints. CI with SAST,
dependency, secret and container scanning plus SBOM.

### Phase 2: Intake

Mailbox worker with UID and UIDVALIDITY checkpointing, IDLE optional and polling
always enabled. Immutable raw RFC 822 storage with hashes. Malware scanning that
fails closed. Quarantine. Folder lifecycle with `MOVE` and a tested `COPY`
fallback. Secure manual upload through the identical pipeline. Operations
dashboard for checkpoint, backlog, oldest unprocessed age, errors, quota and
authentication status.

Delivered with one idempotency key rather than the four signals originally
sketched here: `Message-ID` where the sender supplied one, and the SHA-256 of the
raw message otherwise. The reasoning is in
[the email architecture](../architecture/email-architecture.md#idempotency). In
short, several independent keys can disagree, and a rule for resolving that
disagreement is a rule for deciding when to process an invoice twice. A UID is
deliberately not part of identity, because it is a coordinate in a mailbox rather
than a property of the message, and it changes when `UIDVALIDITY` does.

### Phase 3: Extraction workspace

Safe document viewer with page navigation, zoom, rotate and evidence bounding
boxes. Classification and OCR through the AI Gateway. Field-level confidence and
evidence. Human review for low confidence. The split workspace from section 9.5
of the design standard, with document on the left and data, validation, matches
and timeline on the right.

### Phase 4: Estimates

Estimate register, review and approval, line items, supporting files, budget
context, approval route and history.

Delivered without line items or budget context.

An estimate carries one total in one currency, and
the quotation it came from is attached as the document it was raised from, which
is where the breakdown already exists in the supplier's own words. Re-typing that
breakdown into rows would create a second version of it that nobody reconciles,
and no approval rule, budget check or accrual in the requirements reads a line.
Invoices are where lines start to earn their cost, because that is where a
three-way match needs them.

Budget context is absent because there is no budget in the data model to show. A
cost centre has a code, a name and a department; it has no allocation, no period
and no committed-to-date. An approver looking at "78% of budget used" would be
reading a number this system invented, next to a decision about money, which is
worse than an approver reading nothing. Recorded as an open item against Phase 6
with the three things needed to build it honestly: where allocations come from,
what period they are measured over, and whether a commitment counts when it is
approved or when it is paid.

The approval matrix is real rather than stubbed, ahead of the administration
screen for editing it in Phase 6. Routes are read from stored rules from the
outset because the alternative — a threshold in code, replaced later — would have
meant every approval written in this phase being unexplainable against the rules
in force when it was given. The rules are seeded by migration and edited in SQL
until Phase 6 provides the screen. The reasoning is in
[the solution architecture](../architecture/solution-architecture.md#approving-a-spend).

### Phase 5: Invoices and sign-off

Invoice register, estimate and PO linkage, validation rules, requester receipt
sign-off through a focused page and a signed deep link, and the three-hour
reminder and escalation cycle honouring business hours and suppression.

### Phase 6: Approval matrix and PO control

Configurable matrix across Unit Head, Manager, HOD and COO with sequential and
parallel steps, delegation and out-of-office reassignment. Purchase requisition
and PO controls above the configurable threshold, initially JMD 50,000.

### Phase 7: Payment packages

Aggregation of approved invoices, manifests, per-currency totals, submission
references and evidence, completeness and blocker visibility.

### Phase 8: Vendor confirmation

Signed vendor links and correlated replies. Paid and Outstanding review, where a
vendor claim never itself transitions a record to Paid.

### Phase 9: Credit cards

Statement parsing, transaction table, receipt matching, GL and cost-centre
coding with AI suggestion and evidence, period close.

### Phase 10: Accruals

Candidate generation, evidence review, edit with reason, finalize, period lock,
and Excel and CSV export with version visibility.

### Phase 11: Dashboards and administration

Role dashboards with next actions first, unified work queue, global search,
saved views, notifications, the administration surface, operational health, and
the immutable audit and auditor views.

### Phase 12: Hardening and release

Security testing across the categories in the threat model, performance,
production deployment with backup, restore and rollback, the full documentation
set, UAT, the screenshot index and the final completion report.

Completion report: [completion-report.md](./completion-report.md).

## Risks

| Risk | Mitigation |
|---|---|
| Authoritative requirements document absent | Gaps become configuration with documented defaults; reconcile on arrival |
| Approval matrix bands unknown | Matrix is data-driven from phase 6; no band hard-coded |
| OIDC provider not yet chosen | Provider-neutral adapter; a local development issuer stands in until decided |
| No real test mailbox yet | Greenmail covers protocol behaviour; a real mailbox remains required before production |
| ClamAV signature download slow on first run | Intake fails closed and reports scanner-unready rather than passing files through |
| AI extraction quality unknown on real documents | Deterministic parsers run first; confidence thresholds route to human review |
