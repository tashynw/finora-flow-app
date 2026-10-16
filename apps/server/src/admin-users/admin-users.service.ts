import { randomBytes } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { APIError } from 'better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { auth } from '../better-auth/config.js';
import { AuditService } from '../common/audit.service.js';
import { DomainException, notFound } from '../common/errors.js';
import {
  assertRolesCompatible,
  FINORA_ROLE_IDS,
  formatRoleField,
  parseRoleField,
  permissionsForRoles,
  type FinoraRoleId,
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
      department_id?: string | null;
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
      throw new DomainException(
        'A user with that email already exists.',
        HttpStatus.CONFLICT,
      );
    }
    this.requireKnownRoles(body.roles);

    const departmentId = await this.resolveChosenDepartment(body);
    // A password the person never sees. The invitation email asks them to choose
    // their own, the same way an invite creates the account and then sends a
    // reset link.
    const temporaryPassword = randomBytes(18).toString('base64url');
    try {
      await auth.api.createUser({
        body: {
          email,
          password: temporaryPassword,
          name: body.display_name.trim(),
          role: body.roles as FinoraRoleId[],
        },
      });
    } catch (error) {
      throw new DomainException(authFailure(error), HttpStatus.BAD_REQUEST);
    }

    const row = await this.prisma.user.update({
      where: { email },
      data: { departmentId, role: formatRoleField(body.roles) },
      include: userInclude,
    });

    await this.sendInvite(email).catch(() => {
      throw new DomainException(
        'The account was created, but the invitation email could not be sent. Use Resend invite.',
        HttpStatus.BAD_GATEWAY,
      );
    });

    await this.audit.append({
      action: 'user.created',
      actorId: session.user.id,
      actorLabel: session.user.name ?? session.user.email,
      subjectType: 'user',
      subjectId: row.id,
      detail: {
        email: row.email,
        roles: body.roles,
        reason: body.reason.trim(),
      },
    });

    return serialize(this.toOut(row));
  }

  async resendInvite(id: string, session: UserSession) {
    const row = await this.prisma.user.findUnique({
      where: { id },
      include: userInclude,
    });
    if (!row) throw notFound('User', id);
    if (row.emailVerified) {
      throw new DomainException('This person has already set a password.');
    }
    if (row.archivedAt !== null || row.banned === true) {
      throw new DomainException('A deactivated account cannot be invited.');
    }

    await this.sendInvite(row.email);

    await this.audit.append({
      action: 'user.invite_resent',
      actorId: session.user.id,
      actorLabel: session.user.name ?? session.user.email,
      subjectType: 'user',
      subjectId: row.id,
      detail: { email: row.email },
    });

    return serialize(this.toOut(row));
  }

  async setRoles(id: string, body: { roles: string[] }, session: UserSession) {
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
      },
    });

    return serialize(this.toOut(row));
  }

  async update(
    id: string,
    body: {
      display_name: string;
      department_id?: string | null;
      job_title?: string | null;
      reason: string;
    },
    session: UserSession,
  ) {
    this.requireReason(body.reason);
    const displayName = body.display_name?.trim();
    if (!displayName) {
      throw new DomainException('A display name is required.');
    }

    const before = await this.prisma.user.findUnique({
      where: { id },
      include: userInclude,
    });
    if (!before) throw notFound('User', id);

    const departmentId = await this.resolveProfileDepartment(
      body.department_id,
      before.departmentId,
    );
    const jobTitle = body.job_title?.trim() ? body.job_title.trim() : null;

    const row = await this.prisma.user.update({
      where: { id },
      data: { name: displayName, departmentId, jobTitle },
      include: userInclude,
    });

    await this.audit.append({
      action: 'user.profile_updated',
      actorId: session.user.id,
      actorLabel: session.user.name ?? session.user.email,
      subjectType: 'user',
      subjectId: row.id,
      detail: {
        reason: body.reason.trim(),
        before: {
          display_name: before.name,
          department_id: before.departmentId,
          job_title: before.jobTitle,
        },
        after: {
          display_name: displayName,
          department_id: departmentId,
          job_title: jobTitle,
        },
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
    emailVerified: boolean;
    archivedAt: Date | null;
    banned: boolean | null;
    department: { id: string; name: string } | null;
    jobTitle?: string | null;
  }) {
    const roles = parseRoleField(row.role);
    return {
      id: row.id,
      email: row.email,
      display_name: row.name,
      department: row.department?.name ?? null,
      department_id: row.department?.id ?? null,
      job_title: row.jobTitle ?? null,
      is_active: row.archivedAt === null && row.banned !== true,
      email_verified: row.emailVerified,
      roles,
      permissions: permissionsForRoles(roles),
    };
  }

  private requireReason(reason: string) {
    if (!reason?.trim() || reason.trim().length < 3) {
      throw new DomainException(
        'A reason of at least 3 characters is required.',
      );
    }
  }

  private async resolveChosenDepartment(body: {
    department: string | null;
    department_id?: string | null;
  }): Promise<string | null> {
    const id = body.department_id?.trim();
    if (id) {
      const row = await this.prisma.department.findUnique({ where: { id } });
      if (!row || !row.isActive) {
        throw new DomainException('That department is not available.');
      }
      return row.id;
    }
    return this.resolveDepartmentId(body.department);
  }

  private async resolveProfileDepartment(
    departmentId: string | null | undefined,
    currentId: string | null,
  ): Promise<string | null> {
    const id = departmentId?.trim() ?? '';
    if (!id) return null;
    if (id === currentId) return currentId;
    const row = await this.prisma.department.findUnique({ where: { id } });
    if (!row || !row.isActive) {
      throw new DomainException('That department is not available.');
    }
    return row.id;
  }

  private async resolveDepartmentId(
    department: string | null,
  ): Promise<string | null> {
    const name = department?.trim();
    if (!name) return null;
    const row = await this.prisma.department.findFirst({
      where: {
        OR: [
          { name: { equals: name, mode: 'insensitive' } },
          { costCentreNumber: name },
        ],
      },
    });
    if (!row) {
      throw new DomainException(`No department matches "${name}".`);
    }
    return row.id;
  }

  private requireKnownRoles(roles: string[]) {
    for (const role of roles) {
      if (!FINORA_ROLE_IDS.includes(role as FinoraRoleId)) {
        throw new DomainException(`Unknown role: ${role}`);
      }
    }
  }

  private async sendInvite(email: string) {
    const origin = (process.env.WEB_ORIGIN ?? 'http://localhost:5173').replace(
      /\/$/,
      '',
    );
    try {
      await auth.api.requestPasswordReset({
        body: {
          email,
          redirectTo: `${origin}/reset-password`,
        },
      });
    } catch (error) {
      throw new DomainException(authFailure(error), HttpStatus.BAD_GATEWAY);
    }
  }
}

function authFailure(error: unknown): string {
  if (error instanceof APIError) {
    return error.message || 'The invitation could not be sent.';
  }
  if (error instanceof Error && error.message) return error.message;
  return 'The invitation could not be sent.';
}
