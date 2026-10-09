import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compile, providePrisma, user } from '../testing/fixtures.js';
import { ApprovalsEngineService } from './approvals-engine.service.js';
import { ApprovalsService } from './approvals.service.js';

describe('ApprovalsService', () => {
  const engine = {
    awaitingForUser: vi.fn(),
    filterAwaitingMine: vi.fn(),
    progressFromRequest: vi.fn(),
  };
  const prisma = { estimate: { findMany: vi.fn() } };

  beforeEach(() => vi.clearAllMocks());

  it('lists only the open steps this person can decide', async () => {
    const request = {
      id: 'req-1',
      recordType: 'estimate',
      recordId: 'est-1',
      amountMinorUnits: 1000n,
      currency: 'JMD',
      openedAt: new Date('2026-10-01T00:00:00Z'),
      attempt: 1,
      department: { name: 'Finance' },
      requester: { name: 'Bea' },
      steps: [{ stepOrder: 1, level: 'MANAGER', status: 'READY' }],
    };
    engine.awaitingForUser.mockResolvedValue([request]);
    engine.filterAwaitingMine.mockResolvedValue([
      { request, step: request.steps[0] },
    ]);
    engine.progressFromRequest.mockReturnValue(request.steps);
    prisma.estimate.findMany.mockResolvedValue([
      {
        id: 'est-1',
        reference: 'EST-1',
        description: 'Laptops',
        vendor: { name: 'Acme' },
        totalMinorUnits: 1000n,
        currency: 'JMD',
      },
    ]);

    const service = await compile(ApprovalsService, [
      providePrisma(prisma),
      { provide: ApprovalsEngineService, useValue: engine },
    ]);
    const queue = await service.queue(user);

    expect(queue.total).toBe(1);
    expect(queue.items[0]).toMatchObject({
      record_type: 'estimate',
      reference: 'EST-1',
      vendor_name: 'Acme',
    });
    expect(queue.counts_by_type).toEqual({ estimate: 1 });
  });
});
