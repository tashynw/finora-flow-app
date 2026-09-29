import { expect, test } from '@playwright/test';

import { SESSIONS, settle } from './helpers';

/**
 * The estimate register before anybody has raised one.
 *
 * Photographed in the viewport projects, which run before the specs that create
 * records, so this is the genuine empty state rather than a register that happens
 * to be empty because of test ordering.
 *
 * Both roles are here because they see different registers. A requester's opens
 * on their own unfinished work; an approver's opens on what is waiting for their
 * decision and offers no way to raise anything. Photographing only one of them
 * would let the other's default view break unnoticed.
 */

test.describe('the estimate register, as a requester', () => {
  test.use({ storageState: SESSIONS.requester.storageState });

  test('matches the approved layout', async ({ page }) => {
    await page.goto('/estimates');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Estimates', level: 1 })).toBeVisible();
    await expect(page).toHaveScreenshot('estimates-register-empty.png', { fullPage: true });
  });

  test('opens on this person’s own unfinished work', async ({ page }) => {
    await page.goto('/estimates');
    await settle(page);

    const views = page.getByRole('group', { name: /choose a view/i });
    // Pressed rather than merely coloured: a screen reader user has no other way
    // to know which of five views they are looking at, and it is not "everything".
    await expect(views.getByRole('button', { name: 'My drafts' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // A requester approves nothing, so a queue of work waiting on them would be
    // permanently empty and would teach them to ignore the whole control.
    await expect(views.getByRole('button', { name: 'Waiting on me' })).toHaveCount(0);

    // An empty register has to say which emptiness this is, and offer the way out
    // of itself. "No estimates yet" would be a different and wrong claim.
    await expect(page.getByRole('heading', { name: 'You have no drafts' })).toBeVisible();
    await expect(page.getByRole('button', { name: /show everything/i })).toBeVisible();
  });

  test('offers the way to raise one', async ({ page }) => {
    await page.goto('/estimates');
    await settle(page);

    await expect(
      page.getByRole('group', { name: 'Estimates actions' }).getByRole('button', {
        name: /create estimate/i,
      }),
    ).toBeEnabled();
  });
});

test.describe('the estimate register, as an approver', () => {
  test.use({ storageState: SESSIONS.approver.storageState });

  test('opens on what is waiting for their decision', async ({ page }) => {
    await page.goto('/estimates');
    await settle(page);

    const views = page.getByRole('group', { name: /choose a view/i });
    await expect(views.getByRole('button', { name: 'Waiting on me' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('heading', { name: 'Nothing is waiting on you' })).toBeVisible();

    // An approver raises nothing. Offering them the button and refusing the
    // request afterwards would be the interface disagreeing with the server.
    await expect(page.getByRole('button', { name: /create estimate/i })).toHaveCount(0);

    await expect(page).toHaveScreenshot('estimates-register-approver.png', { fullPage: true });
  });
});

test.describe('the estimate register without the right to see estimates', () => {
  test.use({ storageState: SESSIONS.operator.storageState });

  test('is refused rather than shown as an empty register', async ({ page }) => {
    // Operations run the mailbox and have no business reading what the
    // organisation is being asked to spend. An empty list shown to them would
    // read as "there is nothing here", which is a misleading answer.
    await page.goto('/estimates');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Estimates', level: 1 })).toHaveCount(0);
    await expect(page.getByText(/do not have access to this section/i)).toBeVisible();
  });
});
