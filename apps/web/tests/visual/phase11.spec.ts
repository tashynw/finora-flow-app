import { expect, test } from '@playwright/test';

import { SESSIONS, settle } from './helpers';

/**
 * Phase 11 surfaces: work queue, reports hub, audit trail, search, and the
 * administration screens that landed with users, reference data, retention and
 * operational settings.
 *
 * Photographed after the accrual flow so the shared database already holds the
 * earlier records, and so these baselines do not invent empty-register claims
 * the flow projects already own.
 */

test.describe('My work, as an approver', () => {
  test.use({ storageState: SESSIONS.approver.storageState });

  test('matches the approved layout', async ({ page }) => {
    await page.goto('/work');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'My work', level: 1 })).toBeVisible();
    await expect(page).toHaveScreenshot('work-queue.png', { fullPage: true });
  });
});

test.describe('the reports hub, as finance', () => {
  test.use({ storageState: SESSIONS.clerk.storageState });

  test('matches the approved layout', async ({ page }) => {
    await page.goto('/reports');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible();
    await expect(page).toHaveScreenshot('reports-hub.png', { fullPage: true });
  });

  test('opens the search palette from the shell', async ({ page }) => {
    await page.goto('/');
    await settle(page);

    await page.getByRole('button', { name: /search records/i }).click();
    await expect(page.getByRole('dialog', { name: /search records/i })).toBeVisible();
    await expect(page).toHaveScreenshot('search-palette.png', { fullPage: true });
  });
});

test.describe('the audit trail, as an auditor', () => {
  test.use({ storageState: SESSIONS.auditor.storageState });

  test('matches the approved layout', async ({ page }) => {
    await page.goto('/audit');
    await settle(page);

    await expect(page.getByRole('heading', { name: /audit/i, level: 1 })).toBeVisible();
    await expect(page).toHaveScreenshot('audit-trail.png', { fullPage: true });
  });
});

test.describe('users and roles, as an administrator', () => {
  test.use({ storageState: SESSIONS.administrator.storageState });

  test('matches the approved layout', async ({ page }) => {
    await page.goto('/settings/users');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Users and roles', level: 1 })).toBeVisible();
    await expect(page).toHaveScreenshot('users-and-roles.png', { fullPage: true });
  });

  test('reference data matches the approved layout', async ({ page }) => {
    await page.goto('/settings/reference');
    await settle(page);

    await expect(page.getByRole('heading', { name: /reference/i, level: 1 })).toBeVisible();
    await expect(page).toHaveScreenshot('reference-data.png', { fullPage: true });
  });

  test('retention policies match the approved layout', async ({ page }) => {
    await page.goto('/settings/retention');
    await settle(page);

    await expect(page.getByRole('heading', { name: /retention/i, level: 1 })).toBeVisible();
    await expect(page).toHaveScreenshot('retention-policies.png', { fullPage: true });
  });

  test('operational settings match the approved layout', async ({ page }) => {
    await page.goto('/settings/operations');
    await settle(page);

    await expect(
      page.getByRole('heading', { name: /operational settings/i, level: 1 }),
    ).toBeVisible();
    await expect(page).toHaveScreenshot('operational-settings.png', { fullPage: true });
  });
});
