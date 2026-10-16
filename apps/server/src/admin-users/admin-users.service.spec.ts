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
  const prisma = {
    user: { findUnique: vi.fn(), update: vi.fn() },
    department: { findUnique: vi.fn() },
  };

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

  it('updates the display name and department and leaves the email unchanged', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      email: 'bea@finora.test',
      name: 'Bea',
      role: 'requester',
      jobTitle: null,
      departmentId: null,
      archivedAt: null,
      banned: false,
      department: null,
    });
    prisma.department.findUnique.mockResolvedValue({
      id: 'dept-1',
      name: 'Finance',
      isActive: true,
    });
    prisma.user.update.mockResolvedValue({
      id: 'user-2',
      email: 'bea@finora.test',
      name: 'Beatrice',
      role: 'requester',
      jobTitle: 'Analyst',
      departmentId: 'dept-1',
      archivedAt: null,
      banned: false,
      department: { id: 'dept-1', name: 'Finance' },
    });

    const result = await (await service()).update(
      'user-2',
      {
        display_name: 'Beatrice',
        department_id: 'dept-1',
        job_title: 'Analyst',
        reason: 'Moved into finance',
      },
      session,
    );

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          name: 'Beatrice',
          departmentId: 'dept-1',
          jobTitle: 'Analyst',
        },
      }),
    );
    expect(result.email).toBe('bea@finora.test');
    expect(result.display_name).toBe('Beatrice');
    expect(result.department_id).toBe('dept-1');
    expect(result.job_title).toBe('Analyst');
  });
});
