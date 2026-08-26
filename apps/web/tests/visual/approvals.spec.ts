import { expect, test } from '@playwright/test';

import { SESSIONS, settle } from './helpers';

/**
 * The one queue an approver works from.
 *
 * Photographed in the viewport projects, which run before anything is submitted,
 * so this is the genuine empty state rather than a queue that happens to be
 * empty because of test ordering.
 *
 * What the empty state has to do here is more than say "nothing". An approver
 * seeing an empty queue needs to know it is empty because nothing is waiting,
 * not because a filter is on or because their own requests have been excluded —
 * both of which are true and neither of which is obvious.
 */

test.describe('the approvals queue', () => {
  test.use({ storageState: SESSIONS.approver.storageState });

  test('matches the approved layout', async ({ page }) => {
    await page.goto('/approvals');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Approvals', level: 1 })).toBeVisible();
    await expect(page).toHaveScreenshot('approvals-queue-empty.png', { fullPage: true });
  });

  test('explains that their own requests are never here', async ({ page }) => {
    // Otherwise an approver who raised something and cannot find it concludes
    // the submission failed.
    await page.goto('/approvals');
    await settle(page);

    await expect(page.getByText(/anything you raised yourself never appears/i)).toBeVisible();
  });

  test('shows every kind by default', async ({ page }) => {
    await page.goto('/approvals');
    await settle(page);

    const filters = page.getByRole('group', { name: /filter by record type/i });
    for (const kind of ['Estimates', 'Invoices', 'Purchase orders']) {
      await expect(filters.getByRole('button', { name: new RegExp(`^${kind}`) })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    }
  });
});

test.describe('the approvals queue for somebody who decides nothing', () => {
  test.use({ storageState: SESSIONS.requester.storageState });

  test('is refused rather than shown as an empty queue', async ({ page }) => {
    // An empty list would read as "nothing is waiting", which is a different and
    // misleading answer to "this is not your screen".
    await page.goto('/approvals');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Approvals', level: 1 })).toHaveCount(0);
    await expect(page.getByText(/do not have access to this section/i)).toBeVisible();
  });
});
