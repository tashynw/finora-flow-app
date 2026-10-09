import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainException } from '../common/errors.js';
import {
  auditMock,
  compile,
  provideAudit,
  providePrisma,
  session,
} from '../testing/fixtures.js';
import { AdminUsersService } from './admin-users.service.js';

describe('AdminUsersService', () => {
  const prisma = { user: { findUnique: vi.fn(), update: vi.fn() } };

  beforeEach(() => vi.clearAllMocks());

  async function service() {
    return compile(AdminUsersService, [
      providePrisma(prisma),
      provideAudit(auditMock()),
    ]);
  }

  it('refuses roles that both administer the matrix and decide approvals', async () => {
    await expect(
      (await service()).setRoles(
        'user-2',
        { roles: ['administrator', 'approver'], reason: 'Cover' },
        session,
      ),
    ).rejects.toBeInstanceOf(DomainException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('stores compatible roles as a comma-separated field', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      role: 'requester',
      email: 'bea@finora.test',
      name: 'Bea',
      archivedAt: null,
      banned: false,
      department: null,
    });
    prisma.user.update.mockResolvedValue({
      id: 'user-2',
      role: 'finance',
      email: 'bea@finora.test',
      name: 'Bea',
      archivedAt: null,
      banned: false,
      department: null,
    });

    const result = await (await service()).setRoles(
      'user-2',
      { roles: ['finance'], reason: 'Moved to finance' },
      session,
    );

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { role: 'finance' } }),
    );
    expect(result.roles).toEqual(['finance']);
  });
});
