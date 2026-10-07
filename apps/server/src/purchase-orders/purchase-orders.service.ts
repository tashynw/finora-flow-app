import { Injectable } from '@nestjs/common';
import type {
  Prisma,
  PurchaseOrder,
  PurchaseOrderStatus,
  User,
} from '../generated/prisma/index.js';
import { AuditService } from '../common/audit.service.js';
import { DomainException, notFound } from '../common/errors.js';
import { nextReference } from '../common/ids.js';
import { resolvePage } from '../common/pagination.js';
import { serialize, toBigInt } from '../common/serialize.js';
import { toWorkflowState } from '../common/workflow-state.js';
import { TransitionsService } from '../common/transitions.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { approvalLevelFromApi } from '../approvals/approval-levels.js';
import { ApprovalsEngineService } from '../approvals/approvals-engine.service.js';
import { RECORD_TYPES } from '../approvals/record-types.js';

const RECORD_TYPE = RECORD_TYPES.purchaseOrder;

const TRANSITIONS: Record<PurchaseOrderStatus, readonly PurchaseOrderStatus[]> =
  {
    DRAFT: ['PENDING_APPROVAL', 'CANCELLED'],
    PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'DRAFT', 'CANCELLED'],
    APPROVED: [],
    REJECTED: ['DRAFT', 'CANCELLED'],
    CANCELLED: [],
  };

const detailInclude = {
  vendor: true,
  costCentre: true,
  glAccount: true,
  department: true,
  estimate: true,
  raisedBy: { select: { id: true, name: true } },
  approvalRequests: {
    orderBy: { attempt: 'asc' as const },
    include: { steps: true },
  },
} satisfies Prisma.PurchaseOrderInclude;

