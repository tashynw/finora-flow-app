import { expect, test } from '@playwright/test';

import { SESSIONS, settle } from './helpers';

/**
 * The purchase order register, on the orders the development seed leaves behind.
 *
 * Not an empty state, unlike the estimate and invoice registers: an order is the
 * thing an invoice is billed against, so the seed ships three of them and the
 * register is never empty. What that buys is a baseline that covers the row
 * itself — the remaining capacity, the open and closed labels — rather than only
 * the frame around an empty list.
 *
 * Two roles, because they see different controls and open on different views.
 * Finance raises orders and commits the organisation to spend; an approver
 * decides them and raises none. Which buttons exist at all is the segregation,
 * and photographing one role would let the other rot.
 */

test.describe('the purchase order register, as finance', () => {
  test.use({ storageState: SESSIONS.clerk.storageState });

  test('matches the approved layout', async ({ page }) => {
    await page.goto('/purchase-orders');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Purchase orders', level: 1 })).toBeVisible();
    await expect(page).toHaveScreenshot('purchase-orders-register.png', { fullPage: true });
  });

  test('opens on what is still taking invoices', async ({ page }) => {
    await page.goto('/purchase-orders');
    await settle(page);

    const views = page.getByRole('group', { name: /choose a view/i });
    await expect(views.getByRole('button', { name: 'Open' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // The seed leaves two open and one closed. The open view is the only
    // question the register is asked in the ordinary course of work.
    await expect(page.locator('main').getByRole('listitem')).toHaveCount(2);
  });

  test('says how much of each commitment is left', async ({ page }) => {
    // A reviewer deciding whether an invoice fits needs the remainder, not the
    // total and the billed figure to subtract for themselves.
    await page.goto('/purchase-orders');
    await settle(page);

    await expect(page.getByText(/left$/).first()).toBeVisible();
  });

  test('offers the way to raise one', async ({ page }) => {
    await page.goto('/purchase-orders');
    await settle(page);

    await expect(
      page
        .getByRole('group', { name: 'Purchase orders actions' })
        .getByRole('button', { name: /raise an order/i }),
    ).toBeEnabled();
  });
});

test.describe('the purchase order register, as an approver', () => {
  test.use({ storageState: SESSIONS.approver.storageState });

  test('opens on what is waiting for their decision and offers no way to raise one', async ({
    page,
  }) => {
    await page.goto('/purchase-orders');
    await settle(page);

    const views = page.getByRole('group', { name: /choose a view/i });
    await expect(views.getByRole('button', { name: /waiting on my approval/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Committing the organisation to spend and agreeing to that commitment are
    // separated duties. Offering the button and refusing the request afterwards
    // would be the interface disagreeing with the server.
    await expect(page.getByRole('button', { name: /raise an order/i })).toHaveCount(0);
    await expect(views.getByRole('button', { name: 'Drafts' })).toHaveCount(0);

    await expect(page).toHaveScreenshot('purchase-orders-register-approver.png', {
      fullPage: true,
    });
  });
});

test.describe('the purchase order register without the right to see orders', () => {
  test.use({ storageState: SESSIONS.operator.storageState });

  test('is refused rather than shown as an empty register', async ({ page }) => {
    await page.goto('/purchase-orders');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Purchase orders', level: 1 })).toHaveCount(0);
    await expect(page.getByText(/do not have access to this section/i)).toBeVisible();
  });
});

test.describe('a purchase order that has been honoured and closed', () => {
  test.use({ storageState: SESSIONS.clerk.storageState });

  test('reads as honoured rather than as cancelled', async ({ page }) => {
    // The distinction this baseline protects: closing does not undo the
    // commitment. A closed order was met, and reading it as cancelled would
    // erase spend the supplier acted on.
    await page.goto('/purchase-orders');
    await settle(page);

    await page.getByRole('group', { name: /choose a view/i }).getByRole('button', {
      name: 'Everything',
    }).click();
    await settle(page);

    const closed = page.locator('main').getByRole('listitem').filter({ hasText: 'PO-2026-0003' });
    await expect(closed.getByText('Closed')).toBeVisible();
    await expect(closed.getByText('Cancelled')).toHaveCount(0);
    // One standing, not two. "Approved" beside "Closed" states the workflow
    // state and the label for the same fact, and on an order that opened under
    // the threshold the first of the two is not true.
    await expect(closed.getByText('Approved')).toHaveCount(0);

    await expect(page).toHaveScreenshot('purchase-orders-register-everything.png', {
      fullPage: true,
    });
  });
});

test.describe('a purchase order in full', () => {
  test.use({ storageState: SESSIONS.clerk.storageState });

  test('shows the commitment, what has been drawn against it and what is left', async ({
    page,
  }) => {
    await page.goto('/purchase-orders');
    await settle(page);

    await page.getByRole('link', { name: /PO-2026-0001/ }).click();
    await page.waitForURL(/\/purchase-orders\/[0-9a-f-]{36}$/);
    await settle(page);

    // The three figures that make an order worth having as a record rather than
    // as a number typed onto an invoice. Remaining is derived from the invoices
    // against it, so a page showing the commitment without it would be showing
    // the half that never changes.
    await expect(page.getByText('Committed', { exact: true })).toBeVisible();
    await expect(page.getByText('Billed so far', { exact: true })).toBeVisible();
    await expect(page.getByText('Still available', { exact: true })).toBeVisible();

    await expect(page).toHaveScreenshot('purchase-order-detail.png', { fullPage: true });
  });
});
