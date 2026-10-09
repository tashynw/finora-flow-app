import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalsEngineService } from '../approvals/approvals-engine.service.js';
import { DomainException } from '../common/errors.js';
import {
  auditMock,
  compile,
  provideAudit,
  providePrisma,
  provideTransitions,
  transitionsMock,
  user,
} from '../testing/fixtures.js';
import { EstimatesService } from './estimates.service.js';

const estimate = {
  id: 'est-1',
  reference: 'EST-1',
  status: 'DRAFT',
  requesterId: user.id,
  vendorId: 'vendor-1',
  currency: 'JMD',
  totalMinorUnits: 10_000n,
  description: 'Laptops',
  justification: '',
  documentId: null,
  estimateNumber: null,
  estimateDate: null,
  neededBy: null,
  submittedAt: null,
  decidedAt: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  departmentId: null,
  approvalRequests: [],
  requester: { id: user.id, name: user.name, email: user.email },
  vendor: { name: 'Acme' },
  costCentre: null,
  glAccount: null,
  department: null,
};

describe('EstimatesService', () => {
  const prisma = {
    estimate: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  };
  const approvals = {
    submitForApproval: vi.fn(),
    openRequest: vi.fn(),
    withdrawOpenRequest: vi.fn(),
    recordDecision: vi.fn(),
    progressFromRequest: vi.fn(),
    standing: vi.fn(),
  };
  const audit = auditMock();
  const transitions = transitionsMock();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function service() {
    return compile(EstimatesService, [
      providePrisma(prisma),
      provideTransitions(transitions),
      provideAudit(audit),
      { provide: ApprovalsEngineService, useValue: approvals },
    ]);
  }

  it('creates a draft and does not open an approval route', async () => {
    prisma.estimate.create.mockResolvedValue(estimate);
    const result = await (await service()).create(user, { documentId: 'doc-1' });

    expect(prisma.estimate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DRAFT',
          requesterId: user.id,
          documentId: 'doc-1',
        }),
      }),
    );
    expect(approvals.submitForApproval).not.toHaveBeenCalled();
    expect(result.state).toBe('draft');
  });

  it('refuses to submit an incomplete draft', async () => {
    prisma.estimate.findFirst.mockResolvedValue({
      ...estimate,
      vendorId: null,
    });

    await expect((await service()).submit('est-1', user)).rejects.toBeInstanceOf(
      DomainException,
    );
    expect(approvals.submitForApproval).not.toHaveBeenCalled();
  });

  it('opens the approval route only when a complete draft is submitted', async () => {
    prisma.estimate.findFirst.mockResolvedValue(estimate);
    prisma.estimate.update.mockResolvedValue(estimate);

    await (await service()).submit('est-1', user);

    expect(approvals.submitForApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        recordType: 'estimate',
        recordId: 'est-1',
        amountMinorUnits: 10_000n,
        currency: 'JMD',
        link: { estimateId: 'est-1' },
      }),
    );
    expect(prisma.estimate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PENDING_APPROVAL' }),
      }),
    );
  });
});
