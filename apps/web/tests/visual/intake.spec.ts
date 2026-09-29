import { expect, test } from '@playwright/test';

import { pageAction, SESSIONS, settle } from './helpers';

/**
 * Visual and accessibility coverage for the phase 2 screens.
 *
 * Two things are checked on each screen: that it still looks the way it was
 * approved, and that a keyboard user can reach it. Neither is caught by a unit
 * test, and both are the kind of regression that ships unnoticed.
 */

test.describe('intake queue', () => {
  test.use({ storageState: SESSIONS.clerk.storageState });

  test('matches the approved layout', async ({ page }) => {
    await page.goto('/intake');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
    await expect(page).toHaveScreenshot('intake-queue.png', { fullPage: true });
  });

  test('states its purpose above the queue', async ({ page }) => {
    // The design standard requires every page to say what it is for, because a
    // reader arriving from a notification has no other context.
    await page.goto('/intake');
    await settle(page);

    await expect(page.getByText(/what still needs a person/i)).toBeVisible();
  });

  test('the upload dialog traps focus and names itself', async ({ page }) => {
    await page.goto('/intake');
    await settle(page);

    await pageAction(page, 'Inbox', /^upload$/i).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // An accessible name is what a screen reader announces on open; without it
    // the user is told only "dialog".
    await expect(dialog).toHaveAccessibleName(/upload/i);
    await expect(page).toHaveScreenshot('intake-upload-dialog.png');
  });

  test('the skip link gets a keyboard user past the navigation', async ({ page }) => {
    // Without this, reaching the page's own actions means tabbing through every
    // navigation link on every page load, which is the difference between a
    // keyboard user being able to work and merely being able to arrive.
    await page.goto('/intake');
    await settle(page);

    await page.keyboard.press('Tab');
    const skipLink = page.getByRole('link', { name: /skip to main content/i });
    await expect(skipLink).toBeFocused();
    // It has to be visible when focused, or a sighted keyboard user cannot tell
    // where they are.
    await expect(skipLink).toBeVisible();

    await page.keyboard.press('Enter');
    expect(page.url()).toContain('#main-content');

    // From there the page's primary action is a few tabs away rather than a few
    // dozen. Bounded, so a focus trap fails the test instead of hanging it.
    const upload = pageAction(page, 'Inbox', /^upload$/i);
    let reached = false;
    for (let i = 0; i < 8 && !reached; i += 1) {
      await page.keyboard.press('Tab');
      reached = await upload.evaluate((node) => node === document.activeElement);
    }
    expect(reached).toBe(true);
  });
});

test.describe('intake health', () => {
  test.use({ storageState: SESSIONS.operator.storageState });

  test('matches the approved layout', async ({ page }) => {
    await page.goto('/operations/intake');
    await settle(page);

    await expect(
      page.getByRole('heading', { name: 'Intake health', level: 1 }),
    ).toBeVisible();
    await expect(page).toHaveScreenshot('intake-health.png', { fullPage: true });
  });

  test('does not present a never-polled worker as healthy', async ({ page }) => {
    // The property under test is a product rule, not a style: intake fails
    // silently, so an unrun worker has to look like a problem on the page.
    await page.goto('/operations/intake');
    await settle(page);

    await expect(page.getByText(/what needs doing/i)).toBeVisible();
    await expect(page.getByText(/collecting$/i)).toHaveCount(0);
  });

  test('does not contact the mailbox until asked', async ({ page }) => {
    const probes: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('probe_mailbox')) probes.push(request.url());
    });

    await page.goto('/operations/intake');
    await settle(page);

    // A page that logs into the mailbox on every refresh gets rate-limited or
    // flagged, so the probe has to be an action a person takes.
    expect(probes).toHaveLength(0);

    await page.getByRole('button', { name: /check the mailbox/i }).click();
    await expect.poll(() => probes.length).toBeGreaterThan(0);
  });
});

test.describe('zoom', () => {
  test.use({ storageState: SESSIONS.clerk.storageState });

  test('the queue stays usable at 200% zoom', async ({ page }) => {
    // WCAG 2.2 requires content to remain usable at 200%. Emulated by halving
    // the viewport, which is what doubling the text size amounts to.
    await page.setViewportSize({ width: 720, height: 450 });
    await page.goto('/intake');
    await settle(page);

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Nothing may be cut off horizontally: a horizontal scrollbar at this size
    // is the usual symptom of a fixed width that ignores zoom.
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows).toBe(false);
  });
});
