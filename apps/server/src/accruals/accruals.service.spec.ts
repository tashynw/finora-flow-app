import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainException } from '../common/errors.js';
import { InvoiceStatus } from '../generated/prisma/index.js';
import {
  auditMock,
  compile,
  provideAudit,
  providePrisma,
  session,
} from '../testing/fixtures.js';
import { AccrualsService } from './accruals.service.js';

describe('AccrualsService', () => {
  const prisma = {
    accrualPeriod: { findUnique: vi.fn(), update: vi.fn() },
    accrualCandidate: { count: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
    invoice: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
  };
  const audit = auditMock();

  beforeEach(() => vi.clearAllMocks());

  async function service() {
    return compile(AccrualsService, [
      providePrisma(prisma),
      provideAudit(audit),
    ]);
  }

  it('proposes candidates only from invoices not already on the period', async () => {
    prisma.accrualPeriod.findUnique
      .mockResolvedValueOnce({
        id: 'per-1',
        lockedAt: null,
        periodEnd: new Date('2026-10-31'),
        openedById: 'u-other',
      })
      .mockResolvedValueOnce({
        id: 'per-1',
        reference: 'ACP-1',
        periodStart: new Date('2026-10-01'),
        periodEnd: new Date('2026-10-31'),
        label: 'October',
        lockedAt: null,
        lockReason: null,
        openedById: 'u-other',
        candidates: [],
        exports: [],
      });
    prisma.user.findUnique.mockResolvedValue({ role: 'finance' });
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: 'inv-1',
        currency: 'JMD',
        totalMinorUnits: 1000n,
        vendor: { name: 'Acme' },
        invoiceNumber: '9',
        reference: 'INV-9',
        description: 'Rent',
        glAccountId: null,
        costCentreId: null,
        departmentId: null,
      },
    ]);
    prisma.accrualCandidate.createMany.mockResolvedValue({ count: 1 });

    await (await service()).generateCandidates(session, 'per-1');

    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: expect.arrayContaining([InvoiceStatus.APPROVED]) },
          accrualCandidates: { none: { periodId: 'per-1' } },
        }),
      }),
    );
    expect(prisma.accrualCandidate.createMany).toHaveBeenCalled();
  });

  it('refuses to lock a period that still has unsettled candidates', async () => {
    prisma.accrualPeriod.findUnique.mockResolvedValue({
      id: 'per-1',
      lockedAt: null,
    });
    prisma.accrualCandidate.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);

    await expect(
      (await service()).lockPeriod(session, 'per-1', { reason: 'Close October' }),
    ).rejects.toBeInstanceOf(DomainException);
    expect(prisma.accrualPeriod.update).not.toHaveBeenCalled();
  });

  it('accepts snake_case period dates when opening a period', async () => {
    prisma.accrualPeriod.create = vi.fn().mockResolvedValue({
      id: 'per-new',
      reference: 'ACP-2',
    });
    prisma.accrualPeriod.findUnique.mockResolvedValue({
      id: 'per-new',
      reference: 'ACP-2',
      periodStart: new Date('2026-06-01T00:00:00.000Z'),
      periodEnd: new Date('2026-06-30T00:00:00.000Z'),
      label: 'June 2026',
      lockedAt: null,
      lockReason: null,
      openedById: session.user.id,
      candidates: [],
      exports: [],
    });
    prisma.user.findUnique.mockResolvedValue({ role: 'finance' });

    const detail = await (
      await service()
    ).createPeriod(session, {
      period_start: '2026-06-01',
      period_end: '2026-06-30',
      label: 'June 2026',
    });

    expect(prisma.accrualPeriod.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          label: 'June 2026',
          openedById: session.user.id,
        }),
      }),
    );
    expect(detail).toMatchObject({
      id: 'per-new',
      label: 'June 2026',
      standing: 'open',
      standing_label: 'Open',
      period_start: '2026-06-01',
      period_end: '2026-06-30',
      candidate_count: 0,
    });
  });
});
