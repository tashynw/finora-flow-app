import { Injectable } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { AuditService } from '../common/audit.service.js';
import { conflict, DomainException, notFound } from '../common/errors.js';
import type { Department } from '../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';

const SUBJECT = 'department';
const AUDIT_ACTION = 'configuration_changed';

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

function requireCostCentreNumber(value: string) {
  const cleaned = value.trim();
  if (!cleaned) {
    throw new DomainException('A cost centre number is required.');
  }
  if (cleaned.length > 50) {
    throw new DomainException('That cost centre number is too long.');
  }
  return cleaned;
}

function toDepartmentOut(row: Department) {
  return {
    id: row.id,
    name: row.name,
    costCentreNumber: row.costCentreNumber,
    isActive: row.isActive,
  };
}

@Injectable()
export class DepartmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(includeInactive: boolean) {
    const rows = await this.prisma.department.findMany({
      where: includeInactive ? undefined : { isActive: true },
      orderBy: { costCentreNumber: 'asc' },
    });
    return rows.map(toDepartmentOut);
  }

  async create(
    session: UserSession,
    body: { name: string; costCentreNumber: string },
  ) {
    const name = requireName(body.name);
    const costCentreNumber = requireCostCentreNumber(body.costCentreNumber);

    const existing = await this.prisma.department.findUnique({
      where: { costCentreNumber },
    });
    if (existing) {
      throw conflict('A department with that cost centre number already exists.');
    }

    const row = await this.prisma.department.create({
      data: {
        name,
        costCentreNumber,
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
        name: row.name,
        costCentreNumber: row.costCentreNumber,
      },
    });

    return toDepartmentOut(row);
  }

  async update(
    session: UserSession,
    id: string,
    body: { name?: string; costCentreNumber?: string },
  ) {
    const row = await this.prisma.department.findUnique({ where: { id } });
    if (!row) {
      throw notFound('Department', id);
    }

    const before = {
      name: row.name,
      costCentreNumber: row.costCentreNumber,
    };

    const data: { name?: string; costCentreNumber?: string } = {};
    if (body.name !== undefined) {
      data.name = requireName(body.name);
    }
    if (body.costCentreNumber !== undefined) {
      const costCentreNumber = requireCostCentreNumber(body.costCentreNumber);
      if (costCentreNumber !== row.costCentreNumber) {
        const existing = await this.prisma.department.findUnique({
          where: { costCentreNumber },
        });
        if (existing) {
          throw conflict(
            'A department with that cost centre number already exists.',
          );
        }
        data.costCentreNumber = costCentreNumber;
      }
    }

    const updated = await this.prisma.department.update({
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
        before,
        after: {
          name: updated.name,
          costCentreNumber: updated.costCentreNumber,
        },
      },
    });

    return toDepartmentOut(updated);
  }

  async setActive(session: UserSession, id: string, isActive: boolean) {
    const row = await this.prisma.department.findUnique({ where: { id } });
    if (!row) {
      throw notFound('Department', id);
    }

    if (row.isActive === isActive) {
      return toDepartmentOut(row);
    }

    const updated = await this.prisma.department.update({
      where: { id },
      data: { isActive },
    });

    await this.audit.append({
      action: AUDIT_ACTION,
      actorId: session.user.id,
      actorLabel: session.user.name,
      subjectType: SUBJECT,
      subjectId: updated.id,
      detail: {
        action: isActive ? 'reactivated' : 'deactivated',
        costCentreNumber: updated.costCentreNumber,
        isActive,
      },
    });

    return toDepartmentOut(updated);
  }
}
