import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainException } from '../common/errors.js';
import { InvoiceStatus, PaymentPackageStatus } from '../generated/prisma/index.js';
import { sendEmail } from '../mail/email.js';
import {
  auditMock,
  compile,
  provideAudit,
  providePrisma,
  provideTransitions,
  session,
} from '../testing/fixtures.js';
import { VendorCheckInsService } from './vendor-check-ins.service.js';

vi.mock('../mail/email.js', () => ({
  sendEmail: vi.fn().mockResolvedValue({}),
}));

describe('VendorCheckInsService', () => {
  const prisma = {
    paymentPackage: { findUnique: vi.fn(), update: vi.fn() },
    paymentPackageLine: { groupBy: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    vendorCheckIn: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    vendor: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    invoice: { findUnique: vi.fn(), update: vi.fn() },
  };
  const audit = auditMock();

  beforeEach(() => vi.clearAllMocks());

  async function service() {
    return compile(VendorCheckInsService, [
      providePrisma(prisma),
      provideAudit(audit),
      provideTransitions(),
    ]);
  }

  it('will not raise check-ins before the package has gone to the bank', async () => {
    prisma.paymentPackage.findUnique.mockResolvedValue({
      id: 'pkg-1',
      status: PaymentPackageStatus.OPEN,
      submittedAt: null,
    });

    await expect(
      (await service()).raiseForPackage(session, 'pkg-1'),
    ).rejects.toBeInstanceOf(DomainException);
    expect(prisma.vendorCheckIn.create).not.toHaveBeenCalled();
  });

  it('emails the vendor when the check-in is sent and only then marks it sent', async () => {
    prisma.vendorCheckIn.findUnique.mockResolvedValue({
      id: 'chk-1',
      reference: 'VCI-1',
      packageId: 'pkg-1',
      vendorId: 'vendor-1',
      correlationTag: 'token-1',
      sentAt: null,
      answeredAt: null,
      reviewedAt: null,
      package: { reference: 'PAY-1' },
      vendor: { name: 'Acme', email: 'ap@acme.test' },
    });
    prisma.paymentPackageLine.findMany.mockResolvedValue([
      {
        invoiceNumber: '100',
        invoiceReference: 'INV-1',
        currency: 'JMD',
        amountMinorUnits: 2500n,
      },
    ]);
    prisma.vendorCheckIn.update.mockResolvedValue({ id: 'chk-1', sentAt: new Date() });

    await (await service()).send(session, 'chk-1');

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ap@acme.test',
        text: expect.stringContaining('/payment-check-in/token-1'),
      }),
    );
    expect(prisma.vendorCheckIn.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sentAt: expect.any(Date) }),
      }),
    );
  });

  it('marks the package completed when the last invoice is paid', async () => {
    prisma.vendorCheckIn.findUnique.mockResolvedValue({
      id: 'chk-1',
      reference: 'VCI-1',
      packageId: 'pkg-1',
      vendorId: 'vendor-1',
      sentAt: new Date(),
      answeredAt: new Date(),
      reviewedAt: null,
      package: { id: 'pkg-1' },
      vendor: { name: 'Acme' },
    });
    prisma.paymentPackageLine.findMany.mockResolvedValue([
      { invoiceId: 'inv-1' },
    ]);
    prisma.vendorCheckIn.update.mockResolvedValue({});
    prisma.invoice.findUnique.mockResolvedValue({
      id: 'inv-1',
      status: InvoiceStatus.SUBMITTED,
    });
    prisma.invoice.update.mockResolvedValue({});
    prisma.paymentPackage.findUnique.mockResolvedValue({
      id: 'pkg-1',
      status: PaymentPackageStatus.SUBMITTED,
      reference: 'PAY-1',
    });
    prisma.paymentPackageLine.count.mockResolvedValue(0);
    prisma.paymentPackage.update.mockResolvedValue({});
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', role: 'finance' });

    await (await service()).review(session, 'chk-1', { outcome: 'paid' });

    expect(prisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: InvoiceStatus.PAID }),
      }),
    );
    expect(prisma.paymentPackage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PaymentPackageStatus.COMPLETED,
        }),
      }),
    );
  });

  it('lets staff write down an answer once, and not again', async () => {
    const waiting = answeredCheckIn();
    waiting.answeredAt = null;
    waiting.claim = null;
    const recorded = answeredCheckIn();
    const svc = await service();

    expect(
      svc.toDetail(waiting, { id: 'pay-1', role: 'payment_coordinator' })
        .can_record_answer,
    ).toBe(true);
    expect(
      svc.toDetail(recorded, { id: 'pay-1', role: 'payment_coordinator' })
        .can_record_answer,
    ).toBe(false);

    prisma.vendorCheckIn.findUnique.mockResolvedValue({
      id: 'chk-1',
      answeredAt: new Date(),
      reviewedAt: null,
    });
    await expect(
      svc.answer('chk-1', { claim: 'received', respondentName: 'Ada' }),
    ).rejects.toBeInstanceOf(DomainException);
    expect(prisma.vendorCheckIn.update).not.toHaveBeenCalled();
  });

  it('lets finance conclude and hides the action from a payment coordinator', async () => {
    const checkIn = answeredCheckIn();
    const svc = await service();

    expect(
      svc.toDetail(checkIn, { id: 'finance-1', role: 'finance' }).can_review,
    ).toBe(true);
    expect(
      svc.toDetail(checkIn, { id: 'pay-1', role: 'payment_coordinator' })
        .can_review,
    ).toBe(false);
  });

  it('refuses a payment coordinator who tries to conclude', async () => {
    prisma.vendorCheckIn.findUnique.mockResolvedValue({
      id: 'chk-1',
      sentAt: new Date(),
      answeredAt: new Date(),
      reviewedAt: null,
      package: { submittedById: 'someone-else' },
    });
    prisma.paymentPackageLine.findMany.mockResolvedValue([]);
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      role: 'payment_coordinator',
    });

    await expect(
      (await service()).review(session, 'chk-1', { outcome: 'paid' }),
    ).rejects.toBeInstanceOf(DomainException);
    expect(prisma.vendorCheckIn.update).not.toHaveBeenCalled();
  });

  it('refuses the person who sent the package even when they hold finance', async () => {
    prisma.vendorCheckIn.findUnique.mockResolvedValue({
      id: 'chk-1',
      sentAt: new Date(),
      answeredAt: new Date(),
      reviewedAt: null,
      package: { submittedById: 'user-1' },
    });
    prisma.paymentPackageLine.findMany.mockResolvedValue([]);
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', role: 'finance' });

    await expect(
      (await service()).review(session, 'chk-1', { outcome: 'outstanding' }),
    ).rejects.toBeInstanceOf(DomainException);
    expect(prisma.vendorCheckIn.update).not.toHaveBeenCalled();
  });
});

function answeredCheckIn() {
  return {
    id: 'chk-1',
    reference: 'VCI-1',
    version: 1,
    packageId: 'pkg-1',
    sentAt: new Date(),
    answeredAt: new Date(),
    reviewedAt: null,
    claim: 'received',
    claimChannel: null,
    respondentName: null,
    respondentNote: null,
    reviewOutcome: null,
    reviewNote: null,
    reviewedBy: null,
    package: {
      reference: 'PAY-1',
      submittedAt: new Date(),
      submissionReference: 'BANK-1',
      submittedById: 'coordinator-1',
    },
    vendor: { name: 'Acme', email: 'ap@acme.test' },
    lines: [],
  } as unknown as Parameters<VendorCheckInsService['toDetail']>[0];
}
