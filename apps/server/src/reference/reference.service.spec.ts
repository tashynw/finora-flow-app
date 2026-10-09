import { describe, expect, it, vi } from 'vitest';
import { compile, providePrisma } from '../testing/fixtures.js';
import { ReferenceService } from './reference.service.js';

describe('ReferenceService', () => {
  it('returns only active selectors plus the supported currencies', async () => {
    const prisma = {
      vendor: { findMany: vi.fn().mockResolvedValue([{ id: 'v', code: 'A', name: 'Acme' }]) },
      costCentre: { findMany: vi.fn().mockResolvedValue([]) },
      glAccount: { findMany: vi.fn().mockResolvedValue([]) },
      department: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const service = await compile(ReferenceService, [providePrisma(prisma)]);
    const data = await service.getReferenceData();

    expect(prisma.vendor.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isActive: true, archivedAt: null },
      }),
    );
    expect(data.currencies).toEqual(['JMD', 'USD']);
    expect(data.vendors).toEqual([{ id: 'v', code: 'A', name: 'Acme' }]);
  });
});
