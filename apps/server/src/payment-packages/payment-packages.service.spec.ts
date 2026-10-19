import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvoiceStatus, PaymentPackageStatus } from '../generated/prisma/index.js';
import {
  auditMock,
  compile,
  provideAudit,
  providePrisma,
  provideTransitions,
  session,
  transitionsMock,
} from '../testing/fixtures.js';
import { PaymentPackagesService } from './payment-packages.service.js';

describe('PaymentPackagesService', () => {
  const prisma = {
    invoice: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    paymentPackage: { findUnique: vi.fn(), create: vi.fn() },
    paymentPackageLine: { create: vi.fn() },
  };
  const audit = auditMock();
  const transitions = transitionsMock();

  beforeEach(() => vi.clearAllMocks());

  async function service() {
    return compile(PaymentPackagesService, [
      providePrisma(prisma),
      provideAudit(audit),
      provideTransitions(transitions),
    ]);
  }

  it('offers only approved invoices that are not already on a package', async () => {
    prisma.invoice.findMany.mockResolvedValue([]);
    await (await service()).eligibleInvoices();

    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: InvoiceStatus.APPROVED,
          paymentPackageLine: { is: null },
        }),
      }),
    );
  });

  it('moves an approved invoice to ready for submission when it is added', async () => {
    prisma.paymentPackage.findUnique.mockResolvedValue({
      id: 'pkg-1',
      reference: 'PAY-1',
      status: PaymentPackageStatus.OPEN,
      lines: [],
    });
    prisma.invoice.findUnique.mockResolvedValue({
      id: 'inv-1',
      reference: 'INV-1',
      status: InvoiceStatus.APPROVED,
      archivedAt: null,
      paymentPackageLine: null,
      totalMinorUnits: 1000n,
      currency: 'JMD',
      vendorId: 'vendor-1',
      invoiceNumber: '100',
      dueDate: null,
    });
    prisma.paymentPackageLine.create.mockResolvedValue({ id: 'line-1' });
    prisma.invoice.update.mockResolvedValue({});

    const result = await (await service()).addLines(session, 'pkg-1', ['inv-1']);

    expect(result.added).toHaveLength(1);
    expect(result.refused).toHaveLength(0);
    expect(prisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: InvoiceStatus.READY_FOR_SUBMISSION,
        }),
      }),
    );
  });

  it('refuses an invoice that is not approved', async () => {
    prisma.paymentPackage.findUnique.mockResolvedValue({
      id: 'pkg-1',
      reference: 'PAY-1',
      status: PaymentPackageStatus.OPEN,
      lines: [],
    });
    prisma.invoice.findUnique.mockResolvedValue({
      id: 'inv-1',
      reference: 'INV-1',
      status: InvoiceStatus.DRAFT,
      archivedAt: null,
      paymentPackageLine: null,
    });

    const result = await (await service()).addLines(session, 'pkg-1', ['inv-1']);

    expect(result.added).toHaveLength(0);
    expect(result.refused[0].reason).toMatch(/approved/i);
  });
});
