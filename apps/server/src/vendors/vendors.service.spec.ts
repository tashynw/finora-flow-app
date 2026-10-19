import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainException } from '../common/errors.js';
import {
  auditMock,
  compile,
  provideAudit,
  providePrisma,
  session,
} from '../testing/fixtures.js';
import { VendorsService } from './vendors.service.js';

describe('VendorsService', () => {
  const prisma = { vendor: { findUnique: vi.fn(), create: vi.fn(), findMany: vi.fn(), update: vi.fn() } };
  const audit = auditMock();

  beforeEach(() => vi.clearAllMocks());

  async function service() {
    return compile(VendorsService, [providePrisma(prisma), provideAudit(audit)]);
  }

  it('rejects a duplicate vendor code', async () => {
    prisma.vendor.findUnique.mockResolvedValue({ id: 'v-1' });
    await expect(
      (await service()).create(session, { code: 'ACME', name: 'Acme' }),
    ).rejects.toBeInstanceOf(DomainException);
    expect(prisma.vendor.create).not.toHaveBeenCalled();
  });

  it('lists only active vendors unless inactive ones are requested', async () => {
    prisma.vendor.findMany.mockResolvedValue([]);
    await (await service()).list(false);
    expect(prisma.vendor.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isActive: true, archivedAt: null },
      }),
    );
  });
});
