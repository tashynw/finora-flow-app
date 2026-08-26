import { execFileSync } from 'node:child_process';

import { expect, type Browser, type Page } from '@playwright/test';

import { API_DIR, API_PYTHON, VISUAL_DB } from './api-process';

/**
 * The signed-in sessions the visual suite reuses.
 *
 * One per role that owns a screen, and no role can see all of them, which is the
 * point: a screenshot taken as a user who cannot actually reach the page proves
 * nothing, and a superuser account would hide a wrong permission rather than
 * expose it.
 *
 * The two approvers exist because an estimate needs one at each level a route
 * reaches, and because segregation of duties means the person who raised it can
 * never be the person who agrees to it.
 */
export const SESSIONS = {
  clerk: {
    email: 'clerk@finora.example',
    storageState: 'tests/visual/.auth/clerk.json',
  },
  // Closes credit-card periods. Separate from the clerk so a period coded by
  // one finance person can be closed by another — the pair segregation of duties
  // forbids on the same record.
  closer: {
    email: 'closer@finora.example',
    storageState: 'tests/visual/.auth/closer.json',
  },
  operator: {
    email: 'ops@finora.example',
    storageState: 'tests/visual/.auth/operator.json',
  },
  requester: {
    email: 'requester@finora.example',
    storageState: 'tests/visual/.auth/requester.json',
  },
  approver: {
    email: 'approver@finora.example',
    storageState: 'tests/visual/.auth/approver.json',
  },
  manager: {
    email: 'manager@finora.example',
    storageState: 'tests/visual/.auth/manager.json',
  },
  // Assembles payment packages and sends them. Cannot declare a payment
  // received, which finance can and this account must not: sending money and
  // confirming it arrived are the pair the payment screens most have to be
  // checked against.
  payments: {
    email: 'payments@finora.example',
    storageState: 'tests/visual/.auth/payments.json',
  },
  // Writes the approval rules and satisfies none of them. Separate from the
  // approvers on purpose: an account that could both set a rule and meet it
  // would make the administration screens impossible to check for the one
  // thing that matters about them, which is that those two rights sit with
  // two different people.
  administrator: {
    email: 'admin@finora.example',
    storageState: 'tests/visual/.auth/administrator.json',
  },
  // Reads the trail and verifies the chain. Holds no write rights, so the
  // audit screen is photographed as somebody who cannot alter what they see.
  auditor: {
    email: 'auditor@finora.example',
    storageState: 'tests/visual/.auth/auditor.json',
  },
} as const;

/**
 * A page signed in as one particular role.
 *
 * For the specs that follow a record between people, where `storageState` on the
 * describe block cannot help: an approval route is only meaningful because more
 * than one person is involved, and a test that switched identity by re-signing in
 * on one page would lose the thing it is checking — that what each of them can do
 * differs at the same moment on the same record.
 *
 * The context options repeat the project's, because `newContext` inherits none of
 * them and a screenshot taken at a different size, locale or timezone is not
 * comparable to the baseline.
 */
export async function pageAs(
  browser: Browser,
  session: { storageState: string },
  baseURL: string | undefined,
): Promise<Page> {
  const context = await browser.newContext({
    storageState: session.storageState,
    ...(baseURL === undefined ? {} : { baseURL }),
    viewport: { width: 1440, height: 900 },
    timezoneId: 'UTC',
    locale: 'en-GB',
    colorScheme: 'light',
  });
  return context.newPage();
}

/**
 * The link we emailed a supplier, read back out of their mailbox.
 *
 * The one page in the platform that cannot be reached from inside it. Nothing
 * hands the token over — it is kept as a digest, and the only plaintext copy is
 * the one that went out in the email — so the test opens it the way a supplier
 * does. The detour is the point: a link found here has proved the message was
 * composed, queued, sent and delivered, none of which a screenshot of a page
 * somebody navigated to directly would say anything about.
 *
 * Synchronous because there is nothing else for the test to be doing, and
 * because a failure to find the link should stop the step where it happened
 * rather than surface later as a page that would not load.
 */
/**
 * One unpaid Kingston invoice dated inside the May accrual period.
 *
 * Called from the accrual flow rather than from seed, so the empty invoice
 * register the viewport projects photograph stays empty. Idempotent: the same
 * reference is reused if the script runs twice in one suite.
 */
