# Completion report

Finora Flow — Phases 0–12. Prepared against the design standard §22 and the
master prompt release bar. Authoritative requirements remain open where noted in
[requirements-traceability.md](../requirements/requirements-traceability.md).

## 1. Implemented pages and states

| Area | Routes / states |
|---|---|
| Auth | Local sign-in (dev only); OIDC callback returns 501 until configured |
| Home | Role dashboard with next actions (`GET /work/dashboard`) |
| My work | Unified queue: approvals, sign-off, document review, vendor review; saved views |
| Intake / documents | Queue, upload, review workspace, quarantine, safe preview |
| Estimates | Draft → submit → approval rounds → decide / withdraw / cancel |
| Invoices | Draft → sign-off → approve; linkage to estimate/PO; overdue views |
| Purchase orders | Raise, approve, capacity, close |
| Payments | Package assemble → submit; audited manifest CSV |
| Vendor confirmations | Ask → claim (link/email/phone) → review → Paid/Outstanding |
| Credit cards | Import → code / waive → close (SoD) |
| Accruals | Open → generate → edit → finalize → lock (SoD) → versioned export |
| Search | Ctrl/Cmd+K federated search |
| Reports | Hub linking audited export/review surfaces |
| Audit | Trail list, filters, chain verify |
| Administration | Matrix, approvers, cover, users/roles (T5 composition), reference data, PO thresholds, retention, operational settings (AI kill switch) |
| Operations | Health, intake health |

Every critical workflow remains completable with AI disabled and with animation
disabled (motion tokens honour `prefers-reduced-motion`; AI kill switch is
admin-togglable and env-backed).

## 2. Design tokens and component catalogue

- Tokens: `apps/web/src/styles/` (CSS variables for colour, type, space, motion)
- Primitives: `apps/web/src/components/ui/`
- Workflow chrome: `apps/web/src/components/workflow/`
- Shell: `apps/web/src/layouts/`
- Standard: `docs/design/Executive_Signature_Flow_UI_UX_Implementation_Standard.md`

## 3. MagicUI / 21st.dev

Not adopted as runtime dependencies. The product uses the in-repo primitive set
aligned to the Executive Signature Flow standard. Catalogue exploration during
scaffolding informed spacing and motion vocabulary only; no third-party UI kit is
bundled into production screens.

## 4. Higgsfield assets

None shipped. Brand mark is local SVG (`FinoraMark`). No generative imagery in
the financial UI; atmosphere comes from token gradients on marketing-free app
chrome only where the shell already defined them.

## 5. Screenshot index

See [screenshots.md](../design/screenshots.md). Baselines live under
`apps/web/tests/visual/baselines/` and are platform-specific (`-win32` / CI
Linux). Phase 11 screens are covered by the `phase11` Playwright project.

## 6. Visual-regression results

Run locally / in CI:

```bash
pnpm --filter @finora/web test:visual
```

Against the real API, DB, object store and scanner (ADR 5). Flow projects do not
retry. Missing baselines fail in CI; accept intentionally with reviewed
`--update-snapshots` on the named project only.

## 7. Accessibility results

Playwright visual suite includes accessibility checks on photographed pages
(helpers). Native `<dialog>` for modals; skip link and single `<main>` in the
shell; focus rings via tokens. Full WCAG audit against a production IdP remains
a UAT item once OIDC is configured.

## 8. Deviations from the design standard

- `/reports` is an export/review hub, not the full analytics surface in §9.14 —
  charts deferred until metric definitions exist.
- Retention periods are provisional editable defaults, not confirmed policy.
- OIDC is not live; local accounts cover development only and are refused in
  production startup.
- OCR engine unset; unscannable pages require manual entry rather than invention.

## 9. Unresolved design or business decisions

Listed as open items in requirements-traceability.md: approval band confirmation,
PO thresholds for non-JMD currencies, holiday calendar, bank integration,
reference-data production source, budget context, OIDC tenant, real mailbox, OCR
engine, AI provider, confidence thresholds, accrual reversal automation.

## 10. AI and animation disabled

Confirmed by construction:

- `AiSettings.kill_switch_engaged` and runtime `SystemSetting` `ai.kill_switch`
  force every reading path through deterministic rules / human entry.
- Visual suite forces `animations: 'disabled'` and reduced-motion-friendly CSS.
- No workflow transition is performed by a model; suggestions never approve,
  submit, pay, lock or close.

## Phase 12 hardening

| Gate | Command |
|---|---|
| API lint | `ruff check .` in `apps/api` |
| API types | `mypy src` |
| API security | `bandit -c pyproject.toml -r src` |
| API tests | `pytest` against compose Postgres |
| Web lint / types / unit | `pnpm --filter @finora/web lint`, `typecheck`, `test` |
| Visual + a11y | `pnpm --filter @finora/web test:visual` |
| CI | `.github/workflows/ci.yml` (also pip-audit, pnpm audit, gitleaks, release-bar) |

Threat-model residuals T5 (role composition) and T10 (export audit) are coded;
see `docs/architecture/threat-model.md`.
