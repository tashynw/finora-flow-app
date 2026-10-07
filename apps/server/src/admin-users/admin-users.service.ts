import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { AuditService } from '../common/audit.service.js';
import { DomainException, notFound } from '../common/errors.js';
import {
  assertRolesCompatible,
  formatRoleField,
  parseRoleField,
  permissionsForRoles,
} from '../common/roles.js';
import { serialize } from '../common/serialize.js';
import { PrismaService } from '../prisma/prisma.service.js';

const userInclude = { department: true } as const;

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(includeInactive: boolean) {
    const rows = await this.prisma.user.findMany({
      where: includeInactive ? undefined : { archivedAt: null },
      include: userInclude,
      orderBy: { name: 'asc' },
    });
    return serialize(rows.map((row) => this.toOut(row)));
  }

  async getById(id: string) {
    const row = await this.prisma.user.findUnique({
      where: { id },
      include: userInclude,
    });
    if (!row) throw notFound('User', id);
    return serialize(this.toOut(row));
  }

  async create(
    body: {
      email: string;
      display_name: string;
      department: string | null;
      roles: string[];
      reason: string;
    },
    session: UserSession,
  ) {
    this.requireReason(body.reason);
    if (!body.roles.length) {
      throw new DomainException('At least one role is required.');
    }
    try {
      assertRolesCompatible(body.roles);
    } catch (error) {
      throw new DomainException(
        error instanceof Error ? error.message : 'Incompatible roles',
        HttpStatus.UNPROCESSABLE_ENTITY,
        'ROLE_COMPOSITION',
      );
    }

    const email = body.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new DomainException('A user with that email already exists.', HttpStatus.CONFLICT);
    }

    const departmentId = await this.resolveDepartmentId(body.department);
    const row = await this.prisma.user.create({
      data: {
        id: randomUUID(),
        email,
        name: body.display_name.trim(),
        emailVerified: false,
        role: formatRoleField(body.roles),
        departmentId,
      },
      include: userInclude,
    });

    await this.audit.append({
      action: 'user.created',
      actorId: session.user.id,
      actorLabel: session.user.name ?? session.user.email,
      subjectType: 'user',
      subjectId: row.id,
      detail: { email: row.email, roles: body.roles, reason: body.reason.trim() },
    });

    return serialize(this.toOut(row));
  }

  async setRoles(
    id: string,
    body: { roles: string[]; reason: string },
    session: UserSession,
  ) {
    this.requireReason(body.reason);
    try {
      assertRolesCompatible(body.roles);
    } catch (error) {
      throw new DomainException(
        error instanceof Error ? error.message : 'Incompatible roles',
        HttpStatus.UNPROCESSABLE_ENTITY,
        'ROLE_COMPOSITION',
      );
    }

    const before = await this.prisma.user.findUnique({ where: { id } });
    if (!before) throw notFound('User', id);

    const row = await this.prisma.user.update({
      where: { id },
      data: { role: formatRoleField(body.roles) },
      include: userInclude,
    });

    await this.audit.append({
      action: 'user.roles_updated',
      actorId: session.user.id,
      actorLabel: session.user.name ?? session.user.email,
      subjectType: 'user',
      subjectId: row.id,
      detail: {
        before: parseRoleField(before.role),
        after: body.roles,
        reason: body.reason.trim(),
      },
    });

    return serialize(this.toOut(row));
  }

  async setActive(
    id: string,
    body: { is_active: boolean; reason: string },
    session: UserSession,
  ) {
    this.requireReason(body.reason);

    const before = await this.prisma.user.findUnique({ where: { id } });
    if (!before) throw notFound('User', id);

    const row = await this.prisma.user.update({
      where: { id },
      data: body.is_active
        ? {
            archivedAt: null,
            archivedReason: null,
            banned: false,
            banReason: null,
          }
        : {
            archivedAt: new Date(),
            archivedReason: body.reason.trim(),
            banned: true,
            banReason: body.reason.trim(),
          },
      include: userInclude,
    });

    await this.audit.append({
      action: body.is_active ? 'user.reactivated' : 'user.deactivated',
      actorId: session.user.id,
      actorLabel: session.user.name ?? session.user.email,
      subjectType: 'user',
      subjectId: row.id,
      detail: { reason: body.reason.trim() },
    });

    return serialize(this.toOut(row));
  }

  private toOut(row: {
    id: string;
    email: string;
    name: string;
    role: string | null;
    archivedAt: Date | null;
    banned: boolean | null;
    department: { name: string } | null;
  }) {
    const roles = parseRoleField(row.role);
    return {
      id: row.id,
      email: row.email,
      display_name: row.name,
      department: row.department?.name ?? null,
      is_active: row.archivedAt === null && row.banned !== true,
      roles,
      permissions: permissionsForRoles(roles),
    };
  }

  private requireReason(reason: string) {
    if (!reason?.trim() || reason.trim().length < 3) {
      throw new DomainException('A reason of at least 3 characters is required.');
    }
  }

  private async resolveDepartmentId(department: string | null): Promise<string | null> {
    const name = department?.trim();
    if (!name) return null;
    const row = await this.prisma.department.findFirst({
      where: {
        OR: [{ name: { equals: name, mode: 'insensitive' } }, { costCentreNumber: name }],
      },
    });
    if (!row) {
      throw new DomainException(`No department matches "${name}".`);
    }
    return row.id;
  }
}
