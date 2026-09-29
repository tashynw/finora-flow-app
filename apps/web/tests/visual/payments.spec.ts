import { expect, test } from '@playwright/test';

import { pageAction, SESSIONS, settle } from './helpers';

/**
 * The payment package register before anything has been assembled.
 *
 * Empty on purpose. The record-creating flow runs after every viewport project
 * has photographed the starting state, so what these baselines cover is the
 * screen a payments team meets on a Monday morning: no packages, and an
 * explanation of what one is for rather than a blank card.
 *
 * Three roles, because who may do what to a payment is the whole control. The
 * coordinator assembles and sends; finance may see the register and must never
 * be offered either, since declaring a payment received is finance's right and
 * holding both would let one person send money and then confirm it arrived; a
 * requester has no business here at all.
 */

test.describe('the payment package register, as the payments team', () => {
  test.use({ storageState: SESSIONS.payments.storageState });

  test('matches the approved layout', async ({ page }) => {
    await page.goto('/payments');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Payment packages', level: 1 })).toBeVisible();
    await expect(page).toHaveScreenshot('payments-register-empty.png', { fullPage: true });
  });

  test('opens on what is being assembled rather than on everything', async ({ page }) => {
    // There is at most one open package most weeks, and it is the only one
    // anybody acts on. Finding it by scrolling past six months of history is
    // how a payment run gets sent twice.
    await page.goto('/payments');
    await settle(page);

    const views = page.getByRole('group', { name: /choose a view/i });
    await expect(views.getByRole('button', { name: /being assembled/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('explains what a package is for instead of showing a blank list', async ({ page }) => {
    await page.goto('/payments');
    await settle(page);

    await expect(page.getByText(/no package is being assembled/i)).toBeVisible();
    await expect(page.getByText(/as one instruction/i)).toBeVisible();
    await expect(pageAction(page, 'Payment packages', /new package/i)).toBeEnabled();
  });
});

test.describe('the payment package register, as finance', () => {
  test.use({ storageState: SESSIONS.clerk.storageState });

  test('can be read but offers no way to assemble or send one', async ({ page }) => {
    // Finance holds `payment:mark_paid`, which is the right to declare a
    // payment received. Sending money and confirming it arrived is the pair
    // segregation of duties most exists to keep apart, so the buttons are
    // absent rather than present and refused.
    await page.goto('/payments');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Payment packages', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: /new package/i })).toHaveCount(0);

    await expect(page).toHaveScreenshot('payments-register-finance.png', { fullPage: true });
  });
});

test.describe('the payment package register without the right to see payments', () => {
  test.use({ storageState: SESSIONS.requester.storageState });

  test('is refused rather than shown as an empty register', async ({ page }) => {
    await page.goto('/payments');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Payment packages', level: 1 })).toHaveCount(0);
    await expect(page.getByText(/do not have access to this section/i)).toBeVisible();
  });
});
