import { Injectable } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { AuditService } from '../common/audit.service.js';
import { conflict, DomainException, notFound } from '../common/errors.js';
import type { CostCentre } from '../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';

const SUBJECT = 'cost_centre';
const AUDIT_ACTION = 'configuration_changed';

function requireCode(code: string) {
  const cleaned = code.trim().toUpperCase();
  if (!cleaned) {
    throw new DomainException('A code is required.');
  }
  if (cleaned.length > 50) {
    throw new DomainException('That code is too long.');
  }
  return cleaned;
}

function requireName(name: string) {
  const cleaned = name.trim();
  if (!cleaned) {
    throw new DomainException('A name is required.');
  }
  if (cleaned.length > 300) {
    throw new DomainException('That name is too long.');
  }
  return cleaned;
}

function optionalReason(reason: string | undefined, prompt: string) {
  if (reason === undefined || reason.trim() === '') {
    return undefined;
  }
  const cleaned = reason.trim();
  if (cleaned.length < 3) {
    throw new DomainException(prompt);
  }
  return cleaned;
}

function requireReason(reason: string | undefined, prompt: string) {
  const cleaned = optionalReason(reason, prompt);
  if (!cleaned) {
    throw new DomainException(prompt);
  }
  return cleaned;
}

function toCostCentreOut(row: CostCentre) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    departmentId: row.departmentId,
    isActive: row.isActive,
  };
}

@Injectable()
export class CostCentresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async resolveDepartmentId(departmentId: string | null | undefined) {
    if (departmentId === undefined || departmentId === null || departmentId === '') {
      return null;
    }
    const department = await this.prisma.department.findUnique({
      where: { id: departmentId },
    });
    if (!department) {
      throw notFound('Department', departmentId);
    }
    return department.id;
  }

  async list(includeInactive: boolean) {
    const rows = await this.prisma.costCentre.findMany({
      where: includeInactive
        ? undefined
        : { isActive: true, archivedAt: null },
      orderBy: { code: 'asc' },
    });
    return rows.map(toCostCentreOut);
  }

  async create(
    session: UserSession,
    body: {
      code: string;
      name: string;
      departmentId?: string | null;
      reason?: string;
    },
  ) {
    const cleanedCode = requireCode(body.code);
    const cleanedName = requireName(body.name);
    const cleanedReason = optionalReason(
      body.reason,
      'Say why this cost centre is being added.',
    );
    const departmentId = await this.resolveDepartmentId(body.departmentId);

    const existing = await this.prisma.costCentre.findUnique({
      where: { code: cleanedCode },
    });
    if (existing) {
      throw conflict('A cost centre with that code already exists.');
    }

    const row = await this.prisma.costCentre.create({
      data: {
        code: cleanedCode,
        name: cleanedName,
        departmentId,
        isActive: true,
      },
    });

    await this.audit.append({
      action: AUDIT_ACTION,
      actorId: session.user.id,
      actorLabel: session.user.name,
      subjectType: SUBJECT,
      subjectId: row.id,
      detail: {
        action: 'created',
        code: row.code,
        name: row.name,
        departmentId: row.departmentId,
        reason: cleanedReason ?? null,
      },
    });

    return toCostCentreOut(row);
  }

  async update(
    session: UserSession,
    id: string,
    body: {
      name?: string;
      departmentId?: string | null;
      reason?: string;
    },
  ) {
    const row = await this.prisma.costCentre.findUnique({ where: { id } });
    if (!row) {
      throw notFound('Cost centre', id);
    }

    const cleanedReason = requireReason(
      body.reason,
      'Say why this cost centre is changing.',
    );

    const before = {
      name: row.name,
      departmentId: row.departmentId,
    };

    const data: { name?: string; departmentId?: string | null } = {};
    if (body.name !== undefined) {
      data.name = requireName(body.name);
    }
    if (body.departmentId !== undefined) {
      data.departmentId = await this.resolveDepartmentId(body.departmentId);
    }

    const updated = await this.prisma.costCentre.update({
      where: { id },
      data,
    });

    await this.audit.append({
      action: AUDIT_ACTION,
      actorId: session.user.id,
      actorLabel: session.user.name,
      subjectType: SUBJECT,
      subjectId: updated.id,
      detail: {
        action: 'updated',
        code: updated.code,
        before,
        after: {
          name: updated.name,
          departmentId: updated.departmentId,
        },
        reason: cleanedReason,
      },
    });

    return toCostCentreOut(updated);
  }

  async setActive(
    session: UserSession,
    id: string,
    body: { isActive: boolean; reason?: string },
  ) {
    const row = await this.prisma.costCentre.findUnique({ where: { id } });
    if (!row) {
      throw notFound('Cost centre', id);
    }

    const cleanedReason = optionalReason(
      body.reason,
      'Say why this cost centre is being changed.',
    );

    if (
      row.isActive === body.isActive &&
      ((body.isActive && row.archivedAt === null) ||
        (!body.isActive && row.archivedAt !== null))
    ) {
      return toCostCentreOut(row);
    }

    const now = new Date();
    const updated = await this.prisma.costCentre.update({
      where: { id },
      data: body.isActive
        ? {
            isActive: true,
            archivedAt: null,
            archivedReason: null,
          }
        : {
            isActive: false,
            archivedAt: now,
            archivedReason: cleanedReason ?? null,
          },
    });

    await this.audit.append({
      action: AUDIT_ACTION,
      actorId: session.user.id,
      actorLabel: session.user.name,
      subjectType: SUBJECT,
      subjectId: updated.id,
      detail: {
        action: body.isActive ? 'reactivated' : 'deactivated',
        code: updated.code,
        isActive: body.isActive,
        reason: cleanedReason ?? null,
        changedAt: now.toISOString(),
      },
    });

    return toCostCentreOut(updated);
  }
}
