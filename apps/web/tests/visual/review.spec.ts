import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { drawn, pageAction, SESSIONS, settle } from './helpers';
import { INVOICE_PDF } from './pdf-fixture';

/**
 * The review workspace, end to end, against the real reader.
 *
 * The document is uploaded here rather than seeded, so the whole path runs: the
 * malware scan, the encrypted write, the PDF's text layer being parsed, the rules
 * matching labels to values, and the audit entry each human act produces. A
 * seeded extraction would let every one of those break while this still passed.
 *
 * One test in steps, because each stage depends on the record the one before it
 * created, and because a reading can only be accepted once.
 *
 * It runs in its own project, last, because it adds a document to a database the
 * other specs photograph.
 */

const FILENAME = 'kingston-supplies-inv-4471.pdf';

/** The card for one field of the reading, found by the label the API sends. */
function fieldCard(page: Page, label: string): Locator {
  return page.getByRole('listitem').filter({ has: page.getByText(label, { exact: true }) });
}

test.describe('reviewing what was read', () => {
  test.use({ storageState: SESSIONS.clerk.storageState });

  test('is read, checked, corrected and accepted by a person', async ({ page }) => {
    await test.step('an uploaded invoice is read without anyone asking', async () => {
      await page.goto('/intake');
      await settle(page);

      const dialog = page.getByRole('dialog');
      await pageAction(page, 'Intake', /upload a document/i).click();
      await dialog
        .locator('input[type="file"]')
        .setInputFiles({ name: FILENAME, mimeType: 'application/pdf', buffer: INVOICE_PDF });
      await dialog.getByRole('button', { name: /^upload$/i }).click();
      // A real malware scan happens in between, hence the generous wait.
      await expect(dialog).toHaveAccessibleName(/^Uploaded/, { timeout: 30_000 });

      // Reading happens after the response, in the background, and reaching the
      // review queue means it finished and put the document there. Reloading is
      // this test's way of waiting for a background job rather than a statement
      // about the screen: the queue polls on its own, just not this often.
      await expect
        .poll(
          async () => {
            await page.goto('/documents');
            await settle(page);
            return page.getByRole('link', { name: new RegExp(FILENAME, 'i') }).count();
          },
          { timeout: 60_000, intervals: [500, 1_000, 2_000, 3_000, 5_000] },
        )
        .toBeGreaterThan(0);

      // In the review queue, not merely present: the vendor was taken from the
      // letterhead and the invoice carries bank details, so a reader that waved
      // this through would be the thing worth failing over.
      await expect(page.getByText(/values? to check/i).first()).toBeVisible();

      await expect(page).toHaveScreenshot('documents-queue-populated.png', {
        fullPage: true,
      });
    });

    await test.step('the workspace shows the values, the page and the warnings', async () => {
      await page.getByRole('link', { name: new RegExp(FILENAME, 'i') }).click();
      await settle(page);

      // What the rules read off the page. These are the assertions that fail if
      // the reader regresses, and they are why the fixture is a real PDF with a
      // real text layer rather than a stub.
      await expect(fieldCard(page, 'Document number').getByText('INV-4471')).toBeVisible();
      await expect(fieldCard(page, 'Total').getByText('115,000.00')).toBeVisible();
      await expect(fieldCard(page, 'Purchase order').getByText('PO-99120')).toBeVisible();

      // And what it must not have read. The invoice ends with a remittance
      // sentence naming a bank, and a reader that takes that for the supplier
      // has redirected a payment while reporting high confidence.
      const vendor = fieldCard(page, 'Vendor');
      await expect(vendor.getByText(/First Global/)).toHaveCount(0);
      // The vendor came from the letterhead, which is a guess from layout, so it
      // is shown as one and it is what keeps the document in review.
      await expect(vendor.getByText(/Unsure|Check this/)).toBeVisible();

      // The bank details are raised, and cannot be cleared by anything on this
      // page other than a person saying they carried out the check.
      await expect(page.getByText(/what the reader noticed/i)).toBeVisible();
      await expect(page.getByText(/bank details on the document/i)).toBeVisible();
      await expect(page.getByText(/before this can be accepted/i)).toBeVisible();
      await expect(page.getByRole('button', { name: /accept this reading/i })).toBeDisabled();

      // The document itself renders, from the application's own origin. A viewer
      // that silently failed would leave every value unverifiable.
      await expect(page.getByRole('img', { name: /page 1 of the document/i })).toBeVisible({
        timeout: 30_000,
      });

      await drawn(page);
      await expect(page).toHaveScreenshot('document-review.png', { fullPage: true });
    });

    await test.step('a value can be shown on the page it was read from', async () => {
      const total = fieldCard(page, 'Total');
      const show = total.getByRole('button', { name: /show on the document/i });
      await show.click();

      // Pressed, so which value the highlight belongs to is never ambiguous.
      await expect(show).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('evidence-highlight').first()).toBeVisible();
    });

    await test.step('a value read from the layout is typed in, with a reason', async () => {
      const vendor = fieldCard(page, 'Vendor');
      await vendor.getByRole('button', { name: /change it|type it in/i }).click();
      await vendor
        .getByRole('textbox', { name: /vendor as it appears on the document/i })
        .fill('Kingston Supplies Limited');
      await vendor.getByRole('textbox', { name: /why it was changed/i }).fill('Read off the letterhead.');
      await vendor.getByRole('button', { name: /save this value/i }).click();

      // Provenance is the point: a corrected value has to say whose it is.
      await expect(vendor.getByText('Corrected')).toBeVisible();
      await expect(vendor.getByText(/entered by a person/i)).toBeVisible();
      // Exact, because the letterhead's shouty version is still on the card,
      // struck through. Keeping what the reader had is deliberate: a correction
      // that erased it would leave nobody able to see what went wrong.
      await expect(
        vendor.getByText('Kingston Supplies Limited', { exact: true }),
      ).toBeVisible();
      await expect(
        vendor.getByText('KINGSTON SUPPLIES LIMITED', { exact: true }),
      ).toBeVisible();
    });

    await test.step('acceptance stays refused until the warning is answered', async () => {
      await expect(page.getByRole('button', { name: /accept this reading/i })).toBeDisabled();

      await page.getByRole('button', { name: /i have done this/i }).click();
      await expect(page.getByText('Acknowledged')).toBeVisible();
    });

    await test.step('accepting is recorded against the person who did it', async () => {
      // Everything that stood in the way has now been dealt with, so the list of
      // blockers is gone rather than merely shorter.
      await expect(page.getByText(/before this can be accepted/i)).toHaveCount(0);

      await page
        .getByRole('textbox', { name: /anything worth noting/i })
        .fill('Checked against PO-99120.');
      const accept = page.getByRole('button', { name: /accept this reading/i });
      await expect(accept).toBeEnabled();
      await accept.click();

      await expect(page.getByText(/this reading has been accepted/i)).toBeVisible();
      // Locked afterwards: acceptance is the one act on this page that cannot be
      // undone from it.
      await expect(page.getByRole('button', { name: /this is correct/i })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /change it/i })).toHaveCount(0);
      await drawn(page);
      await expect(page).toHaveScreenshot('document-accepted.png', { fullPage: true });
    });
  });
});
