import { expect, test } from '@playwright/test';

import { SESSIONS, settle } from './helpers';

/**
 * The credit-card register before any statement has been imported.
 *
 * Empty on purpose. The record-creating flow runs after every viewport project
 * has photographed the starting state. Finance both codes and closes, so the
 * empty register is photographed as finance; a requester has no business here.
 */

test.describe('the credit-card register, as finance', () => {
  test.use({ storageState: SESSIONS.clerk.storageState });

  test('matches the approved layout', async ({ page }) => {
    await page.goto('/credit-cards');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Credit cards', level: 1 })).toBeVisible();
    await expect(page).toHaveScreenshot('credit-cards-register-empty.png', {
      fullPage: true,
    });
  });

  test('opens on open periods rather than on everything', async ({ page }) => {
    await page.goto('/credit-cards');
    await settle(page);

    const views = page.getByRole('group', { name: /choose a view/i });
    await expect(views.getByRole('button', { name: /^open$/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('explains what a period is for instead of showing a blank list', async ({ page }) => {
    await page.goto('/credit-cards');
    await settle(page);

    await expect(page.getByText(/no open statement periods/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /import statement/i })).toBeEnabled();
  });
});

test.describe('the credit-card register without the right to see cards', () => {
  test.use({ storageState: SESSIONS.requester.storageState });

  test('is refused rather than shown as an empty register', async ({ page }) => {
    await page.goto('/credit-cards');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Credit cards', level: 1 })).toHaveCount(0);
    await expect(page.getByText(/do not have access to this section/i)).toBeVisible();
  });
});
