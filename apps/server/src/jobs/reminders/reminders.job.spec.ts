import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalsEngineService } from '../../approvals/approvals-engine.service.js';
import { sendEmail } from '../../mail/email.js';
import { auditMock, compile, provideAudit, providePrisma } from '../../testing/fixtures.js';
import { RemindersJob } from './reminders.job.js';

vi.mock('../../mail/email.js', () => ({
  sendEmail: vi.fn().mockResolvedValue({}),
}));

const prisma = {
  invoice: { findMany: vi.fn(), findUnique: vi.fn() },
  estimate: { findMany: vi.fn(), findUnique: vi.fn() },
  user: { findMany: vi.fn() },
  reminderSchedule: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  approvalRequest: { findMany: vi.fn() },
  vendorCheckIn: { findMany: vi.fn() },
  paymentPackageLine: { findMany: vi.fn() },
  purchaseOrder: { findUnique: vi.fn() },
};
const audit = auditMock();

describe('RemindersJob', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function job() {
    return compile(RemindersJob, [
      providePrisma(prisma),
      provideAudit(audit),
      { provide: ApprovalsEngineService, useValue: { listReadyApprovers: vi.fn() } },
    ]);
  }

  it('sends a sign-off reminder and only then advances the schedule', async () => {
    const due = new Date('2026-10-12T14:00:00.000Z');
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: 'inv-1',
        reference: 'INV-1',
        updatedAt: new Date('2026-10-09T13:00:00.000Z'),
        departmentId: null,
        requester: { id: 'req-1', name: 'Ada', email: 'ada@finora.test', departmentId: null },
      },
    ]);
    prisma.reminderSchedule.findUnique.mockResolvedValue({
      id: 'sched-1',
      recordId: 'inv-1',
      sentCount: 0,
      nextDueAt: due,
      stoppedAt: null,
      stoppedReason: null,
    });
    prisma.reminderSchedule.findMany.mockResolvedValue([
      {
        id: 'sched-1',
        recordId: 'inv-1',
        sentCount: 0,
        nextDueAt: due,
        stoppedAt: null,
        stoppedReason: null,
      },
    ]);
    prisma.reminderSchedule.update.mockResolvedValue({});

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T15:00:00.000Z'));
    await (await job()).remindSignOff();
    vi.useRealTimers();

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ada@finora.test', subject: 'Sign-off still needed: invoice INV-1' }),
    );
    expect(prisma.reminderSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sched-1' },
        data: expect.objectContaining({ sentCount: { increment: 1 } }),
      }),
    );
  });

  it('leaves the schedule due when the email fails', async () => {
    const due = new Date('2026-10-12T14:00:00.000Z');
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: 'inv-1',
        reference: 'INV-1',
        updatedAt: new Date('2026-10-09T13:00:00.000Z'),
        departmentId: null,
        requester: { id: 'req-1', name: 'Ada', email: 'ada@finora.test', departmentId: null },
      },
    ]);
    prisma.reminderSchedule.findUnique.mockResolvedValue({
      id: 'sched-1',
      recordId: 'inv-1',
      sentCount: 0,
      nextDueAt: due,
      stoppedAt: null,
      stoppedReason: null,
    });
    prisma.reminderSchedule.findMany.mockResolvedValue([
      {
        id: 'sched-1',
        recordId: 'inv-1',
        sentCount: 0,
        nextDueAt: due,
        stoppedAt: null,
        stoppedReason: null,
      },
    ]);
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error('smtp down'));

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T15:00:00.000Z'));
    const result = await (await job()).remindSignOff();
    vi.useRealTimers();

    expect(result.sent).toBe(0);
    expect(prisma.reminderSchedule.update).not.toHaveBeenCalled();
  });

  it('emails finance about a mailbox draft that is still unreviewed', async () => {
    const due = new Date('2026-10-12T14:00:00.000Z');
    prisma.estimate.findMany.mockResolvedValue([
      { id: 'est-1', reference: 'EST-1', createdAt: new Date('2026-10-09T13:00:00.000Z') },
    ]);
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'fin-1', name: 'Fay', email: 'fay@finora.test', role: 'finance' },
      { id: 'aud-1', name: 'Aud', email: 'aud@finora.test', role: 'auditor' },
    ]);
    dueSchedule('sched-est', 'est-1', due);

    await atOfficeHours(async () => (await job()).remindUnreviewed());

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'fay@finora.test',
        subject: 'Please review estimate EST-1',
      }),
    );
    expect(sendEmail).not.toHaveBeenCalledWith(expect.objectContaining({ to: 'aud@finora.test' }));
  });

  it('stops a sign-off cycle once the invoice is no longer waiting', async () => {
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.reminderSchedule.findMany.mockResolvedValue([
      schedule('sched-old', 'inv-gone', new Date('2026-10-12T14:00:00.000Z')),
    ]);

    const result = await atOfficeHours(async () => (await job()).remindSignOff());

    expect(result).toMatchObject({ sent: 0, stopped: 1 });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(prisma.reminderSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stoppedReason: 'The record has moved on.',
          nextDueAt: null,
        }),
      }),
    );
  });

  it('holds a due reminder until the office opens', async () => {
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: 'inv-1',
        reference: 'INV-1',
        updatedAt: new Date('2026-10-09T13:00:00.000Z'),
        departmentId: null,
        requester: { id: 'req-1', name: 'Ada', email: 'ada@finora.test', departmentId: null },
      },
    ]);
    dueSchedule('sched-1', 'inv-1', new Date('2026-10-10T14:00:00.000Z'));

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T15:00:00.000Z'));
    const result = await (await job()).remindSignOff();
    vi.useRealTimers();

    expect(result.sent).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(prisma.reminderSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { nextDueAt: new Date('2026-10-12T13:00:00.000Z') },
      }),
    );
  });

  it('copies the unit head in once sign-off has been chased three times', async () => {
    const due = new Date('2026-10-12T14:00:00.000Z');
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: 'inv-1',
        reference: 'INV-1',
        updatedAt: new Date('2026-10-09T13:00:00.000Z'),
        departmentId: 'dept-1',
        requester: { id: 'req-1', name: 'Ada', email: 'ada@finora.test', departmentId: 'dept-1' },
      },
    ]);
    prisma.reminderSchedule.findUnique.mockResolvedValue(
      schedule('sched-1', 'inv-1', due, { sentCount: 2 }),
    );
    prisma.reminderSchedule.findMany.mockResolvedValue([
      schedule('sched-1', 'inv-1', due, { sentCount: 2 }),
    ]);
    prisma.user.findMany.mockResolvedValue([{ email: 'head@finora.test', name: 'Hedy' }]);

    await atOfficeHours(async () => (await job()).remindSignOff());

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'ada@finora.test' }));
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'head@finora.test' }));
    expect(prisma.reminderSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ escalationLevel: 1, sentCount: { increment: 1 } }),
      }),
    );
  });

  it('emails the ready approver and leaves the cycle due when nobody is assigned', async () => {
    const due = new Date('2026-10-12T14:00:00.000Z');
    const approvers = vi.fn().mockResolvedValueOnce([
      { email: 'maya@finora.test', name: 'Maya', level: 'MANAGER' },
    ]);
    prisma.approvalRequest.findMany.mockResolvedValue([
      {
        id: 'apr-1',
        recordType: 'ESTIMATE',
        recordId: 'est-1',
        requesterId: 'req-1',
        departmentId: 'dept-1',
        openedAt: new Date('2026-10-09T13:00:00.000Z'),
        currency: 'JMD',
        amountMinorUnits: 5000n,
        steps: [{ level: 'MANAGER', status: 'READY' }],
      },
    ]);
    prisma.estimate.findUnique.mockResolvedValue({ reference: 'EST-9' });
    dueSchedule('sched-apr', 'apr-1', due);

    const withApprovers = await compile(RemindersJob, [
      providePrisma(prisma),
      provideAudit(audit),
      { provide: ApprovalsEngineService, useValue: { listReadyApprovers: approvers } },
    ]);
    await atOfficeHours(() => withApprovers.remindApprovals());

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'maya@finora.test',
        subject: 'Approval still waiting: Estimate EST-9',
        text: expect.stringContaining('JMD 50.00'),
      }),
    );

    approvers.mockResolvedValueOnce([]);
    vi.mocked(sendEmail).mockClear();
    prisma.reminderSchedule.update.mockClear();
    dueSchedule('sched-apr', 'apr-1', due);
    await atOfficeHours(() => withApprovers.remindApprovals());
    expect(sendEmail).not.toHaveBeenCalled();
    expect(prisma.reminderSchedule.update).not.toHaveBeenCalled();
  });

  it('asks finance to build a payment package for an approved invoice', async () => {
    const due = new Date('2026-10-12T14:00:00.000Z');
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: 'inv-1',
        reference: 'INV-4',
        updatedAt: new Date('2026-10-09T13:00:00.000Z'),
        currency: 'USD',
        totalMinorUnits: 2500n,
      },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'pay-1', name: 'Pat', email: 'pat@finora.test', role: 'payment_coordinator' },
    ]);
    dueSchedule('sched-pay', 'inv-1', due);

    await atOfficeHours(async () => (await job()).remindPaymentPackages());

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'pat@finora.test',
        subject: 'Payment package needed: invoice INV-4',
        text: expect.stringContaining('USD 25.00'),
      }),
    );
  });

  it('follows up with the vendor and stops after the third chase', async () => {
    const due = new Date('2026-10-13T14:00:00.000Z');
    prisma.vendorCheckIn.findMany.mockResolvedValue([
      {
        id: 'chk-1',
        reference: 'VCI-1',
        correlationTag: 'tag-99',
        packageId: 'pkg-1',
        vendorId: 'vendor-1',
        sentAt: new Date('2026-10-08T14:00:00.000Z'),
        vendor: { name: 'Acme', email: 'ap@acme.test' },
        package: { reference: 'PAY-1', id: 'pkg-1' },
      },
    ]);
    prisma.paymentPackageLine.findMany.mockResolvedValue([
      { invoiceNumber: '100', invoiceReference: 'INV-1', currency: 'JMD', amountMinorUnits: 2500n },
    ]);
    dueSchedule('sched-v', 'chk-1', due, { sentCount: 2 });

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T15:00:00.000Z'));
    await (await job()).remindVendorCheckIns();
    vi.useRealTimers();

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ap@acme.test',
        subject: 'Did this payment reach you? PAY-1 [tag-99]',
        text: expect.stringContaining('/payment-check-in/tag-99'),
      }),
    );
    expect(prisma.reminderSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stoppedReason: 'This has been chased the maximum number of times.',
        }),
      }),
    );
  });

  it('opens a schedule for a new draft and does not email before it is due', async () => {
    prisma.estimate.findMany.mockResolvedValue([
      { id: 'est-new', reference: 'EST-NEW', createdAt: new Date('2026-10-12T15:00:00.000Z') },
    ]);
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'fin-1', name: 'Fay', email: 'fay@finora.test', role: 'finance' },
    ]);
    prisma.reminderSchedule.findUnique.mockResolvedValue(null);
    prisma.reminderSchedule.findMany.mockResolvedValue([]);

    await atOfficeHours(async () => (await job()).remindUnreviewed());

    expect(prisma.reminderSchedule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recordType: 'estimate',
          recordId: 'est-new',
          purpose: 'unreviewed',
        }),
      }),
    );
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('restarts a cycle that was stopped because the record had moved on', async () => {
    const due = new Date('2026-10-12T14:00:00.000Z');
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: 'inv-1',
        reference: 'INV-1',
        updatedAt: new Date('2026-10-12T13:00:00.000Z'),
        departmentId: null,
        requester: { id: 'req-1', name: 'Ada', email: 'ada@finora.test', departmentId: null },
      },
    ]);
    prisma.reminderSchedule.findUnique.mockResolvedValue({
      id: 'sched-1',
      recordId: 'inv-1',
      recipientId: 'req-1',
      sentCount: 4,
      nextDueAt: null,
      stoppedAt: new Date('2026-10-11T15:00:00.000Z'),
      stoppedReason: 'The record has moved on.',
    });
    prisma.reminderSchedule.findMany.mockResolvedValue([]);

    await atOfficeHours(async () => (await job()).remindSignOff());

    expect(prisma.reminderSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stoppedAt: null,
          sentCount: 0,
          stoppedReason: null,
        }),
      }),
    );
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

function schedule(
  id: string,
  recordId: string,
  due: Date,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    recordId,
    sentCount: 0,
    nextDueAt: due,
    stoppedAt: null,
    stoppedReason: null,
    ...overrides,
  };
}

function dueSchedule(
  id: string,
  recordId: string,
  due: Date,
  overrides: Record<string, unknown> = {},
) {
  const row = schedule(id, recordId, due, overrides);
  prisma.reminderSchedule.findUnique.mockResolvedValue(row);
  prisma.reminderSchedule.findMany.mockResolvedValue([row]);
  prisma.reminderSchedule.update.mockResolvedValue({});
}

async function atOfficeHours<T>(work: () => Promise<T>) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-12T15:00:00.000Z'));
  try {
    return await work();
  } finally {
    vi.useRealTimers();
  }
}
