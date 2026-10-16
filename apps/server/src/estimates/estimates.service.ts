import { Injectable } from '@nestjs/common';
import type {
  Estimate,
  EstimateStatus,
  Prisma,
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
import { withReadyStates } from '../approvals/approval-domain.js';
import { mapStepsForApi } from '../approvals/approvals.service.js';
import { ApprovalsEngineService } from '../approvals/approvals-engine.service.js';
import { RECORD_TYPES } from '../approvals/record-types.js';

const RECORD_TYPE = RECORD_TYPES.estimate;

const TRANSITIONS: Record<EstimateStatus, readonly EstimateStatus[]> = {
  DRAFT: ['PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'DRAFT', 'CANCELLED'],
  APPROVED: [],
  REJECTED: ['DRAFT', 'CANCELLED'],
  CANCELLED: [],
  EXCEPTION: [],
};

const detailInclude = {
  vendor: true,
  costCentre: true,
  glAccount: true,
  department: true,
  requester: { select: { id: true, name: true, email: true } },
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
} satisfies Prisma.EstimateInclude;

@Injectable()
export class EstimatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transitions: TransitionsService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsEngineService,
  ) {}

  async list(
    user: User,
    query: {
      status?: string[];
      search?: string;
      mine?: boolean;
      limit?: number;
      offset?: number;
      page?: number;
      pageSize?: number;
      awaitingMe?: boolean;
    },
  ) {
    const page = resolvePage(query);
    const where: Prisma.EstimateWhereInput = { archivedAt: null };

    if (query.status?.length) {
      where.status = {
        in: query.status.map((s) => s.toUpperCase() as EstimateStatus),
      };
    }
    if (query.mine) where.requesterId = user.id;
    if (query.search?.trim()) {
      const term = query.search.trim();
      where.OR = [
        { reference: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
        { vendor: { name: { contains: term, mode: 'insensitive' } } },
      ];
    }

    let idsFilter: string[] | undefined;
    if (query.awaitingMe) {
      const open = await this.approvals.awaitingForUser(user, RECORD_TYPE);
      const mine = await this.approvals.filterAwaitingMine(user, open);
      idsFilter = mine.map(({ request }) => request.recordId);
      if (idsFilter.length === 0) {
        return serialize({
          items: [],
          total: 0,
          limit: page.limit ?? page.take,
          offset: page.offset ?? page.skip,
        });
      }
      where.id = { in: idsFilter };
    }

    const [items, total] = await Promise.all([
      this.prisma.estimate.findMany({
        where,
        include: { vendor: true, requester: true, department: true },
        orderBy: { createdAt: 'desc' },
        take: page.take,
        skip: page.skip,
      }),
      this.prisma.estimate.count({ where }),
    ]);

    return serialize({
      items: await Promise.all(
        items.map((row) => this.toSummary(row, user)),
      ),
      total,
      limit: page.limit ?? page.take,
      offset: page.offset ?? page.skip,
    });
  }

  async getById(id: string, user: User) {
    const estimate = await this.prisma.estimate.findFirst({
      where: { id, archivedAt: null },
      include: detailInclude,
    });
    if (!estimate) throw notFound('Estimate', id);
    return serialize(await this.toDetail(estimate, user));
  }

  async create(user: User, body: { documentId?: string | null }) {
    const estimate = await this.prisma.estimate.create({
      data: {
        reference: nextReference('EST'),
        status: 'DRAFT',
        requesterId: user.id,
        documentId: body.documentId ?? null,
      },
      include: detailInclude,
    });
    await this.audit.append({
      action: 'estimate.created',
      actorId: user.id,
      actorLabel: user.name,
      subjectType: RECORD_TYPE,
      subjectId: estimate.id,
      detail: { reference: estimate.reference },
    });
    return serialize(await this.toDetail(estimate, user));
  }

  async updateDraft(
    id: string,
    user: User,
    body: {
      vendorId?: string | null;
      description?: string;
      justification?: string;
      estimateNumber?: string | null;
      estimateDate?: string | null;
      neededBy?: string | null;
      totalMinorUnits?: string | number | null;
      currency?: string | null;
      costCentreId?: string | null;
      glAccountId?: string | null;
      documentId?: string | null;
    },
  ) {
    const estimate = await this.requireEstimate(id);
    if (estimate.status !== 'DRAFT') {
      throw new DomainException('Only draft estimates can be edited');
    }

    const updated = await this.prisma.estimate.update({
      where: { id },
      data: {
        vendorId: body.vendorId,
        description: body.description?.slice(0, 500) ?? undefined,
        justification: body.justification?.slice(0, 4000) ?? undefined,
        estimateNumber: body.estimateNumber,
        estimateDate: body.estimateDate ? new Date(body.estimateDate) : undefined,
        neededBy: body.neededBy ? new Date(body.neededBy) : undefined,
        totalMinorUnits: toBigInt(body.totalMinorUnits),
        currency: body.currency as never,
        costCentreId: body.costCentreId,
        glAccountId: body.glAccountId,
        documentId: body.documentId,
      },
      include: detailInclude,
    });

    return serialize(await this.toDetail(updated, user));
  }

  async submit(id: string, user: User) {
    const estimate = await this.requireEstimate(id);
    if (estimate.status !== 'DRAFT') {
      throw new DomainException('Only drafts can be submitted');
    }
    this.assertReadyToSubmit(estimate);

    const correlationId = crypto.randomUUID();
    const departmentId = user.departmentId;

    await this.prisma.estimate.update({
      where: { id },
      data: {
        submittedAt: new Date(),
        submittedById: user.id,
        departmentId,
      },
    });

    await this.approvals.submitForApproval({
      recordType: RECORD_TYPE,
      recordId: id,
      amountMinorUnits: estimate.totalMinorUnits!,
      currency: estimate.currency!,
      departmentId,
      requesterId: estimate.requesterId,
      actor: { userId: user.id, displayName: user.name },
      correlationId,
      link: { estimateId: id },
    });

    await this.moveStatus(
      estimate,
      'PENDING_APPROVAL',
      user,
      null,
      correlationId,
    );

    return this.getById(id, user);
  }

  async withdraw(id: string, user: User, reason: string) {
    const estimate = await this.requireEstimate(id);
    if (estimate.status !== 'PENDING_APPROVAL') {
      throw new DomainException('Only pending estimates can be withdrawn');
    }
    if (!reason?.trim()) {
      throw new DomainException('Give a reason for withdrawing');
    }
    const correlationId = crypto.randomUUID();
    await this.approvals.withdrawOpenRequest(
      RECORD_TYPE,
      id,
      { userId: user.id, displayName: user.name },
      reason.trim(),
      correlationId,
    );
    await this.moveStatus(estimate, 'DRAFT', user, reason.trim(), correlationId);
    await this.prisma.estimate.update({
      where: { id },
      data: { submittedAt: null, submittedById: null },
    });
    return this.getById(id, user);
  }

  async cancel(id: string, user: User, reason: string) {
    const estimate = await this.requireEstimate(id);
    if (!reason?.trim()) {
      throw new DomainException('Give a reason for cancelling');
    }
    const correlationId = crypto.randomUUID();
    if (estimate.status === 'PENDING_APPROVAL') {
      await this.approvals.withdrawOpenRequest(
        RECORD_TYPE,
        id,
        { userId: user.id, displayName: user.name },
        `Estimate cancelled: ${reason.trim()}`,
        correlationId,
      );
    }
    await this.moveStatus(
      estimate,
      'CANCELLED',
      user,
      reason.trim(),
      correlationId,
    );
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
    const estimate = await this.requireEstimate(id);
    if (estimate.status !== 'PENDING_APPROVAL') {
      throw new DomainException('This estimate is not awaiting approval');
    }

    const level = approvalLevelFromApi(body.level);
    const routeState = await this.approvals.recordDecision({
      recordType: RECORD_TYPE,
      recordId: id,
      stepOrder: body.stepOrder,
      level,
      outcome: body.outcome,
      actor: user,
      comment: body.comment,
    });

    if (routeState === 'APPROVED') {
      await this.prisma.estimate.update({
        where: { id },
        data: { decidedAt: new Date(), status: 'APPROVED' },
      });
      await this.transitions.record({
        recordType: RECORD_TYPE,
        recordId: id,
        fromState: 'PENDING_APPROVAL',
        toState: 'APPROVED',
        actorId: user.id,
        actorLabel: user.name,
        reason: body.comment ?? null,
      });
    } else if (routeState === 'REJECTED') {
      await this.prisma.estimate.update({
        where: { id },
        data: { decidedAt: new Date(), status: 'REJECTED' },
      });
      await this.transitions.record({
        recordType: RECORD_TYPE,
        recordId: id,
        fromState: 'PENDING_APPROVAL',
        toState: 'REJECTED',
        actorId: user.id,
        actorLabel: user.name,
        reason: body.comment ?? null,
      });
    }

    return this.getById(id, user);
  }

  private assertReadyToSubmit(estimate: Estimate) {
    const problems: string[] = [];
    if (!estimate.vendorId) problems.push('vendor');
    if (!estimate.currency) problems.push('currency');
    if (estimate.totalMinorUnits == null || estimate.totalMinorUnits <= 0n) {
      problems.push('amount');
    }
    if (!estimate.description?.trim()) problems.push('description');
    if (problems.length) {
      throw new DomainException(
        'Estimate is not ready to submit',
        undefined,
        'NOT_READY',
        { problems },
      );
    }
  }

  private async requireEstimate(id: string) {
    const estimate = await this.prisma.estimate.findFirst({
      where: { id, archivedAt: null },
    });
    if (!estimate) throw notFound('Estimate', id);
    return estimate;
  }

  private async moveStatus(
    estimate: Estimate,
    to: EstimateStatus,
    user: User,
    reason: string | null,
    correlationId: string,
  ) {
    this.transitions.assertTransition(TRANSITIONS, estimate.status, to);
    await this.prisma.estimate.update({
      where: { id: estimate.id },
      data: { status: to },
    });
    await this.transitions.record({
      recordType: RECORD_TYPE,
      recordId: estimate.id,
      fromState: estimate.status,
      toState: to,
      actorId: user.id,
      actorLabel: user.name,
      reason,
      correlationId,
    });
  }

  private async toSummary(estimate: Estimate & { vendor?: { name: string } | null; requester: { name: string }; department?: { name: string } | null }, user: User) {
    const open = estimate.status === 'PENDING_APPROVAL'
      ? await this.approvals.openRequest(RECORD_TYPE, estimate.id)
      : null;
    let awaitingMe = false;
    if (open) {
      const standing = await this.canDecideAnyStep(user, open, estimate.requesterId);
      awaitingMe = standing;
    }
    return {
      id: estimate.id,
      reference: estimate.reference,
      state: toWorkflowState(estimate.status),
      state_label: estimate.status.replace(/_/g, ' ').toLowerCase(),
      vendor_name: estimate.vendor?.name ?? '',
      description: estimate.description,
      total_minor_units:
        estimate.totalMinorUnits != null
          ? Number(estimate.totalMinorUnits)
          : null,
      currency: estimate.currency,
      estimate_date: estimate.estimateDate?.toISOString().slice(0, 10) ?? null,
      needed_by: estimate.neededBy?.toISOString().slice(0, 10) ?? null,
      requester_label: estimate.requester.name,
      department: estimate.department?.name ?? null,
      created_at: estimate.createdAt.toISOString(),
      submitted_at: estimate.submittedAt?.toISOString() ?? null,
      decided_at: estimate.decidedAt?.toISOString() ?? null,
      route_summary: null,
      awaiting_labels: [],
      awaiting_me: awaitingMe,
      problem_count: estimate.status === 'DRAFT' ? 0 : 0,
    };
  }

  private async toDetail(
    estimate: Prisma.EstimateGetPayload<{ include: typeof detailInclude }>,
    user: User,
  ) {
    const open = estimate.approvalRequests.find((r) => r.status === 'OPEN');
    const actions = await this.computeActions(estimate, user, open ?? null);

    const route = open
      ? await this.buildRouteView(open, user, estimate.requesterId)
      : null;

    return {
      ...((await this.toSummary(
        { ...estimate, requester: estimate.requester! },
        user,
      )) as object),
      vendor_id: estimate.vendorId,
      estimate_number: estimate.estimateNumber,
      justification: estimate.justification,
      document_id: estimate.documentId,
      cost_centre: namedRef(estimate.costCentre),
      gl_account: namedRef(estimate.glAccount),
      problems: [],
      route,
      route_history: estimate.approvalRequests
        .filter((r) => r.status !== 'OPEN')
        .map((r) =>
          mapStepsForApi(r, user.id, estimate.requesterId, () => false),
        ),
      planned_route: null,
      planned_route_problem: null,
      transitions: [],
      actions,
    };
  }

  private async computeActions(
    estimate: Estimate,
    user: User,
    open: { id: string } | null,
  ) {
    const mayEdit = estimate.status === 'DRAFT';
    const maySubmit = mayEdit && estimate.requesterId === user.id;
    const mayWithdraw =
      estimate.status === 'PENDING_APPROVAL' &&
      estimate.requesterId === user.id;
    const mayCancel =
      estimate.status === 'DRAFT' ||
      estimate.status === 'PENDING_APPROVAL' ||
      estimate.status === 'REJECTED';
    let mayDecide = false;
    if (open && estimate.status === 'PENDING_APPROVAL') {
      const fullOpen = await this.approvals.openRequest(RECORD_TYPE, estimate.id);
      mayDecide = await this.canDecideAnyStep(
        user,
        fullOpen,
        estimate.requesterId,
      );
    }
    return {
      may_edit: mayEdit,
      may_submit: maySubmit,
      may_withdraw: mayWithdraw,
      may_cancel: mayCancel,
      may_decide: mayDecide,
    };
  }

  private async canDecideAnyStep(
    user: User,
    open: Awaited<ReturnType<ApprovalsEngineService['openRequest']>>,
    requesterId: string,
  ) {
    if (!open || user.id === requesterId) return false;
    const ready = withReadyStates(this.approvals.progressFromRequest(open)).filter(
      (s) => s.status === 'READY',
    );
    for (const step of ready) {
      const standing = await this.approvals.standing(
        open.departmentId,
        step.level,
        user,
      );
      if (standing.mayDecide) return true;
    }
    return false;
  }

  private async buildRouteView(
    open: NonNullable<
      Awaited<ReturnType<ApprovalsEngineService['openRequest']>>
    >,
    user: User,
    requesterId: string,
  ) {
    const decidable = new Set<string>();
    const ready = withReadyStates(
      this.approvals.progressFromRequest(open),
    ).filter((s) => s.status === 'READY');
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
}

function namedRef(
  row: { id: string; code: string; name: string } | null | undefined,
) {
  if (!row) return null;
  return { id: row.id, code: row.code, name: row.name };
}
