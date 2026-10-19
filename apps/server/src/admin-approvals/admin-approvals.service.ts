import { HttpStatus, Injectable } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { AuditService } from '../common/audit.service.js';
import { DomainException, notFound } from '../common/errors.js';
import { mayDecide, parseRoleField } from '../common/roles.js';
import { serialize } from '../common/serialize.js';
import type { ApprovalLevel, ApprovalRecordType } from '../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  formatMoney,
  LEVEL_LABELS,
  parseApprovalLevel,
  parseCurrency,
  parseRecordTypeSlug,
  RECORD_TYPE_LABELS,
  RECORD_TYPE_TO_SLUG,
} from './admin-approvals.constants.js';
import {
  emptyMatrixAudit,
  matchRulesForAmount,
  ruleToOut,
  stepsToLabels,
} from './admin-approvals.matrix.js';

const ruleInclude = { department: true } as const;

@Injectable()
export class AdminApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getMatrix(recordTypeSlug: string, includeRetired: boolean) {
    const recordType = this.knownRecordType(recordTypeSlug);
    const rules = await this.prisma.approvalRule.findMany({
      where: {
        recordType,
        ...(includeRetired ? {} : { isActive: true }),
      },
      include: ruleInclude,
      orderBy: [
        { isActive: 'desc' },
        { stepOrder: 'asc' },
        { minAmountMinorUnits: 'asc' },
      ],
    });

