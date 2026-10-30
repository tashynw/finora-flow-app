import { Injectable } from '@nestjs/common';
import type { Invoice, InvoiceStatus, Prisma, User } from '../generated/prisma/index.js';
import { AuditService } from '../common/audit.service.js';
import { conflict, DomainException, notFound } from '../common/errors.js';
import { nextReference } from '../common/ids.js';
import { resolvePage } from '../common/pagination.js';
import { serialize, toBigInt } from '../common/serialize.js';
import { toWorkflowState } from '../common/workflow-state.js';
import { TransitionsService } from '../common/transitions.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { withReadyStates } from '../approvals/approval-domain.js';
import { approvalLevelFromApi } from '../approvals/approval-levels.js';
import { mapStepsForApi } from '../approvals/approvals.service.js';
import { ApprovalsEngineService } from '../approvals/approvals-engine.service.js';
import { RECORD_TYPES } from '../approvals/record-types.js';
import { parseRoleField } from '../common/roles.js';
import { sendEmail } from '../mail/email.js';
import { LinksService } from '../links/links.service.js';

const RECORD_TYPE = RECORD_TYPES.invoice;

function formatMoney(minor: number, currency: string) {
  return new Intl.NumberFormat('en-JM', {
    style: 'currency',
    currency,
    currencyDisplay: 'code',
  }).format(minor / 100);
}

function daysUntil(due: Date | null) {
  if (!due) return null;
  const today = new Date();
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const end = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
  return Math.round((end - start) / 86_400_000);
}

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
  estimate: { include: { vendor: true } },
  purchaseOrder: { include: { vendor: true } },
  requester: { select: { id: true, name: true, email: true } },
  createdBy: { select: { id: true, name: true } },
  signedOffBy: { select: { id: true, name: true } },
  approvalRequests: {
    orderBy: { attempt: 'asc' as const },
    include: {
      department: true,
      steps: {
        orderBy: [{ stepOrder: 'asc' as const }, { level: 'asc' as const }],
        include: { onBehalfOf: { select: { name: true } } },
      },
    },
  },
} satisfies Prisma.InvoiceInclude;

type InvoiceDetailRow = Prisma.InvoiceGetPayload<{ include: typeof detailInclude }>;

function dateOnly(value: Date | null) {
  return value ? value.toISOString().slice(0, 10) : null;
}

function stateLabel(status: string) {
  return status.toLowerCase().replaceAll('_', ' ');
}

