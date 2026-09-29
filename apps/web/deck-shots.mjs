// One-off: captures the screens for the client demo deck.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:5173';
const OUT = path.resolve('..', '..', 'redesign-pack', 'deck', 'shots');

const SHOTS = [
  { email: null, route: '/sign-in', name: 'signin', wait: 2500 },
  { email: 'approver@finora.example', route: '/', name: 'dashboard' },
  { email: 'clerk@finora.example', route: '/', name: 'dashboard-finance', full: true },
  { email: 'approver@finora.example', route: '/work', name: 'my-work' },
  { email: 'approver@finora.example', route: '/', name: 'search', keys: 'Control+k', type: 'Kingston', wait: 1500 },
  { email: 'clerk@finora.example', route: '/intake', name: 'inbox' },
  { email: 'clerk@finora.example', route: '/intake', name: 'message', row: 'Invoice CFS-7822', full: true },
  { email: 'clerk@finora.example', route: '/documents', name: 'documents', button: 'Everything' },
  { email: 'clerk@finora.example', route: '/documents', name: 'document-review', button: 'Everything', row: 'kingston-supplies', full: true },
  { email: 'requester@finora.example', route: '/estimates', name: 'estimates', button: 'Everything I raised' },
  { email: 'approver@finora.example', route: '/approvals', name: 'approvals' },
  { email: 'approver@finora.example', route: '/approvals', name: 'approval-decision', row: 'EST-D-0004', full: true },
  { email: 'clerk@finora.example', route: '/invoices', name: 'invoices', button: 'Everything' },
  { email: 'clerk@finora.example', route: '/invoices', name: 'invoice-detail', button: 'Everything', row: 'INV-D-0014', full: true },
  { email: 'clerk@finora.example', route: '/purchase-orders', name: 'purchase-orders' },
  { email: 'clerk@finora.example', route: '/purchase-orders', name: 'po-detail', row: 'PO-2026-0001', full: true },
  { email: 'payments@finora.example', route: '/payments', name: 'payments', button: 'Everything' },
  { email: 'payments@finora.example', route: '/payments', name: 'package-detail', button: 'Everything', row: 'PKG-D-0001', full: true },
  { email: 'payments@finora.example', route: '/vendor-confirmations', name: 'vendor-confirmations', button: 'Everything' },
  { email: 'payments@finora.example', route: '/vendor-confirmations', name: 'check-in-detail', button: 'Everything', row: 'VCI-000330', full: true },
  { email: 'clerk@finora.example', route: '/credit-cards', name: 'credit-cards' },
  { email: 'clerk@finora.example', route: '/credit-cards', name: 'card-period', row: 'CCS-000018', full: true },
  { email: 'clerk@finora.example', route: '/accruals', name: 'accruals', button: 'Everything' },
  { email: 'clerk@finora.example', route: '/accruals', name: 'accrual-period', button: 'Everything', row: 'ACR-D-0001', full: true },
  { email: 'auditor@finora.example', route: '/reports', name: 'reports' },
  { email: 'auditor@finora.example', route: '/audit', name: 'audit' },
  { email: 'ops@finora.example', route: '/operations', name: 'system-health' },
  { email: 'ops@finora.example', route: '/operations/intake', name: 'intake-health' },
  { email: 'admin@finora.example', route: '/settings/users', name: 'users' },
  { email: 'admin@finora.example', route: '/settings/approval-matrix', name: 'matrix', full: true },
  { email: 'admin@finora.example', route: '/settings/approvers', name: 'approvers' },
  { email: 'admin@finora.example', route: '/settings/reference', name: 'reference' },
  { email: 'admin@finora.example', route: '/settings/thresholds', name: 'thresholds' },
  { email: 'admin@finora.example', route: '/settings/retention', name: 'retention' },
  { email: 'admin@finora.example', route: '/settings/operations', name: 'operational-settings' },
  { email: 'approver@finora.example', route: '/settings/cover', name: 'cover' },
  { email: 'approver@finora.example', route: '/', name: 'phone-dashboard', phone: true },
  { email: null, route: '/sign-in', name: 'phone-signin', phone: true, wait: 2500 },
];

async function settle(page, extra = 600) {
  await page.locator('main').waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  await page
    .waitForFunction(() => !document.querySelector('.motion-shimmer'), null, { timeout: 15000 })
    .catch(() => {});
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  await page.waitForTimeout(extra);
}

const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();

for (const shot of SHOTS) {
  if (only && !only.includes(shot.name)) continue;
  const ctx = await browser.newContext({
    viewport: shot.phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    isMobile: Boolean(shot.phone),
    hasTouch: Boolean(shot.phone),
    colorScheme: 'light',
  });
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE}/sign-in`, { waitUntil: 'domcontentloaded' });
    if (shot.email) {
      await page.evaluate(async (email) => {
        await fetch('/api/v1/auth/local/sign-in', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email }),
        });
      }, shot.email);
    }
    await page.goto(`${BASE}${shot.route}`, { waitUntil: 'networkidle' });
    await settle(page);
    if (shot.button) {
      await page.getByRole('button', { name: shot.button, exact: true }).first().click().catch(() => {});
      await settle(page);
    }
    if (shot.row) {
      await page.getByText(shot.row, { exact: false }).first().click();
      await page.waitForLoadState('networkidle');
      await settle(page, 900);
    }
    if (shot.keys) {
      await page.keyboard.press(shot.keys);
      await page.waitForTimeout(400);
      if (shot.type) await page.keyboard.type(shot.type, { delay: 40 });
    }
    if (shot.wait) await page.waitForTimeout(shot.wait);
    await page.screenshot({ path: path.join(OUT, `${shot.name}.png`), fullPage: Boolean(shot.full || shot.phone) });
    console.log(`ok ${shot.name} ${page.url().replace(BASE, '')}`);
  } catch (error) {
    console.log(`FAIL ${shot.name}: ${error.message.split('\n')[0]}`);
  }
  await ctx.close();
}
await browser.close();
