import { expect, test } from '@playwright/test';

import { SESSIONS, settle } from './helpers';

/**
 * The screens that decide what the platform will refuse.
 *
 * The matrix is the only place a user changes the rules rather than working
 * within them, so what these baselines protect is not really the layout. It is
 * that the consequence of a change is on screen at the moment it is made: the
 * route a given amount would take, and any amount that would have no route at
 * all. A matrix with a hole in it refuses a submission in front of somebody who
 * cannot fix it, and the only reliable moment to catch that is here.
 *
 * Photographed as an administrator, who writes the rules and satisfies none of
 * them, and checked as an approver, who does the reverse. Cover is the one
 * screen both reach, for opposite reasons.
 */

test.describe('the approval matrix', () => {
  test.use({ storageState: SESSIONS.administrator.storageState });

  test('matches the approved layout', async ({ page }) => {
    await page.goto('/settings/approval-matrix');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Approval matrix', level: 1 })).toBeVisible();
    await expect(page).toHaveScreenshot('administration-matrix.png', { fullPage: true });
  });

  test('states the verdict on the matrix before the rules themselves', async ({ page }) => {
    // The seeded matrix covers every amount, so this reads as the reassurance.
    // What matters is that the sentence is there either way: a screen that only
    // spoke up when something was wrong would leave the reader unsure whether it
    // had checked.
    await page.goto('/settings/approval-matrix');
    await settle(page);

    await expect(page.getByText(/every amount has a route/i)).toBeVisible();
  });

  test('says what a real amount would actually do', async ({ page }) => {
    await page.goto('/settings/approval-matrix');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Route simulator' })).toBeVisible();
    // Worked out by the platform rather than by the browser. A second
    // implementation of the routing rules here would be the more convincing of
    // the two the moment they disagreed.
    await expect(page.getByText(/goes to:/i)).toBeVisible();
    // Numbered, because a route is an order rather than a set of people. The
    // number is what distinguishes "then the Manager" from "and the Manager".
    await expect(page.getByText('1. Unit Head', { exact: true })).toBeVisible();
  });

  test('offers replacing and retiring, and never editing', async ({ page }) => {
    // A rule that could be edited in place would rewrite history, and an
    // approval given last quarter has to stay explicable by the rule that was
    // live when it was given.
    await page.goto('/settings/approval-matrix');
    await settle(page);

    await expect(page.getByRole('button', { name: 'Replace' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retire' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^edit$/i })).toHaveCount(0);
  });

  test('will not write a rule without a reason', async ({ page }) => {
    await page.goto('/settings/approval-matrix');
    await settle(page);

    // Nothing is open yet, so nothing should be on the page. A closed dialog that
    // still occupies layout puts a second, phantom form under the real content.
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.getByRole('button', { name: /^add rule$/i }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a rule' });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel(/what this rule is called/i).fill('Manager for large spend');
    // Not an exact match: a required field's accessible name carries the
    // "(required)" a screen reader hears, which a literal label misses.
    await dialog.getByLabel(/^From/).fill('100000');

    // Still refused: whoever audits this matrix reads the reason rather than
    // guessing why a band moved.
    await expect(dialog.getByRole('button', { name: /add it/i })).toBeDisabled();

    await expect(page).toHaveScreenshot('administration-rule-dialog.png');
  });
});

test.describe('who holds each level', () => {
  test.use({ storageState: SESSIONS.administrator.storageState });

  test('matches the approved layout', async ({ page }) => {
    await page.goto('/settings/approvers');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Who approves what', level: 1 })).toBeVisible();
    await expect(page).toHaveScreenshot('administration-assignments.png', { fullPage: true });
  });

  test('names an empty level rather than leaving it off the page', async ({ page }) => {
    // A level with nobody in it stops every route that reaches it, and the work
    // waits with no visible cause. Absence is the one thing a list of who holds
    // what cannot show by listing.
    await page.goto('/settings/approvers');
    await settle(page);

    for (const level of ['Unit Head', 'Manager', 'Head of Department', 'COO']) {
      await expect(page.getByRole('heading', { name: level })).toBeVisible();
    }
  });
});

test.describe('cover while away, as the administrator', () => {
  test.use({ storageState: SESSIONS.administrator.storageState });

  test('matches the approved layout and lists everybody', async ({ page }) => {
    // An administrator arranges cover for somebody who is already gone, which is
    // the case that otherwise leaves a queue stopped for a fortnight.
    await page.goto('/settings/cover');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Cover while away', level: 1 })).toBeVisible();
    await expect(page.getByText('Everybody else')).toBeVisible();

    // Somebody who has arranged nothing is still listed, with a way to arrange it
    // for them. A list of only those who planned ahead cannot contain the person
    // who did not, who is the whole reason to be here.
    const unarranged = page
      .locator('main')
      .getByRole('listitem')
      .filter({ hasText: 'No cover arranged' })
      .first();
    await expect(unarranged).toBeVisible();
    await expect(unarranged.getByRole('button', { name: 'Arrange' })).toBeVisible();

    await expect(page).toHaveScreenshot('administration-cover-admin.png', { fullPage: true });
  });
});

test.describe('cover while away, as an approver', () => {
  test.use({ storageState: SESSIONS.approver.storageState });

  test('shows their own arrangement and not everybody else’s', async ({ page }) => {
    await page.goto('/settings/cover');
    await settle(page);

    await expect(page.getByText('Your cover')).toBeVisible();
    // Offered before anything is arranged, not only afterwards.
    await expect(page.getByRole('button', { name: 'Arrange cover' })).toBeVisible();
    // Who else is away is not an approver's business, and the list would be a
    // directory of the organisation's absences.
    await expect(page.getByText('Everybody else')).toHaveCount(0);

    await expect(page).toHaveScreenshot('administration-cover-approver.png', { fullPage: true });
  });

  test('offers no way to change the rules themselves', async ({ page }) => {
    await page.goto('/settings/approval-matrix');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Approval matrix', level: 1 })).toHaveCount(0);
    await expect(page.getByText(/do not have access to this section/i)).toBeVisible();
  });
});
