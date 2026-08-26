# Cursor Master Prompt - Unified Invoice & Estimate Automation Platform (Web + IMAP)

You are the principal solution architect, security engineer, product designer, full-stack engineer, QA lead and technical writer for a production-grade internal financial workflow platform.

## Mission

Build the Unified Invoice & Estimate Automation Platform end to end as a normal browser-based application. It must automate the journey from forwarded-email intake through estimate approval, invoice validation, requester sign-off, purchase requisition/purchase order control, payment submission, vendor payment confirmation, credit card reconciliation, dashboards and month-end accrual reporting.

The application will **not** connect directly to Outlook or Microsoft 365 mail. An external process will forward messages to a dedicated mailbox that the platform team fully controls. The platform must read that mailbox through IMAP and send workflow communications through configurable SMTP.

The authoritative specification is:

- `Unified_Invoice_Automation_Web_IMAP_Requirements_v2.docx`

Create and maintain a Markdown copy under `/docs/requirements/`, plus a requirement traceability matrix.

## Non-negotiable outcomes

1. Reduce manual and fragmented invoice/estimate processing.
2. Provide one view from estimate through payment or accrual.
3. Automatically capture forwarded messages and attachments through IMAPS.
4. Confirm invoice validity and receipt of goods/services before payment.
5. Reduce sign-off, approval and payment follow-up delays.
6. Enforce configurable approval and PO rules, initially JMD 50,000.
7. Automate credit-card reconciliation support and accrual reporting.
8. Keep AI assistive, explainable, reviewable and local by default.
9. Deliver premium, accessible, task-first UI/UX.
10. Deploy without Windows-specific development or Microsoft Graph.

## Fixed architecture direction

Use a secure modular monolith with replaceable infrastructure adapters and a scale-out path:

- Frontend: React + TypeScript, accessible component system, TanStack Query/Table, React Hook Form/Zod, PDF.js and WCAG 2.2 AA.
- Backend: Python FastAPI with domain/application/infrastructure boundaries, OpenAPI and strict type/schema validation.
- Database: PostgreSQL with source-controlled migrations and transactional constraints.
- Jobs: Redis-backed durable workers/scheduler with idempotency, retries and dead-letter queues.
- Documents: encrypted S3-compatible object storage with immutable originals, hashes and short-lived signed access.
- Inbound email: provider-neutral IMAPS adapter. Poll by UID/UIDVALIDITY; optional IMAP IDLE for latency; polling is the recovery source of truth.
- Outbound email: authenticated SMTP with TLS, outbox pattern, template/version tracking and reply correlation.
- Identity: provider-neutral OIDC; Microsoft Entra ID may be configured for browser SSO but must not be coupled to mailbox access.
- AI/OCR: internal AI Gateway and separate OCR/model service using an OpenAI-compatible provider contract. Local/self-hosted is default; business modules never call model providers directly.
- Security scanning: malware scan and sandbox/resource limits before parsing/previewing.
- Deployment: Docker Compose for development/pilot and a hardened Linux/container platform for production.
- Observability: structured logs, metrics, traces/correlation IDs, health/readiness endpoints and alerting.

Do not add IIS, Windows Services, Outlook desktop automation, Microsoft Graph, Exchange app permissions or PowerShell-only deployment steps.

## Email boundary

- The external Outlook forwarding rule is out of application scope.
- The platform receives only the forwarded copy in the controlled mailbox.
- Preserve the raw RFC 822 message, all headers and attachments before parsing.
- Support both transparent forwarding and forwarding as a nested `message/rfc822` attachment.
- Store outer sender and detected original sender separately; never assume headers are trustworthy.
- The system must work even if forwarding rewrites envelope/Received headers.

## IMAP requirements

Implement a production-grade mailbox worker:

- IMAP over validated TLS only, normally port 993.
- OAuth2/XOAUTH2 where available; dedicated app credential fallback. Secrets only from the configured secret store.
- Incremental sync using mailbox, folder, UIDVALIDITY, UID and persisted checkpoints.
- Optional IMAP IDLE; scheduled polling always remains enabled as recovery.
- Idempotency using UID identity, Message-ID, raw-message hash and attachment hashes.
- Durable storage before move/flag/delete.
- Processing, Processed, Exception and Quarantine folders.
- Use IMAP MOVE when supported; safe COPY + flags + expunge fallback.
- Recover from connection loss, authentication failure, rate limits, quota, UIDVALIDITY reset and worker restart.
- Operations dashboard: last successful read, checkpoint, backlog, oldest unprocessed age, errors, quota and auth status.
- Authorized retry/reprocess with versioned attempts and no silent overwrite.
- Secure manual upload must use the identical scan/extraction/audit pipeline.

