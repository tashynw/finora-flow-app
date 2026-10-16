import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainException } from '../common/errors.js';
import {
  auditMock,
  compile,
  provideAudit,
  providePrisma,
  session,
} from '../testing/fixtures.js';
import { DepartmentsService } from './departments.service.js';

describe('DepartmentsService', () => {
  const prisma = {
    department: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  };

  beforeEach(() => vi.clearAllMocks());

  it('refuses a department whose cost centre number is already used', async () => {
    prisma.department.findUnique.mockResolvedValue({ id: 'dept-1' });
    const service = await compile(DepartmentsService, [
      providePrisma(prisma),
      provideAudit(auditMock()),
    ]);

    await expect(
      service.create(session, { name: 'Finance', costCentreNumber: '100' }),
    ).rejects.toBeInstanceOf(DomainException);
    expect(prisma.department.create).not.toHaveBeenCalled();
  });

  it('searches active departments and caps the page', async () => {
    prisma.department.findMany.mockResolvedValue([]);
    const service = await compile(DepartmentsService, [
      providePrisma(prisma),
      provideAudit(auditMock()),
    ]);

    await service.list(false, 'fin', 500);

    expect(prisma.department.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isActive: true }),
        take: 50,
      }),
    );
  });

  it('returns the first page when nothing has been typed', async () => {
    prisma.department.findMany.mockResolvedValue([]);
    const service = await compile(DepartmentsService, [
      providePrisma(prisma),
      provideAudit(auditMock()),
    ]);

    await service.list(false, '', 10);

    expect(prisma.department.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10 }),
    );
  });
});
