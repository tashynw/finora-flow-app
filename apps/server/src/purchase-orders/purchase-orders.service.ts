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
  closedBy: { select: { id: true, name: true } },
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
      openOnly?: boolean;
      limit?: number;
      offset?: number;
    },
  ) {
    const page = resolvePage(query);
    const where: Prisma.PurchaseOrderWhereInput = { archivedAt: null };
    if (query.openOnly) {
      where.status = 'APPROVED';
      where.closedAt = null;
    }
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
      rows: items.map((row) => toSummary(row)),
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
    const transitions = await this.prisma.stateTransition.findMany({
      where: { recordType: RECORD_TYPE, recordId: id },
      orderBy: { occurredAt: 'asc' },
    });
    return serialize(toDetail(order, transitions));
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

function ref(row: { id: string; code: string; name: string } | null | undefined) {
  if (!row) return null;
  return { id: row.id, code: row.code, name: row.name };
}

const STATE_LABELS: Record<string, string> = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

const MIN_DESCRIPTION_LENGTH = 10;

const PROBLEM_EXPLANATIONS: Record<string, string> = {
  vendor_missing:
    'Name the supplier this order goes to. An order is an instruction to a particular company, and payment only ever goes to a recorded one.',
  description_missing:
    'Say what is being ordered, in a line the approver can judge without opening anything else.',
  amount_missing: 'Enter the value being committed, and its currency.',
  amount_not_positive: 'The value must be more than zero. An order for nothing commits nothing.',
  cost_centre_missing:
    'Choose the cost centre this commitment belongs to. It decides who has to approve it.',
  below_what_is_billed:
    'Suppliers have already invoiced more against this order than the new figure. The commitment cannot shrink below what has already been billed.',
  estimate_not_approved: 'The estimate this order draws on is not approved.',
  estimate_vendor_mismatch:
    'This order names a different supplier from the estimate it draws on.',
  estimate_currency_mismatch:
    'This order is in a different currency from the estimate it draws on.',
  exceeds_estimate:
    'This order commits more than the approved estimate covers.',
};

const PROBLEM_FIELDS: Record<string, string> = {
  vendor_missing: 'vendor_id',
  description_missing: 'description',
  amount_missing: 'total',
  amount_not_positive: 'total',
  cost_centre_missing: 'cost_centre_id',
  below_what_is_billed: 'total',
  estimate_not_approved: 'estimate_id',
  estimate_vendor_mismatch: 'estimate_id',
  estimate_currency_mismatch: 'estimate_id',
  exceeds_estimate: 'total',
};

const BLOCKING = new Set([
  'below_what_is_billed',
  'estimate_not_approved',
  'estimate_vendor_mismatch',
  'estimate_currency_mismatch',
  'exceeds_estimate',
]);

function orderStateLabel(status: string, closedAt: Date | null) {
  const state = toWorkflowState(status);
  if (state === 'approved') return closedAt ? 'Closed' : 'Open';
  return STATE_LABELS[state] ?? state;
}

function formatOrderMoney(minor: bigint | number | null | undefined, currency: string | null) {
  if (minor == null || !currency) return null;
  const major = Number(minor) / 100;
  return `${currency} ${major.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function toSummary(row: {
  id: string;
  number: string;
  status: string;
  description: string | null;
  totalMinorUnits: bigint | null;
  currency: string | null;
  closedAt: Date | null;
  createdAt: Date;
  vendor?: { name: string } | null;
  raisedBy?: { name: string } | null;
}) {
  const state = toWorkflowState(row.status);
  const total =
    row.totalMinorUnits != null ? Number(row.totalMinorUnits) : null;
  return {
    id: row.id,
    number: row.number,
    state,
    state_label: orderStateLabel(row.status, row.closedAt),
    is_open: state === 'approved' && row.closedAt == null,
    vendor_name: row.vendor?.name ?? null,
    description: row.description ?? '',
    total_minor_units: total,
    currency: row.currency,
    total_formatted: formatOrderMoney(row.totalMinorUnits, row.currency),
    billed_formatted: null,
    remaining_minor_units: total,
    remaining_formatted: formatOrderMoney(row.totalMinorUnits, row.currency),
    department: null,
    raised_by_label: row.raisedBy?.name ?? '',
    created_at: row.createdAt.toISOString(),
    awaiting: [] as string[],
    is_awaiting_me: false,
    blocker_count: 0,
  };
}

function orderProblems(order: {
  vendorId: string | null;
  description: string | null;
  totalMinorUnits: bigint | null;
  currency: string | null;
  costCentreId?: string | null;
  costCentre?: { id: string } | null;
  estimateId: string | null;
  estimate?: {
    status: string;
    vendorId: string | null;
    currency: string | null;
    totalMinorUnits: bigint | null;
  } | null;
}) {
  const found: string[] = [];
  if (!order.vendorId) found.push('vendor_missing');
  if ((order.description ?? '').trim().length < MIN_DESCRIPTION_LENGTH) {
    found.push('description_missing');
  }
  if (order.totalMinorUnits == null || !order.currency) found.push('amount_missing');
  else if (order.totalMinorUnits <= 0n) found.push('amount_not_positive');
  if (!order.costCentre && !order.costCentreId) found.push('cost_centre_missing');

  const estimate = order.estimate;
  if (order.estimateId && estimate) {
    if (estimate.status !== 'APPROVED') found.push('estimate_not_approved');
    if (
      estimate.vendorId &&
      order.vendorId &&
      estimate.vendorId !== order.vendorId
    ) {
      found.push('estimate_vendor_mismatch');
    }
    if (
      estimate.currency &&
      order.currency &&
      estimate.totalMinorUnits != null &&
      order.totalMinorUnits != null
    ) {
      if (estimate.currency !== order.currency) found.push('estimate_currency_mismatch');
      else if (order.totalMinorUnits > estimate.totalMinorUnits) {
        found.push('exceeds_estimate');
      }
    }
  }
  return found.map((problem) => ({
    problem,
    field: PROBLEM_FIELDS[problem] ?? problem,
    explanation: PROBLEM_EXPLANATIONS[problem] ?? problem,
    is_blocking: BLOCKING.has(problem),
  }));
}

function toDetail(
  order: {
    id: string;
    number: string;
    status: string;
    version?: number;
    vendorId: string | null;
    vendor?: { id: string; code: string; name: string } | null;
    estimateId: string | null;
    estimate?: {
      reference: string;
      status: string;
      vendorId: string | null;
      currency: string | null;
      totalMinorUnits: bigint | null;
    } | null;
    description: string | null;
    totalMinorUnits: bigint | null;
    currency: string | null;
    costCentreId?: string | null;
    costCentre?: { id: string; code: string; name: string } | null;
    glAccount?: { id: string; code: string; name: string } | null;
    department?: { name: string } | null;
    closedAt: Date | null;
    closedReason: string | null;
    closedBy?: { name: string } | null;
    openedAt: Date | null;
    submittedAt?: Date | null;
    raisedBy?: { name: string } | null;
  },
  transitions: {
    fromState: string;
    toState: string;
    actorLabel: string | null;
    reason: string | null;
    occurredAt: Date;
  }[],
) {
  const state = toWorkflowState(order.status);
  const problems = orderProblems(order);
  const editable = state === 'draft' || state === 'rejected';
  const open = state === 'approved' && order.closedAt == null;
  const covered =
    order.estimate?.status === 'APPROVED' &&
    order.estimate.vendorId === order.vendorId &&
    order.estimate.currency === order.currency &&
    (order.estimate.totalMinorUnits == null ||
      order.totalMinorUnits == null ||
      order.totalMinorUnits <= order.estimate.totalMinorUnits);
  return {
    id: order.id,
    number: order.number,
    state,
    state_label: orderStateLabel(order.status, order.closedAt),
    is_open: open,
    version: order.version ?? 1,
    vendor: ref(order.vendor),
    description: order.description ?? '',
    total_minor_units:
      order.totalMinorUnits != null ? Number(order.totalMinorUnits) : null,
    currency: order.currency,
    total_formatted: formatOrderMoney(order.totalMinorUnits, order.currency),
    cost_centre: ref(order.costCentre),
    gl_account: ref(order.glAccount),
    department: order.department?.name ?? null,
    estimate_id: order.estimateId,
    estimate_reference: order.estimate?.reference ?? null,
    billed_minor_units: null,
    billed_formatted: null,
    remaining_minor_units:
      order.totalMinorUnits != null ? Number(order.totalMinorUnits) : null,
    remaining_formatted: formatOrderMoney(order.totalMinorUnits, order.currency),
    raised_by_label: order.raisedBy?.name ?? '',
    submitted_at: order.submittedAt?.toISOString() ?? null,
    opened_at: order.openedAt?.toISOString() ?? null,
    closed_at: order.closedAt?.toISOString() ?? null,
    closed_by_label: order.closedBy?.name ?? null,
    closed_reason: order.closedReason,
    problems,
    blockers: problems.filter((problem) => problem.is_blocking),
    planned_route: [],
    route_unavailable: null,
    needs_approval: !covered,
    route: null,
    transitions: transitions.map((entry) => ({
      from_state: toWorkflowState(entry.fromState),
      to_state: toWorkflowState(entry.toState),
      to_state_label: orderStateLabel(entry.toState, null),
      actor_label: entry.actorLabel,
      reason: entry.reason,
      occurred_at: entry.occurredAt.toISOString(),
    })),
    can_edit: editable,
    can_submit: editable && problems.length === 0,
    can_withdraw: state === 'pending_approval',
    can_amend: open,
    can_close: open,
    can_cancel: state !== 'cancelled' && state !== 'rejected',
    can_decide: false,
  };
}