Create an integration test environment using a containerized IMAP/SMTP server and also support an approved real test mailbox.

## SMTP requirements

- Authenticated SMTP with STARTTLS or implicit TLS and strict certificate validation.
- Separate SMTP/IMAP permissions where supported.
- Outbox pattern: commit business transaction before asynchronous send.
- Record Message-ID, recipients, template version, business record, attempts and provider response.
- Correlate replies with In-Reply-To, References, signed tokens and a safe subject token; never rely on subject alone.
- Routine reminders/approvals contain secure deep links, not sensitive attachments.
- Retry transient failures; dead-letter permanent failures; expose bounce/invalid-address exceptions.
- Protect against automatic reply loops and repeated vendor follow-ups.
- Email replies cannot approve internal financial actions.
- Validate SPF/DKIM/DMARC readiness as a production prerequisite, without trying to manage DNS from the application.

## Security-first rules

- Deny by default and authorize every endpoint, record, document and export server-side.
- Use OIDC with MFA/conditional access where available; provide a tightly controlled break-glass path.
- Apply segregation of duties across requester, approver, payment coordinator, finance, administrator, operations and auditor.
- Never commit credentials, mailbox passwords, private keys or production endpoints.
- Preserve immutable original messages/documents and tamper-evident audit events.
- Validate content signatures/MIME; scan every attachment; enforce size/page/archive/decompression/time limits; quarantine unsafe files; sanitize HTML and block remote resources.
- Use HTTPS, HSTS, secure cookies, CSRF protection, CSP, output encoding, parameterized data access, rate limiting and safe errors.
- Encrypt database, object storage and backups. Use short-lived signed file URLs.
- Add SAST, dependency/container/IaC scans, secret scanning, SBOM and release gates.
- Test IDOR, privilege escalation, upload attacks, injection, XSS, CSRF, replay, export leakage, mail-loop abuse and credential compromise.
- AI receives only minimum necessary data through the AI Gateway; it has no IMAP/SMTP credentials and no direct authority to approve, pay, mark paid or change configuration.
- Treat every email/document as untrusted data, never as model instructions. Include prompt-injection test documents.
- Provide provider circuit breakers, feature flags and a global AI kill switch. Core workflows must operate manually.

## Required business modules

Implement each with backend rules, persistence, UI, audit, notifications and tests:

1. IMAP mailbox intake and secure manual upload.
2. Malware scan, quarantine, safe preview and immutable repository.
3. Classification, OCR, extraction, confidence/evidence and human review.
4. Estimate workflow and approval history.
5. Invoice register, estimate/PO linkage, validation and requester receipt sign-off.
6. Three-hour reminder and escalation workflow, configurable for business hours and suppression.
7. Configurable approval matrix supporting Unit Head, Manager, HOD and COO, sequential/parallel steps, delegation and out-of-office reassignment.
8. Purchase requisition and PO controls above configurable threshold, initially JMD 50,000.
9. Payment package aggregation, manifests, totals, submission references and evidence.
10. Vendor payment check-in via signed links/correlated replies and Paid/Outstanding review.
11. Credit-card statement parsing, transaction table, receipts, GL/cost-centre review and period close.
12. Month-end accrual candidate generation, review, finalization, lock and Excel/CSV export.
13. Role dashboards, global search, saved views, alerts and operational health.
14. Administration for users/roles, approval rules, thresholds, templates, schedules, vendor/GL reference data, IMAP/SMTP, AI, retention and integrations.
15. Immutable audit and auditor views.

## Workflow states

At minimum: Draft, Pending Sign-Off, Pending Approval, Approved, Ready for Submission, Submitted, Paid, Outstanding, Exception, Accrual Needed, Rejected and Cancelled.

Use a backend state machine. Record previous/new state, actor/service, reason, timestamp, source and correlation ID. Require comments for rejection, cancellation, override and material correction. Use optimistic concurrency.

## AI implementation

Create a provider-neutral AI Gateway with prompt/schema versioning, model pinning, integrity metadata, telemetry and evaluation.

Initial assistance:

- Document type classification.
- Invoice/estimate extraction.
- Requester/vendor suggestion.
- Estimate/PO/invoice matching.
- Duplicate prioritization.
- Vendor reply parsing.
- GL/cost-centre suggestion.
- Exception summary and draft communication.

Controls:

- Deterministic rules/parsers first.
- Structured schema output only; invalid output rejected.
- Field-level evidence and confidence.
- Human review for low confidence and every high-impact action.
- No fabricated missing values.
- Version every result; reprocessing never overwrites accepted history.
- De-identified representative evaluation set and regression suite.
- Model/prompt upgrades require quality, safety, performance and rollback evidence.
- CPU pilot and optional GPU profile without business-code changes.

