import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { pageAs, SESSIONS, settle } from './helpers';

/**
 * An estimate from a blank draft to a decision, through the people involved.
 *
 * Three signed-in people at once, on the same records, because that is the only
 * way the interesting claims can be checked. That the requester cannot approve
 * their own request, that a Manager cannot decide before the Unit Head has, that
 * an approval carries the name of whoever gave it — none of these can be tested
 * from a single session, and all of them are the reason an approval route exists.
 *
 * Two estimates rather than one, because the amount decides the route. JMD 250,000
 * needs two levels and JMD 40,000 needs one, and a suite that only ever raised one
 * figure would not notice the bands being read wrongly.
 *
 * One test in steps, in its own project, running last: each stage depends on the
 * record the one before it created, and the register screenshots taken by the
 * viewport projects are of a register these estimates would appear in.
 */

// Fixed rather than relative to today. The quotation date must not be in the
// future, and the date needed must not precede it, so a pair of constants in the
// past satisfies both rules permanently and keeps the screenshots identical
// between runs.
const QUOTED_ON = '2026-07-15';
const NEEDED_BY = '2026-09-30';

const SUPPLIER = 'Kingston Supplies Limited';

/** The step in a route for one approval level, found by its heading. */
function step(page: Page, level: string): Locator {
  return page
    .getByRole('listitem')
    .filter({ has: page.getByText(level, { exact: true }) })
    .last();
}

/** The panel an approver decides in, which only the person whose turn it is has. */
function decision(page: Page): Locator {
  return page.getByText(/your decision as/i);
}

interface DraftValues {
  description: string;
  amount: string;
  justification: string;
  quotationNumber: string;
}

/**
 * The box for the total.
 *
 * Found by role and a loose name because every label carries "(required)" or
 * "(optional)" in its accessible name, which is deliberate — a sighted reader
 * sees an asterisk and a screen reader hears the word — and which means an exact
 * label match would be matching the asterisk convention rather than the field.
 */
function totalBox(page: Page): Locator {
  return page.getByRole('textbox', { name: /^total/i });
}

/** Fills every box on a draft, leaving it complete. */
async function fillDraft(page: Page, values: DraftValues): Promise<void> {
  await page
    .getByRole('combobox', { name: /^supplier/i })
    .selectOption({ label: SUPPLIER });
  await page
    .getByRole('textbox', { name: /quotation number/i })
    .fill(values.quotationNumber);
  await page.getByRole('textbox', { name: /what is being bought/i }).fill(values.description);
  await totalBox(page).fill(values.amount);
  await page.getByLabel(/date on the quotation/i).fill(QUOTED_ON);
  await page.getByLabel(/^needed by/i).fill(NEEDED_BY);
  await page
    .getByRole('combobox', { name: /cost centre/i })
    .selectOption({ label: 'CC-100 — Facilities' });
  await page
    .getByRole('combobox', { name: /gl account/i })
    .selectOption({ label: '6100 — Repairs and maintenance' });
  await page.getByRole('textbox', { name: /why this is needed/i }).fill(values.justification);
}

/** The reference an estimate was given, which is the page's own title. */
async function referenceOf(page: Page): Promise<string> {
  const title = await page.getByRole('heading', { level: 1 }).first().textContent();
  return (title ?? '').trim();
}

/** Raises a blank draft and returns the path of the estimate it created. */
async function raiseDraft(page: Page): Promise<string> {
  await page.goto('/estimates');
  await settle(page);
  await page
    .getByRole('group', { name: 'Estimates actions' })
    .getByRole('button', { name: /new estimate/i })
    .click();
  await page.waitForURL(/\/estimates\/[0-9a-f-]{36}$/);
  await settle(page);
  return new URL(page.url()).pathname;
}

