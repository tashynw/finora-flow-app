import { defineConfig, devices } from '@playwright/test';

import { API_DIR, API_PYTHON, VISUAL_DB } from './tests/visual/api-process';

/**
 * Visual regression and accessibility checks.
 *
 * Runs against the real application: the real API, the real database, the real
 * object store. Screenshots of mocked screens would pass while the product was
 * broken, which is the failure this gate exists to catch.
 *
 * The viewports are the three the design standard requires. They are separate
 * projects rather than resizes inside one test so a layout that only breaks on a
 * phone fails on its own line and cannot be lost in a desktop pass.
 */

// The built bundle, served by `vite preview`, rather than the dev server. The dev
// server reloads the page when it discovers a dependency to pre-bundle, which
// lands mid-test as a navigation nobody asked for, and screenshots of a
// dev-transformed page are not screenshots of what ships.
const BASE_URL = process.env.FINORA_E2E_BASE_URL ?? 'http://localhost:4173';
const PREVIEW_PORT = new URL(BASE_URL).port || '4173';

// The suite's own database, rebuilt before every run, is named in `api-process`
// alongside the interpreter that rebuilds it. The reset script refuses to drop
// anything else, so that name is the safety interlock and not just a label.

// Specs that create records, as opposed to only reading them. Each runs in its
// own project, in a fixed order, because each one's screenshots include the rows
// every earlier one added.
const INTAKE_FLOW = /upload\.spec\.ts/;
const REVIEW_FLOW = /review\.spec\.ts/;
const ESTIMATE_FLOW = /estimate-flow\.spec\.ts/;
const INVOICE_FLOW = /invoice-flow\.spec\.ts/;
const PAYMENT_FLOW = /payment-flow\.spec\.ts/;
const CONFIRMATION_FLOW = /vendor-confirmation-flow\.spec\.ts/;
const CREDIT_CARD_FLOW = /credit-card-flow\.spec\.ts/;
const ACCRUAL_FLOW = /accrual-flow\.spec\.ts/;
const PHASE11 = /phase11\.spec\.ts/;

const RECORD_CREATING = [
  INTAKE_FLOW,
  REVIEW_FLOW,
  ESTIMATE_FLOW,
  INVOICE_FLOW,
  PAYMENT_FLOW,
  CONFIRMATION_FLOW,
  CREDIT_CARD_FLOW,
  ACCRUAL_FLOW,
  PHASE11,
];


