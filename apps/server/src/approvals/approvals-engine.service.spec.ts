import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendEmail } from '../mail/email.js';
import {
  auditMock,
  compile,
  provideAudit,
  providePrisma,
} from '../testing/fixtures.js';
import { ApprovalsEngineService } from './approvals-engine.service.js';

vi.mock('../mail/email.js', () => ({
  sendEmail: vi.fn().mockResolvedValue({}),
}));

describe('ApprovalsEngineService', () => {
  const prisma = {
    approvalRequest: {
      findFirst: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    approvalRule: { findMany: vi.fn() },
    approvalStep: { updateMany: vi.fn() },
    user: { findMany: vi.fn() },
    estimate: { findUnique: vi.fn() },
  };
  const audit = auditMock();

  beforeEach(() => vi.clearAllMocks());

  async function service() {
    return compile(ApprovalsEngineService, [
      providePrisma(prisma),
      provideAudit(audit),
    ]);
  }

  it('emails the first approver when a route is opened', async () => {
    prisma.approvalRequest.findFirst.mockResolvedValue(null);
    prisma.approvalRule.findMany.mockResolvedValue([
      {
        level: 'MANAGER',
        stepOrder: 1,
        minAmountMinorUnits: 0n,
        maxAmountMinorUnits: null,
        currency: 'JMD',
        departmentId: null,
        isParallel: false,
      },
    ]);
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'approver-1',
        email: 'mgr@finora.test',
        name: 'Grace',
        archivedAt: null,
        delegateTo: null,
        outOfOfficeUntil: null,
      },
    ]);
    prisma.approvalRequest.aggregate.mockResolvedValue({ _max: { attempt: 0 } });
    prisma.approvalRequest.create.mockResolvedValue({
      id: 'req-1',
      recordType: 'estimate',
      recordId: 'est-1',
      requesterId: 'user-1',
      departmentId: null,
      amountMinorUnits: 1000n,
      currency: 'JMD',
      steps: [{ stepOrder: 1, level: 'MANAGER', status: 'READY' }],
    });
    prisma.estimate.findUnique.mockResolvedValue({ reference: 'EST-1' });

    await (await service()).submitForApproval({
      recordType: 'estimate',
      recordId: 'est-1',
      amountMinorUnits: 1000n,
      currency: 'JMD',
      departmentId: null,
      requesterId: 'user-1',
      actor: { userId: 'user-1', displayName: 'Ada' },
      link: { estimateId: 'est-1' },
    });

    expect(prisma.approvalRequest.create.mock.calls[0][0].data.steps.create[0]).toEqual(
      expect.objectContaining({ status: 'READY', level: 'MANAGER' }),
    );
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'mgr@finora.test',
        subject: expect.stringContaining('EST-1'),
      }),
    );
  });

  it('does not email the requester to approve their own request', async () => {
    prisma.approvalRequest.findFirst.mockResolvedValue(null);
    prisma.approvalRule.findMany.mockResolvedValue([
      {
        level: 'MANAGER',
        stepOrder: 1,
        minAmountMinorUnits: 0n,
        maxAmountMinorUnits: null,
        currency: 'JMD',
        departmentId: null,
        isParallel: false,
      },
    ]);
    prisma.user.findMany.mockImplementation(async (args: { where?: { id?: { not?: string } } }) => {
      if (args?.where?.id?.not) return [];
      return [
        {
          id: 'user-1',
          email: 'ada@finora.test',
          name: 'Ada',
          archivedAt: null,
          delegateTo: null,
          outOfOfficeUntil: null,
        },
      ];
    });
    prisma.approvalRequest.aggregate.mockResolvedValue({ _max: { attempt: null } });
    prisma.approvalRequest.create.mockResolvedValue({
      id: 'req-1',
      recordType: 'estimate',
      recordId: 'est-1',
      requesterId: 'user-1',
      departmentId: null,
      amountMinorUnits: 1000n,
      currency: 'JMD',
      steps: [{ stepOrder: 1, level: 'MANAGER', status: 'READY' }],
    });
    prisma.estimate.findUnique.mockResolvedValue({ reference: 'EST-1' });

    await (await service()).submitForApproval({
      recordType: 'estimate',
      recordId: 'est-1',
      amountMinorUnits: 1000n,
      currency: 'JMD',
      departmentId: null,
      requesterId: 'user-1',
      actor: { userId: 'user-1', displayName: 'Ada' },
    });

    expect(sendEmail).not.toHaveBeenCalled();
  });
});