function money(minor: bigint | null, currency: string | null) {
  if (minor == null || !currency) return null;
  return formatMoney(Number(minor), currency);
}

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transitions: TransitionsService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsEngineService,
    private readonly links: LinksService,
  ) {}

  async summary() {
    const invoices = await this.prisma.invoice.findMany({
      where: { archivedAt: null },
      select: { status: true, currency: true, totalMinorUnits: true },
    });
    const currencyCounts = new Map<string, number>();
    for (const invoice of invoices) {
      if (!invoice.currency) continue;
      currencyCounts.set(
        invoice.currency,
        (currencyCounts.get(invoice.currency) ?? 0) + 1,
      );
    }
    const primary =
      [...currencyCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ??
      'JMD';
    const summed = (statuses: readonly InvoiceStatus[]) =>
      invoices.reduce((total, invoice) => {
        if (!statuses.includes(invoice.status) || invoice.currency !== primary) {
          return total;
        }
        return total + Number(invoice.totalMinorUnits ?? 0n);
      }, 0);
    const count = (...statuses: InvoiceStatus[]) =>
      invoices.filter((invoice) => statuses.includes(invoice.status)).length;

    return serialize({
      count: invoices.length,
      stats: [
        {
          key: 'count',
          label: 'Total invoices',
          value: String(invoices.length),
          tone: 'primary',
        },
        {
          key: 'outstanding',
          label: 'Outstanding to pay',
          value: formatMoney(
            summed([
              'APPROVED',
              'READY_FOR_SUBMISSION',
              'SUBMITTED',
              'OUTSTANDING',
              'ACCRUAL_NEEDED',
            ]),
            primary,
          ),
          tone: 'warning',
        },
        {
          key: 'paid',
          label: 'Settled',
          value: formatMoney(summed(['PAID']), primary),
          tone: 'success',
        },
      ],
      status_mix: [
        { label: 'Draft', count: count('DRAFT'), tone: 'neutral' },
        {
          label: 'In approval',
          count: count('PENDING_SIGN_OFF', 'PENDING_APPROVAL'),
          tone: 'primary',
        },
        {
          label: 'In flight',
          count: count('APPROVED', 'READY_FOR_SUBMISSION', 'SUBMITTED'),
          tone: 'info',
        },
        {
          label: 'Outstanding',
          count: count('OUTSTANDING', 'ACCRUAL_NEEDED'),
          tone: 'warning',
        },
        { label: 'Paid', count: count('PAID'), tone: 'success' },
        { label: 'Exception', count: count('EXCEPTION'), tone: 'danger' },
      ],
    });
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
        state_label: row.status.toLowerCase().replaceAll('_', ' '),
        invoice_number: row.invoiceNumber,
        description: row.description,
        vendor_name: row.vendor?.name ?? '',
        total_minor_units:
          row.totalMinorUnits != null ? Number(row.totalMinorUnits) : null,
        total_formatted:
          row.totalMinorUnits != null && row.currency
            ? formatMoney(Number(row.totalMinorUnits), row.currency)
            : null,
        currency: row.currency,
        requester_label: row.requester?.name ?? null,
        created_at: row.createdAt.toISOString(),
        due_date: row.dueDate?.toISOString().slice(0, 10) ?? null,
        days_until_due: daysUntil(row.dueDate),
        awaiting_labels: [],
        awaiting_me: false,
        awaiting_my_sign_off: false,
        problem_count: 0,
        blocker_count: 0,
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
    return serialize(await this.presentDetail(invoice, user));
  }

  async create(user: User, body: { documentId?: string | null }) {
    if (body.documentId) {
      return this.createFromDocument(user, body.documentId);
    }

    const invoice = await this.prisma.invoice.create({
      data: {
        reference: nextReference('INV'),
        status: 'DRAFT',
        createdById: user.id,
      },
    });
    await this.audit.append({
      action: 'invoice.created',
      actorId: user.id,
      actorLabel: user.name,
      subjectType: RECORD_TYPE,
      subjectId: invoice.id,
      detail: { reference: invoice.reference, from_document: null },
    });
    return this.getById(invoice.id, user);
  }

  /**
   * Record a draft from an accepted invoice reading.
   *
   * Accept alone does not create the invoice: that would put a payment record on
   * the board without someone choosing to raise it. This path copies confirmed
   * values and links the source document.
   */
  private async createFromDocument(user: User, documentId: string) {
    const document = await this.prisma.s3Document.findUnique({
      where: { id: documentId },
      include: {
        extractions: {
          where: { isCurrent: true },
          orderBy: { attempt: 'desc' },
        },
      },
    });
    if (!document) throw notFound('Document', documentId);

    const fields = document.extractions;
    const head = fields[0];
    if (!head || head.status !== 'accepted') {
      throw conflict(
        'The values read from this document have not been accepted yet. Check them in the review workspace and accept them first.',
      );
    }
    if (head.kind !== 'invoice') {
      throw conflict(
        `This document was accepted as a ${head.kind.replaceAll('_', ' ')}, not an invoice. Change its type in the review workspace if that is wrong.`,
      );
    }

    const existing = await this.prisma.invoice.findFirst({
      where: { documentId, archivedAt: null },
    });
    if (existing) {
      throw conflict(
        `This document has already been recorded as invoice ${existing.reference}.`,
      );
    }

    const textOf = (name: string) => {
      const row = fields.find((item) => item.labelText === name);
      return row?.valueText?.trim() ?? '';
    };

    const vendorName = textOf('vendor_name');
    const vendor = vendorName
      ? await this.prisma.vendor.findFirst({
          where: { name: { equals: vendorName, mode: 'insensitive' } },
        })
      : null;

    const currencyText = textOf('currency').toUpperCase().slice(0, 3);
    const totalParsed = parseMoneyText(textOf('total'), currencyText || undefined);
    const currencyRaw = totalParsed?.currency ?? currencyText;
    const currency =
      currencyRaw === 'JMD' || currencyRaw === 'USD' ? currencyRaw : null;

    const invoice = await this.prisma.invoice.create({
      data: {
        reference: nextReference('INV'),
        status: 'DRAFT',
        createdById: user.id,
        documentId,
        vendorId: vendor?.id ?? null,
        invoiceNumber: textOf('document_number').slice(0, 120) || null,
        invoiceDate: parseDateText(textOf('document_date')),
        dueDate: parseDateText(textOf('due_date')),
        totalMinorUnits: totalParsed?.minor ?? null,
        currency,
        description: '',
      },
    });

    await this.audit.append({
      action: 'invoice.created',
      actorId: user.id,
      actorLabel: user.name,
      subjectType: RECORD_TYPE,
      subjectId: invoice.id,
      detail: {
        reference: invoice.reference,
        from_document: documentId,
        vendor_name: vendorName || null,
        invoice_number: invoice.invoiceNumber,
      },
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

  async requestSignOff(
    id: string,
    user: User,
    body: { requesterId?: string } = {},
  ) {
    const invoice = await this.requireInvoice(id);
    if (invoice.status !== 'DRAFT') {
      throw new DomainException('Only drafts can request sign-off');
    }
    const requesterId = body.requesterId ?? invoice.requesterId;
    if (!requesterId) {
      throw new DomainException(
        'Choose who should confirm receipt before asking',
      );
    }
    this.assertReady(invoice);
    await this.prisma.invoice.update({
      where: { id },
      data: {
        requesterId,
        submittedAt: new Date(),
        submittedById: user.id,
      },
    });
    await this.moveStatus(invoice, 'PENDING_SIGN_OFF', user, null);
    const requester = await this.prisma.user.findUnique({
      where: { id: requesterId },
    });
    if (requester) {
      const link = await this.links.issue({
        recordType: 'invoice',
        recordId: id,
        purpose: 'sign_off',
        issuedToId: requester.id,
      });
      if (requester.email) {
        await sendEmail({
          to: requester.email,
          subject: `Confirm receipt of ${invoice.reference}`,
          text: `Open the invoice: ${link.url}`,
        }).catch(() => undefined);
      }
    }
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
    const departmentId = user.departmentId;
    const routeInput = {
      recordType: RECORD_TYPE,
      recordId: id,
      amountMinorUnits: invoice.totalMinorUnits!,
      currency: invoice.currency!,
      departmentId,
      requesterId: user.id,
      actor: { userId: user.id, displayName: user.name },
      correlationId,
      link: { invoiceId: id },
    };

    // Fail before recording receipt if the matrix or assignees cannot open a route.
    await this.approvals.assertCanOpenRoute(routeInput);

    let signedOffWritten = false;
    let routeOpened = false;
    try {
      await this.prisma.invoice.update({
        where: { id },
        data: {
          signedOffAt: new Date(),
          signedOffById: user.id,
          signOffNote: body.note?.trim() || null,
          departmentId,
        },
      });
      signedOffWritten = true;

      await this.approvals.submitForApproval(routeInput);
      routeOpened = true;

      await this.moveStatus(
        invoice,
        'PENDING_APPROVAL',
        user,
        null,
        correlationId,
      );
    } catch (error) {
      if (routeOpened) {
        await this.approvals
          .withdrawOpenRequest(
            RECORD_TYPE,
            id,
            { userId: user.id, displayName: user.name },
            'Sign-off rolled back because the approval route could not finish opening.',
            correlationId,
          )
          .catch(() => undefined);
      }
      if (signedOffWritten) {
        await this.prisma.invoice
          .update({
            where: { id },
            data: {
              signedOffAt: null,
              signedOffById: null,
              signOffNote: null,
            },
          })
          .catch(() => undefined);
      }
      throw error;
    }

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
    const declined = reason.trim();
    await this.moveStatus(invoice, 'EXCEPTION', user, declined);
    await this.notifyCreatorOfDecline(invoice, user, declined);
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
      await this.notifyApproved(invoice);
    } else if (routeState === 'REJECTED') {
      await this.prisma.invoice.update({
        where: { id },
        data: { status: 'REJECTED', decidedAt: new Date() },
      });
    }
    return this.getById(id, user);
  }

  private async presentDetail(invoice: InvoiceDetailRow, user: User) {
    const requests = invoice.approvalRequests ?? [];
    const open = requests.find((request) => request.status === 'OPEN');
    const requesterId = open?.requesterId ?? invoice.requesterId ?? '';
    const route = open
      ? await this.buildRouteView(open, user, requesterId)
      : null;
    const currency = invoice.currency;
    const total = invoice.totalMinorUnits;
    const estimateBilled = await this.billedMinor(
      invoice.estimateId ? { estimateId: invoice.estimateId } : null,
    );
    const orderBilledByOthers = await this.billedMinor(
      invoice.purchaseOrderId
        ? { purchaseOrderId: invoice.purchaseOrderId, id: { not: invoice.id } }
        : null,
    );
    const estimate = invoice.estimate;
    const order = invoice.purchaseOrder;
    const estimateRemaining =
      estimate?.totalMinorUnits != null
        ? estimate.totalMinorUnits - estimateBilled
        : null;
    const orderRemaining =
      order?.totalMinorUnits != null
        ? order.totalMinorUnits - orderBilledByOthers - (total ?? 0n)
        : null;

    return {
      id: invoice.id,
      reference: invoice.reference,
      state: toWorkflowState(invoice.status),
      state_label: stateLabel(invoice.status),
      invoice_number: invoice.invoiceNumber,
      invoice_date: dateOnly(invoice.invoiceDate),
      due_date: dateOnly(invoice.dueDate),
      days_until_due: daysUntil(invoice.dueDate),
      vendor_id: invoice.vendorId,
      vendor_name: invoice.vendor?.name ?? '',
      estimate_id: invoice.estimateId,
      purchase_order_id: invoice.purchaseOrderId,
      requester_id: invoice.requesterId,
      requester_label: invoice.requester?.name ?? null,
      suggested_requester_id: null,
      description: invoice.description,
      total_minor_units: total != null ? Number(total) : null,
      total_formatted: money(total, currency),
      currency,
      document_id: invoice.documentId,
      department: invoice.department?.name ?? null,
      cost_centre: invoice.costCentre
        ? {
            id: invoice.costCentre.id,
            code: invoice.costCentre.code,
            name: invoice.costCentre.name,
          }
        : null,
      gl_account: invoice.glAccount
        ? {
            id: invoice.glAccount.id,
            code: invoice.glAccount.code,
            name: invoice.glAccount.name,
          }
        : null,
      created_at: invoice.createdAt.toISOString(),
      created_by_label: invoice.createdBy.name,
      submitted_at: invoice.submittedAt?.toISOString() ?? null,
      decided_at: invoice.decidedAt?.toISOString() ?? null,
      signed_off_at: invoice.signedOffAt?.toISOString() ?? null,
      reminders_sent: 0,
      awaiting_labels: route
        ? route.steps
            .filter((step) => step.state === 'ready')
            .map((step) => step.level_label)
        : [],
      awaiting_me: route?.steps.some((step) => step.is_mine_to_decide) ?? false,
      awaiting_my_sign_off:
        invoice.status === 'PENDING_SIGN_OFF' && invoice.requesterId === user.id,
      problem_count: 0,
      blocker_count: 0,
      problems: [],
      transitions: [],
      route,
      route_history: requests
        .filter((request) => request.status !== 'OPEN')
        .map((request) =>
          mapStepsForApi(
            request,
            user.id,
            request.requesterId,
            () => false,
          ),
        ),
      route_summary: route?.summary ?? null,
      planned_route: null,
      planned_route_problem: null,
      sign_off: {
        escalation_level: 0,
        is_mine_to_sign:
          invoice.status === 'PENDING_SIGN_OFF' && invoice.requesterId === user.id,
        next_reminder_at: null,
        note: invoice.signOffNote,
        reminders_sent: 0,
        requested_at: invoice.submittedAt?.toISOString() ?? null,
        requester_email: invoice.requester?.email ?? null,
        requester_id: invoice.requesterId,
        requester_label: invoice.requester?.name ?? null,
        signed_off_at: invoice.signedOffAt?.toISOString() ?? null,
        signed_off_by_label: invoice.signedOffBy?.name ?? null,
      },
      estimate: estimate
        ? {
            id: estimate.id,
            reference: estimate.reference,
            state: toWorkflowState(estimate.status),
            state_label: stateLabel(estimate.status),
            vendor_name: estimate.vendor?.name ?? '',
            currency: estimate.currency,
            approved_total_minor_units:
              estimate.totalMinorUnits != null
                ? Number(estimate.totalMinorUnits)
                : null,
            approved_total_formatted: money(
              estimate.totalMinorUnits,
              estimate.currency,
            ),
            remaining_minor_units:
              estimateRemaining != null ? Number(estimateRemaining) : null,
            remaining_formatted: money(estimateRemaining, estimate.currency),
          }
        : null,
      purchase_order: order
        ? {
            id: order.id,
            number: order.number,
            currency: order.currency ?? currency ?? 'JMD',
            is_open: order.status === 'APPROVED',
            state_label: stateLabel(order.status),
            vendor_name: order.vendor?.name ?? '',
            total_minor_units: Number(order.totalMinorUnits ?? 0n),
            total_formatted:
              money(order.totalMinorUnits, order.currency) ?? '—',
            billed_by_others_minor_units: Number(orderBilledByOthers),
            billed_by_others_formatted:
              money(orderBilledByOthers, order.currency) ?? '—',
            remaining_minor_units: Number(orderRemaining ?? 0n),
            remaining_formatted:
              money(orderRemaining, order.currency) ?? '—',
          }
        : null,
      actions: {
        ...this.computeActions(invoice, user),
        may_decide: route?.steps.some((step) => step.is_mine_to_decide) ?? false,
      },
    };
  }

  private async billedMinor(
    where: Prisma.InvoiceWhereInput | null,
  ): Promise<bigint> {
    if (!where) return 0n;
    const sum = await this.prisma.invoice.aggregate({
      where: {
        ...where,
        archivedAt: null,
        status: { notIn: ['CANCELLED', 'REJECTED'] },
      },
      _sum: { totalMinorUnits: true },
    });
    return sum._sum.totalMinorUnits ?? 0n;
  }

  private async buildRouteView(
    open: InvoiceDetailRow['approvalRequests'][number],
    user: User,
    requesterId: string,
  ) {
    const decidable = new Set<string>();
    const ready = withReadyStates(
      this.approvals.progressFromRequest(open),
    ).filter((step) => step.status === 'READY');
    for (const step of ready) {
      const standing = await this.approvals.standing(
        open.departmentId,
        step.level,
        user,
      );
      if (standing.mayDecide && user.id !== requesterId) {
        decidable.add(step.level);
      }
    }
    return mapStepsForApi(open, user.id, requesterId, (level) =>
      decidable.has(level),
    );
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

  private async notifyApproved(invoice: Invoice) {
    const people = await this.prisma.user.findMany({
      where: { archivedAt: null, banned: { not: true } },
      select: { id: true, name: true, email: true, role: true },
    });
    const finance = people.filter(
      (person) => person.email && parseRoleField(person.role).includes('finance'),
    );
    const requester = people.find(
      (person) => person.id === invoice.requesterId && person.email,
    );
    const origin = (
      process.env.WEB_ORIGIN ??
      process.env.WEB_APP_URL ??
      'http://localhost:5173'
    ).replace(/\/$/, '');
    const link = `${origin}/invoices/${invoice.id}`;
    const amount =
      invoice.totalMinorUnits != null && invoice.currency
        ? `${invoice.currency} ${(Number(invoice.totalMinorUnits) / 100).toFixed(2)}`
        : null;
    const amountLine = amount ? `\n\nAmount: ${amount}` : '';
    const sent = new Set<string>();

    for (const person of finance) {
      sent.add(person.email);
      await sendEmail({
        to: person.email,
        subject: `Invoice ${invoice.reference} is approved`,
        text: `Hi ${person.name},\n\nInvoice ${invoice.reference} is approved and can go on a payment package.${amountLine}\n\nOpen it: ${link}`,
      }).catch(() => undefined);
    }

    if (requester && !sent.has(requester.email)) {
      await sendEmail({
        to: requester.email,
        subject: `Invoice ${invoice.reference} is approved`,
        text: `Hi ${requester.name},\n\nInvoice ${invoice.reference} for what you requested is now approved.${amountLine}\n\nOpen it: ${link}`,
      }).catch(() => undefined);
    }
  }

  private async notifyCreatorOfDecline(
    invoice: Invoice,
    requester: User,
    reason: string,
  ) {
    const creator = await this.prisma.user.findUnique({
      where: { id: invoice.createdById },
      select: { name: true, email: true },
    });
    if (!creator?.email) return;
    const origin = (
      process.env.WEB_ORIGIN ??
      process.env.WEB_APP_URL ??
      'http://localhost:5173'
    ).replace(/\/$/, '');
    await sendEmail({
      to: creator.email,
      subject: `Receipt declined for ${invoice.reference}`,
      text: `Hi ${creator.name},\n\n${requester.name} said the goods or services on ${invoice.reference} did not arrive as billed.\n\n${reason}\n\nOpen the invoice: ${origin}/invoices/${invoice.id}`,
    }).catch(() => undefined);
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

function parseMoneyText(
  text: string,
  fallbackCurrency?: string,
): { minor: bigint; currency?: string } | null {
  const cleaned = text.replace(/,/g, '').trim();
  if (!cleaned) return null;
  const match = cleaned.match(
    /(?:([A-Za-z]{3})\s*)?(-?\d+(?:\.\d{1,2})?)(?:\s*([A-Za-z]{3}))?/,
  );
  if (!match) return null;
  const major = Number.parseFloat(match[2]!);
  if (!Number.isFinite(major)) return null;
  const currency = (match[1] ?? match[3] ?? fallbackCurrency)?.toUpperCase();
  return {
    minor: BigInt(Math.round(major * 100)),
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : undefined,
  };
}

function parseDateText(text: string): Date | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso) {
    return new Date(
      Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])),
    );
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}