export default defineConfig({
  testDir: './tests/visual',
  outputDir: './tests/visual/.output',
  snapshotDir: './tests/visual/baselines',
  // Committed baselines are reviewed, so a diff must fail rather than quietly
  // rewrite the thing it is being compared against. In CI a *missing* baseline
  // fails too, instead of being written: baselines are per-platform, and a job
  // that invents its own would report success against a picture nobody approved.
  // The rendered screenshot is still attached to the report to be reviewed and
  // committed.
  updateSnapshots: process.env.CI ? 'none' : 'missing',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // The suite shares one API process and one database. Past a handful of browsers
  // the bottleneck stops being the application and starts being the machine, and
  // the failures that produces look like product bugs without being any.
  //
  // Two rather than four, after four produced exactly that: a page left on
  // "Checking your session" for twenty seconds, in a different spec each run,
  // while three other browsers hammered the same single-process API. Nothing was
  // wrong with the page, and the only thing a wider timeout would have bought is
  // a slower way to find that out.
  workers: 2,
  // Generous, because these tests wait on a real malware scan and a real object
  // store rather than a stub.
  timeout: 60_000,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  expect: {
    toHaveScreenshot: {
      // Font rasterisation and subpixel rounding differ slightly between
      // machines. Tight enough to catch a spacing or colour change, loose enough
      // that a rebuilt container does not fail the suite for no reason.
      //
      // A ratio alone is the wrong shape for this. One per cent of a full-page
      // screenshot is several thousand pixels, and it grows with the page, so
      // the longest screens get the weakest checking. Three buttons changing
      // from filled to outlined came in under it and the suite reported no
      // change at all. The absolute cap is what actually holds, and the ratio
      // now only relaxes it on the very tallest pages.
      maxDiffPixels: 600,
      maxDiffPixelRatio: 0.002,
      // Time to *take* the picture, which is a separate thing from how much of
      // it is allowed to differ and does not relax the comparison at all. A
      // full-page screenshot is taken twice and compared with itself to prove
      // the page has stopped moving, and each one means scrolling a long screen
      // and rasterising it. On a busy machine two of those do not fit in the
      // five seconds Playwright allows by default, and what that produces is a
      // failure reporting no pixel difference whatsoever — the least
      // informative way possible to say the suite ran out of patience.
      timeout: 20_000,
      // Motion is disabled in the page setup, so anything still moving is a bug
      // rather than something to wait out.
      animations: 'disabled',
      caret: 'hide',
    },
  },

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Fixed so a screenshot does not change with the machine's clock or region.
    timezoneId: 'UTC',
    locale: 'en-GB',
    colorScheme: 'light',
  },

  projects: [
    // Each spec declares which saved session it needs, because no single role can
    // reach both phase 2 screens.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'desktop',
      dependencies: ['setup'],
      testIgnore: RECORD_CREATING,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'tablet',
      dependencies: ['setup'],
      testIgnore: RECORD_CREATING,
      use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } },
    },
    {
      name: 'mobile',
      dependencies: ['setup'],
      testIgnore: RECORD_CREATING,
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } },
    },
    // Specs that create records run last, and only once. The viewport projects
    // above photograph screens in their starting state, and they all share one
    // database, so a spec that adds a row while they are running would decide by
    // timing whether an "empty queue" baseline still matched. One viewport,
    // because a document created three times over is three documents.
    // The project names are part of every baseline's filename, so they are left
    // alone once screenshots have been approved under them.
    // None of the four retry, whatever the run is configured for. A retry starts
    // the workflow again against the database the failed attempt left behind, so
    // the second attempt raises a record that already exists and photographs a
    // state no clean run produces. A flow that fails has to be read, not rolled.
    {
      name: 'flows',
      retries: 0,
      dependencies: ['desktop', 'tablet', 'mobile'],
      testMatch: INTAKE_FLOW,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    // After the intake flow rather than beside it: both add a document, and this
    // one's queue screenshot contains the row the other created.
    {
      name: 'review',
      retries: 0,
      dependencies: ['flows'],
      testMatch: REVIEW_FLOW,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    // Last. The references it produces come from a sequence, so a spec that ran
    // beside it and also raised an estimate would decide by timing which number
    // each one got, and the references are in the screenshots.
    // Its own pages are created per role rather than from the project's
    // `storageState`, so the viewport here only sets the size for anything the
    // spec does through the default page.
    {
      name: 'estimates',
      retries: 0,
      dependencies: ['review'],
      testMatch: ESTIMATE_FLOW,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    // After the estimates, and for a stronger reason than sequence numbers: the
    // approved estimate that spec leaves behind is what an invoice is billed
    // against, so running these the other way round would test the linkage
    // controls against a database with nothing to link to.
    {
      name: 'invoices',
      retries: 0,
      dependencies: ['estimates'],
      testMatch: INVOICE_FLOW,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    // Last of all, and necessarily so: a package can only hold invoices somebody
    // has already approved, and the approved one it starts from is what the
    // invoice flow leaves behind. It also adds a US dollar band to the approval
    // matrix, which the administration baselines are taken before.
    {
      name: 'payments',
      retries: 0,
      dependencies: ['invoices'],
      testMatch: PAYMENT_FLOW,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    // After the payments, and there is nothing arbitrary about the order: there
    // is nothing to ask a supplier about until somebody has paid them, and the
    // package this flow asks about is the one the payment flow sent.
    {
      name: 'confirmations',
      retries: 0,
      dependencies: ['payments'],
      testMatch: CONFIRMATION_FLOW,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    // After confirmations only for suite ordering: cards do not need payment
    // data, but they do create periods that would appear on a register another
    // viewport project might photograph as empty if this ran first.
    {
      name: 'creditcards',
      retries: 0,
      dependencies: ['confirmations'],
      testMatch: CREDIT_CARD_FLOW,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    // After credit cards only for suite ordering: accruals plant their own unpaid
    // invoice rather than depending on payment data, but opening a period earlier
    // would put rows on a register the empty baselines expect to be blank.
    {
      name: 'accruals',
      retries: 0,
      dependencies: ['creditcards'],
      testMatch: ACCRUAL_FLOW,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    // After accruals: Phase 11 screens read the shared database but do not
    // invent register-empty claims the earlier projects already own.
    {
      name: 'phase11',
      retries: 0,
      dependencies: ['setup'],
      testMatch: PHASE11,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],

  webServer: [
    {
      // The API is started from its own virtual environment rather than through
      // `uv run`, so this works on a machine where uv is not on PATH.
      //
      // The database is rebuilt first, and it is the suite's own, not the
      // development one. Baselines only mean anything if the data behind them is
      // identical every run, and a shared database accumulates records, so a
      // screenshot would drift until someone overwrote the baseline to make the
      // failure go away. Chained into this command rather than run as a global
      // setup step so the ordering is not open to interpretation: the API cannot
      // start before the reset has finished.
      command:
        `${API_PYTHON} scripts/reset_visual_db.py && ` +
        `${API_PYTHON} -m uvicorn finora.api.app:app --port 8000`,
      cwd: API_DIR,
      // The base URL matters as much as the database name. Links that go into
      // email are built from configuration rather than from the request, so
      // without this the supplier's link would point at the development server
      // on another port, and the one spec that opens a real emailed link would
      // photograph whatever happened to be running there.
      env: { FINORA_DB_NAME: VISUAL_DB, FINORA_WEB_BASE_URL: BASE_URL },
      // Readiness, not liveness. Liveness deliberately touches no dependency, so
      // waiting on it starts the suite while the database pool and the mappers
      // are still cold, and the first few tests pay for that in timeouts that
      // look like product faults.
      url: 'http://localhost:8000/api/v1/health/ready',
      // Never reused: a server already running is one whose database was not
      // rebuilt, and pointing the suite at it would silently give up the
      // determinism this is all for.
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // Always rebuild. The suite photographs the shipped bundle, and reusing a
      // preview left over from an earlier run would quietly compare against an
      // older build than the one under test.
      // Port follows FINORA_E2E_BASE_URL so a machine whose 4173 is already
      // taken by another project's leftover `vite preview` can still run the
      // suite without silently photographing that other app.
      command: `yarn build && yarn preview --port ${PREVIEW_PORT} --strictPort`,
      url: BASE_URL,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
