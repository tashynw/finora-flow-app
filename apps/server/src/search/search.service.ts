import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(query: string, limit = 25) {
    const q = query.trim();
    if (!q) {
      return { query: q, items: [], total: 0 };
    }

    const take = Math.min(Math.max(limit, 1), 50);
    const contains = { contains: q, mode: 'insensitive' as const };

    const [invoices, estimates, orders, vendors] = await Promise.all([
      this.prisma.invoice.findMany({
        where: {
          archivedAt: null,
          OR: [
            { reference: contains },
            { invoiceNumber: contains },
            { description: contains },
            { vendor: { name: contains } },
          ],
        },
        take,
        include: { vendor: true },
      }),
      this.prisma.estimate.findMany({
        where: {
          archivedAt: null,
          OR: [
            { reference: contains },
            { estimateNumber: contains },
            { description: contains },
            { vendor: { name: contains } },
          ],
        },
        take,
        include: { vendor: true },
      }),
      this.prisma.purchaseOrder.findMany({
        where: {
          archivedAt: null,
          OR: [{ number: contains }, { description: contains }],
        },
        take,
      }),
      this.prisma.vendor.findMany({
        where: {
          archivedAt: null,
          OR: [{ code: contains }, { name: contains }],
        },
        take,
      }),
    ]);

    const items = [
      ...invoices.map((row) => ({
        recordType: 'invoice',
        recordId: row.id,
        reference: row.reference,
        title: row.invoiceNumber ?? row.reference,
        subtitle: row.vendor?.name ?? row.description,
        state: row.status,
      })),
      ...estimates.map((row) => ({
        recordType: 'estimate',
        recordId: row.id,
        reference: row.reference,
        title: row.estimateNumber ?? row.reference,
        subtitle: row.vendor?.name ?? row.description,
        state: row.status,
      })),
      ...orders.map((row) => ({
        recordType: 'purchase_order',
        recordId: row.id,
        reference: row.number,
        title: row.number,
        subtitle: row.description,
        state: row.status,
      })),
      ...vendors.map((row) => ({
        recordType: 'vendor',
        recordId: row.id,
        reference: row.code,
        title: row.name,
        subtitle: row.code,
        state: row.isActive ? 'active' : 'inactive',
      })),
    ].slice(0, take);

    return { query: q, items, total: items.length };
  }
}
