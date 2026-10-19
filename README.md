# Finora Flow

Unified Invoice and Estimate Automation Platform. An internal financial
workflow system that carries work from forwarded-email intake through estimate
approval, invoice validation, requester sign-off, purchase requisition and PO
control, payment submission, vendor payment confirmation, credit card
reconciliation, dashboards and month-end accrual reporting.

## Governing documents

| Document | Authority |
|---|---|
| [Cursor_Master_Prompt_Unified_Invoice_Automation_Web_IMAP_v2.md](Cursor_Master_Prompt_Unified_Invoice_Automation_Web_IMAP_v2.md) | Functional scope, security rules, architecture, build sequence |
| [docs/design/Executive_Signature_Flow_UI_UX_Implementation_Standard.md](docs/design/Executive_Signature_Flow_UI_UX_Implementation_Standard.md) | Visual and interaction requirements |
| [docs/requirements/requirements-traceability.md](docs/requirements/requirements-traceability.md) | Requirement to implementation mapping |

When requirements appear to conflict, resolve in this order: security,
authorization, audit and financial control first; then business requirements;
then accessibility; then the reference board's visual direction; then
third-party component defaults. Deviations are recorded in
[docs/design/deviations.md](docs/design/deviations.md).

## What this platform deliberately does not do

It does not connect to Outlook, Microsoft 365 mail, Microsoft Graph or Exchange
app permissions. An external forwarding rule, out of scope here, delivers
copies into a mailbox the platform team controls. The platform reads that
mailbox over IMAPS and sends through configurable SMTP. There is no IIS, no
Windows Service and no PowerShell-only deployment path; everything runs in
Linux containers.

AI is assistive only. It runs behind an internal gateway, is local by default,
holds no mail credentials, and has no authority to approve, pay, mark paid or
change configuration. Every workflow remains completable by hand with AI
switched off.

## Architecture

- **Frontend** React with TypeScript, Vite, Tailwind, shadcn/ui and Radix
  primitives, TanStack Query and Table, React Hook Form with Zod, PDF.js.
- **Backend** Python FastAPI with domain, application and infrastructure
  boundaries and a strict OpenAPI contract.
- **Database** PostgreSQL with source-controlled Alembic migrations.
- **Jobs** Redis-backed durable workers with idempotency, retries and a dead
  letter queue.
- **Documents** S3-compatible object storage holding immutable originals with
  hashes and short-lived signed access.
- **Mail** provider-neutral IMAPS adapter using UID and UIDVALIDITY
  checkpoints, plus authenticated SMTP behind a transactional outbox.
- **Identity** provider-neutral OIDC, decoupled from mailbox access.

## Repository layout

```text
apps/web              React single-page application
apps/api              FastAPI service, workers and migrations
packages/shared-types TypeScript types generated from the OpenAPI schema
deploy/containers     Compose stacks, environment templates, operational scripts
docs                  Requirements, architecture, ADRs, guides, design standard
```

## Prerequisites

Node 22 or newer, Yarn 1.22, Docker with Compose v2, and Python 3.12 which `uv`
installs for you. Git is required.

### Machines behind a TLS-inspecting proxy

If `uv` fails with `invalid peer certificate: UnknownIssuer`, it is not reading
the corporate root certificate. Use the operating system trust store:

```powershell
$env:UV_SYSTEM_CERTS = 1
```

This was required on the original development machine and is the reason
`UV_SYSTEM_CERTS` appears in the setup steps below.

## Getting started

```bash
# 1. Dependency containers: PostgreSQL, Redis, MinIO, ClamAV, Greenmail
cp deploy/containers/env/dev.env.example deploy/containers/env/dev.env
yarn stack:up

# 2. Backend
cd apps/api
uv venv --python 3.12
uv pip install -e ".[dev]"
.venv/bin/python -m pytest            # .venv\Scripts\python.exe on Windows

# 3. Web app and Nest server, from the repository root
yarn install --ignore-engines
yarn --cwd apps/server install --ignore-engines
yarn dev
```

ClamAV downloads its signature database on first start and reports unhealthy
for a few minutes. Intake will fail closed until it is ready, which is the
intended behaviour: a missing scanner is never treated as a clean result.

MinIO needs `S3_KMS_KEY` from the environment template. The API requests
server-side encryption on every write and MinIO refuses an encrypted write when it
has no key service configured, so without it nothing can be stored at all. If you
have an older `dev.env`, copy that line across. The value is a development key and
a real deployment uses KES or a cloud KMS instead.

## Testing

```bash
yarn test              # frontend unit and component tests
yarn test:visual       # visual regression and accessibility; needs the stack up
yarn storybook         # component catalogue
cd apps/api && .venv/bin/python -m pytest             # unit tests
cd apps/api && .venv/bin/python -m pytest -m integration   # needs the stack up
```

`yarn test:visual` drives the real application: the real API, database, object
store and malware scanner, with nothing on the path under test substituted. It
signs in as the role that owns each screen, uploads a document through the actual
upload path, and compares the result against the committed baselines indexed in
[docs/design/screenshots.md](docs/design/screenshots.md).

It uses its own database, `finora_visual`, which it drops and rebuilds by
migration on every run, so it never touches your development data and its
screenshots do not drift as records accumulate. Because it rebuilds that database,
it also seeds the sign-in accounts it needs; there is nothing to set up first
beyond having the stack running.

A baseline is never overwritten automatically. A new screen writes one and fails
once, so it gets reviewed before it is committed; a changed screen fails and stays
failed until someone deletes the old baseline deliberately.
[ADR 5](docs/adr/0005-visual-regression-against-the-real-stack.md) covers why it
is built this way.

## Security

Never commit credentials, mailbox passwords, private keys or production
endpoints. `deploy/containers/env/*.env` is git-ignored; only `.example`
templates belong in version control. Production secrets come from the
configured secret store, and the API refuses to start in production when a
required secret is missing or a development placeholder is still in place.
