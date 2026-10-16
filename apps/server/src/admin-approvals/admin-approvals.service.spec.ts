import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainException } from '../common/errors.js';
import {
  auditMock,
  compile,
  provideAudit,
  providePrisma,
  session,
} from '../testing/fixtures.js';
import { AdminApprovalsService } from './admin-approvals.service.js';

describe('AdminApprovalsService', () => {
  const prisma = {
    approvalRule: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    user: { findMany: vi.fn() },
  };

  beforeEach(() => vi.clearAllMocks());

  it('retires a live matrix rule instead of deleting it', async () => {
    prisma.approvalRule.findUnique.mockResolvedValue({
      id: 'rule-1',
      isActive: true,
      recordType: 'ESTIMATE',
    });
    prisma.approvalRule.update.mockResolvedValue({});
    prisma.approvalRule.findMany.mockResolvedValue([]);

    const service = await compile(AdminApprovalsService, [
      providePrisma(prisma),
      provideAudit(auditMock()),
    ]);
    const matrix = await service.retireRule('rule-1', 'Superseded', session);

    expect(prisma.approvalRule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isActive: false,
          retiredAt: expect.any(Date),
        }),
      }),
    );
    expect(matrix.record_type).toBe('estimate');
  });

  it('refuses to retire a rule that is already retired', async () => {
    prisma.approvalRule.findUnique.mockResolvedValue({
      id: 'rule-1',
      isActive: false,
      recordType: 'ESTIMATE',
    });
    const service = await compile(AdminApprovalsService, [
      providePrisma(prisma),
      provideAudit(auditMock()),
    ]);

    await expect(
      service.retireRule('rule-1', 'Again', session),
    ).rejects.toBeInstanceOf(DomainException);
  });

  it('searches open accounts by name or email and caps the page', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    const service = await compile(AdminApprovalsService, [
      providePrisma(prisma),
      provideAudit(auditMock()),
    ]);

    await service.listPeople('ada', 500);

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );
  });

  it('returns the first page of people when nothing has been typed', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    const service = await compile(AdminApprovalsService, [
      providePrisma(prisma),
      provideAudit(auditMock()),
    ]);

    await service.listPeople('  ', 10);

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10, orderBy: { name: 'asc' } }),
    );
  });
});
