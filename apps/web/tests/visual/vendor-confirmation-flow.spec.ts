import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { emailedLink, pageAs, SESSIONS, settle } from './helpers';

/**
 * Closing the gap between "we sent the money" and "they got it".
 *
 * Everything before this phase can be true at once and still leave a supplier
 * unpaid: an invoice approved, a package assembled, an instruction accepted by a
 * bank. None of that is money in somebody's account, and the platform has until
 * now had no way to say so. This flow is the claim that it now does, and that it
 * does it without ever letting a supplier's word become our finding.
 *
 * Two people, because the phase's control is a segregation of duties. Paula
 * Payments sent the package to the bank and may ask the suppliers about it; she
 * may not conclude, and has no button that would let her. Casey Clerk in finance
 * may conclude and has no way to send a payment. Marking a payment paid is the
 * one action in the platform that closes an invoice for good, and the person who
 * released the money is the last person who should be allowed to declare it
 * arrived.
 *
 * Runs after the payment flow and depends entirely on what it leaves behind: one
 * submitted package holding two invoices from two suppliers, in two currencies.
 * There is nothing to confirm until somebody has paid something.
 */

const KINGSTON = 'Kingston Supplies Limited';
const CARIBBEAN = 'Caribbean Facilities Services';

/** Where Kingston's post arrives, as seeded on the supplier record. */
const KINGSTON_MAILBOX = 'accounts@kingston-supplies.example';

/** The card on the confirmations detail page that carries a given title. */
function card(page: Page, title: string) {
  return page.locator('.surface-card').filter({ hasText: title });
}

/** A row in the confirmations queue, by the supplier it is about. */
function queueRow(page: Page, supplier: string) {
  return page.locator('main').getByRole('listitem').filter({ hasText: supplier });
}

/** Opens a check-in from the queue, from whichever view shows it. */
async function openCheckIn(page: Page, view: RegExp, supplier: string) {
  await page.goto('/vendor-confirmations');
  await settle(page);
  await page
    .getByRole('group', { name: /choose a view/i })
    .getByRole('button', { name: view })
    .click();
  await settle(page);
  await queueRow(page, supplier).getByRole('link').click();
  await page.waitForURL(/\/vendor-confirmations\/[0-9a-f-]{36}$/);
  await settle(page);
}

