import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainException } from '../common/errors.js';
import {
  auditMock,
  compile,
  provideAudit,
  providePrisma,
  session,
} from '../testing/fixtures.js';
import { AdminThresholdsService } from './admin-thresholds.service.js';

describe('AdminThresholdsService', () => {
  const prisma = {
    purchaseOrderThreshold: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  };

  beforeEach(() => vi.clearAllMocks());

  it('creates a threshold when that currency does not have one yet', async () => {
    prisma.purchaseOrderThreshold.findUnique.mockResolvedValue(null);
    prisma.purchaseOrderThreshold.create.mockResolvedValue({
      id: 'th-1',
      currency: 'JMD',
      appliesAboveMinorUnits: 5_000_000n,
      isActive: true,
    });

    const service = await compile(AdminThresholdsService, [
      providePrisma(prisma),
      provideAudit(auditMock()),
    ]);
    await service.upsert(
      {
        currency: 'JMD',
        applies_above_minor_units: 5_000_000,
        reason: 'Board limit',
      },
      session,
    );

    expect(prisma.purchaseOrderThreshold.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currency: 'JMD',
          appliesAboveMinorUnits: 5_000_000n,
        }),
      }),
    );
  });

  it('requires a reason', async () => {
    const service = await compile(AdminThresholdsService, [
      providePrisma(prisma),
      provideAudit(auditMock()),
    ]);
    await expect(
      service.upsert(
        { currency: 'JMD', applies_above_minor_units: 1, reason: 'no' },
        session,
      ),
    ).rejects.toBeInstanceOf(DomainException);
  });
});
