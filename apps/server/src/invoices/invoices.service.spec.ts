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
  invoiceDate: null,
  dueDate: null,
  description: 'Paper',
  currency: 'JMD',
  totalMinorUnits: 5000n,
  archivedAt: null,
  submittedAt: null,
  decidedAt: null,
  signedOffAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  createdBy: { id: user.id, name: user.name },
  requester: { id: user.id, name: user.name },
  vendor: { id: 'vendor-1', name: 'Acme' },
  estimate: null,
  purchaseOrder: null,
  department: null,
  costCentre: null,
  glAccount: null,
  approvalRequests: [],
};

describe('InvoicesService', () => {
  const prisma = {
    invoice: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      groupBy: vi.fn(),
      aggregate: vi.fn().mockResolvedValue({ _sum: { totalMinorUnits: null } }),
    },
    s3Document: { findUnique: vi.fn() },
    vendor: { findFirst: vi.fn() },
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

  it('creates a blank draft without starting approval', async () => {
    prisma.invoice.create.mockResolvedValue(invoice);
    prisma.invoice.findFirst.mockResolvedValue(invoice);

    const result = await (await service()).create(user, {});

    expect(prisma.invoice.create.mock.calls[0][0].data.status).toBe('DRAFT');
    expect(prisma.invoice.create.mock.calls[0][0].data.documentId).toBeUndefined();
    expect(approvals.submitForApproval).not.toHaveBeenCalled();
    expect(result.state).toBe('draft');
  });

  it('copies accepted invoice reading values onto a new draft', async () => {
    prisma.s3Document.findUnique.mockResolvedValue({
      id: 'doc-1',
      extractions: [
        {
          status: 'accepted',
          kind: 'invoice',
          labelText: 'vendor_name',
          valueText: 'Acme Supplies',
        },
        {
          status: 'accepted',
          kind: 'invoice',
          labelText: 'document_number',
          valueText: 'INV-99',
        },
        {
          status: 'accepted',
          kind: 'invoice',
          labelText: 'document_date',
          valueText: '2026-06-15',
        },
        {
          status: 'accepted',
          kind: 'invoice',
          labelText: 'currency',
          valueText: 'JMD',
        },
        {
          status: 'accepted',
          kind: 'invoice',
          labelText: 'total',
          valueText: 'JMD 125.50',
        },
      ],
    });
    prisma.invoice.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...invoice,
        documentId: 'doc-1',
        invoiceNumber: 'INV-99',
        totalMinorUnits: 12550n,
      });
    prisma.vendor.findFirst.mockResolvedValue({ id: 'vendor-1', name: 'Acme Supplies' });
    prisma.invoice.create.mockResolvedValue({
      ...invoice,
      documentId: 'doc-1',
      invoiceNumber: 'INV-99',
      totalMinorUnits: 12550n,
    });

    const result = await (await service()).create(user, { documentId: 'doc-1' });

    expect(prisma.invoice.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DRAFT',
          documentId: 'doc-1',
          vendorId: 'vendor-1',
          invoiceNumber: 'INV-99',
          totalMinorUnits: 12550n,
          currency: 'JMD',
        }),
      }),
    );
    expect(result.document_id).toBe('doc-1');
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
