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
  const prisma = { department: { findUnique: vi.fn(), create: vi.fn() } };

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
});
