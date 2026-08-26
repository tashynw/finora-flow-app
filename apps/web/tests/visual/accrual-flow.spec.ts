import { expect, test } from '@playwright/test';

import { pageAction, pageAs, plantAccrualInvoice, SESSIONS, settle } from './helpers';

/**
 * An accrual period opened, candidates generated, finalized by one person, and
 * locked by another.
 *
 * The claim of the phase: unpaid invoices become an accountable pack by
 * generating, adjusting with a reason, finalizing, and locking — never by the
 * same person who edited, and never by an assistive suggestion.
 *
 * The unpaid invoice is planted here rather than in seed, so the empty invoice
 * register photographed earlier in the suite stays empty. Its May date keeps
 * July invoices from earlier flows out of this period's candidates.
 */

test.describe('an accrual period, from open to locked', () => {
  test('is opened, filled, finalized by one person, and locked by somebody else', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    plantAccrualInvoice();
    const editor = await pageAs(browser, SESSIONS.clerk, baseURL);
    const locker = await pageAs(browser, SESSIONS.closer, baseURL);

    await test.step('opening a period leaves an empty pack ready for generation', async () => {
      await editor.goto('/accruals');
      await settle(editor);
      await pageAction(editor, 'Accruals', /open period/i).click();
      await settle(editor);

      await editor.getByLabel(/period start/i).fill('2026-05-01');
      await editor.getByLabel(/period end/i).fill('2026-05-31');
      await editor.getByLabel(/^label/i).fill('May 2026');
      await editor.locator('form').getByRole('button', { name: /^open period$/i }).click();
      await settle(editor);

      await editor.goto('/accruals');
      await settle(editor);
      await expect(editor.getByText(/ACC-/i).first()).toBeVisible();

      await expect(editor).toHaveScreenshot('accruals-register-open.png', {
        fullPage: true,
      });
    });

    await test.step('generating pulls in the unpaid invoice', async () => {
      await editor.locator('main').getByRole('listitem').first().getByRole('link').click();
      await editor.waitForURL(/\/accruals\/[0-9a-f-]{36}$/);
      await settle(editor);

      await editor.getByRole('button', { name: /generate candidates/i }).click();
      await settle(editor);

      await expect(editor.getByText(/kingston/i).first()).toBeVisible({ timeout: 15_000 });
      await expect(editor.getByText(/proposed/i).first()).toBeVisible();
      await expect(editor.getByRole('button', { name: /lock period/i })).toHaveCount(0);

      await expect(editor).toHaveScreenshot('accrual-period-proposed.png', {
        fullPage: true,
      });
    });

    await test.step('adjusting and finalizing each open candidate', async () => {
      const row = editor.getByRole('row').filter({ hasText: /kingston/i }).first();
      await row.click();
      await settle(editor);

      const dialog = editor.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByLabel(/^reason/i).fill('Confirmed against the delivery note.');
      await dialog.getByRole('button', { name: /save adjustment/i }).click();
      await settle(editor);

      await row.click();
      await settle(editor);
      await editor.getByRole('dialog').getByRole('button', { name: /finalise candidate/i }).click();
      await settle(editor);

      await expect(editor.getByText(/finalized/i).first()).toBeVisible();
      await expect(editor.getByText(/ready to lock/i)).toBeVisible();

      await expect(editor).toHaveScreenshot('accrual-period-finalized.png', {
        fullPage: true,
      });
    });

    await test.step('the person who edited cannot lock', async () => {
      await expect(editor.getByRole('button', { name: /lock period/i })).toHaveCount(0);
    });

    await test.step('somebody else locks the period', async () => {
      await locker.goto(new URL(editor.url()).pathname);
      await settle(locker);

      await locker.getByRole('button', { name: /lock period/i }).click();
      const dialog = locker.getByRole('dialog', { name: /lock ACC-/i });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel(/^why/i).fill('Month-end review complete for May.');
      await dialog.getByRole('button', { name: /^lock period$/i }).click();
      await settle(locker);

      await expect(locker.getByText(/^locked$/i).first()).toBeVisible();
      await expect(locker.getByRole('button', { name: /lock period/i })).toHaveCount(0);

      await expect(locker).toHaveScreenshot('accrual-period-locked.png', {
        fullPage: true,
      });
    });
  });
});
