import { describe, expect, it, vi } from 'vitest';
import { InvoiceStatus } from '../generated/prisma/index.js';
import { compile, providePrisma } from '../testing/fixtures.js';
import { OverviewService } from './overview.service.js';

describe('OverviewService', () => {
  it('aggregates invoice counts and approved spend in the database', async () => {
    const prisma = {
      invoice: {
        groupBy: vi
          .fn()
          .mockResolvedValueOnce([
            { status: InvoiceStatus.APPROVED, _count: { _all: 3 } },
          ])
          .mockResolvedValueOnce([
            { currency: 'JMD', _sum: { totalMinorUnits: 15_000n } },
          ]),
      },
    };
    const service = await compile(OverviewService, [providePrisma(prisma)]);
    const metrics = await service.metrics(6);

    expect(metrics.invoiceCountsByStatus).toEqual({ APPROVED: 3 });
    expect(metrics.approvedSpendByCurrency).toEqual({ JMD: '15000' });
    expect(prisma.invoice.groupBy).toHaveBeenCalledTimes(2);
  });
});
