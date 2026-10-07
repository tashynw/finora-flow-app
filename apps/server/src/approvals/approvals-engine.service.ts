import { Injectable } from '@nestjs/common';
import type {
  ApprovalLevel,
  ApprovalStepStatus,
  Currency,
  User,
} from '../generated/prisma/index.js';
import { AuditService } from '../common/audit.service.js';
import { DomainException, conflict } from '../common/errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  openStepOrder,
  planRoute,
  routeState,
  validateDecision,
  withReadyStates,
  type ApprovalOutcome,
  type MatrixRule,
  type StepProgress,
} from './approval-domain.js';
import { toPrismaApprovalRecordType } from './record-types.js';
import type { WorkflowRecordType } from './record-types.js';

export type WorkflowActor = {
  userId: string;
  displayName: string;
};

export type OpenApprovalInput = {
  recordType: WorkflowRecordType;
  recordId: string;
  amountMinorUnits: bigint;
  currency: Currency;
  departmentId: string | null;
  requesterId: string;
  actor: WorkflowActor;
  correlationId?: string;
  link?: {
    estimateId?: string;
    purchaseOrderId?: string;
    invoiceId?: string;
  };
};

export type DecisionInput = {
  recordType: WorkflowRecordType;
  recordId: string;
  stepOrder: number;
  level: ApprovalLevel;
  outcome: ApprovalOutcome;
  actor: User;
  comment?: string | null;
  correlationId?: string;
};