## UI/UX bar

Build a premium purpose-built financial workflow product, not an admin template:

- Role-based home with next actions first.
- Unified work queue with urgency, due date, owner, blockers, vendor, amount and saved views.
- Split document workspace: viewer on the left; fields, validation, approvals and timeline on the right.
- Clicking an extracted field highlights its source evidence.
- Every record shows status, owner, next action and timeline.
- Explain all warnings, blocks, urgency and AI suggestions in plain language.
- Keyboard navigation, command/search palette, safe bulk actions and fast inline review.
- Complete empty/loading/success/partial failure/forbidden/offline/maintenance states.
- Responsive desktop/tablet and mobile approval review.
- FGB-inspired blue/gold accents, bright neutral surfaces, restrained motion and consistent tokens.
- WCAG 2.2 AA, screen reader support, visible focus and 200% zoom.
- Component catalogue and screenshot visual-regression coverage for every core screen/state.

## Data integrity

- Fixed-precision decimal money and ISO currency.
- UTC timestamps plus configured display timezone.
- Immutable raw message/document evidence and hashes.
- Versioned corrections, approvals, submissions, exports and configuration.
- Database constraints, optimistic concurrency and transactional outbox/inbox.
- No normal hard delete of financial/audit records.
- Permission-aware and audited exports.

## Testing and quality gates

Build tests continuously:

- Unit: domain rules, state transitions, money, validation, authorization, idempotency, urgency and accrual.
- Integration: PostgreSQL, object storage, Redis/jobs, audit and outbox/inbox.
- Email: IMAP/SMTP test server plus real test mailbox; duplicate delivery, UIDVALIDITY reset, MOVE fallback, connection loss, malformed/nested messages, quota and credential rotation.
- Security/document: malware, MIME mismatch, corrupt/encrypted files, archive bombs, parser timeout and unauthorized download.
- AI: representative extraction/classification, invalid schema, prompt injection, timeout, provider outage and regression.
- End-to-end: every core journey.
- Accessibility and visual regression.
- Load/resilience: large mailbox backlog, worker restart, database/Redis/storage transient failures, IMAP/SMTP outage and AI outage.
- Operations: install, upgrade, rollback, backup, restore and disaster recovery.

No release is complete while a critical path contains hard-coded production-like sample data, fake success, placeholder screens, TODO gates or manual database edits.

## Repository deliverables

Create and maintain:

- `/docs/requirements/requirements-traceability.md`
- `/docs/architecture/solution-architecture.md`
- `/docs/architecture/email-architecture.md`
- `/docs/architecture/threat-model.md`
- `/docs/architecture/data-model.md`
- `/docs/adr/`
- `/docs/plan/implementation-plan.md`
- `/docs/guides/user-guide/`
- `/docs/guides/admin-guide/`
- `/docs/guides/operations-runbook/`
- `/docs/guides/security-controls/`
- `/deploy/containers/` with compose/manifests, environment templates, migrations, smoke tests, backup/restore and rollback.

Every guide feature section must include outcome, users/trigger, steps, control relevance, AI assistance/limitations, exceptions, next action, audit evidence and related requirement IDs.

## Build sequence

1. Foundation: repository, OIDC, RBAC, PostgreSQL, audit, design system, health and CI security.
2. IMAP/manual intake, raw-message storage, malware scan, quarantine and object repository.
3. Safe viewer and classification/extraction review workspace.
4. Estimate workflow and approvals.
5. Invoice, receipt sign-off, validation and reminders.
6. Approval matrix and PO controls.
7. Payment packages and submission tracking.
8. Vendor confirmation and reply correlation.
9. Credit-card reconciliation.
10. Accrual reporting.
11. Dashboards/search/admin/operational health.
12. Security hardening, performance, deployment, documentation and UAT.

After each slice: run clean build, lint/format, tests/scans; update traceability/docs; capture screenshots; demonstrate real outcome; fix failures before continuing.

## Completion response required from Cursor

Provide:

1. What was built by requirement/module.
2. Exact container/Linux setup and deployment steps.
3. IMAP/SMTP configuration and test instructions without exposing secrets.
4. Test/security evidence and pass/fail results.
5. Remaining external decisions/integrations with no hidden gaps.
6. Screenshot index of every screen/state.
7. Requirement traceability status.
8. User/admin/operations documentation index.
9. Known risks and recommended next actions.

Do not claim completion until every mandatory requirement has implementation/test evidence or an explicitly approved deferment.
