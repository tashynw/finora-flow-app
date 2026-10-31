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
  currency: 'JMD' as const,
  totalMinorUnits: 8_000n,
  description: 'Laptops for the team desk',
  closedAt: null,
  closedReason: null,
  openedAt: null,
  submittedAt: null,
  departmentId: 'dept-1',
  costCentreId: 'cc-1',
  costCentre: { id: 'cc-1', code: 'CC', name: 'Ops' },
  glAccount: null,
  department: { id: 'dept-1', name: 'Operations' },
  vendor: { id: 'vendor-1', code: 'V1', name: 'Acme' },
  estimate: null,
  raisedBy: { id: user.id, name: user.name },
  closedBy: null,
  approvalRequests: [],
  version: 1,
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
    stateTransition: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const approvals = {
    submitForApproval: vi.fn(),
    loadMatrixRules: vi.fn().mockResolvedValue([
      {
        level: 'UNIT_HEAD',
        stepOrder: 1,
        minAmountMinorUnits: 1n,
        maxAmountMinorUnits: null,
        currency: 'JMD',
        departmentId: null,
        isParallel: false,
      },
    ]),
    standing: vi.fn().mockResolvedValue({ mayDecide: false, onBehalfOfId: null }),
    progressFromRequest: vi.fn().mockReturnValue([]),
  };
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

  it('returns the missing fields a new draft still has to fill in', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValue({
      ...order,
      vendorId: null,
      vendor: null,
      estimateId: null,
      estimate: null,
      description: '',
      totalMinorUnits: null,
      currency: null,
      costCentreId: null,
      costCentre: null,
    });

    const detail = await (await service()).getById('po-1', user);

    expect(detail.problems.map((problem) => problem.problem)).toEqual([
      'vendor_missing',
      'description_missing',
      'amount_missing',
      'cost_centre_missing',
    ]);
    expect(detail.blockers).toEqual([]);
    expect(detail.can_edit).toBe(true);
    expect(detail.transitions).toEqual([]);
    expect(detail.planned_route).toEqual([]);
    expect(detail.route).toBeNull();
    expect(detail.can_decide).toBe(false);
  });

  it('shows the planned route a draft would take when submitted', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValue({
      ...order,
      estimateId: null,
      estimate: null,
    });

    const detail = await (await service()).getById('po-1', user);

    expect(detail.needs_approval).toBe(true);
    expect(detail.planned_route).toEqual([
      {
        step_order: 1,
        level: 'unit_head',
        level_label: 'Unit Head',
      },
    ]);
    expect(detail.route_unavailable).toBeNull();
  });

  it('says an approved estimate covers the order with an empty planned route', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValue({
      ...order,
      estimate: {
        reference: 'EST-1',
        status: 'APPROVED',
        vendorId: 'vendor-1',
        currency: 'JMD',
        totalMinorUnits: 10_000n,
      },
    });

    const detail = await (await service()).getById('po-1', user);

    expect(detail.needs_approval).toBe(false);
    expect(detail.planned_route).toEqual([]);
    expect(detail.route_unavailable).toBeNull();
    expect(approvals.loadMatrixRules).not.toHaveBeenCalled();
  });

  it('exposes a live route and can_decide when the viewer may act', async () => {
    const openRequest = {
      id: 'req-1',
      status: 'OPEN',
      attempt: 1,
      currentStepOrder: 1,
      amountMinorUnits: 8_000n,
      currency: 'JMD',
      openedAt: new Date('2026-01-01'),
      closedAt: null,
      departmentId: 'dept-1',
      department: { name: 'Operations' },
      requesterId: user.id,
      steps: [
        {
          stepOrder: 1,
          level: 'UNIT_HEAD',
          status: 'WAITING',
          decidedAt: null,
          decidedByLabel: null,
          comment: null,
          onBehalfOf: null,
        },
      ],
    };
    const approver = { ...user, id: 'approver-1', name: 'Approver' };
    prisma.purchaseOrder.findFirst.mockResolvedValue({
      ...order,
      status: 'PENDING_APPROVAL',
      estimateId: null,
      estimate: null,
      raisedById: user.id,
      approvalRequests: [openRequest],
    });
    approvals.progressFromRequest.mockReturnValue([
      { stepOrder: 1, level: 'UNIT_HEAD', status: 'WAITING' },
    ]);
    approvals.standing.mockResolvedValue({
      mayDecide: true,
      onBehalfOfId: null,
    });

    const detail = await (await service()).getById('po-1', approver);

    expect(detail.route).not.toBeNull();
    expect(detail.route?.steps[0]?.is_mine_to_decide).toBe(true);
    expect(detail.can_decide).toBe(true);
  });

  it('commits immediately when an approved estimate already covers the order', async () => {
    prisma.purchaseOrder.findFirst.mockResolvedValue({
      ...order,
      estimate: {
        reference: 'EST-1',
        status: 'APPROVED',
        vendorId: 'vendor-1',
        currency: 'JMD',
        totalMinorUnits: 10_000n,
      },
    });
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
      estimate: null,
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
