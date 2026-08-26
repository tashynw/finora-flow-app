import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { pageAs, SESSIONS, settle } from './helpers';

/**
 * Approved invoices gathered into one instruction to the bank, and sent.
 *
 * The claim this flow exists to make is the one the phase is for: a package
 * holding two currencies shows two totals and never a third figure combining
 * them. Everything else here is in service of getting a genuinely mixed package
 * in front of a reviewer — and a second currency is where two controls fail
 * closed at once. The matrix ships with JMD bands alone and refuses a USD
 * invoice rather than guessing who may approve foreign spend, and the
 * purchase-order threshold is stated in JMD alone, which makes an order
 * mandatory for every US dollar bill. Both are worked through in the interface
 * rather than arranged behind it, because the arranging is the evidence.
 *
 * Five people, on the same records, because none of the controls mean anything
 * from one identity. An administrator writes the band and approves nothing.
 * Finance records the bill and cannot send money. The person who asked for the
 * goods confirms they came. An approver agrees to the spend. Only then may the
 * payments coordinator put it in a package — and finance, who holds the right to
 * declare a payment received, is offered no way to send one.
 *
 * Runs after the invoice flow and depends on what it leaves behind: one approved
 * JMD invoice. That is the other half of the mixed package.
 */

// Fixed rather than counted from today, so the manifest, the screenshots and the
// digest are the same on every run. Far enough out that the "intended payment
// date has gone by" control never fires for the life of these baselines.
const PAY_ON = '2030-01-15';

// The invoice's own dates, in the past for the same reason the invoice flow's
// are: an invoice may not be dated in the future, and its due date may not
// precede it.
const BILLED_ON = '2026-07-20';
const DUE_ON = '2026-08-19';

const SUPPLIER = 'Caribbean Facilities Services';
const RECEIVER = 'Rina Requester';

/**
 * The card that answers "what does this come to".
 *
 * Scoped by the card class rather than by filtering every ancestor on the text,
 * which resolves to the header the title sits in and finds none of the figures
 * underneath it.
 */
function totalsCard(page: Page) {
  return page.locator('.surface-card').filter({ hasText: 'What it comes to' });
}

/**
 * Write one band into the matrix for a record type that has none in this currency.
 *
 * Written twice with different arguments rather than once with a loop, because
 * the two rules exist for different reasons and the test reads better saying so.
 */
async function addUsdRule(
  page: Page,
  { recordType, name, why }: { recordType: string; name: string; why: string },
) {
  await page.goto('/settings/approval-matrix');
  await settle(page);

  await page
    .getByRole('group', { name: /choose a record type/i })
    .getByRole('button', { name: recordType })
    .click();
  await settle(page);

  await page
    .getByRole('group', { name: 'Approval matrix actions' })
    .getByRole('button', { name: /add a rule/i })
    .click();

  const dialog = page.getByRole('dialog', { name: /add a rule/i });
  await expect(dialog).toBeVisible();

  await dialog.getByRole('textbox', { name: /what this rule is called/i }).fill(name);
  await dialog.getByRole('combobox', { name: /who approves/i }).selectOption('unit_head');
  await dialog.getByRole('textbox', { name: /^currency/i }).fill('USD');
  await dialog.getByRole('textbox', { name: /^from/i }).fill('0');
  await dialog.getByRole('textbox', { name: /why this rule exists/i }).fill(why);

  await dialog.getByRole('button', { name: /add it/i }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(name)).toBeVisible();
}

