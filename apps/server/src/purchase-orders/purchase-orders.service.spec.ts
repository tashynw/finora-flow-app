import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalsEngineService } from '../approvals/approvals-engine.service.js';
import {
  auditMock,
  compile,
  provideAudit,
  providePrisma,
  provideTransitions,
  transitionsMock,
  user,
} from '../testing/fixtures.js';
import { PurchaseOrdersService } from './purchase-orders.service.js';

const order = {
  id: 'po-1',
  number: 'PO-1',
  status: 'DRAFT',
  raisedById: user.id,
  vendorId: 'vendor-1',
  estimateId: 'est-1',
  currency: 'JMD',
  totalMinorUnits: 8_000n,
  description: 'Laptops',
  closedAt: null,
  closedReason: null,
  openedAt: null,
  costCentre: null,
  glAccount: null,
  archivedAt: null,
};

describe('PurchaseOrdersService', () => {
  const prisma = {
    purchaseOrder: {
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    estimate: { findUnique: vi.fn() },
  };
  const approvals = { submitForApproval: vi.fn() };
  const transitions = transitionsMock();

  beforeEach(() => vi.clearAllMocks());

  async function service() {
    return compile(PurchaseOrdersService, [
      providePrisma(prisma),
      provideTransitions(transitions),
      provideAudit(auditMock()),
      { provide: ApprovalsEngineService, useValue: approvals },
    ]);
  }

  it('commits immediately when an approved estimate already covers the order', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValue(order);
    prisma.purchaseOrder.update.mockResolvedValue(order);
    prisma.estimate.findUnique.mockResolvedValue({
      id: 'est-1',
      status: 'APPROVED',
      vendorId: 'vendor-1',
      currency: 'JMD',
      totalMinorUnits: 10_000n,
    });

    await (await service()).submit('po-1', user);

    expect(approvals.submitForApproval).not.toHaveBeenCalled();
    expect(prisma.purchaseOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'APPROVED' }),
      }),
    );
  });

  it('opens an approval route when the order is not covered', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValue({
      ...order,
      estimateId: null,
    });
    prisma.purchaseOrder.update.mockResolvedValue(order);

    await (await service()).submit('po-1', user);

    expect(approvals.submitForApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        recordType: 'purchase_order',
        recordId: 'po-1',
        link: { purchaseOrderId: 'po-1' },
      }),
    );
  });
});
