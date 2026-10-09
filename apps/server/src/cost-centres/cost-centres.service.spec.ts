import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainException } from '../common/errors.js';
import {
  auditMock,
  compile,
  provideAudit,
  providePrisma,
  session,
} from '../testing/fixtures.js';
import { CostCentresService } from './cost-centres.service.js';

describe('CostCentresService', () => {
  const prisma = {
    costCentre: { findUnique: vi.fn(), create: vi.fn() },
    department: { findUnique: vi.fn() },
  };

  beforeEach(() => vi.clearAllMocks());

  it('refuses a cost centre whose department does not exist', async () => {
    prisma.department.findUnique.mockResolvedValue(null);
    const service = await compile(CostCentresService, [
      providePrisma(prisma),
      provideAudit(auditMock()),
    ]);

    await expect(
      service.create(session, {
        code: 'FIN',
        name: 'Finance',
        departmentId: 'missing',
      }),
    ).rejects.toBeInstanceOf(DomainException);
    expect(prisma.costCentre.create).not.toHaveBeenCalled();
  });
});