test.describe('a payment package, from approved invoices to the bank', () => {
  test('is assembled, priced per currency, sent once, and then fixed', async ({
    browser,
    baseURL,
  }) => {
    const administrator = await pageAs(browser, SESSIONS.administrator, baseURL);
    const finance = await pageAs(browser, SESSIONS.clerk, baseURL);
    const receiver = await pageAs(browser, SESSIONS.requester, baseURL);
    const unitHead = await pageAs(browser, SESSIONS.approver, baseURL);
    const payments = await pageAs(browser, SESSIONS.payments, baseURL);

    let usdOrder = '';
    let usdInvoice = '';
    let packagePath = '';
    let reference = '';

    await test.step('a currency with no bands is refused rather than guessed at', async () => {
      // The matrix ships with JMD alone. Until somebody decides who may approve
      // US dollar spend, the platform will not decide it by treating the digits
      // as comparable — a five-figure US invoice would otherwise go through a
      // Unit Head because the number looked small.
      //
      // Two rules, because a US dollar invoice needs a purchase order behind it
      // (see below) and an order is approved on its own matrix. Both are the
      // same refusal: no band, no route, no guess.
      await addUsdRule(administrator, {
        recordType: 'Invoices',
        name: 'Unit Head, all US dollar invoices',
        why: 'Suppliers invoicing in US dollars have no route at all until this exists.',
      });
      await addUsdRule(administrator, {
        recordType: 'Purchase orders',
        name: 'Unit Head, all US dollar orders',
        why: 'US dollar orders cannot be committed while no band says who may agree to them.',
      });
    });

    await test.step('a US dollar order is raised first, because the order control fails closed', async () => {
      // The purchase-order threshold is configured in JMD alone, and a figure in
      // JMD says nothing about US dollars. Rather than let an unconfigured
      // currency quietly switch the control off, every invoice in one needs an
      // order — so the order comes first.
      await finance.goto('/purchase-orders');
      await settle(finance);
      await finance
        .getByRole('group', { name: 'Purchase orders actions' })
        .getByRole('button', { name: /raise an order/i })
        .click();
      await finance.waitForURL(/\/purchase-orders\/[0-9a-f-]{36}$/);
      await settle(finance);

      await finance.getByRole('combobox', { name: /^supplier/i }).selectOption({ label: SUPPLIER });
      await finance
        .getByRole('textbox', { name: /what is being ordered/i })
        .fill('Annual fire safety inspection and certification');
      await finance.getByRole('textbox', { name: /order total/i }).fill('15000');
      await finance.getByRole('combobox', { name: /^currency/i }).selectOption('USD');
      // Named without its code, unlike the invoice form's version of the same
      // selector.
      await finance.getByRole('combobox', { name: /cost centre/i }).selectOption({
        label: 'Facilities',
      });

      usdOrder = (
        (await finance.getByRole('heading', { level: 1 }).first().textContent()) ?? ''
      ).trim();

      await finance.getByRole('button', { name: /send for approval/i }).click();
      await settle(finance);

      await unitHead.goto(new URL(finance.url()).pathname);
      await settle(unitHead);
      await unitHead.getByRole('button', { name: /^approve$/i }).click();
      await unitHead.getByRole('button', { name: /record the approval/i }).click();
      // Open and with room in it, which is the only condition under which an
      // invoice may name it.
      await expect(unitHead.getByText(/still available to bill against/i)).toBeVisible();
    });

    await test.step('a US dollar invoice is recorded, confirmed and approved', async () => {
      await finance.goto('/invoices');
      await settle(finance);
      await finance
        .getByRole('group', { name: 'Invoices actions' })
        .getByRole('button', { name: /record an invoice/i })
        .click();
      await finance.waitForURL(/\/invoices\/[0-9a-f-]{36}$/);
      await settle(finance);
      usdInvoice = new URL(finance.url()).pathname;

      await finance.getByRole('combobox', { name: /^supplier/i }).selectOption({ label: SUPPLIER });
      await finance.getByRole('textbox', { name: /invoice number/i }).fill('CFS-2026-0090');
      await finance
        .getByRole('textbox', { name: /what was supplied/i })
        .fill('Annual fire safety inspection, billed in US dollars');
      await finance.getByRole('textbox', { name: /^invoice total/i }).fill('12000');
      await finance.getByRole('combobox', { name: /^currency/i }).selectOption('USD');
      await finance.getByLabel(/date on the invoice/i).fill(BILLED_ON);
      await finance.getByLabel(/payment due/i).fill(DUE_ON);

      // Chosen by its option's value rather than by its label, because the
      // label carries the remaining balance and pinning a formatted figure into
      // the test would break it the first time anything bills the order.
      const orders = finance.getByRole('combobox', { name: /^purchase order/i });
      const chosen = await orders.locator('option', { hasText: usdOrder }).getAttribute('value');
      await orders.selectOption(chosen ?? '');

      await finance
        .getByRole('combobox', { name: /cost centre/i })
        .selectOption({ label: 'CC-100 — Facilities' });
      await finance
        .getByRole('combobox', { name: /gl account/i })
        .selectOption({ label: '6400 — Professional fees' });
      await finance
        .getByRole('combobox', { name: /who confirms it arrived/i })
        .selectOption({ label: RECEIVER });

      await finance.getByRole('button', { name: /ask for confirmation/i }).click();
      await expect(finance.getByText('Pending sign-off').first()).toBeVisible();

      await receiver.goto(usdInvoice);
      await settle(receiver);
      await receiver.getByRole('button', { name: /yes, this arrived/i }).click();
      await expect(receiver.getByRole('heading', { name: /receipt confirmed/i })).toBeVisible();

      await unitHead.goto(usdInvoice);
      await settle(unitHead);
      await unitHead.getByRole('button', { name: /^approve$/i }).click();
      await unitHead.getByRole('button', { name: /record the approval/i }).click();
      await expect(unitHead.getByText('Fully approved', { exact: true })).toBeVisible();
    });

    await test.step('an empty package explains itself and asks for nobody’s approval', async () => {
      await payments.goto('/payments');
      await settle(payments);

      await payments
        .getByRole('group', { name: 'Payment packages actions' })
        .getByRole('button', { name: /start a package/i })
        .click();
      await payments.waitForURL(/\/payments\/[0-9a-f-]{36}$/);
      await settle(payments);

      packagePath = new URL(payments.url()).pathname;
      reference = ((await payments.getByRole('heading', { level: 1 }).first().textContent()) ?? '')
        .trim();
      expect(reference).toMatch(/^PAY-\d{6}$/);

      // Nothing here is waiting on a decision, and nothing pretends to be.
      // Every invoice a package can hold was approved before it could be added,
      // so an approval panel on this screen would be inviting a second one.
      await expect(payments.getByText(/nothing in it yet/i).first()).toBeVisible();
      await expect(payments.getByText(/your decision as/i)).toHaveCount(0);
      await expect(payments.getByRole('button', { name: /send to the bank/i })).toHaveCount(0);

      await expect(payments).toHaveScreenshot('payment-package-empty.png', { fullPage: true });
    });

    await test.step('choosing what goes out prices the selection as it is ticked', async () => {
      await payments.getByRole('button', { name: /add invoices/i }).click();

      const picker = payments.getByRole('dialog', { name: /add approved invoices/i });
      await expect(picker).toBeVisible();

      // Nothing is preselected. A dialog that opens with everything ticked turns
      // paying a supplier into a matter of not noticing.
      await expect(picker.getByText(/nothing chosen yet/i)).toBeVisible();

      // Both approved invoices and nothing else: the two the earlier steps left,
      // in two currencies.
      await expect(picker.getByRole('listitem')).toHaveCount(2);

      await expect(payments).toHaveScreenshot('payment-package-add-invoices.png', {
        fullPage: true,
      });

      await picker.getByRole('button', { name: /tick these 2/i }).click();

      // Priced as two figures while it is still being chosen, because "how much
      // is about to leave" is the question, and nobody adds up thirty rows.
      await expect(picker.getByText(/2 chosen, coming to/i)).toContainText('JMD');
      await expect(picker.getByText(/2 chosen, coming to/i)).toContainText('USD');

      await picker.getByRole('button', { name: /^add 2 invoices$/i }).click();
      await expect(picker).toBeHidden();
    });

    await test.step('two currencies come to two totals and never to a third figure', async () => {
      // The claim of the phase. There is no rate at which JMD and USD add up,
      // so a single number beside them would be denominated in nothing — and
      // somebody would eventually put it in front of a bank.
      const totals = totalsCard(payments);
      await expect(totals.getByRole('listitem')).toHaveCount(2);
      await expect(totals.getByText(/no rate at which they add up/i)).toBeVisible();

      await expect(totals.getByText('2 invoices, 2 suppliers', { exact: true })).toBeVisible();
    });

    await test.step('a package with no method or date says so and produces no manifest', async () => {
      // Both are on the manifest, so until they exist there is no file to
      // preview. Reported as unfinished work rather than as an error.
      // Read from the list of what is unfinished rather than from the fields:
      // each gap is said twice, once beside the control and once in the summary,
      // and it is the summary that makes the package's own state legible.
      const unfinished = payments.getByRole('listitem');
      await expect(unfinished.filter({ hasText: /say how the money leaves/i })).toBeVisible();
      await expect(
        unfinished.filter({ hasText: /give the date the money is meant to leave/i }),
      ).toBeVisible();
      await expect(payments.getByRole('button', { name: /send to the bank/i })).toHaveCount(0);
    });

    await test.step('the manifest appears once the bank has been told how and when', async () => {
      await payments
        .getByRole('combobox', { name: /how it is paid/i })
        .selectOption('bank_transfer');
      await payments.getByLabel(/intended payment date/i).fill(PAY_ON);
      await payments
        .getByRole('textbox', { name: /what this package is for/i })
        .fill('Suppliers, mixed currency, January run');
      await payments.getByRole('button', { name: /^save$/i }).click();
      await expect(payments.getByText(/^saved at/i)).toBeVisible();
      await settle(payments);

      // Both invoices on the file, and a fingerprint over it. The digest is what
      // makes the stored evidence worth storing.
      const manifest = payments.locator('.surface-card').filter({ hasText: 'The manifest' });
      await expect(manifest.getByText('Invoices listed')).toBeVisible();
      await expect(manifest.getByText(/^[0-9a-f]{64}$/)).toBeVisible();

      await expect(payments).toHaveScreenshot('payment-package-ready.png', { fullPage: true });
    });

    await test.step('the last screen before the money goes restates the figures', async () => {
      await payments.getByRole('button', { name: /send to the bank/i }).click();

      const confirm = payments.getByRole('dialog', { name: new RegExp(`send ${reference}`, 'i') });
      await expect(confirm).toBeVisible();

      // Not "are you sure". A confirmation that only asks for confirmation is
      // answered without being read; the figures are the last chance to
      // recognise the wrong package.
      await expect(confirm.getByRole('listitem')).toHaveCount(2);
      await expect(confirm.getByText(/two currencies, so two figures/i)).toBeVisible();

      // Refused without the bank's reference. Without it there is nothing tying
      // this package to what the bank did with it, on either side.
      await expect(confirm.getByRole('button', { name: /record it as sent/i })).toBeDisabled();

      await expect(payments).toHaveScreenshot('payment-package-submit.png', { fullPage: true });

      await confirm.getByRole('textbox', { name: /the bank's reference/i }).fill('BATCH-2030-0114');
      await confirm.getByRole('button', { name: /record it as sent/i }).click();
      await expect(confirm).toBeHidden();
    });

    await test.step('what was sent is fixed, and answerable', async () => {
      await settle(payments);

      await expect(payments.getByText('Submitted').first()).toBeVisible();

      // Who sent it and under what reference, read from the evidence card
      // rather than from anywhere on the page: the coordinator's name is also
      // in the account menu and in the line saying who started the package,
      // and neither of those is evidence of anything.
      const evidence = payments
        .locator('.surface-card')
        .filter({ hasText: 'Evidence of submission' });
      await expect(evidence.getByText('BATCH-2030-0114', { exact: true })).toBeVisible();
      await expect(evidence.getByText('Paula Payments', { exact: true })).toBeVisible();

      // Immutable, and shown to be. Nothing can be added, taken out or edited,
      // because a package that could change after submission could not say what
      // the bank was given.
      await expect(payments.getByRole('button', { name: /add invoices/i })).toHaveCount(0);
      await expect(payments.getByRole('button', { name: /^save$/i })).toHaveCount(0);
      await expect(payments.getByRole('button', { name: /abandon/i })).toHaveCount(0);
      await expect(payments.getByRole('combobox', { name: /how it is paid/i })).toHaveCount(0);

      // Sent is not paid, and the page says so where somebody might assume
      // otherwise.
      await expect(payments.getByText(/not yet confirmed paid/i)).toBeVisible();

      await expect(payments).toHaveScreenshot('payment-package-submitted.png', { fullPage: true });
    });

    await test.step('the invoices inside it moved with it', async () => {
      // The package has no state; the money does. Submitting moves every
      // invoice in it to Submitted, which is where a supplier confirmation
      // later finds them.
      await finance.goto(usdInvoice);
      await settle(finance);
      await expect(finance.getByText('Submitted').first()).toBeVisible();
    });

    await test.step('nothing is left that could be paid twice', async () => {
      // Both invoices are spoken for, so neither can be offered to a second
      // package. The server refuses it either way; this is what keeps that
      // refusal rare rather than routine.
      await payments.goto('/payments');
      await settle(payments);

      await payments
        .getByRole('group', { name: 'Payment packages actions' })
        .getByRole('button', { name: /start a package/i })
        .click();
      await payments.waitForURL(/\/payments\/[0-9a-f-]{36}$/);
      await settle(payments);

      await payments.getByRole('button', { name: /add invoices/i }).click();
      const picker = payments.getByRole('dialog', { name: /add approved invoices/i });
      await expect(picker.getByText(/nothing is waiting to be paid/i)).toBeVisible();
      await picker.getByRole('button', { name: /back/i }).click();

      await payments.getByRole('button', { name: /abandon/i }).click();
      const abandon = payments.getByRole('dialog', { name: /abandon this package/i });
      await abandon
        .getByRole('textbox', { name: /why you are abandoning it/i })
        .fill('Opened by mistake: everything approved is already in the January run.');
      await abandon.getByRole('button', { name: /abandon it/i }).click();
      await expect(abandon).toBeHidden();

      await expect(payments.getByRole('heading', { name: /^abandoned$/i })).toBeVisible();
    });

    await test.step('the register separates what has gone from what has not', async () => {
      await payments.goto('/payments');
      await settle(payments);

      // Nothing is being assembled: one package went, the other was abandoned.
      await expect(payments.getByText(/no package is being assembled/i)).toBeVisible();

      await payments
        .getByRole('group', { name: /choose a view/i })
        .getByRole('button', { name: 'Everything' })
        .click();
      await settle(payments);

      const sent = payments
        .locator('main')
        .getByRole('listitem')
        .filter({ hasText: reference });
      await expect(sent.getByText('Submitted')).toBeVisible();
      await expect(sent.getByText(/bank reference BATCH-2030-0114/)).toBeVisible();
      // Two figures on the row as well. A register that summed them would be
      // the one place the rule was quietly broken.
      await expect(sent.getByRole('listitem')).toHaveCount(2);

      await expect(payments).toHaveScreenshot('payments-register-populated.png', {
        fullPage: true,
      });
    });

    await test.step('finance can read the package and cannot send another', async () => {
      // Finance declares payments received. Sending money and confirming it
      // arrived is the pair segregation of duties most exists to keep apart, so
      // the controls are absent rather than present and refused.
      await finance.goto(packagePath);
      await settle(finance);

      await expect(finance.getByRole('heading', { name: reference, level: 1 })).toBeVisible();
      await expect(finance.getByText('BATCH-2030-0114', { exact: true })).toBeVisible();
      await expect(finance.getByRole('button', { name: /send to the bank/i })).toHaveCount(0);
      await expect(finance.getByRole('button', { name: /add invoices/i })).toHaveCount(0);
    });
  });
});
