import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditMock,
  compile,
  provideAudit,
  providePrisma,
  session,
} from '../testing/fixtures.js';
import { GlAccountsService } from './gl-accounts.service.js';

describe('GlAccountsService', () => {
  const prisma = { glAccount: { findUnique: vi.fn(), update: vi.fn() } };

  beforeEach(() => vi.clearAllMocks());

  it('archives a GL account instead of deleting it', async () => {
    prisma.glAccount.findUnique.mockResolvedValue({
      id: 'gl-1',
      code: '5000',
      name: 'Supplies',
      isActive: true,
      archivedAt: null,
    });
    prisma.glAccount.update.mockImplementation(async ({ data }) => ({
      id: 'gl-1',
      code: '5000',
      name: 'Supplies',
      ...data,
    }));

    const service = await compile(GlAccountsService, [
      providePrisma(prisma),
      provideAudit(auditMock()),
    ]);
    const result = await service.setActive(session, 'gl-1', {
      isActive: false,
      reason: 'No longer used',
    });

    expect(prisma.glAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isActive: false, archivedAt: expect.any(Date) }),
      }),
    );
    expect(result.isActive).toBe(false);
  });
});
