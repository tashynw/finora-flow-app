import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { pageAs, SESSIONS, settle } from './helpers';

/**
 * An invoice from a recorded bill to a decision, through the people involved.
 *
 * Three signed-in people at once on the same records, because the claims worth
 * making here cannot be made from one session. That finance cannot confirm a
 * delivery they did not receive; that the person who did confirm it is named
 * against the record; that no approver sees the invoice until that confirmation
 * arrives. None of these mean anything from a single identity, and all of them
 * are the reason receipt sign-off exists at all.
 *
 * Two invoices, because the refusals are where the money is. The first goes the
 * whole way: recorded, confirmed, approved. The second is caught as a duplicate
 * and then declined by the person who was supposed to receive the goods, which
 * are the two ways this workflow stops a payment that should not happen.
 *
 * One test in steps, in its own project, running last: each stage depends on the
 * record the one before it created, and the empty-register baselines taken by
 * the viewport projects are of the register these invoices land in.
 */

// Fixed rather than relative to today. The invoice date must not be in the
// future and the due date must not precede it, so a pair of constants in the
// past satisfies both rules permanently and keeps the screenshots identical
// between runs. What is counted from today — "due in nine days" — is marked
// volatile in the components that render it, for the same reason.
const BILLED_ON = '2026-07-15';
const DUE_ON = '2026-08-14';

const SUPPLIER = 'Kingston Supplies Limited';
const RECEIVER = 'Rina Requester';

/**
 * The box for the total.
 *
 * Found by role and a loose name because every label carries "(required)" or
 * "(optional)" in its accessible name, so an exact match would be matching the
 * asterisk convention rather than the field.
 */
function totalBox(page: Page): Locator {
  return page.getByRole('textbox', { name: /^invoice total/i });
}

/** The panel an approver decides in, which only the person whose turn it is has. */
function decision(page: Page): Locator {
  return page.getByText(/your decision as/i);
}

interface Bill {
  invoiceNumber: string;
  description: string;
  amount: string;
}

/** Fills every box on a draft invoice, leaving nothing outstanding. */
async function fillInvoice(page: Page, bill: Bill): Promise<void> {
  await page.getByRole('combobox', { name: /^supplier/i }).selectOption({ label: SUPPLIER });
  await page.getByRole('textbox', { name: /invoice number/i }).fill(bill.invoiceNumber);
  await page.getByRole('textbox', { name: /what was supplied/i }).fill(bill.description);
  await totalBox(page).fill(bill.amount);
  await page.getByLabel(/date on the invoice/i).fill(BILLED_ON);
  await page.getByLabel(/payment due/i).fill(DUE_ON);
  await page
    .getByRole('combobox', { name: /cost centre/i })
    .selectOption({ label: 'CC-100 — Facilities' });
  await page
    .getByRole('combobox', { name: /gl account/i })
    .selectOption({ label: '6100 — Repairs and maintenance' });
  await page
    .getByRole('combobox', { name: /who confirms it arrived/i })
    .selectOption({ label: RECEIVER });
}

/** The reference an invoice was given, which is the page's own title. */
async function referenceOf(page: Page): Promise<string> {
  const title = await page.getByRole('heading', { level: 1 }).first().textContent();
  return (title ?? '').trim();
}

/** Records a blank invoice and returns the path of the one it created. */
async function recordInvoice(page: Page): Promise<string> {
  await page.goto('/invoices');
  await settle(page);
  await page
    .getByRole('group', { name: 'Invoices actions' })
    .getByRole('button', { name: /record an invoice/i })
    .click();
  await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/);
  await settle(page);
  return new URL(page.url()).pathname;
}

