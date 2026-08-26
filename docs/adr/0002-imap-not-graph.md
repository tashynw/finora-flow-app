# ADR 0002: Read mail over IMAPS rather than Microsoft Graph

- **Status** Accepted
- **Date** 2026-08-04

## Context

Invoices and estimates arrive by email. The organisation runs Microsoft 365, so
Microsoft Graph would be the obvious integration. The master prompt explicitly
forbids it, along with Outlook desktop automation and Exchange application
permissions.

## Decision

An external forwarding rule, outside this application's scope, copies messages
into a mailbox the platform team controls. The platform reads that mailbox over
IMAPS using UID and UIDVALIDITY checkpoints, and sends through configurable
authenticated SMTP.

## Consequences

Mailbox access is decoupled from identity. Entra ID can still provide browser
single sign-on through OIDC without the application holding any mail
permission, which removes an entire category of tenant-wide risk: an
application-level `Mail.Read` grant would expose far more than one mailbox.

The adapter is provider-neutral, so the same code runs against Greenmail in
development and any compliant IMAP server in production. Integration tests
become genuinely possible without a Microsoft tenant.

The costs are real. Forwarding rewrites headers, so the original sender must be
recovered from message content and treated as an unverified claim. IMAP offers
no change notification comparable to a Graph subscription, so latency depends on
polling interval or optional IDLE. UIDVALIDITY resets must be handled
explicitly. And the forwarding rule itself is an operational dependency this
application cannot monitor from the inside, which is why intake age and backlog
are surfaced in operational health.
