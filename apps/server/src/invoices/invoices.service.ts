import { Injectable } from '@nestjs/common';
import type { Invoice, InvoiceStatus, Prisma, User } from '../generated/prisma/index.js';
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

const RECORD_TYPE = RECORD_TYPES.invoice;

const TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  DRAFT: ['PENDING_SIGN_OFF', 'CANCELLED'],
  PENDING_SIGN_OFF: ['PENDING_APPROVAL', 'EXCEPTION', 'DRAFT', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: [],
  READY_FOR_SUBMISSION: [],
  SUBMITTED: [],
  PAID: [],
  OUTSTANDING: [],
  EXCEPTION: [],
  ACCRUAL_NEEDED: [],
  REJECTED: ['DRAFT', 'CANCELLED'],
  CANCELLED: [],
};

const detailInclude = {
  vendor: true,
  costCentre: true,
  glAccount: true,
  department: true,
  estimate: true,
  purchaseOrder: true,
  requester: { select: { id: true, name: true, email: true } },
  createdBy: { select: { id: true, name: true } },
  approvalRequests: {
    orderBy: { attempt: 'asc' as const },
    include: { steps: true },
  },
} satisfies Prisma.InvoiceInclude;

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transitions: TransitionsService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsEngineService,
  ) {}

  async summary() {
    const groups = await this.prisma.invoice.groupBy({
      by: ['status'],
      where: { archivedAt: null },
      _count: { _all: true },
    });
    const counts: Record<string, number> = {};
    for (const row of groups) {
      counts[toWorkflowState(row.status)] = row._count._all;
    }
    return serialize({ counts_by_status: counts });
  }

  async linkableReference() {
    const [estimates, orders, people] = await Promise.all([
      this.prisma.estimate.findMany({
        where: { status: 'APPROVED', archivedAt: null },
        include: { vendor: true },
        take: 200,
      }),
      this.prisma.purchaseOrder.findMany({
        where: { status: 'APPROVED', closedAt: null, archivedAt: null },
        include: { vendor: true },
        take: 200,
      }),
      this.prisma.user.findMany({
        where: { archivedAt: null },
        select: { id: true, name: true, email: true },
        orderBy: { name: 'asc' },
        take: 500,
      }),
    ]);

    return serialize({
      approved_estimates: estimates.map((e) => ({
        id: e.id,
        reference: e.reference,
        vendor_name: e.vendor?.name ?? '',
      })),
      open_purchase_orders: orders.map((o) => ({
        id: o.id,
        number: o.number,
        vendor_name: o.vendor?.name ?? '',
      })),
      people: people.map((p) => ({
        id: p.id,
        name: p.name,
        email: p.email,
      })),
    });
  }

  async list(
    query: {
      status?: string[];
      search?: string;
      limit?: number;
      offset?: number;
    },
  ) {
    const page = resolvePage(query);
    const where: Prisma.InvoiceWhereInput = { archivedAt: null };
    if (query.status?.length) {
      where.status = {
        in: query.status.map((s) => s.toUpperCase() as InvoiceStatus),
      };
    }
    if (query.search?.trim()) {
      const term = query.search.trim();
      where.OR = [
        { reference: { contains: term, mode: 'insensitive' } },
        { invoiceNumber: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        include: { vendor: true, requester: true },
        orderBy: { createdAt: 'desc' },
        take: page.take,
        skip: page.skip,
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return serialize({
      items: items.map((row) => ({
        id: row.id,
        reference: row.reference,
        state: toWorkflowState(row.status),
        vendor_name: row.vendor?.name ?? '',
        total_minor_units:
          row.totalMinorUnits != null ? Number(row.totalMinorUnits) : null,
        currency: row.currency,
        requester_label: row.requester?.name ?? null,
        created_at: row.createdAt.toISOString(),
      })),
      total,
      limit: page.limit ?? page.take,
      offset: page.offset ?? page.skip,
    });
  }

  async getById(id: string, user: User) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, archivedAt: null },
      include: detailInclude,
    });
    if (!invoice) throw notFound('Invoice', id);
    return serialize({
      id: invoice.id,
      reference: invoice.reference,
      state: toWorkflowState(invoice.status),
      invoice_number: invoice.invoiceNumber,
      vendor_id: invoice.vendorId,
      estimate_id: invoice.estimateId,
      purchase_order_id: invoice.purchaseOrderId,
      requester_id: invoice.requesterId,
      description: invoice.description,
      total_minor_units:
        invoice.totalMinorUnits != null
          ? Number(invoice.totalMinorUnits)
          : null,
      currency: invoice.currency,
      actions: this.computeActions(invoice, user),
    });
  }

  async create(user: User, body: { documentId?: string | null }) {
    const invoice = await this.prisma.invoice.create({
      data: {
        reference: nextReference('INV'),
        status: 'DRAFT',
        createdById: user.id,
        documentId: body.documentId ?? null,
      },
    });
    await this.audit.append({
      action: 'invoice.created',
      actorId: user.id,
      actorLabel: user.name,
      subjectType: RECORD_TYPE,
      subjectId: invoice.id,
      detail: { reference: invoice.reference },
    });
    return this.getById(invoice.id, user);
  }

  async updateDraft(id: string, user: User, body: Record<string, unknown>) {
    const invoice = await this.requireInvoice(id);
    if (invoice.status !== 'DRAFT') {
      throw new DomainException('Only draft invoices can be edited');
    }
    await this.prisma.invoice.update({
      where: { id },
      data: {
        vendorId: (body.vendorId ?? body.vendor_id) as string | null | undefined,
        estimateId: (body.estimateId ?? body.estimate_id) as
          | string
          | null
          | undefined,
        purchaseOrderId: (body.purchaseOrderId ??
          body.purchase_order_id) as string | null | undefined,
        requesterId: (body.requesterId ?? body.requester_id) as
          | string
          | null
          | undefined,
        invoiceNumber: (body.invoiceNumber ?? body.invoice_number) as
          | string
          | null
          | undefined,
        invoiceDate: body.invoiceDate
          ? new Date(body.invoiceDate as string)
          : body.invoice_date
            ? new Date(body.invoice_date as string)
            : undefined,
        dueDate: body.dueDate
          ? new Date(body.dueDate as string)
          : body.due_date
            ? new Date(body.due_date as string)
            : undefined,
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
        documentId: (body.documentId ?? body.document_id) as
          | string
          | null
          | undefined,
      },
    });
    void user;
    return this.getById(id, user);
  }

  async requestSignOff(id: string, user: User, body: { requesterId: string }) {
    const invoice = await this.requireInvoice(id);
    if (invoice.status !== 'DRAFT') {
      throw new DomainException('Only drafts can request sign-off');
    }
    this.assertReady(invoice);
    await this.prisma.invoice.update({
      where: { id },
      data: {
        requesterId: body.requesterId,
        submittedAt: new Date(),
        submittedById: user.id,
      },
    });
    await this.moveStatus(invoice, 'PENDING_SIGN_OFF', user, null);
    return this.getById(id, user);
  }

  async signOff(id: string, user: User, body: { note?: string | null }) {
    const invoice = await this.requireInvoice(id);
    if (invoice.status !== 'PENDING_SIGN_OFF') {
      throw new DomainException('Invoice is not awaiting sign-off');
    }
    if (invoice.requesterId !== user.id) {
      throw new DomainException('Only the named requester may sign off');
    }
    this.assertReady(invoice);
    const correlationId = crypto.randomUUID();

    await this.prisma.invoice.update({
      where: { id },
      data: {
        signedOffAt: new Date(),
        signedOffById: user.id,
        signOffNote: body.note?.trim() || null,
        departmentId: user.departmentId,
      },
    });

    await this.approvals.submitForApproval({
      recordType: RECORD_TYPE,
      recordId: id,
      amountMinorUnits: invoice.totalMinorUnits!,
      currency: invoice.currency!,
      departmentId: user.departmentId,
      requesterId: user.id,
      actor: { userId: user.id, displayName: user.name },
      correlationId,
      link: { invoiceId: id },
    });

    await this.moveStatus(invoice, 'PENDING_APPROVAL', user, null, correlationId);
    return this.getById(id, user);
  }

  async decline(id: string, user: User, reason: string) {
    const invoice = await this.requireInvoice(id);
    if (invoice.status !== 'PENDING_SIGN_OFF') {
      throw new DomainException('Invoice is not awaiting sign-off');
    }
    if (invoice.requesterId !== user.id) {
      throw new DomainException('Only the requester may decline sign-off');
    }
    if (!reason?.trim()) throw new DomainException('Give a reason');
    await this.moveStatus(invoice, 'EXCEPTION', user, reason.trim());
    return this.getById(id, user);
  }

  async recall(id: string, user: User, reason: string) {
    const invoice = await this.requireInvoice(id);
    if (invoice.status !== 'PENDING_SIGN_OFF') {
      throw new DomainException('Only pending sign-off invoices can be recalled');
    }
    if (!reason?.trim()) throw new DomainException('Give a reason');
    await this.moveStatus(invoice, 'DRAFT', user, reason.trim());
    await this.prisma.invoice.update({
      where: { id },
      data: { submittedAt: null, submittedById: null, requesterId: null },
    });
    return this.getById(id, user);
  }

  async cancel(id: string, user: User, reason: string) {
    const invoice = await this.requireInvoice(id);
    if (!reason?.trim()) throw new DomainException('Give a reason');
    if (invoice.status === 'PENDING_APPROVAL') {
      await this.approvals.withdrawOpenRequest(
        RECORD_TYPE,
        id,
        { userId: user.id, displayName: user.name },
        `Invoice cancelled: ${reason.trim()}`,
      );
    }
    await this.moveStatus(invoice, 'CANCELLED', user, reason.trim());
    return this.getById(id, user);
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
    const invoice = await this.requireInvoice(id);
    if (invoice.status !== 'PENDING_APPROVAL') {
      throw new DomainException('Invoice is not pending approval');
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
      await this.prisma.invoice.update({
        where: { id },
        data: { status: 'APPROVED', decidedAt: new Date() },
      });
    } else if (routeState === 'REJECTED') {
      await this.prisma.invoice.update({
        where: { id },
        data: { status: 'REJECTED', decidedAt: new Date() },
      });
    }
    return this.getById(id, user);
  }

  private computeActions(invoice: Invoice, user: User) {
    return {
      may_edit: invoice.status === 'DRAFT',
      may_request_sign_off: invoice.status === 'DRAFT',
      may_sign_off:
        invoice.status === 'PENDING_SIGN_OFF' &&
        invoice.requesterId === user.id,
      may_decline:
        invoice.status === 'PENDING_SIGN_OFF' &&
        invoice.requesterId === user.id,
      may_recall: invoice.status === 'PENDING_SIGN_OFF',
      may_cancel:
        invoice.status === 'DRAFT' ||
        invoice.status === 'PENDING_SIGN_OFF' ||
        invoice.status === 'PENDING_APPROVAL' ||
        invoice.status === 'REJECTED',
      may_decide: invoice.status === 'PENDING_APPROVAL',
    };
  }

  private assertReady(invoice: Invoice) {
    if (
      !invoice.vendorId ||
      !invoice.currency ||
      invoice.totalMinorUnits == null
    ) {
      throw new DomainException('Invoice is incomplete');
    }
  }

  private async requireInvoice(id: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, archivedAt: null },
    });
    if (!invoice) throw notFound('Invoice', id);
    return invoice;
  }

  private async moveStatus(
    invoice: Invoice,
    to: InvoiceStatus,
    user: User,
    reason: string | null,
    correlationId?: string,
  ) {
    this.transitions.assertTransition(TRANSITIONS, invoice.status, to);
    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: to },
    });
    await this.transitions.record({
      recordType: RECORD_TYPE,
      recordId: invoice.id,
      fromState: invoice.status,
      toState: to,
      actorId: user.id,
      actorLabel: user.name,
      reason,
      correlationId: correlationId ?? crypto.randomUUID(),
    });
  }
}