    const slug = RECORD_TYPE_TO_SLUG[recordType];
    return serialize({
      record_type: slug,
      record_type_label: RECORD_TYPE_LABELS[slug],
      rules: rules.map((rule) => ruleToOut(rule)),
      audit: emptyMatrixAudit(),
    });
  }

  async createRule(
    body: {
      name: string;
      record_type: string;
      level: string;
      step_order: number;
      min_amount_minor_units: number;
      max_amount_minor_units?: number | null;
      currency: string;
      department?: string | null;
      is_parallel?: boolean;
      reason: string;
    },
    session: UserSession,
  ) {
    this.requireReason(body.reason);
    const recordType = this.knownRecordType(body.record_type);
    const level = parseApprovalLevel(body.level);
    const currency = parseCurrency(body.currency);
    const departmentId = await this.resolveDepartmentId(body.department ?? null);

    const minAmount = BigInt(body.min_amount_minor_units);
    const maxAmount =
      body.max_amount_minor_units === null || body.max_amount_minor_units === undefined
        ? null
        : BigInt(body.max_amount_minor_units);

    if (maxAmount !== null && maxAmount < minAmount) {
      throw new DomainException('max_amount_minor_units must be at least min_amount_minor_units.');
    }

    await this.prisma.approvalRule.create({
      data: {
        name: body.name.trim(),
        recordType,
        level,
        stepOrder: body.step_order,
        minAmountMinorUnits: minAmount,
        maxAmountMinorUnits: maxAmount,
        currency,
        departmentId,
        isParallel: body.is_parallel ?? false,
        createdById: session.user.id,
      },
    });

    await this.audit.append({
      action: 'approval_matrix.rule_created',
      actorId: session.user.id,
      actorLabel: session.user.name ?? session.user.email,
      subjectType: 'approval_matrix',
      detail: {
        record_type: body.record_type,
        level: body.level,
        reason: body.reason.trim(),
      },
    });

    return this.getMatrix(body.record_type, false);
  }

  async retireRule(ruleId: string, reason: string, session: UserSession) {
    this.requireReason(reason);
    const rule = await this.prisma.approvalRule.findUnique({ where: { id: ruleId } });
    if (!rule) throw notFound('Approval rule', ruleId);
    if (!rule.isActive) {
      throw new DomainException('That rule is already retired.', HttpStatus.CONFLICT);
    }

    await this.prisma.approvalRule.update({
      where: { id: ruleId },
      data: { isActive: false, retiredAt: new Date() },
    });

    await this.audit.append({
      action: 'approval_matrix.rule_retired',
      actorId: session.user.id,
      actorLabel: session.user.name ?? session.user.email,
      subjectType: 'approval_matrix',
      subjectId: ruleId,
      detail: { reason: reason.trim(), record_type: RECORD_TYPE_TO_SLUG[rule.recordType] },
    });

    return this.getMatrix(RECORD_TYPE_TO_SLUG[rule.recordType], false);
  }

  async previewRoute(
    recordTypeSlug: string,
    amountMinorUnits: number,
    currencyCode: string,
    departmentName?: string,
  ) {
    const recordType = this.knownRecordType(recordTypeSlug);
    const currency = parseCurrency(currencyCode);
    const amount = BigInt(amountMinorUnits);
    const departmentId = await this.resolveDepartmentId(departmentName?.trim() || null);

    const rules = await this.prisma.approvalRule.findMany({
      where: { recordType, isActive: true, currency },
      include: ruleInclude,
    });

    const matched = matchRulesForAmount(rules, {
      recordType,
      currency,
      amountMinorUnits: amount,
      departmentId,
    });

    const slug = RECORD_TYPE_TO_SLUG[recordType];
    const department = departmentName?.trim() || null;
    const amountFormatted = formatMoney(amount, currency);

    if (matched.length === 0) {
      return serialize({
        record_type: slug,
        amount_formatted: amountFormatted,
        department,
        steps: [],
        unreachable: 'No approval route matches this amount under the live matrix.',
      });
    }

    const steps = matched.map((rule) => ({
      stepOrder: rule.stepOrder,
      level: rule.level,
    }));

    return serialize({
      record_type: slug,
      amount_formatted: amountFormatted,
      department,
      steps: stepsToLabels(steps),
      unreachable: null,
    });
  }

  async listPeople(query?: string, limit?: number) {
    const q = query?.trim();
    const rows = await this.prisma.user.findMany({
      where: {
        archivedAt: null,
        AND: [
          { OR: [{ banned: false }, { banned: null }] },
          ...(q
            ? [
                {
                  OR: [
                    { name: { contains: q, mode: 'insensitive' as const } },
                    { email: { contains: q, mode: 'insensitive' as const } },
                  ],
                },
              ]
            : []),
        ],
      },
      include: { department: true },
      orderBy: { name: 'asc' },
      ...(q || limit != null ? { take: searchLimit(limit) } : {}),
    });

    return serialize(
      rows.map((row) => {
        const roles = parseRoleField(row.role);
        return {
          id: row.id,
          name: row.name,
          email: row.email,
          department: row.department?.name ?? null,
          may_decide: mayDecide(roles),
        };
      }),
    );
  }

  async listAssignments(levelFilter?: string) {
    const level = levelFilter ? parseApprovalLevel(levelFilter) : undefined;
    const rows = await this.prisma.approvalAssignment.findMany({
      where: level ? { level } : undefined,
      include: {
        user: { include: { department: true, delegateTo: true } },
        department: true,
      },
      orderBy: [{ level: 'asc' }, { user: { name: 'asc' } }],
    });

    const now = new Date();
    return serialize(
      rows.map((row) => this.assignmentToOut(row, now)),
    );
  }

  async createAssignment(
    body: { user_id: string; level: string; department?: string | null },
    session: UserSession,
  ) {
    const level = parseApprovalLevel(body.level);
    const user = await this.prisma.user.findUnique({ where: { id: body.user_id } });
    if (!user) throw notFound('User', body.user_id);
    if (user.archivedAt !== null || user.banned) {
      throw new DomainException(`${user.name}'s account is closed.`);
    }
    if (!mayDecide(parseRoleField(user.role))) {
      throw new DomainException(
        `${user.name} cannot record approvals. Assign the approver role first.`,
      );
    }

    const departmentId = await this.resolveDepartmentId(body.department ?? null);

    const existing = await this.prisma.approvalAssignment.findFirst({
      where: { level, userId: user.id, departmentId },
    });

    let assignmentId: string;
    if (existing) {
      if (existing.isActive) {
        throw new DomainException(`${user.name} already holds ${LEVEL_LABELS[level]} here.`);
      }
      await this.prisma.approvalAssignment.update({
        where: { id: existing.id },
        data: { isActive: true },
      });
      assignmentId = existing.id;
    } else {
      const created = await this.prisma.approvalAssignment.create({
        data: { level, userId: user.id, departmentId, isActive: true },
      });
      assignmentId = created.id;
    }

    await this.audit.append({
      action: 'approval_assignment.created',
      actorId: session.user.id,
      actorLabel: session.user.name ?? session.user.email,
      subjectType: 'approval_assignment',
      subjectId: assignmentId,
      detail: { level: body.level, user_id: body.user_id },
    });

    return this.listAssignments();
  }

  async deleteAssignment(assignmentId: string, session: UserSession) {
    const row = await this.prisma.approvalAssignment.findUnique({
      where: { id: assignmentId },
    });
    if (!row) throw notFound('Approval assignment', assignmentId);
    if (!row.isActive) {
      throw new DomainException('That assignment has already been removed.');
    }

    await this.prisma.approvalAssignment.update({
      where: { id: assignmentId },
      data: { isActive: false },
    });

    await this.audit.append({
      action: 'approval_assignment.removed',
      actorId: session.user.id,
      actorLabel: session.user.name ?? session.user.email,
      subjectType: 'approval_assignment',
      subjectId: assignmentId,
    });

    return this.listAssignments();
  }

  async listDelegations() {
    const rows = await this.prisma.user.findMany({
      where: {
        OR: [{ delegateToId: { not: null } }, { outOfOfficeUntil: { not: null } }],
      },
      include: { delegateTo: true },
      orderBy: { name: 'asc' },
    });

    const now = new Date();
    return serialize(rows.map((row) => this.delegationToOut(row, now)));
  }

  async updateDelegation(
    userId: string,
    body: { delegate_to_id?: string | null; out_of_office_until?: string | null },
    session: UserSession,
  ) {
    const approver = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!approver) throw notFound('User', userId);

    let delegateToId: string | null = body.delegate_to_id ?? null;
    if (delegateToId) {
      const delegate = await this.prisma.user.findUnique({ where: { id: delegateToId } });
      if (!delegate) throw notFound('User', delegateToId);
      if (!mayDecide(parseRoleField(delegate.role))) {
        throw new DomainException('Cover must be someone who can record approvals.');
      }
    }

    const outOfOfficeUntil =
      body.out_of_office_until === null || body.out_of_office_until === undefined
        ? null
        : new Date(body.out_of_office_until);

    if (outOfOfficeUntil !== null && Number.isNaN(outOfOfficeUntil.getTime())) {
      throw new DomainException('out_of_office_until must be a valid ISO datetime.');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { delegateToId, outOfOfficeUntil },
    });

    await this.audit.append({
      action: 'approval_delegation.updated',
      actorId: session.user.id,
      actorLabel: session.user.name ?? session.user.email,
      subjectType: 'approval_delegation',
      subjectId: userId,
      detail: {
        delegate_to_id: delegateToId,
        out_of_office_until: outOfOfficeUntil?.toISOString() ?? null,
      },
    });

    const updated = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { delegateTo: true },
    });
    return serialize(this.delegationToOut(updated!, new Date()));
  }

  private knownRecordType(slug: string): ApprovalRecordType {
    try {
      return parseRecordTypeSlug(slug);
    } catch (error) {
      throw new DomainException(
        error instanceof Error ? error.message : 'Unknown record type',
        HttpStatus.NOT_FOUND,
      );
    }
  }

  private assignmentToOut(
    row: {
      id: string;
      level: ApprovalLevel;
      isActive: boolean;
      user: {
        id: string;
        name: string;
        email: string;
        archivedAt: Date | null;
        banned: boolean | null;
        outOfOfficeUntil: Date | null;
        delegateTo: { id: string; name: string } | null;
      };
      department: { name: string } | null;
    },
    now: Date,
  ) {
    const away =
      row.user.outOfOfficeUntil !== null && row.user.outOfOfficeUntil > now;
    const covering = away && row.user.delegateTo ? row.user.delegateTo : null;
    const holderActive = row.user.archivedAt === null && row.user.banned !== true;

    return {
      id: row.id,
      level: row.level.toLowerCase(),
      level_label: LEVEL_LABELS[row.level],
      user_id: row.user.id,
      user_name: row.user.name,
      user_email: row.user.email,
      department: row.department?.name ?? null,
      is_active: row.isActive && holderActive,
      is_covered_by_id: covering?.id ?? null,
      is_covered_by_name: covering?.name ?? null,
    };
  }

  private delegationToOut(
    row: {
      id: string;
      name: string;
      delegateToId: string | null;
      outOfOfficeUntil: Date | null;
      delegateTo: { id: string; name: string } | null;
    },
    now: Date,
  ) {
    const inEffect =
      row.delegateToId !== null &&
      row.outOfOfficeUntil !== null &&
      row.outOfOfficeUntil > now;

    return {
      user_id: row.id,
      user_name: row.name,
      delegate_to_id: row.delegateToId,
      delegate_to_name: row.delegateTo?.name ?? null,
      out_of_office_until: row.outOfOfficeUntil,
      is_in_effect: inEffect,
    };
  }

  private requireReason(reason: string) {
    if (!reason?.trim()) {
      throw new DomainException('Say why the approval matrix is changing.');
    }
  }

  private async resolveDepartmentId(department: string | null): Promise<string | null> {
    if (!department) return null;
    const row = await this.prisma.department.findFirst({
      where: {
        OR: [
          { name: { equals: department, mode: 'insensitive' } },
          { costCentreNumber: department },
        ],
      },
    });
    if (!row) {
      throw new DomainException(`No department matches "${department}".`);
    }
    return row.id;
  }
}

function searchLimit(limit: number | undefined) {
  if (limit == null || !Number.isFinite(limit) || limit < 1) return 20;
  return Math.min(Math.floor(limit), 50);
}
