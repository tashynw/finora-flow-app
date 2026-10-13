import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalsEngineService } from '../approvals/approvals-engine.service.js';
import { LinksService } from '../links/links.service.js';
import { DomainException } from '../common/errors.js';
import {
  auditMock,
  compile,
  provideAudit,
  providePrisma,
  provideTransitions,
  session,
  transitionsMock,
  user,
} from '../testing/fixtures.js';
import { InvoicesService } from './invoices.service.js';

const invoice = {
  id: 'inv-1',
  reference: 'INV-1',
  status: 'DRAFT',
  createdById: user.id,
  requesterId: user.id,
  vendorId: 'vendor-1',
  purchaseOrderId: null,
  estimateId: null,
  documentId: null,
  invoiceNumber: null,
  description: 'Paper',
  currency: 'JMD',
  totalMinorUnits: 5000n,
  archivedAt: null,
};

describe('InvoicesService', () => {
  const prisma = {
    invoice: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      groupBy: vi.fn(),
    },
    estimate: { findMany: vi.fn() },
    purchaseOrder: { findMany: vi.fn(), update: vi.fn() },
    user: { findMany: vi.fn() },
  };
  const approvals = { submitForApproval: vi.fn(), recordDecision: vi.fn() };
  const audit = auditMock();

  beforeEach(() => vi.clearAllMocks());

  async function service() {
    return compile(InvoicesService, [
      providePrisma(prisma),
      provideTransitions(transitionsMock()),
      provideAudit(audit),
      { provide: ApprovalsEngineService, useValue: approvals },
      { provide: LinksService, useValue: { issue: vi.fn(), resolve: vi.fn() } },
    ]);
  }

  it('creates a draft without starting approval', async () => {
    prisma.invoice.create.mockResolvedValue({ ...invoice, documentId: 'doc-1' });
    prisma.invoice.findFirst.mockResolvedValue({ ...invoice, documentId: 'doc-1' });

    const result = await (await service()).create(user, { documentId: 'doc-1' });

    expect(prisma.invoice.create.mock.calls[0][0].data.status).toBe('DRAFT');
    expect(approvals.submitForApproval).not.toHaveBeenCalled();
    expect(result.state).toBe('draft');
  });

  it('links a purchase order on the draft and leaves the order untouched', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      ...invoice,
      purchaseOrderId: 'po-1',
    });
    prisma.invoice.update.mockResolvedValue({
      ...invoice,
      purchaseOrderId: 'po-1',
    });

    const result = await (await service()).updateDraft('inv-1', user, {
      purchase_order_id: 'po-1',
    });

    expect(prisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ purchaseOrderId: 'po-1' }),
      }),
    );
    expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
    expect(result.purchase_order_id).toBe('po-1');
  });

  it('starts approval only when the named requester signs off', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      ...invoice,
      status: 'PENDING_SIGN_OFF',
    });
    prisma.invoice.update.mockResolvedValue(invoice);

    await expect(
      (await service()).signOff('inv-1', { ...user, id: 'someone-else' }, {}),
    ).rejects.toBeInstanceOf(DomainException);

    await (await service()).signOff('inv-1', user, { note: 'Received' });

    expect(approvals.submitForApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        recordType: 'invoice',
        recordId: 'inv-1',
        link: { invoiceId: 'inv-1' },
      }),
    );
    expect(prisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PENDING_APPROVAL' }),
      }),
    );
    void session;
  });
});
