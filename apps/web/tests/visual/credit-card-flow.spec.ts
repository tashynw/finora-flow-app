import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';

import { pageAs, SESSIONS, settle } from './helpers';

/**
 * A statement imported, coded by one person, and closed by another.
 *
 * The claim of the phase: charges that already happened become accountable by
 * coding, and closing freezes that coding — never by an assistive suggestion,
 * and never by the same person who wrote the codes.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STATEMENT = `date,merchant,amount,cardholder,category
2026-05-02,Kingston Office Depot,125.50,A. Reid,Supplies
2026-05-03,Caribbean Airlines,450.00,A. Reid,Travel
`;

function statementFile(): string {
  const dir = path.join(__dirname, '.fixtures');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'may-statement.csv');
  writeFileSync(file, STATEMENT, 'utf8');
  return file;
}

async function codeAndWaive(page: Page, merchant: string): Promise<void> {
  await page.getByRole('row', { name: new RegExp(merchant, 'i') }).click();
  await settle(page);

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByLabel(/^gl account/i).selectOption({ label: '6100 — Repairs and maintenance' });
  await dialog.getByLabel(/^cost centre/i).selectOption({ label: 'CC-100 — Facilities' });
  await dialog.getByRole('button', { name: /save coding/i }).click();
  await settle(page);
  await expect(dialog).toHaveCount(0);

  await page.getByRole('row', { name: new RegExp(merchant, 'i') }).click();
  await settle(page);
  await expect(dialog).toBeVisible();
  await dialog
    .getByLabel(/waive receipt/i)
    .fill('Issuer fee line — no merchant receipt was issued.');
  await dialog.getByRole('button', { name: /waive receipt/i }).click();
  await settle(page);
  await expect(dialog).toHaveCount(0);
}

test.describe('a credit-card statement, from import to closed', () => {
  test('is imported, coded by one person, and closed by somebody else', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const coder = await pageAs(browser, SESSIONS.clerk, baseURL);
    const closer = await pageAs(browser, SESSIONS.closer, baseURL);
    const csv = statementFile();

    await test.step('import opens a period with uncoded lines', async () => {
      await coder.goto('/credit-cards');
      await settle(coder);
      await coder.getByRole('button', { name: /import statement/i }).click();
      await settle(coder);

      // No card yet — create one as part of the first import.
      await coder.getByLabel(/^card label/i).fill('Facilities Mastercard');
      await coder.getByLabel(/last four digits/i).fill('4412');
      await coder.getByLabel(/^cardholder/i).fill('A. Reid');
      await coder.getByRole('button', { name: /save card/i }).click();
      await settle(coder);

      await expect(coder.getByRole('combobox', { name: /^card/i })).toBeVisible();

      await coder.getByLabel(/period start/i).fill('2026-05-01');
      await coder.getByLabel(/period end/i).fill('2026-05-31');
      await coder.getByLabel(/statement date/i).fill('2026-06-01');
      await coder.getByLabel(/statement csv/i).setInputFiles(csv);
      await coder.getByRole('button', { name: /^import$/i }).click();
      await settle(coder);

      // Import closes the panel and lands the new period on the open view.
      await expect(coder.getByText(/CCS-/i).first()).toBeVisible({ timeout: 15_000 });
      await expect(coder.getByText(/2 lines still need coding/i)).toBeVisible();

      await expect(coder).toHaveScreenshot('credit-cards-register-open.png', {
        fullPage: true,
      });
    });

    await test.step('the period shows every charge and nothing is settled yet', async () => {
      await coder.locator('main').getByRole('listitem').first().getByRole('link').click();
      await coder.waitForURL(/\/credit-cards\/[0-9a-f-]{36}$/);
      await settle(coder);

      await expect(coder.getByText('Kingston Office Depot')).toBeVisible();
      await expect(coder.getByText('Caribbean Airlines')).toBeVisible();
      await expect(coder.getByText(/needs coding/i).first()).toBeVisible();
      await expect(coder.getByRole('button', { name: /close period/i })).toHaveCount(0);

      await expect(coder).toHaveScreenshot('credit-card-period-uncoded.png', {
        fullPage: true,
      });
    });

    await test.step('coding each line, and waiving receipts that will not arrive', async () => {
      await codeAndWaive(coder, 'Kingston Office Depot');
      await codeAndWaive(coder, 'Caribbean Airlines');

      await expect(coder.getByText(/ready to close/i)).toBeVisible();
      await expect(coder).toHaveScreenshot('credit-card-period-coded.png', {
        fullPage: true,
      });
    });

    await test.step('the person who coded cannot close', async () => {
      await expect(coder.getByRole('button', { name: /close period/i })).toHaveCount(0);
    });

    await test.step('somebody else closes the period', async () => {
      await closer.goto(new URL(coder.url()).pathname);
      await settle(closer);

      await closer.getByRole('button', { name: /close period/i }).click();
      const dialog = closer.getByRole('dialog', { name: /close CCS-/i });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel(/^why/i).fill('Month-end review complete for May.');
      await dialog.getByRole('button', { name: /^close period$/i }).click();
      await settle(closer);

      await expect(closer.getByText(/^closed$/i).first()).toBeVisible();
      await expect(closer.getByRole('button', { name: /close period/i })).toHaveCount(0);

      await expect(closer).toHaveScreenshot('credit-card-period-closed.png', {
        fullPage: true,
      });
    });
  });
});