test.describe('an invoice and the people who let it be paid', () => {
  test('is recorded, confirmed, approved, and stopped when it should be', async ({
    browser,
    baseURL,
  }) => {
    const finance = await pageAs(browser, SESSIONS.clerk, baseURL);
    const receiver = await pageAs(browser, SESSIONS.requester, baseURL);
    const unitHead = await pageAs(browser, SESSIONS.approver, baseURL);

    let invoice = '';
    let reference = '';

    await test.step('a blank invoice says what is missing and has asked nobody', async () => {
      invoice = await recordInvoice(finance);
      reference = await referenceOf(finance);
      expect(reference).toMatch(/^INV-\d{6}$/);

      // Everything outstanding at once. Discovering the remaining fields through
      // one refusal at a time is the failure this panel exists to prevent.
      await expect(finance.getByText(/things still to fill in/i)).toBeVisible();
      await expect(
        finance.getByRole('heading', { name: /before anybody can be asked to confirm/i }),
      ).toBeVisible();

      // Including the person to ask, which is not a field of the bill but is the
      // reason the send button is unavailable. Left off the list, it would be a
      // disabled control with nothing on screen explaining itself.
      await expect(finance.getByText(/name the person who will confirm/i)).toBeVisible();

      // Listed above, but not marked against the boxes themselves. A form that
      // opens with every field red accuses the reader of mistakes they have not
      // had the chance to make.
      await expect(finance.locator('[aria-invalid="true"]')).toHaveCount(0);

      // Nobody is being chased, because nobody has been asked.
      await expect(
        finance.getByRole('heading', { name: /receipt not yet confirmed/i }),
      ).toBeVisible();

      await expect(finance).toHaveScreenshot('invoice-draft-new.png', { fullPage: true });
    });

    await test.step('leaving with unsaved changes is questioned, not obeyed', async () => {
      await finance
        .getByRole('textbox', { name: /what was supplied/i })
        .fill('Air-conditioning units');
      await finance.getByRole('link', { name: /all invoices/i }).click();

      const warning = finance.getByRole('dialog', { name: /changes you have not saved/i });
      await expect(warning).toBeVisible();
      await expect(finance).toHaveURL(new RegExp(`${invoice}$`));

      await warning.getByRole('button', { name: /stay on this page/i }).click();
      await expect(warning).toBeHidden();
      await expect(finance.getByRole('textbox', { name: /what was supplied/i })).toHaveValue(
        'Air-conditioning units',
      );
    });

    await test.step('a completed invoice names who will be asked and what it will need', async () => {
      await fillInvoice(finance, {
        invoiceNumber: 'KSL-2026-4411',
        description: 'Replacement air-conditioning units for the Kingston branch',
        amount: '40000',
      });
      await finance.getByRole('button', { name: /save draft/i }).click();
      await expect(finance.getByText(/draft saved at/i)).toBeVisible();

      // Nothing outstanding, so the panel is gone rather than empty.
      await expect(
        finance.getByRole('heading', { name: /before anybody can be asked to confirm/i }),
      ).toHaveCount(0);

      // The person about to be chased is named on the panel, in a sentence,
      // before any chasing starts. Reminders every three working hours to
      // somebody finance never saw named is how the wrong person gets chased for
      // a week. Matched on the sentence rather than the name alone, because the
      // name is also sitting in the selector it was chosen from.
      await expect(
        finance.getByText(new RegExp(`${RECEIVER} will be asked to confirm`)),
      ).toBeVisible();

      // JMD 40,000 is below the JMD 50,000 band, so a Manager is not on this
      // route. This is the assertion that fails if the bands are read wrongly.
      await expect(finance.getByText('Unit Head', { exact: true })).toBeVisible();
      await expect(finance.getByText('Manager', { exact: true })).toHaveCount(0);

      await expect(finance).toHaveScreenshot('invoice-draft-complete.png', { fullPage: true });
    });

    await test.step('asking for confirmation starts the clock and closes the form', async () => {
      await finance.getByRole('button', { name: /ask for confirmation/i }).click();

      await expect(finance.getByText('Pending sign-off').first()).toBeVisible();

      // Read back rather than editable. An amount that could change while
      // somebody is being asked to vouch for it is an amount nobody vouched for.
      await expect(finance.getByRole('heading', { name: 'What was billed' })).toBeVisible();
      await expect(totalBox(finance)).toHaveCount(0);

      // Finance cannot answer their own question, whatever else they may do.
      await expect(finance.getByRole('button', { name: /yes, this arrived/i })).toHaveCount(0);
      await expect(finance.getByRole('button', { name: /take it back/i })).toBeEnabled();

      // Asked, and not yet chased. The distinction matters to whoever later
      // judges whether escalating was reasonable.
      await expect(finance.getByText(/nobody has been chased yet/i)).toBeVisible();

      // The note left over from the last save is gone with the draft it described.
      // It said nobody had been asked, and somebody just was; leaving it up sends
      // finance to chase a person by hand who is already being chased by email.
      await expect(finance.getByText(/nobody has been asked about it yet/i)).toHaveCount(0);

      await expect(finance).toHaveScreenshot('invoice-pending-sign-off.png', { fullPage: true });
    });

    await test.step('it reaches the right person, and no approver sees it yet', async () => {
      await receiver.goto('/invoices');
      await settle(receiver);

      const row = receiver.getByRole('link', { name: new RegExp(reference) });
      await expect(row).toBeVisible();
      await expect(row.getByText('Confirm receipt')).toBeVisible();

      await expect(receiver).toHaveScreenshot('invoices-waiting-to-confirm.png', {
        fullPage: true,
      });

      // The control's whole purpose. An approver who could decide before anybody
      // confirmed the delivery would be approving payment for a claim.
      await unitHead.goto('/invoices');
      await settle(unitHead);
      await expect(unitHead.getByRole('link', { name: new RegExp(reference) })).toHaveCount(0);
    });

    await test.step('the person who asked for the goods confirms they arrived', async () => {
      await receiver.goto(invoice);
      await settle(receiver);

      // Put as a question about a delivery, not as an approval. Somebody working
      // through their inbox must not think they are agreeing to the spending.
      await expect(receiver.getByRole('heading', { name: /did this arrive\?/i })).toBeVisible();
      await expect(receiver.getByText(/not an approval of the spending/i)).toBeVisible();
      await expect(receiver.getByRole('button', { name: /no, something is wrong/i })).toBeVisible();

      await expect(receiver).toHaveScreenshot('invoice-confirm-receipt.png', { fullPage: true });

      await receiver
        .getByRole('textbox', { name: /anything worth recording/i })
        .fill('Both units delivered on the 14th and installed the same day.');
      await receiver.getByRole('button', { name: /yes, this arrived/i }).click();

      // Named and quoted. A confirmation with nobody against it is not a control.
      await expect(receiver.getByRole('heading', { name: /receipt confirmed/i })).toBeVisible();
      await expect(receiver.getByText(/installed the same day/)).toBeVisible();
      await expect(
        receiver.getByText(new RegExp(`${RECEIVER} confirmed that this was received`)),
      ).toBeVisible();
    });

    await test.step('only now does it reach an approver', async () => {
      await unitHead.goto('/invoices');
      await settle(unitHead);

      const row = unitHead.getByRole('link', { name: new RegExp(reference) });
      await expect(row).toBeVisible();
      await expect(row.getByText('Yours to decide')).toBeVisible();

      await unitHead.goto(invoice);
      await settle(unitHead);

      // Exactly one panel: theirs. Two would mean the interface had offered a
      // decision the server would refuse.
      await expect(decision(unitHead)).toHaveCount(1);
      await expect(decision(unitHead)).toContainText('Unit Head');
      // What the delivery was vouched for as, in front of the person deciding
      // whether to pay for it.
      await expect(unitHead.getByText(/installed the same day/)).toBeVisible();

      await expect(unitHead).toHaveScreenshot('invoice-decision.png', { fullPage: true });

      await unitHead.getByRole('button', { name: /^approve$/i }).click();
      await unitHead.getByRole('button', { name: /record the approval/i }).click();

      await expect(unitHead.getByText('Fully approved', { exact: true })).toBeVisible();
      await expect(unitHead.getByText('Ana Approver').first()).toBeVisible();

      await expect(unitHead).toHaveScreenshot('invoice-approved.png', { fullPage: true });
    });

    // ------------------------------------------------- the bill that is stopped

    let second = '';
    let secondReference = '';

    await test.step('a second bill carrying the same number is caught as a duplicate', async () => {
      second = await recordInvoice(finance);
      secondReference = await referenceOf(finance);

      await fillInvoice(finance, {
        // The same supplier and the same number as the invoice already approved.
        // Paying a supplier twice for one delivery is the most expensive ordinary
        // mistake in accounts payable, and it nearly always looks like this.
        invoiceNumber: 'KSL-2026-4411',
        description: 'Replacement air-conditioning units for the Kingston branch',
        amount: '40000',
      });
      await finance.getByRole('button', { name: /save draft/i }).click();
      await expect(finance.getByText(/draft saved at/i)).toBeVisible();

      // Reported as a control that has fired, in red, above the form — not as one
      // more amber field to skim past. The draft is still saved, because the
      // person who spotted it needs both records in front of them.
      await expect(
        finance.getByRole('heading', { name: /a control has stopped this invoice/i }),
      ).toBeVisible();
      // Said twice on purpose: once in the list of what is stopping the invoice,
      // and once against the number itself, so it is neither missed at a glance
      // nor a mystery by the time the eye reaches the field.
      const duplicate = /already sent an invoice with this number/i;
      await expect(finance.getByRole('listitem').filter({ hasText: duplicate })).toBeVisible();
      await expect(finance.locator('[aria-live="polite"]').filter({ hasText: duplicate })).toBeVisible();

      await expect(finance).toHaveScreenshot('invoice-duplicate-blocked.png', { fullPage: true });
    });

    await test.step('the duplicate cannot be sent on, whatever else is right about it', async () => {
      // Refused by being unavailable rather than by being clickable and then
      // failing: the reason is already stated above the form, and a button that
      // cannot work invites somebody to press it until it does. The server turns
      // the same request down on its own account, which the API tests hold to.
      await expect(finance.getByRole('button', { name: /ask for confirmation/i })).toBeDisabled();

      // Nothing moved and nobody was emailed about a bill that should not be paid.
      await expect(finance.getByText('Pending sign-off')).toHaveCount(0);
    });

    await test.step('a bill for goods that never came is sent back with a reason', async () => {
      // Given its own number, so what is tested below is the decline rather than
      // the duplicate control firing again.
      await finance.getByRole('textbox', { name: /invoice number/i }).fill('KSL-2026-4412');
      await finance.getByRole('button', { name: /ask for confirmation/i }).click();
      await expect(finance.getByText('Pending sign-off').first()).toBeVisible();

      await receiver.goto(second);
      await settle(receiver);
      await receiver.getByRole('button', { name: /no, something is wrong/i }).click();

      const dialog = receiver.getByRole('dialog');
      await expect(dialog).toBeVisible();
      // Refused without a reason. Finance cannot take "no" to a supplier, and the
      // record could not answer for itself later.
      await expect(dialog.getByRole('button', { name: /send it back/i })).toBeDisabled();

      await dialog
        .getByLabel(/what is wrong with it/i)
        .fill('Only one of the two units was delivered. The second is still on back order.');
      await dialog.getByRole('button', { name: /send it back/i }).click();

      await expect(dialog).toBeHidden();
      await expect(receiver.getByRole('heading', { name: /receipt was declined/i })).toBeVisible();
      await expect(receiver.getByText(/still on back order/).first()).toBeVisible();

      await expect(receiver).toHaveScreenshot('invoice-declined.png', { fullPage: true });
    });

    await test.step('finance is told she answered, not that she is still being waited on', async () => {
      await finance.goto(second);
      await settle(finance);

      // The failure this guards against is a panel that still reads "waiting on
      // the requester" after the requester has answered, which sends finance off
      // to chase somebody who already replied.
      await expect(finance.getByRole('heading', { name: /receipt was declined/i })).toBeVisible();
      await expect(finance.getByText(/still on back order/).first()).toBeVisible();
      await expect(finance.getByText(/next reminder/i)).toHaveCount(0);

      // Back with finance to correct: editable again, and nobody has approved
      // anything.
      await expect(totalBox(finance)).toBeVisible();
      await expect(decision(finance)).toHaveCount(0);

      await expect(finance).toHaveScreenshot('invoice-declined-for-finance.png', {
        fullPage: true,
      });
    });

    await test.step('each invoice sits in the register under its own outcome', async () => {
      await finance.goto('/invoices');
      await settle(finance);
      await finance
        .getByRole('group', { name: /choose a view/i })
        .getByRole('button', { name: 'Everything' })
        .click();
      await settle(finance);

      await expect(finance.getByRole('link', { name: new RegExp(reference) })).toBeVisible();
      await expect(finance.getByRole('link', { name: new RegExp(secondReference) })).toBeVisible();

      await expect(finance).toHaveScreenshot('invoices-register-populated.png', {
        fullPage: true,
      });
    });
  });
});
