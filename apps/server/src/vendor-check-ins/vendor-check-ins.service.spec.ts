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
});
