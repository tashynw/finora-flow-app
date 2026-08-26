import { expect, test } from '@playwright/test';

import { pageAction, SESSIONS, settle } from './helpers';

/**
 * The upload path, end to end, against the real API.
 *
 * The document is created here rather than seeded, so the malware scan, the
 * object store and the audit write are all genuinely exercised. A misconfigured
 * bucket fails this test instead of passing it, which is how the encrypted-write
 * failure against MinIO was found.
 *
 * It also produces the only populated screenshots in the suite. That is only
 * sound because the database is rebuilt before every run, so this file is the one
 * thing that has put a record in it and the queue contains exactly one row. It
 * runs in its own project, after the viewport projects, so it cannot add that row
 * while they are photographing the empty state.
 *
 * One test in steps rather than several, because each stage depends on the record
 * the previous one created. Splitting them would mean sharing mutable state
 * between tests, which only works while they happen to run in order in the same
 * worker.
 */

// Fixed, not generated. Intake deduplicates on content, and the database is
// rebuilt each run, so a constant document gives a constant filename and a
// constant hash, which is what lets the screens below have baselines at all.
const FILENAME = 'acme-invoice-4471.pdf';

// Minimal but structurally valid: intake checks the leading bytes against the
// declared content type and refuses anything that does not match.
const PDF = Buffer.from(
  '%PDF-1.7\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

test.describe('uploading a document', () => {
  test.use({ storageState: SESSIONS.clerk.storageState });

  test('is scanned, stored, listed and openable', async ({ page }) => {
    await page.goto('/intake');
    await settle(page);

    const dialog = page.getByRole('dialog');

    await test.step('the upload reports what happened to the file', async () => {
      await pageAction(page, 'Intake', /upload a document/i).click();
      await dialog
        .locator('input[type="file"]')
        .setInputFiles({ name: FILENAME, mimeType: 'application/pdf', buffer: PDF });
      await dialog.getByRole('button', { name: /^upload$/i }).click();

      // The outcome has to be stated, not implied by the dialog closing: a
      // silently dismissed upload is indistinguishable from one that never
      // happened. The timeout is generous because a real malware scan happens in
      // between.
      await expect(dialog).toHaveAccessibleName(/^Uploaded/, { timeout: 30_000 });
      // A clean file, specifically. With the scanner down this would report a
      // quarantine, and the test would fail rather than record a pass for a
      // pipeline that cannot actually clear anything.
      await expect(dialog.getByText(/scanned, found clean/i)).toBeVisible();
      await expect(page).toHaveScreenshot('upload-accepted.png');
    });

    await test.step('it appears in the queue', async () => {
      await dialog.getByRole('button', { name: /open it/i }).click();
      await settle(page);
      await page.goto('/intake');
      await settle(page);

      await expect(page.getByRole('link', { name: new RegExp(FILENAME, 'i') })).toBeVisible();
      await expect(page).toHaveScreenshot('intake-queue-populated.png', {
        fullPage: true,
      });
    });

    await test.step('opening it shows where it came from and what was stored', async () => {
      await page.getByRole('link', { name: new RegExp(FILENAME, 'i') }).click();
      await settle(page);

      // Provenance and the content hash are what make the record auditable, so
      // they belong on the page rather than in a developer tool.
      await expect(page.getByText(/original hash/i)).toBeVisible();
      await expect(page.getByText(/^Uploaded$/)).toBeVisible();
      // The verdict is shown against the attachment, not only the message,
      // because the attachment is what a reviewer is about to open.
      await expect(page.getByText(/^Clean$/)).toBeVisible();
      await expect(page.getByRole('button', { name: /^open$/i })).toBeVisible();
      await expect(page).toHaveScreenshot('message-detail.png', { fullPage: true });
    });

    await test.step('the same document cannot be uploaded twice', async () => {
      // Content, not filename: renaming an invoice does not make it a different
      // invoice, and a second record would let it be paid twice.
      await page.goto('/intake');
      await settle(page);

      await pageAction(page, 'Intake', /upload a document/i).click();
      await dialog
        .locator('input[type="file"]')
        .setInputFiles({ name: 'renamed.pdf', mimeType: 'application/pdf', buffer: PDF });
      await dialog.getByRole('button', { name: /^upload$/i }).click();

      // Refused, and it says which record already holds it, so the person can go
      // and look rather than assume their upload vanished.
      await expect(dialog.getByText(/already uploaded this exact file/i)).toBeVisible();
      await expect(dialog).toHaveAccessibleName(/upload a document/i);
    });
  });
});