test.describe('confirming that a payment actually arrived', () => {
  // Longer than the suite default: this test drains the outbox, reads a real
  // mailbox and walks the check-in through two people, which is more waiting
  // than a single-screen photograph.
  test('is asked of the supplier, answered by them, and decided by somebody else', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(180_000);
    const payments = await pageAs(browser, SESSIONS.payments, baseURL);
    const finance = await pageAs(browser, SESSIONS.clerk, baseURL);

    await test.step('the queue is empty until a payment has been made', async () => {
      await payments.goto('/vendor-confirmations');
      await settle(payments);

      // The default view is the work rather than the history, so an untouched
      // queue opens on "nothing is waiting on you" rather than on a list of
      // conversations somebody already finished.
      await expect(payments.getByText(/nothing is waiting on you/i)).toBeVisible();

      await expect(payments).toHaveScreenshot('vendor-confirmations-empty.png', {
        fullPage: true,
      });
    });

    await test.step('asking is a separate act from sending the package', async () => {
      // Deliberately not automatic on submission. A coordinator sending a
      // package at four in the afternoon decides when a dozen suppliers are
      // written to, and a run that fired on submit would decide it for them.
      await payments.goto('/payments');
      await settle(payments);
      await payments
        .getByRole('group', { name: /choose a view/i })
        .getByRole('button', { name: 'Sent' })
        .click();
      await settle(payments);
      await payments.locator('main').getByRole('listitem').first().getByRole('link').click();
      await payments.waitForURL(/\/payments\/[0-9a-f-]{36}$/);
      await settle(payments);

      const ask = card(payments, 'Ask the suppliers');
      await expect(ask.getByText(/nothing is emailed until you send each one/i)).toBeVisible();

      await ask.getByRole('button', { name: /ask the suppliers/i }).click();
      await expect(ask.getByText(/2 questions opened/i)).toBeVisible();
    });

    await test.step('both suppliers are waiting on us, not the other way round', async () => {
      await payments.goto('/vendor-confirmations');
      await settle(payments);

      // Still nothing to decide: the questions exist and nobody has been asked.
      await expect(payments.getByText(/nothing is waiting on you/i)).toBeVisible();

      await payments
        .getByRole('group', { name: /choose a view/i })
        .getByRole('button', { name: /out with suppliers/i })
        .click();
      await settle(payments);

      await expect(queueRow(payments, KINGSTON).getByText(/nobody has asked yet/i)).toBeVisible();
      await expect(queueRow(payments, CARIBBEAN)).toBeVisible();

      // Two currencies on two rows, and no third figure anywhere: the package
      // rule holds here too, because these are the same amounts seen from the
      // supplier's side.
      await expect(queueRow(payments, KINGSTON).getByRole('listitem')).toHaveCount(1);

      await expect(payments).toHaveScreenshot('vendor-confirmations-awaiting.png', {
        fullPage: true,
      });
    });

    await test.step('an unasked check-in shows the whole sequence, not just what has happened', async () => {
      await openCheckIn(payments, /out with suppliers/i, KINGSTON);

      // All five steps, including the three still to come. A timeline that
      // rendered only the past would put a supplier's answer at the bottom of
      // the page, which is exactly where a reader takes the last thing as the
      // conclusion.
      const sequence = card(payments, 'What has happened');
      await expect(sequence.getByText('Sent to the bank')).toBeVisible();
      await expect(sequence.getByText('Supplier asked')).toBeVisible();
      await expect(sequence.getByText('Supplier answered')).toBeVisible();
      await expect(sequence.getByText('Checked here')).toBeVisible();
      await expect(sequence.getByText('Not settled')).toBeVisible();

      // Nothing to conclude on yet, and nothing to write down either.
      await expect(payments.getByRole('button', { name: /^conclude$/i })).toHaveCount(0);
      await expect(
        payments.getByRole('button', { name: /write down what they said/i }),
      ).toHaveCount(0);

      await expect(payments).toHaveScreenshot('vendor-check-in-not-asked.png', { fullPage: true });
    });

    await test.step('the supplier is asked, and silence is labelled as silence', async () => {
      await payments.getByRole('button', { name: /ask the supplier/i }).click();
      await settle(payments);

      await expect(payments.getByText(/waiting on the supplier/i).first()).toBeVisible();
      // Said in the purpose line and again on the timeline. Either place is the
      // claim; matching both at once is a strict-mode failure, not a product one.
      await expect(payments.getByText(/silence is not payment/i).first()).toBeVisible();

      // Asking once is asking. A second Ask button would produce two links to
      // the same supplier and two answers to reconcile.
      await expect(payments.getByRole('button', { name: /ask the supplier/i })).toHaveCount(0);

      await expect(payments).toHaveScreenshot('vendor-check-in-awaiting.png', { fullPage: true });
    });

    await test.step('the supplier answers from the email, with no account and no session', async () => {
      // The link is read out of Kingston's mailbox rather than constructed
      // here, because nothing inside the platform will hand a token over: it is
      // kept as a digest and the only plaintext copy went out in the email. So
      // this step also proves the message was composed, queued, sent and
      // delivered, which is most of what the phase actually does.
      const link = emailedLink(KINGSTON_MAILBOX);
      // Path only. The host in the email is whatever the API was configured to
      // write; opening that absolute URL would leave the suite if the API's
      // idea of the web origin ever drifted from the preview under test.
      const path = new URL(link).pathname;

      // A context with no storage state at all. Not a convenience: a supplier
      // has no account, and a page photographed under somebody's session is not
      // the page a supplier gets.
      const supplier = await browser.newContext({
        ...(baseURL === undefined ? {} : { baseURL }),
        viewport: { width: 1440, height: 900 },
        timezoneId: 'UTC',
        locale: 'en-GB',
        colorScheme: 'light',
      });
      const vendor = await supplier.newPage();

      await vendor.goto(path);
      await settle(vendor);

      // Asked, never asserted. The page must not tell a supplier they were paid,
      // because the reason it exists is that we do not know.
      await expect(vendor.getByRole('heading', { name: /did this payment reach you\?/i })).toBeVisible();
      await expect(vendor.getByText(/somebody in our accounts team checks it/i)).toBeVisible();

      // Their invoices and their amounts. Nothing about any other supplier and
      // nobody here named.
      await expect(vendor.getByText('What we sent')).toBeVisible();
      await expect(vendor.getByRole('navigation')).toHaveCount(0);
      await expect(vendor.getByRole('radio', { checked: true })).toHaveCount(0);

      await expect(vendor).toHaveScreenshot('vendor-page-question.png', { fullPage: true });

      await vendor.getByRole('radio', { name: /yes, the full amount arrived/i }).click();
      await vendor.getByRole('textbox', { name: /your name/i }).fill('Marcia Bennett');
      await vendor
        .getByRole('textbox', { name: /anything else we should know/i })
        .fill('Landed on the 16th, full amount, quoted your reference back.');
      await vendor.getByRole('button', { name: /send my answer/i }).click();

      // Thanked, and told plainly that nothing is closed. A supplier who reads
      // only "thank you" stops chasing, which is the wrong outcome for every
      // answer except the one that turns out to be true.
      // Announced as status rather than a heading, because the form it replaced
      // was submitted by the reader and a silent swap would leave a screen-reader
      // user with no idea it worked. Matched by text: a status region's
      // accessible name is its aria-label, which this one deliberately has none.
      await expect(vendor.getByRole('status').filter({ hasText: /^thank you$/i })).toBeVisible();
      await expect(
        vendor.getByText(/somebody in our accounts team will check it/i),
      ).toBeVisible();

      await expect(vendor).toHaveScreenshot('vendor-page-answered.png', { fullPage: true });

      // Spent, and spent on answering rather than on opening. A second answer
      // through the same link would be a second claim with nothing to say which
      // of them is current.
      await vendor.goto(path);
      await settle(vendor);
      await expect(
        vendor.getByRole('heading', { name: /this link cannot be opened/i }),
      ).toBeVisible();

      await supplier.close();
    });

    await test.step('a supplier saying yes settles nothing and turns nothing green', async () => {
      await payments.reload();
      await settle(payments);

      // The claim of the phase. Everything on this page now says a supplier
      // told us the money arrived, and not one thing on it says the invoice is
      // paid.
      await expect(payments.getByText(/they say it arrived/i).first()).toBeVisible();
      await expect(card(payments, 'What the supplier says')).toBeVisible();
      await expect(
        payments.getByText(/recorded as given and not verified by anybody here/i),
      ).toBeVisible();

      await expect(card(payments, 'What has happened').getByText('Not settled')).toBeVisible();
      await expect(payments.getByText('Settled', { exact: true })).toHaveCount(0);

      await expect(payments).toHaveScreenshot('vendor-check-in-answered.png', { fullPage: true });
    });

    await test.step('the person who released the money cannot declare it arrived', async () => {
      // Absent rather than present and refused. Paula sent this package to the
      // bank; letting her conclude on it would make the whole check-in a formality
      // she performs on herself.
      await expect(payments.getByRole('button', { name: /^conclude$/i })).toHaveCount(0);
      await expect(
        payments.getByText(/right to mark a payment paid, which is held separately/i),
      ).toBeVisible();
    });

    await test.step('finance weighs the claim rather than confirming it', async () => {
      await finance.goto(new URL(payments.url()).pathname);
      await settle(finance);

      await finance.getByRole('button', { name: /^conclude$/i }).click();
      const decide = finance.getByRole('dialog', { name: /conclude on VCI-/i });
      await expect(decide).toBeVisible();

      // The evidence is described in a sentence and never as a filled-in radio
      // button, so the reviewer has to choose rather than agree.
      await expect(decide.getByRole('radio', { checked: true })).toHaveCount(0);
      await expect(decide.getByText(/not a decision until you make it/i)).toBeVisible();

      await expect(finance).toHaveScreenshot('vendor-check-in-review.png', { fullPage: true });

      // The accessible name is the label plus the help under it, so an exact
      // "Paid" match would miss the only Paid option on the page.
      await decide.getByRole('radio', { name: /^paid\b/i }).click();
      await decide
        .getByRole('textbox', { name: /^why/i })
        .fill('Debit for the full amount on the statement for the 16th, against BATCH-2030-0114.');
      await decide.getByRole('button', { name: /record this decision/i }).click();
      await expect(decide).toBeHidden();
      await settle(finance);
    });

    await test.step('only the decision settles it', async () => {
      await expect(card(finance, 'What has happened').getByText('Settled')).toBeVisible();
      await expect(finance.getByText(/every invoice in this check-in is now paid/i)).toBeVisible();

      // Attributed to the person who decided, not to the supplier who claimed.
      const decision = card(finance, 'The decision');
      await expect(decision.getByText('Casey Clerk', { exact: true })).toBeVisible();

      await expect(finance).toHaveScreenshot('vendor-check-in-paid.png', { fullPage: true });
    });

    await test.step('the invoice behind it moved, and only now', async () => {
      const invoice = card(finance, 'The invoices this covers');
      await expect(invoice.getByText('Paid').first()).toBeVisible();
    });

    await test.step('concluding against a supplier costs a sentence', async () => {
      // The second supplier, and the case the design most has to survive: our
      // record and theirs disagree. Whoever reads this in six months needs to
      // know why the supplier's account was set aside.
      await openCheckIn(payments, /out with suppliers/i, CARIBBEAN);
      await payments.getByRole('button', { name: /ask the supplier/i }).click();
      await settle(payments);

      await payments.getByRole('button', { name: /write down what they said/i }).click();
      const said = payments.getByRole('dialog', { name: /write down what they said/i });
      await expect(said).toBeVisible();

      // The other way a claim reaches us: a supplier who telephones rather than
      // clicks. Written down as theirs, with their name against it, and no more
      // authoritative for having been typed by somebody here.
      await expect(said.getByRole('radio', { checked: true })).toHaveCount(0);
      await expect(said.getByText(/records their claim and settles nothing/i)).toBeVisible();

      await expect(payments).toHaveScreenshot('vendor-check-in-record-answer.png', {
        fullPage: true,
      });

      await said.getByRole('radio', { name: /they say nothing arrived/i }).click();
      await said.getByRole('textbox', { name: /who at the supplier told you/i }).fill('Dwight Ellis');
      await said.getByRole('button', { name: /record what they said/i }).click();
      await expect(said).toBeHidden();
      await settle(payments);

      await finance.goto(new URL(payments.url()).pathname);
      await settle(finance);
      await finance.getByRole('button', { name: /^conclude$/i }).click();

      const decide = finance.getByRole('dialog', { name: /conclude on VCI-/i });
      // The accessible name is the label plus the help under it, so an exact
      // "Paid" match would miss the only Paid option on the page.
      await decide.getByRole('radio', { name: /^paid\b/i }).click();
      await expect(decide.getByText(/goes against what the supplier told us/i)).toBeVisible();

      await decide.getByRole('button', { name: /record this decision/i }).click();
      // Refused, and still open, because the reason is the record.
      await expect(decide).toBeVisible();
      await expect(
        decide.getByText(/reason is needed when the conclusion differs/i),
      ).toBeVisible();

      await expect(finance).toHaveScreenshot('vendor-check-in-disagreement.png', {
        fullPage: true,
      });
    });

    await test.step('agreeing with the supplier leaves the payment unsettled', async () => {
      const decide = finance.getByRole('dialog', { name: /conclude on VCI-/i });
      await decide.getByRole('radio', { name: /still outstanding/i }).click();
      await decide.getByRole('button', { name: /record this decision/i }).click();
      await expect(decide).toBeHidden();
      await settle(finance);

      // Reviewed, and emphatically not settled. A review is a conclusion, not a
      // payment, and concluding that the money never landed must not tick the
      // box that says it did.
      await expect(card(finance, 'What has happened').getByText('Not settled')).toBeVisible();
      // Timeline and the review outcome badge both say it; either is enough.
      await expect(finance.getByText(/back to being owed/i).first()).toBeVisible();
      await expect(finance.getByText('Still outstanding').first()).toBeVisible();

      await expect(finance).toHaveScreenshot('vendor-check-in-outstanding.png', {
        fullPage: true,
      });
    });

    await test.step('the queue separates the two conclusions', async () => {
      await finance.goto('/vendor-confirmations');
      await settle(finance);
      await finance
        .getByRole('group', { name: /choose a view/i })
        .getByRole('button', { name: 'Concluded' })
        .click();
      await settle(finance);

      await expect(queueRow(finance, KINGSTON).getByText('Paid')).toBeVisible();
      // The API's label, not the longer wording the detail page uses in the
      // timeline. A queue that said "Still outstanding" on every row would be
      // harder to scan than one that says what was concluded in one word.
      await expect(queueRow(finance, CARIBBEAN).getByText('Outstanding')).toBeVisible();

      await expect(finance).toHaveScreenshot('vendor-confirmations-concluded.png', {
        fullPage: true,
      });
    });
  });
});

test.describe('the supplier’s own page', () => {
  test.use({ storageState: SESSIONS.payments.storageState });

  test('is outside the application and says nothing about it', async ({ page }) => {
    // A token that never existed is answered exactly as an expired, spent or
    // revoked one is. Four different messages would let a stranger work out
    // which tokens are real, and this is the one door with no session behind it.
    //
    // Visited with a signed-in session on purpose. The supplier's endpoints are
    // called without credentials, so a colleague who clicks a supplier's link
    // sees precisely what the supplier sees — and if that ever stopped being
    // true, this page would start working in testing and failing in the wild.
    await page.goto('/payment-check-in/not-a-real-token');
    await settle(page);

    await expect(
      page.getByRole('heading', { name: /this link cannot be opened/i }),
    ).toBeVisible();

    // No shell, no sidebar, nowhere else to go. Every link in this application
    // leads somewhere a supplier cannot open.
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await expect(page.getByText(/it cannot be used to sign in/i)).toBeVisible();

    await expect(page).toHaveScreenshot('vendor-page-refused.png', { fullPage: true });
  });
});