@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transitions: TransitionsService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsEngineService,
  ) {}

  async referenceData() {
    const [vendors, costCentres, glAccounts, estimates] = await Promise.all([
      this.prisma.vendor.findMany({
        where: { isActive: true, archivedAt: null },
        orderBy: { name: 'asc' },
      }),
      this.prisma.costCentre.findMany({
        where: { isActive: true, archivedAt: null },
        orderBy: { code: 'asc' },
      }),
      this.prisma.glAccount.findMany({
        where: { isActive: true, archivedAt: null },
        orderBy: { code: 'asc' },
      }),
      this.prisma.estimate.findMany({
        where: { status: 'APPROVED', archivedAt: null },
        include: { vendor: true },
        orderBy: { reference: 'desc' },
        take: 200,
      }),
    ]);

    return serialize({
      vendors: vendors.map((v) => ({ id: v.id, code: v.code, name: v.name })),
      cost_centres: costCentres.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
      })),
      gl_accounts: glAccounts.map((g) => ({
        id: g.id,
        code: g.code,
        name: g.name,
      })),
      approved_estimates: estimates.map((e) => ({
        id: e.id,
        reference: e.reference,
        vendor_name: e.vendor?.name ?? '',
        total_minor_units:
          e.totalMinorUnits != null ? Number(e.totalMinorUnits) : null,
        currency: e.currency,
      })),
    });
  }

  async list(
    user: User,
    query: {
      status?: string[];
      search?: string;
      mine?: boolean;
      limit?: number;
      offset?: number;
    },
  ) {
    const page = resolvePage(query);
    const where: Prisma.PurchaseOrderWhereInput = { archivedAt: null };
    if (query.status?.length) {
      where.status = {
        in: query.status.map((s) => s.toUpperCase() as PurchaseOrderStatus),
      };
    }
    if (query.mine) where.raisedById = user.id;
    if (query.search?.trim()) {
      const term = query.search.trim();
      where.OR = [
        { number: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where,
        include: { vendor: true, raisedBy: true },
        orderBy: { createdAt: 'desc' },
        take: page.take,
        skip: page.skip,
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);

    return serialize({
      items: items.map((row) => ({
        id: row.id,
        number: row.number,
        state: toWorkflowState(row.status),
        vendor_name: row.vendor?.name ?? '',
        description: row.description,
        total_minor_units:
          row.totalMinorUnits != null ? Number(row.totalMinorUnits) : null,
        currency: row.currency,
        closed_at: row.closedAt?.toISOString() ?? null,
        raised_by_label: row.raisedBy.name,
        created_at: row.createdAt.toISOString(),
      })),
      total,
      limit: page.limit ?? page.take,
      offset: page.offset ?? page.skip,
    });
  }

  async getById(id: string) {
    const order = await this.prisma.purchaseOrder.findFirst({
      where: { id, archivedAt: null },
      include: detailInclude,
    });
    if (!order) throw notFound('Purchase order', id);
    return serialize({
      id: order.id,
      number: order.number,
      state: toWorkflowState(order.status),
      vendor_id: order.vendorId,
      estimate_id: order.estimateId,
      description: order.description,
      total_minor_units:
        order.totalMinorUnits != null ? Number(order.totalMinorUnits) : null,
      currency: order.currency,
      cost_centre: ref(order.costCentre),
      gl_account: ref(order.glAccount),
      closed_at: order.closedAt?.toISOString() ?? null,
      closed_reason: order.closedReason,
      opened_at: order.openedAt?.toISOString() ?? null,
      actions: {
        may_edit: order.status === 'DRAFT' || order.status === 'REJECTED',
        may_submit: order.status === 'DRAFT' || order.status === 'REJECTED',
        may_withdraw: order.status === 'PENDING_APPROVAL',
        may_cancel:
          order.status === 'DRAFT' ||
          order.status === 'PENDING_APPROVAL' ||
          order.status === 'REJECTED',
        may_close: order.status === 'APPROVED' && order.closedAt == null,
        may_amend: order.status === 'APPROVED' && order.closedAt == null,
      },
    });
  }

  async create(user: User, body: { estimateId?: string | null }) {
    const order = await this.prisma.purchaseOrder.create({
      data: {
        number: nextReference('PO'),
        status: 'DRAFT',
        raisedById: user.id,
        estimateId: body.estimateId ?? null,
      },
      include: detailInclude,
    });
    await this.audit.append({
      action: 'purchase_order.created',
      actorId: user.id,
      actorLabel: user.name,
      subjectType: RECORD_TYPE,
      subjectId: order.id,
      detail: { number: order.number },
    });
    return this.getById(order.id);
  }

  async updateDraft(id: string, user: User, body: Record<string, unknown>) {
    const order = await this.requireOrder(id);
    if (order.status !== 'DRAFT' && order.status !== 'REJECTED') {
      throw new DomainException('Only draft or rejected orders can be edited');
    }
    await this.prisma.purchaseOrder.update({
      where: { id },
      data: {
        vendorId: (body.vendorId ?? body.vendor_id) as string | null | undefined,
        description: (body.description as string | undefined)?.slice(0, 500),
        totalMinorUnits: toBigInt(
          (body.totalMinorUnits ?? body.total_minor_units) as
            | string
            | number
            | null
            | undefined,
        ),
        currency: body.currency as never,
        costCentreId: (body.costCentreId ?? body.cost_centre_id) as
          | string
          | null
          | undefined,
        glAccountId: (body.glAccountId ?? body.gl_account_id) as
          | string
          | null
          | undefined,
        estimateId: (body.estimateId ?? body.estimate_id) as
          | string
          | null
          | undefined,
      },
    });
    void user;
    return this.getById(id);
  }

  async submit(id: string, user: User) {
    const order = await this.requireOrder(id);
    if (order.status !== 'DRAFT' && order.status !== 'REJECTED') {
      throw new DomainException('This order cannot be submitted');
    }
    this.assertReady(order);
    const correlationId = crypto.randomUUID();
    const departmentId = user.departmentId;

    await this.prisma.purchaseOrder.update({
      where: { id },
      data: {
        submittedAt: new Date(),
        submittedById: user.id,
        departmentId,
      },
    });

    const needsApproval = !(await this.coveredByApprovedEstimate(order));
    if (needsApproval) {
      await this.approvals.submitForApproval({
        recordType: RECORD_TYPE,
        recordId: id,
        amountMinorUnits: order.totalMinorUnits!,
        currency: order.currency!,
        departmentId,
        requesterId: order.raisedById,
        actor: { userId: user.id, displayName: user.name },
        correlationId,
        link: { purchaseOrderId: id },
      });
      await this.moveStatus(order, 'PENDING_APPROVAL', user, null, correlationId);
    } else {
      await this.moveStatus(order, 'PENDING_APPROVAL', user, null, correlationId);
      const pending = { ...order, status: 'PENDING_APPROVAL' as const };
      await this.moveStatus(
        pending,
        'APPROVED',
        user,
        'Committed against approved estimate',
        correlationId,
      );
      await this.prisma.purchaseOrder.update({
        where: { id },
        data: { openedAt: new Date() },
      });
    }
    return this.getById(id);
  }

  async withdraw(id: string, user: User, reason: string) {
    const order = await this.requireOrder(id);
    if (order.status !== 'PENDING_APPROVAL') {
      throw new DomainException('Only pending orders can be withdrawn');
    }
    if (!reason?.trim()) throw new DomainException('Give a reason');
    const correlationId = crypto.randomUUID();
    await this.approvals.withdrawOpenRequest(
      RECORD_TYPE,
      id,
      { userId: user.id, displayName: user.name },
      reason.trim(),
      correlationId,
    );
    await this.moveStatus(order, 'DRAFT', user, reason.trim(), correlationId);
    await this.prisma.purchaseOrder.update({
      where: { id },
      data: { submittedAt: null, submittedById: null },
    });
    return this.getById(id);
  }

  async amend(
    id: string,
    user: User,
    body: { totalMinorUnits: string | number; reason: string },
  ) {
    const order = await this.requireOrder(id);
    if (order.status !== 'APPROVED' || order.closedAt != null) {
      throw new DomainException('Only open approved orders can be amended');
    }
    const newTotal = toBigInt(body.totalMinorUnits);
    if (newTotal == null) throw new DomainException('Amount required');
    if (!body.reason?.trim()) throw new DomainException('Give a reason');

    const oldTotal = order.totalMinorUnits ?? 0n;
    await this.prisma.purchaseOrder.update({
      where: { id },
      data: { totalMinorUnits: newTotal },
    });

    if (newTotal > oldTotal) {
      const correlationId = crypto.randomUUID();
      await this.approvals.submitForApproval({
        recordType: RECORD_TYPE,
        recordId: id,
        amountMinorUnits: newTotal,
        currency: order.currency!,
        departmentId: order.departmentId,
        requesterId: order.raisedById,
        actor: { userId: user.id, displayName: user.name },
        correlationId,
        link: { purchaseOrderId: id },
      });
      await this.moveStatus(
        { ...order, status: 'APPROVED' },
        'PENDING_APPROVAL',
        user,
        body.reason.trim(),
        correlationId,
      );
    }

    return this.getById(id);
  }

  async close(id: string, user: User, reason: string) {
    const order = await this.requireOrder(id);
    if (order.status !== 'APPROVED' || order.closedAt != null) {
      throw new DomainException('Only open approved orders can be closed');
    }
    if (!reason?.trim()) throw new DomainException('Give a reason');
    await this.prisma.purchaseOrder.update({
      where: { id },
      data: {
        closedAt: new Date(),
        closedById: user.id,
        closedReason: reason.trim(),
      },
    });
    return this.getById(id);
  }

  async cancel(id: string, user: User, reason: string) {
    const order = await this.requireOrder(id);
    if (!reason?.trim()) throw new DomainException('Give a reason');
    if (order.status === 'PENDING_APPROVAL') {
      await this.approvals.withdrawOpenRequest(
        RECORD_TYPE,
        id,
        { userId: user.id, displayName: user.name },
        `Cancelled: ${reason.trim()}`,
      );
    }
    await this.moveStatus(order, 'CANCELLED', user, reason.trim());
    return this.getById(id);
  }

  async decision(
    id: string,
    user: User,
    body: {
      stepOrder: number;
      level: string;
      outcome: 'approved' | 'rejected';
      comment?: string | null;
    },
  ) {
    const order = await this.requireOrder(id);
    if (order.status !== 'PENDING_APPROVAL') {
      throw new DomainException('Order is not pending approval');
    }
    const routeState = await this.approvals.recordDecision({
      recordType: RECORD_TYPE,
      recordId: id,
      stepOrder: body.stepOrder,
      level: approvalLevelFromApi(body.level),
      outcome: body.outcome,
      actor: user,
      comment: body.comment,
    });
    if (routeState === 'APPROVED') {
      await this.prisma.purchaseOrder.update({
        where: { id },
        data: { status: 'APPROVED', openedAt: new Date() },
      });
    } else if (routeState === 'REJECTED') {
      await this.prisma.purchaseOrder.update({
        where: { id },
        data: { status: 'REJECTED' },
      });
    }
    void user;
    return this.getById(id);
  }

  private async coveredByApprovedEstimate(order: PurchaseOrder) {
    if (!order.estimateId) return false;
    const estimate = await this.prisma.estimate.findUnique({
      where: { id: order.estimateId },
    });
    if (!estimate || estimate.status !== 'APPROVED') return false;
    if (estimate.vendorId !== order.vendorId) return false;
    if (estimate.currency !== order.currency) return false;
    if (
      estimate.totalMinorUnits != null &&
      order.totalMinorUnits != null &&
      order.totalMinorUnits > estimate.totalMinorUnits
    ) {
      return false;
    }
    return true;
  }

  private assertReady(order: PurchaseOrder) {
    if (!order.vendorId || !order.currency || order.totalMinorUnits == null) {
      throw new DomainException('Order is incomplete');
    }
    if (!order.description?.trim()) {
      throw new DomainException('Description is required');
    }
  }

  private async requireOrder(id: string) {
    const order = await this.prisma.purchaseOrder.findFirst({
      where: { id, archivedAt: null },
    });
    if (!order) throw notFound('Purchase order', id);
    return order;
  }

  private async moveStatus(
    order: PurchaseOrder,
    to: PurchaseOrderStatus,
    user: User,
    reason: string | null,
    correlationId?: string,
  ) {
    this.transitions.assertTransition(TRANSITIONS, order.status, to);
    await this.prisma.purchaseOrder.update({
      where: { id: order.id },
      data: { status: to },
    });
    await this.transitions.record({
      recordType: RECORD_TYPE,
      recordId: order.id,
      fromState: order.status,
      toState: to,
      actorId: user.id,
      actorLabel: user.name,
      reason,
      correlationId: correlationId ?? crypto.randomUUID(),
    });
  }
}

function ref(row: { id: string; code: string; name: string } | null) {
  if (!row) return null;
  return { id: row.id, code: row.code, name: row.name };
}