test.describe('an estimate and the people who decide it', () => {
  test('is raised, routed, decided and recorded against whoever acted', async ({
    browser,
    baseURL,
  }) => {
    const requester = await pageAs(browser, SESSIONS.requester, baseURL);
    const unitHead = await pageAs(browser, SESSIONS.approver, baseURL);
    const manager = await pageAs(browser, SESSIONS.manager, baseURL);

    let estimate = '';
    let reference = '';

    await test.step('a blank draft says what is missing and promises no route', async () => {
      estimate = await raiseDraft(requester);
      reference = await referenceOf(requester);
      expect(reference).toMatch(/^EST-\d{6}$/);

      // Everything outstanding at once. Discovering six missing fields through
      // six refusals is the failure this panel exists to prevent.
      await expect(requester.getByText(/things still to fill in/i)).toBeVisible();
      await expect(
        requester.getByRole('heading', { name: /before this can go for approval/i }),
      ).toBeVisible();

      // No route is claimed while there is no amount to plan one from. A route
      // shown against a blank draft would be a guess presented as a fact.
      await expect(
        requester.getByText(/enter the total and its currency/i),
      ).toBeVisible();

      // Listed above, but not yet marked against the boxes themselves. A form
      // that opens with every field flagged red is accusing the requester of
      // mistakes they have not had the chance to make.
      await expect(requester.locator('[aria-invalid="true"]')).toHaveCount(0);

      // The guidance is what a blank form needs, so it must be the thing on show.
      await expect(
        requester.getByText(/choose from the suppliers finance has already set up/i),
      ).toBeVisible();

      await expect(requester).toHaveScreenshot('estimate-draft-new.png', { fullPage: true });
    });

    await test.step('leaving with unsaved changes is questioned, not obeyed', async () => {
      await requester
        .getByRole('textbox', { name: /why this is needed/i })
        .fill('The server cupboard is overheating.');

      await requester.getByRole('link', { name: /all estimates/i }).click();

      // Still here, and asked about it. Silently discarding a typed
      // justification because somebody clicked the wrong link is lost work.
      const warning = requester.getByRole('dialog', { name: /changes you have not saved/i });
      await expect(warning).toBeVisible();
      await expect(requester).toHaveURL(new RegExp(`${estimate}$`));

      await warning.getByRole('button', { name: /stay on this page/i }).click();
      await expect(warning).toBeHidden();
      await expect(
        requester.getByRole('textbox', { name: /why this is needed/i }),
      ).toHaveValue('The server cupboard is overheating.');
    });

    await test.step('saving marks what is still outstanding on the boxes', async () => {
      await requester.getByRole('button', { name: /save draft/i }).click();
      await expect(requester.getByText(/draft saved at/i)).toBeVisible();

      // Offered up for checking, so now the gaps are marked. This is the moment
      // the flagging is help rather than accusation.
      expect(await requester.locator('[aria-invalid="true"]').count()).toBeGreaterThan(0);

      // And the guidance survives the flagging, because a reader told a field is
      // wrong still needs to know what it wants.
      await expect(
        requester.getByText(/choose from the suppliers finance has already set up/i),
      ).toBeVisible();
    });

    await test.step('a completed draft is told which approvals its amount needs', async () => {
      await fillDraft(requester, {
        quotationNumber: 'Q-2026-118',
        description: 'Replacement air-conditioning units for the Kingston branch',
        amount: '250000',
        justification:
          'Two of the three units failed during the July heat and the server cupboard is now the warmest room on the floor.',
      });
      await requester.getByRole('button', { name: /save draft/i }).click();

      await expect(requester.getByText(/draft saved at/i)).toBeVisible();
      // Nothing outstanding any more, so the panel is gone rather than empty.
      await expect(
        requester.getByRole('heading', { name: /before this can go for approval/i }),
      ).toHaveCount(0);

      // JMD 250,000 is above the JMD 50,000 band, so it needs a second approval.
      // This is the assertion that fails if the matrix is read wrongly, and it is
      // shown before submission because a requester is entitled to know who they
      // are about to send their request to.
      await expect(requester.getByText('Unit Head', { exact: true })).toBeVisible();
      await expect(requester.getByText('Manager', { exact: true })).toBeVisible();

      await expect(requester).toHaveScreenshot('estimate-draft-complete.png', { fullPage: true });
    });

    await test.step('submitting opens the route and closes the form', async () => {
      await requester.getByRole('button', { name: /send for approval/i }).click();

      await expect(requester.getByText('Pending approval').first()).toBeVisible();
      // The details are read back rather than editable. An amount that could be
      // changed while approvers are deciding is an amount nobody approved.
      await expect(requester.getByRole('heading', { name: 'What was requested' })).toBeVisible();
      await expect(totalBox(requester)).toHaveCount(0);
      await expect(requester.getByRole('button', { name: /withdraw/i })).toBeEnabled();

      // Segregation of duties, on screen. The requester holds no approver role
      // here, and even if they did this route is theirs.
      await expect(decision(requester)).toHaveCount(0);

      await expect(step(requester, 'Unit Head').getByText('Waiting on this')).toBeVisible();
      await expect(step(requester, 'Manager').getByText('Not yet due')).toBeVisible();

      await expect(requester).toHaveScreenshot('estimate-pending.png', { fullPage: true });
    });

    await test.step('it reaches the first approver’s queue and nobody else’s', async () => {
      await unitHead.goto('/estimates');
      await settle(unitHead);

      const row = unitHead.getByRole('link', { name: new RegExp(reference) });
      await expect(row).toBeVisible();
      await expect(row.getByText('Yours to decide')).toBeVisible();

      await expect(unitHead).toHaveScreenshot('estimates-waiting-on-me.png', { fullPage: true });

      // The Manager is on this route but it is not their turn, so it must not be
      // in their queue. A queue containing work that would be refused is a queue
      // an approver stops reading.
      await manager.goto('/estimates');
      await settle(manager);
      await expect(manager.getByRole('link', { name: new RegExp(reference) })).toHaveCount(0);
    });

    await test.step('the one queue answers whether anybody is waiting on them', async () => {
      // The register answers "what estimates are waiting"; this answers "is
      // anybody waiting on me", across every kind of record at once. It is the
      // only screen an approver should have to open to find that out.
      await unitHead.goto('/approvals');
      await settle(unitHead);

      const waiting = unitHead.getByRole('listitem').filter({ hasText: reference });
      await expect(waiting).toBeVisible();
      await expect(waiting.getByText('Estimate')).toBeVisible();
      // The level being asked for, not merely that something is asked.
      await expect(waiting.getByText('Unit Head')).toBeVisible();

      await expect(unitHead).toHaveScreenshot('approvals-queue-populated.png', {
        fullPage: true,
      });

      // Same reasoning as the register: not their turn, not their queue.
      await manager.goto('/approvals');
      await settle(manager);
      await expect(manager.getByRole('listitem').filter({ hasText: reference })).toHaveCount(0);
    });

    await test.step('the approver whose turn it is decides, and only that step', async () => {
      await unitHead.goto(estimate);
      await settle(unitHead);

      // Exactly one panel: theirs. Two would mean the interface had offered a
      // decision the server would refuse.
      await expect(decision(unitHead)).toHaveCount(1);
      await expect(decision(unitHead)).toContainText('Unit Head');
      await expect(unitHead.getByText(/you are deciding JMD\s?250,000\.00/i)).toBeVisible();

      // Reject is as prominent as Approve. An approver whose only obvious option
      // is to agree has been told what is expected of them.
      await expect(unitHead.getByRole('button', { name: /^approve$/i })).toBeVisible();
      await expect(unitHead.getByRole('button', { name: /^reject$/i })).toBeVisible();

      await expect(unitHead).toHaveScreenshot('estimate-decision.png', { fullPage: true });

      await unitHead.getByRole('button', { name: /^approve$/i }).click();
      await unitHead
        .getByLabel(/anything to add/i)
        .fill('Checked against the quotation. The failed units are the ones on the roof.');
      await unitHead.getByRole('button', { name: /record the approval/i }).click();

      // Named and quoted. A step reading "Approved" with nobody against it is not
      // an approval, and this platform does not have approvals nobody made.
      const decided = step(unitHead, 'Unit Head');
      await expect(decided.getByText(/Approved by/)).toBeVisible();
      await expect(decided.getByText('Ana Approver')).toBeVisible();
      await expect(decided.getByText(/the ones on the roof/)).toBeVisible();

      // Their part is done, so the panel is gone: they are not the Manager, and
      // the next step is not theirs to take.
      await expect(decision(unitHead)).toHaveCount(0);
      await expect(step(unitHead, 'Manager').getByText('Waiting on this')).toBeVisible();
    });

    await test.step('the second approval closes the route and moves the estimate', async () => {
      await manager.goto('/estimates');
      await settle(manager);
      // Now it is their turn, so now it is in their queue.
      await expect(manager.getByRole('link', { name: new RegExp(reference) })).toBeVisible();

      await manager.goto(estimate);
      await settle(manager);
      await expect(decision(manager)).toContainText('Manager');

      await manager.getByRole('button', { name: /^approve$/i }).click();
      await manager.getByRole('button', { name: /record the approval/i }).click();

      await expect(manager.getByText('Fully approved', { exact: true })).toBeVisible();
      await expect(manager.getByText('Approved', { exact: true }).first()).toBeVisible();
      // Both approvals survive the route closing. The record of who agreed is the
      // whole point of having asked them.
      await expect(step(manager, 'Unit Head').getByText('Ana Approver')).toBeVisible();
      await expect(step(manager, 'Manager').getByText('Marcus Manager')).toBeVisible();

      await expect(manager).toHaveScreenshot('estimate-approved.png', { fullPage: true });
    });

    await test.step('the requester sees the outcome and can no longer change it', async () => {
      await requester.goto(estimate);
      await settle(requester);

      await expect(requester.getByRole('heading', { name: 'History' })).toBeVisible();
      await expect(requester.getByRole('button', { name: /save draft/i })).toHaveCount(0);
      await expect(requester.getByRole('button', { name: /withdraw/i })).toHaveCount(0);
    });

    // ------------------------------------------------------- withdrawal, refusal

    let second = '';
    let secondReference = '';

    await test.step('a smaller amount takes a shorter route', async () => {
      second = await raiseDraft(requester);
      secondReference = await referenceOf(requester);

      await fillDraft(requester, {
        quotationNumber: 'Q-2026-204',
        description: 'Annual service of the standby generator',
        amount: '40000',
        justification:
          'The service is overdue and the generator is what keeps the branch open during an outage.',
      });
      await requester.getByRole('button', { name: /save draft/i }).click();
      await expect(requester.getByText(/draft saved at/i)).toBeVisible();

      // Below the JMD 50,000 band, so the Manager is not on this route at all.
      await expect(requester.getByText('Unit Head', { exact: true })).toBeVisible();
      await expect(requester.getByText('Manager', { exact: true })).toHaveCount(0);

      await requester.getByRole('button', { name: /send for approval/i }).click();
      await expect(requester.getByText('Pending approval').first()).toBeVisible();
    });

    await test.step('withdrawing needs a reason and keeps the abandoned round', async () => {
      await requester.getByRole('button', { name: /withdraw/i }).click();
      const dialog = requester.getByRole('dialog');
      await expect(dialog).toBeVisible();

      // Refused without one. A route abandoned for no stated reason is a gap in
      // the record that nobody can close later.
      await expect(dialog.getByRole('button', { name: /withdraw it/i })).toBeDisabled();
      await dialog
        .getByLabel(/why you are withdrawing it/i)
        .fill('The supplier sent a revised quotation with a different scope.');
      await dialog.getByRole('button', { name: /withdraw it/i }).click();

      await expect(dialog).toBeHidden();
      // Editable again, and the abandoned round is kept rather than erased.
      await expect(totalBox(requester)).toBeVisible();
      await expect(requester.getByRole('heading', { name: 'Earlier rounds' })).toBeVisible();
      await expect(requester.getByText('Withdrawn').first()).toBeVisible();

      await expect(requester).toHaveScreenshot('estimate-withdrawn.png', { fullPage: true });
    });

    await test.step('a rejection is recorded with its reason and ends the request', async () => {
      await requester.getByRole('button', { name: /send for approval/i }).click();
      await expect(requester.getByText('Pending approval').first()).toBeVisible();
      // A second round, numbered, beside the first.
      await expect(requester.getByText(/round 2/i)).toBeVisible();

      await unitHead.goto(second);
      await settle(unitHead);
      await unitHead.getByRole('button', { name: /^reject$/i }).click();

      // A refusal has to be answerable by the person whose request it was, so it
      // cannot be recorded without saying why.
      const record = unitHead.getByRole('button', { name: /record the rejection/i });
      await expect(record).toBeDisabled();
      await expect(unitHead.getByText(/a rejection needs a reason/i)).toBeVisible();

      await unitHead
        .getByLabel(/why you are rejecting this/i)
        .fill('Facilities has a maintenance contract that already covers this service.');
      await record.click();

      await expect(unitHead.getByText('Rejected', { exact: true }).first()).toBeVisible();
      // Quoted against the step, not paraphrased. What the approver wrote is the
      // record, and it is also repeated in the history, so this names which of
      // the two it is looking at.
      await expect(
        unitHead.getByRole('blockquote').filter({ hasText: /already covers this service/ }),
      ).toBeVisible();

      await expect(unitHead).toHaveScreenshot('estimate-rejected.png', { fullPage: true });
    });

    await test.step('the refused estimate is closed to everyone, including its author', async () => {
      await requester.goto(second);
      await settle(requester);

      await expect(requester.getByText('Rejected', { exact: true }).first()).toBeVisible();
      await expect(requester.getByText(/already covers this service/).first()).toBeVisible();
      // Terminal. Starting again means raising a new estimate, which keeps this
      // one's history intact instead of overwriting it.
      await expect(requester.getByRole('button', { name: /save draft/i })).toHaveCount(0);
      await expect(requester.getByRole('button', { name: /send for approval/i })).toHaveCount(0);
      await expect(requester.getByRole('button', { name: /^cancel$/i })).toHaveCount(0);
    });

    await test.step('each estimate sits in the register under its own outcome', async () => {
      await requester.goto('/estimates');
      await settle(requester);
      await requester
        .getByRole('group', { name: /choose a view/i })
        .getByRole('button', { name: /everything i raised/i })
        .click();

      await expect(requester.getByRole('link', { name: new RegExp(reference) })).toBeVisible();
      await expect(
        requester.getByRole('link', { name: new RegExp(secondReference) }),
      ).toBeVisible();

      await expect(requester).toHaveScreenshot('estimates-register-populated.png', {
        fullPage: true,
      });
    });
  });
});
