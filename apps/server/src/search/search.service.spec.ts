import { describe, expect, it, vi } from 'vitest';
import { compile, providePrisma } from '../testing/fixtures.js';
import { SearchService } from './search.service.js';

describe('SearchService', () => {
  it('returns nothing for a blank query and does not hit the database', async () => {
    const prisma = {
      invoice: { findMany: vi.fn() },
      estimate: { findMany: vi.fn() },
      purchaseOrder: { findMany: vi.fn() },
      vendor: { findMany: vi.fn() },
    };
    const service = await compile(SearchService, [providePrisma(prisma)]);
    const result = await service.search('   ');
    expect(result).toEqual({ query: '', items: [], total: 0 });
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
  });

  it('merges matches across invoices, estimates, orders, and vendors', async () => {
    const contains = { contains: 'acme', mode: 'insensitive' };
    const prisma = {
      invoice: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'inv-1',
            reference: 'INV-1',
            invoiceNumber: null,
            description: 'Paper',
            status: 'APPROVED',
            vendor: { name: 'Acme' },
          },
        ]),
      },
      estimate: { findMany: vi.fn().mockResolvedValue([]) },
      purchaseOrder: { findMany: vi.fn().mockResolvedValue([]) },
      vendor: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'v-1', code: 'ACME', name: 'Acme', isActive: true },
        ]),
      },
    };
    const service = await compile(SearchService, [providePrisma(prisma)]);
    const result = await service.search('acme', 10);

    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([{ reference: contains }]),
        }),
      }),
    );
    expect(result.items.map((item) => item.recordType)).toEqual([
      'invoice',
      'vendor',
    ]);
    expect(result.total).toBe(2);
  });
});
