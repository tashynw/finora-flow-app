import { Injectable } from '@nestjs/common';
import { InvoiceStatus } from '../generated/prisma/index.js';
import { serialize } from '../common/serialize.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class OverviewService {
  constructor(private readonly prisma: PrismaService) {}

  async metrics(months = 6) {
    const since = new Date();
    since.setMonth(since.getMonth() - Math.max(1, Math.min(months, 24)));

    const whereSince = { archivedAt: null, createdAt: { gte: since } };

    const [statusGroups, spendGroups] = await Promise.all([
      this.prisma.invoice.groupBy({
        by: ['status'],
        where: whereSince,
        _count: { _all: true },
      }),
      this.prisma.invoice.groupBy({
        by: ['currency'],
        where: {
          ...whereSince,
          status: InvoiceStatus.APPROVED,
          totalMinorUnits: { not: null },
          currency: { not: null },
        },
        _sum: { totalMinorUnits: true },
      }),
    ]);

    const invoiceCountsByStatus: Record<string, number> = {};
    for (const row of statusGroups) {
      invoiceCountsByStatus[row.status] = row._count._all;
    }

    const approvedSpendByCurrency: Record<string, string> = {};
    for (const row of spendGroups) {
      if (!row.currency) continue;
      approvedSpendByCurrency[row.currency] = (
        row._sum.totalMinorUnits ?? 0n
      ).toString();
    }

    return serialize({
      months,
      since: since.toISOString(),
      invoiceCountsByStatus,
      approvedSpendByCurrency,
    });
  }
}
