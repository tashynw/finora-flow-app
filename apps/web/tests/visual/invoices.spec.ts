import { expect, test } from '@playwright/test';

import { SESSIONS, settle } from './helpers';

/**
 * The invoice register before anybody has recorded one.
 *
 * Photographed in the viewport projects, which run before the specs that create
 * records, so this is the genuine empty state rather than a register that happens
 * to be empty because of test ordering.
 *
 * Three roles, because they open on three different views and see three different
 * sets of controls. Finance records invoices; a requester is asked to confirm the
 * goods arrived and records nothing; an approver decides and does neither. The
 * duty separation that keeps the same person from confirming a delivery and then
 * approving payment for it is visible here as which buttons exist at all, and a
 * suite that photographed only one role would let the other two rot.
 */

test.describe('the invoice register, as finance', () => {
  test.use({ storageState: SESSIONS.clerk.storageState });

  test('matches the approved layout', async ({ page }) => {
    await page.goto('/invoices');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Invoices', level: 1 })).toBeVisible();
    await expect(page).toHaveScreenshot('invoices-register-empty.png', { fullPage: true });
  });

  test('opens on this person’s own unfinished work', async ({ page }) => {
    await page.goto('/invoices');
    await settle(page);

    const views = page.getByRole('group', { name: /choose a view/i });
    // Pressed rather than merely coloured: a screen reader user has no other way
    // to know which of several views they are looking at.
    await expect(views.getByRole('button', { name: 'My drafts' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Finance never confirms receipt — that is the whole point of the control —
    // so a view of deliveries waiting on them would be permanently empty and
    // would teach them to ignore the row of views entirely.
    await expect(views.getByRole('button', { name: /waiting on me to confirm/i })).toHaveCount(0);
    await expect(views.getByRole('button', { name: /waiting on my approval/i })).toHaveCount(0);

    await expect(page.getByRole('heading', { name: 'You have no drafts' })).toBeVisible();
    await expect(page.getByRole('button', { name: /show everything/i })).toBeVisible();
  });

  test('offers the way to record one', async ({ page }) => {
    await page.goto('/invoices');
    await settle(page);

    await expect(
      page.getByRole('group', { name: 'Invoices actions' }).getByRole('button', {
        name: /create invoice/i,
      }),
    ).toBeEnabled();
  });
});

test.describe('the invoice register, as the person who confirms deliveries', () => {
  test.use({ storageState: SESSIONS.requester.storageState });

  test('opens on what is waiting for their confirmation', async ({ page }) => {
    await page.goto('/invoices');
    await settle(page);

    const views = page.getByRole('group', { name: /choose a view/i });
    await expect(views.getByRole('button', { name: /waiting on me to confirm/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(
      page.getByRole('heading', { name: /nobody is waiting on you to confirm anything/i }),
    ).toBeVisible();

    // A requester records no invoices. Offering the button and refusing the
    // request afterwards would be the interface disagreeing with the server.
    await expect(page.getByRole('button', { name: /create invoice/i })).toHaveCount(0);

    await expect(page).toHaveScreenshot('invoices-register-requester.png', { fullPage: true });
  });

  test('explains that the chasing happens by email as well', async ({ page }) => {
    await page.goto('/invoices');
    await settle(page);

    // Somebody who only ever answers these from their inbox should be able to
    // learn from this screen why they keep getting the emails.
    await expect(page.getByText(/every three working hours/i)).toBeVisible();
  });
});

test.describe('the invoice register, as an approver', () => {
  test.use({ storageState: SESSIONS.approver.storageState });

  test('opens on what is waiting for their decision', async ({ page }) => {
    await page.goto('/invoices');
    await settle(page);

    const views = page.getByRole('group', { name: /choose a view/i });
    await expect(views.getByRole('button', { name: /waiting on my approval/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Approving a payment and confirming the delivery it pays for are separated
    // duties, so an approver is never offered the confirmation view.
    await expect(views.getByRole('button', { name: /waiting on me to confirm/i })).toHaveCount(0);

    await expect(page).toHaveScreenshot('invoices-register-approver.png', { fullPage: true });
  });
});

test.describe('the invoice register without the right to see invoices', () => {
  test.use({ storageState: SESSIONS.operator.storageState });

  test('is refused rather than shown as an empty register', async ({ page }) => {
    // Operations run the mailbox and have no business reading what the
    // organisation is being billed. An empty list shown to them would read as
    // "there is nothing here", which is a misleading answer.
    await page.goto('/invoices');
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Invoices', level: 1 })).toHaveCount(0);
    await expect(page.getByText(/do not have access to this section/i)).toBeVisible();
  });
});

test.describe('a link from a reminder that no longer works', () => {
  test.use({ storageState: SESSIONS.requester.storageState });

  test('says so plainly and points at the list instead', async ({ page }) => {
    // A token that never existed is answered exactly as an expired or spent one
    // is. Four different messages would let a holder work out which tokens are
    // real, which is the one thing a single-use link must not reveal.
    await page.goto('/link/not-a-real-token');
    await settle(page);

    await expect(
      page.getByRole('heading', { name: /this link no longer works/i }),
    ).toBeVisible();
    // Reassurance, because the reader's honest worry is that they have missed
    // something by being slow to open an email.
    await expect(page.getByText(/nothing has been lost/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /go to invoices/i })).toBeVisible();

    await expect(page).toHaveScreenshot('invoices-dead-link.png', { fullPage: true });
  });
});
