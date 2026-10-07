import { Injectable } from '@nestjs/common';
import { InvoiceStatus } from '../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class OverviewService {
  constructor(private readonly prisma: PrismaService) {}

  async metrics(months = 6) {
    const since = new Date();
    since.setMonth(since.getMonth() - Math.max(1, Math.min(months, 24)));

    const invoices = await this.prisma.invoice.findMany({
      where: { archivedAt: null, createdAt: { gte: since } },
      select: {
        status: true,
        currency: true,
        totalMinorUnits: true,
      },
    });

    const countsByStatus: Record<string, number> = {};
    for (const inv of invoices) {
      countsByStatus[inv.status] = (countsByStatus[inv.status] ?? 0) + 1;
    }

    const approvedSpend: Record<string, bigint> = {};
    for (const inv of invoices) {
      if (
        inv.status !== InvoiceStatus.APPROVED ||
        inv.totalMinorUnits == null ||
        !inv.currency
      ) {
        continue;
      }
      approvedSpend[inv.currency] =
        (approvedSpend[inv.currency] ?? 0n) + inv.totalMinorUnits;
    }

    return {
      months,
      since: since.toISOString(),
      invoiceCountsByStatus: countsByStatus,
      approvedSpendByCurrency: Object.fromEntries(
        Object.entries(approvedSpend).map(([currency, minor]) => [
          currency,
          minor.toString(),
        ]),
      ),
    };
  }
}