@Injectable()
export class ApprovalsEngineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async loadMatrixRules(recordType: WorkflowRecordType): Promise<MatrixRule[]> {
    const prismaType = toPrismaApprovalRecordType(recordType);
    const rows = await this.prisma.approvalRule.findMany({
      where: { recordType: prismaType, isActive: true, retiredAt: null },
      orderBy: [{ stepOrder: 'asc' }, { level: 'asc' }],
    });
    return rows.map((row) => ({
      level: row.level,
      stepOrder: row.stepOrder,
      minAmountMinorUnits: row.minAmountMinorUnits,
      maxAmountMinorUnits: row.maxAmountMinorUnits,
      currency: row.currency,
      departmentId: row.departmentId,
      isParallel: row.isParallel,
    }));
  }

  async openRequest(recordType: WorkflowRecordType, recordId: string) {
    return this.prisma.approvalRequest.findFirst({
      where: {
        recordType,
        recordId,
        status: 'OPEN',
      },
      include: { steps: true },
    });
  }

  progressFromRequest(request: {
    steps: Array<{
      stepOrder: number;
      level: ApprovalLevel;
      status: ApprovalStepStatus;
    }>;
  }): StepProgress[] {
    return request.steps
      .map((s) => ({
        stepOrder: s.stepOrder,
        level: s.level,
        status: s.status,
      }))
      .sort(
        (a, b) =>
          a.stepOrder - b.stepOrder ||
          a.level.localeCompare(b.level),
      );
  }

  async submitForApproval(input: OpenApprovalInput) {
    const existing = await this.openRequest(input.recordType, input.recordId);
    if (existing) {
      throw conflict('This record already has an open approval request');
    }

    const rules = await this.loadMatrixRules(input.recordType);
    let planned: ReturnType<typeof planRoute>;
    try {
      planned = planRoute(
        rules,
        input.amountMinorUnits,
        input.currency,
        input.departmentId,
      );
    } catch (err) {
      throw new DomainException(
        err instanceof Error ? err.message : 'No approval route available',
      );
    }

    for (const step of planned) {
      const staffed = await this.assignees(step.level, input.departmentId);
      if (staffed.length === 0) {
        throw new DomainException(
          `Nobody is assigned at level ${step.level} for this record`,
        );
      }
    }

    const attempt = await this.nextAttempt(input.recordType, input.recordId);
    const correlationId = input.correlationId ?? crypto.randomUUID();
    const firstOrder = planned[0]?.stepOrder ?? null;

    const request = await this.prisma.approvalRequest.create({
      data: {
        recordType: input.recordType,
        recordId: input.recordId,
        attempt,
        status: 'OPEN',
        currentStepOrder: firstOrder,
        amountMinorUnits: input.amountMinorUnits,
        currency: input.currency,
        departmentId: input.departmentId,
        requesterId: input.requesterId,
        openedAt: new Date(),
        estimateId: input.link?.estimateId ?? null,
        purchaseOrderId: input.link?.purchaseOrderId ?? null,
        invoiceId: input.link?.invoiceId ?? null,
        steps: {
          create: planned.map((step) => ({
            stepOrder: step.stepOrder,
            level: step.level,
            status:
              step.stepOrder === firstOrder
                ? ('READY' as ApprovalStepStatus)
                : ('WAITING' as ApprovalStepStatus),
          })),
        },
      },
      include: { steps: true },
    });

    await this.audit.append({
      action: 'approval.requested',
      actorId: input.actor.userId,
      actorLabel: input.actor.displayName,
      subjectType: input.recordType,
      subjectId: input.recordId,
      correlationId,
      detail: {
        attempt,
        amountMinorUnits: input.amountMinorUnits.toString(),
        currency: input.currency,
        route: planned,
      },
    });

    return request;
  }

  async withdrawOpenRequest(
    recordType: WorkflowRecordType,
    recordId: string,
    actor: WorkflowActor,
    reason: string,
    correlationId?: string,
  ) {
    const request = await this.openRequest(recordType, recordId);
    if (!request) return null;

    await this.prisma.approvalStep.updateMany({
      where: {
        requestId: request.id,
        status: { notIn: ['APPROVED', 'REJECTED'] },
      },
      data: { status: 'WITHDRAWN' },
    });

    await this.settleRequest(request.id);

    await this.audit.append({
      action: 'approval.withdrawn',
      actorId: actor.userId,
      actorLabel: actor.displayName,
      subjectType: recordType,
      subjectId: recordId,
      correlationId: correlationId ?? crypto.randomUUID(),
      detail: { attempt: request.attempt, reason },
    });

    return request;
  }

  async recordDecision(input: DecisionInput): Promise<'OPEN' | 'APPROVED' | 'REJECTED'> {
    const request = await this.openRequest(input.recordType, input.recordId);
    if (!request) {
      throw new DomainException('No open approval request for this record');
    }

    const progress = this.progressFromRequest(request);
    const standing = await this.standing(
      request.departmentId,
      input.level,
      input.actor,
    );

    let validatedComment: string | null;
    try {
      ({ comment: validatedComment } = validateDecision({
        steps: progress,
        stepOrder: input.stepOrder,
        level: input.level,
        outcome: input.outcome,
        actorId: input.actor.id,
        requesterId: request.requesterId,
        actorMayDecide: standing.mayDecide,
        comment: input.comment,
      }));
    } catch (err) {
      throw new DomainException(
        err instanceof Error ? err.message : 'Invalid decision',
      );
    }

    const stepStatus: ApprovalStepStatus =
      input.outcome === 'approved' ? 'APPROVED' : 'REJECTED';

    await this.prisma.approvalStep.updateMany({
      where: {
        requestId: request.id,
        stepOrder: input.stepOrder,
        level: input.level,
      },
      data: {
        status: stepStatus,
        decidedAt: new Date(),
        decidedById: input.actor.id,
        decidedByLabel: input.actor.name,
        comment: validatedComment,
        onBehalfOfId: standing.onBehalfOfId,
      },
    });

    const settled = await this.settleRequest(request.id);
    const correlationId = input.correlationId ?? crypto.randomUUID();

    await this.audit.append({
      action:
        input.outcome === 'approved' ? 'approval.approved' : 'approval.rejected',
      actorId: input.actor.id,
      actorLabel: input.actor.name,
      subjectType: input.recordType,
      subjectId: input.recordId,
      correlationId,
      detail: {
        attempt: request.attempt,
        stepOrder: input.stepOrder,
        level: input.level,
        outcome: input.outcome,
        comment: validatedComment,
      },
    });

    return settled;
  }

  async standing(
    departmentId: string | null,
    level: ApprovalLevel,
    user: User,
  ): Promise<{ mayDecide: boolean; onBehalfOfId: string | null }> {
    const assignees = await this.assignees(level, departmentId);
    if (assignees.length === 0) {
      return { mayDecide: false, onBehalfOfId: null };
    }
    if (assignees.some((a) => a.id === user.id)) {
      return { mayDecide: true, onBehalfOfId: null };
    }
    const now = new Date();
    for (const assignee of assignees) {
      if (
        assignee.delegateToId === user.id &&
        assignee.outOfOfficeUntil != null &&
        assignee.outOfOfficeUntil > now
      ) {
        return { mayDecide: true, onBehalfOfId: assignee.id };
      }
    }
    return { mayDecide: false, onBehalfOfId: null };
  }

  async levelsHeld(userId: string): Promise<ApprovalLevel[]> {
    const direct = await this.prisma.approvalAssignment.findMany({
      where: { userId, isActive: true },
      select: { level: true },
    });
    const delegated = await this.prisma.approvalAssignment.findMany({
      where: {
        isActive: true,
        user: {
          delegateToId: userId,
          outOfOfficeUntil: { gt: new Date() },
        },
      },
      select: { level: true },
    });
    return [...new Set([...direct, ...delegated].map((r) => r.level))];
  }

  awaitingForUser(user: User, recordType?: WorkflowRecordType) {
    return this.prisma.approvalRequest.findMany({
      where: {
        status: 'OPEN',
        requesterId: { not: user.id },
        ...(recordType ? { recordType } : {}),
        steps: {
          some: {
            status: 'READY',
          },
        },
      },
      include: {
        steps: true,
        requester: { select: { id: true, name: true, email: true } },
        department: { select: { id: true, name: true } },
      },
      orderBy: { openedAt: 'asc' },
    });
  }

  async filterAwaitingMine(user: User, requests: Awaited<ReturnType<typeof this.awaitingForUser>>) {
    const result = [];
    for (const request of requests) {
      const ready = withReadyStates(this.progressFromRequest(request)).filter(
        (s) => s.status === 'READY',
      );
      for (const step of ready) {
        const standing = await this.standing(
          request.departmentId,
          step.level,
          user,
        );
        if (standing.mayDecide) {
          result.push({ request, step });
          break;
        }
      }
    }
    return result;
  }

  private async assignees(level: ApprovalLevel, departmentId: string | null) {
    return this.prisma.user.findMany({
      where: {
        archivedAt: null,
        approvalAssignments: {
          some: {
            level,
            isActive: true,
            OR: [
              { departmentId: null },
              ...(departmentId ? [{ departmentId }] : []),
            ],
          },
        },
      },
    });
  }

  private async nextAttempt(recordType: string, recordId: string) {
    const highest = await this.prisma.approvalRequest.aggregate({
      where: { recordType, recordId },
      _max: { attempt: true },
    });
    return (highest._max.attempt ?? 0) + 1;
  }

  private async settleRequest(requestId: string) {
    const request = await this.prisma.approvalRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { steps: true },
    });
    const progress = this.progressFromRequest(request);
    const state = routeState(progress);
    const openAt = openStepOrder(progress);

    const statusMap: Record<
      ReturnType<typeof routeState>,
      'OPEN' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN'
    > = {
      OPEN: 'OPEN',
      APPROVED: 'APPROVED',
      REJECTED: 'REJECTED',
      WITHDRAWN: 'WITHDRAWN',
    };

    await this.prisma.approvalRequest.update({
      where: { id: requestId },
      data: {
        status: statusMap[state],
        currentStepOrder: state === 'OPEN' ? openAt : null,
        closedAt: state === 'OPEN' ? null : new Date(),
      },
    });

    if (state === 'OPEN' && openAt != null) {
      await this.prisma.approvalStep.updateMany({
        where: {
          requestId,
          status: { notIn: ['APPROVED', 'REJECTED', 'WITHDRAWN'] },
        },
        data: { status: 'WAITING' },
      });
      await this.prisma.approvalStep.updateMany({
        where: {
          requestId,
          stepOrder: openAt,
          status: { notIn: ['APPROVED', 'REJECTED', 'WITHDRAWN'] },
        },
        data: { status: 'READY' },
      });
    }

    if (state === 'APPROVED') return 'APPROVED' as const;
    if (state === 'REJECTED') return 'REJECTED' as const;
    return 'OPEN' as const;
  }
}
