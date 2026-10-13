import { describe, expect, it, vi } from 'vitest';
import { compile, providePrisma } from '../testing/fixtures.js';
import { OverviewService } from './overview.service.js';

describe('OverviewService', () => {
  it('returns the dashboard arrays even when every register is empty', async () => {
    const prisma = {
      invoice: { findMany: vi.fn().mockResolvedValue([]) },
      estimate: { findMany: vi.fn().mockResolvedValue([]) },
      purchaseOrder: { findMany: vi.fn().mockResolvedValue([]) },
      paymentPackage: { count: vi.fn().mockResolvedValue(2) },
      accrualPeriod: { count: vi.fn().mockResolvedValue(0) },
      creditCardPeriod: { count: vi.fn().mockResolvedValue(0) },
      approvalRequest: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const service = await compile(OverviewService, [providePrisma(prisma)]);
    const metrics = await service.metrics(6);

    expect(metrics.spend_cards.map((card) => card.key)).toEqual([
      'total_spend',
      'approved_amount',
      'pending_approvals',
      'open_items',
    ]);
    expect(metrics.kpis.find((kpi) => kpi.key === 'open_packages')?.value).toBe(2);
    expect(metrics.invoice_states.find((slice) => slice.label === 'Exception')?.count).toBe(0);
    expect(metrics.monthly_spend).toHaveLength(6);
  });
});
