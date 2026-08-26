import { expect, test } from '@playwright/test';

import { SESSIONS, settle } from './helpers';

/**
 * The accrual register before any period has been opened.
 *
 * Empty on purpose. The record-creating flow runs after every viewport project
 * has photographed the starting state. Finance both raises and locks, so the
 * empty register is photographed as finance; a requester has no business here.
 */

test.describe('the accrual register, as finance', () => {
  test.use({ storageState: SESSIONS.clerk.storageState });

  test('matches the approved layout', async ({ page }) => {
    await page.goto('/accruals');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Accruals', level: 1 })).toBeVisible();
    await expect(page).toHaveScreenshot('accruals-register-empty.png', {
      fullPage: true,
    });
  });

  test('opens on open periods rather than on everything', async ({ page }) => {
    await page.goto('/accruals');
    await settle(page);

    const views = page.getByRole('group', { name: /choose a view/i });
    await expect(views.getByRole('button', { name: /^open$/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('explains what a period is for instead of showing a blank list', async ({ page }) => {
    await page.goto('/accruals');
    await settle(page);

    await expect(page.getByText(/no open accrual periods/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /open period/i })).toBeEnabled();
  });
});

test.describe('the accrual register without the right to see accruals', () => {
  test.use({ storageState: SESSIONS.requester.storageState });

  test('is refused rather than shown as an empty register', async ({ page }) => {
    await page.goto('/accruals');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Accruals', level: 1 })).toHaveCount(0);
    await expect(page.getByText(/do not have access to this section/i)).toBeVisible();
  });
});
