import { expect, test } from '@playwright/test';

import { SESSIONS, settle } from './helpers';

/**
 * The document queue before anything has been read.
 *
 * Photographed in the viewport projects, which run before the specs that create
 * records, so this is genuinely the empty state and not a queue that happens to
 * be empty because of test ordering.
 *
 * The empty state is worth a baseline of its own. It is the first thing a new
 * reviewer sees, and an empty queue that says nothing is indistinguishable from a
 * screen that failed to load.
 */

test.describe('document queue', () => {
  test.use({ storageState: SESSIONS.clerk.storageState });

  test('matches the approved layout', async ({ page }) => {
    await page.goto('/documents');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible();
    await expect(page).toHaveScreenshot('documents-queue.png', { fullPage: true });
  });

  test('says what the screen is for and what to do next', async ({ page }) => {
    await page.goto('/documents');
    await settle(page);

    await expect(page.getByText(/how sure the reader was/i)).toBeVisible();
    // The queue opens on "needs review", so an empty one means the work is done
    // rather than that nothing exists. It has to read that way.
    await expect(
      page.getByRole('heading', { name: 'Nothing needs review' }),
    ).toBeVisible();
    // An empty state has to offer the way out of itself, and widening the filter
    // is not one: it shows the same emptiness differently.
    await expect(page.getByRole('link', { name: /go to intake/i })).toBeVisible();
  });

  test('an empty filter is not reported as an empty product', async ({ page }) => {
    await page.goto('/documents');
    await settle(page);

    await page.getByRole('group', { name: /filter by state/i }).getByRole('button', {
      name: 'Everything',
    }).click();

    // Different wording for the two, because they mean different things and a
    // reviewer decides what to do next from them.
    await expect(page.getByRole('heading', { name: 'No documents yet' })).toBeVisible();
  });

  test('filters are announced as a group with the current one pressed', async ({ page }) => {
    await page.goto('/documents');
    await settle(page);

    const filters = page.getByRole('group', { name: /filter by state/i });
    await expect(filters).toBeVisible();
    // Pressed rather than merely coloured: a screen reader user has no other way
    // to know which filter is in force, and the default is not "everything".
    await expect(filters.getByRole('button', { name: 'Needs review' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

});

test.describe('document queue without the right to read documents', () => {
  test.use({ storageState: SESSIONS.operator.storageState });

  test('is refused rather than shown as an empty queue', async ({ page }) => {
    // Operations run the mailbox and have no business reading invoices. An empty
    // list shown to them would read as "there is nothing here", which is a
    // misleading answer about a screen full of financial records.
    await page.goto('/documents');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Documents', level: 1 })).toHaveCount(0);
    await expect(page.getByText(/do not have access to this section/i)).toBeVisible();
  });
});