export function plantAccrualInvoice(): string {
  const output = execFileSync(API_PYTHON, ['scripts/visual_accrual_invoice.py'], {
    cwd: API_DIR,
    env: { ...process.env, FINORA_DB_NAME: VISUAL_DB },
    encoding: 'utf8',
    timeout: 30_000,
  });
  const reference = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .reverse()
    .find((line) => /^INV-ACCRUAL-SEED$/.test(line));
  expect(reference, `No accrual invoice was planted.\n${output}`).toBeTruthy();
  return reference!;
}

export function emailedLink(address: string): string {
  const output = execFileSync(
    API_PYTHON,
    ['scripts/visual_mail.py', '--to', address],
    {
      cwd: API_DIR,
      env: { ...process.env, FINORA_DB_NAME: VISUAL_DB },
      encoding: 'utf8',
      // The drain writes progress to the same stream the script prints the
      // link on. Captured separately so a log line cannot be mistaken for the
      // URL, and so a failure in the script is still readable here.
      timeout: 60_000,
    },
  );
  // Last matching line, not the whole buffer: the outbox drain logs as it
  // sends, and `goto` of a multi-line string lands on the sign-in page.
  const link = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .reverse()
    .find((line) => /\/payment-check-in\/[A-Za-z0-9_-]+$/.test(line));
  expect(link, `No supplier link reached ${address}.\n${output}`).toBeTruthy();
  return link!;
}

/**
 * A button in a page's header action group.
 *
 * Scoped rather than matched by name alone, because a page's primary action is
 * usually offered twice: once in the header and again as an empty-state prompt.
 */
export function pageAction(page: Page, title: string, name: RegExp) {
  return page.getByRole('group', { name: `${title} actions` }).getByRole('button', { name });
}

/**
 * Waits until a page is worth photographing.
 *
 * Screenshots are the flakiest thing in a suite, and almost all of that flake is
 * one of three causes: a request still in flight, an animation mid-way, or a
 * caret blinking. Each is removed here rather than absorbed by a loose pixel
 * threshold, because a threshold wide enough to hide a caret is also wide enough
 * to hide a spacing regression.
 */
export async function settle(page: Page): Promise<void> {
  // Deliberately not `networkidle`. Both intake screens poll on a timer, so a
  // quiet network is never something the page promises to reach, and waiting for
  // one turns a perfectly healthy screen into a timeout. The loading placeholders
  // are the honest signal: while any of them is on the page, the data has not
  // arrived, and once they are all gone it has.
  // The app shell, and with it `main`, only exists once the session check has
  // resolved; until then the page is a splash. The longer timeout covers a cold
  // API on the first navigation of a run rather than hiding a slow page, because
  // anything past this is a failure either way. The supplier's page also uses
  // `main`, so the same wait covers both.
  await expect(page.locator('main')).toBeVisible({ timeout: 20_000 });
  // The same allowance, for the same reason. The cold API that makes the shell
  // slow to appear on the first navigation of a run also makes its first query
  // slow to answer, and a placeholder still on the page at five seconds is far
  // more often that than a screen that will never load.
  await expect(page.locator('.motion-shimmer')).toHaveCount(0, { timeout: 20_000 });

  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
      /* Relative times, digests and "saved at" clocks change between runs and
         would otherwise make every screenshot a false failure. The element is
         kept in the layout so its space is still verified. */
      [data-visual-volatile] { visibility: hidden !important; }
      /* A full-page screenshot is taken by scrolling the page, and a sticky pane
         follows that scroll, so it lands in the middle of the picture over the
         content it was meant to sit beside. Returned to the flow for the
         photograph; the behaviour itself is not what these baselines cover. */
      [data-visual-sticky] { position: static !important; max-height: none !important; }
    `,
  });

  await page.evaluate(() => document.fonts.ready);
}

/**
 * Waits for the document viewer to finish drawing a page.
 *
 * Separate from `settle`, and called immediately before a screenshot rather than
 * once on arrival, because the overlay this waits on appears *after* the page is
 * otherwise ready: the canvas starts drawing when the file has downloaded, which
 * is well after the surrounding screen has settled.
 *
 * Its absence cost a run. The image element becomes visible as soon as the
 * canvas is mounted, so a test that waited on the image photographed a pane
 * reading "Drawing page 1" over a blank sheet, and the diff — several thousand
 * pixels of missing invoice — looked exactly like a viewer that had broken.
 */
export async function drawn(page: Page): Promise<void> {
  await expect(page.getByText(/^Drawing page \d+$/)).toHaveCount(0, { timeout: 30_000 });
}
