import { describe, expect, it, vi } from 'vitest';
import { compile, providePrisma } from '../testing/fixtures.js';
import { WorkService } from './work.service.js';

describe('WorkService', () => {
  it('counts pending invoices, estimates, and purchase orders into my work', async () => {
    const prisma = {
      invoice: { count: vi.fn().mockResolvedValue(2), findMany: vi.fn() },
      estimate: { count: vi.fn().mockResolvedValue(1), findMany: vi.fn() },
      purchaseOrder: { count: vi.fn().mockResolvedValue(3), findMany: vi.fn() },
      inboundMessage: { count: vi.fn().mockResolvedValue(4) },
      vendorCheckIn: { count: vi.fn().mockResolvedValue(5) },
    };
    const service = await compile(WorkService, [providePrisma(prisma)]);
    const badges = await service.badges();

    expect(badges.myWork).toBe(6);
    expect(badges.intakeUnprocessed).toBe(4);
    expect(badges.vendorNeedingReview).toBe(5);
  });
});
