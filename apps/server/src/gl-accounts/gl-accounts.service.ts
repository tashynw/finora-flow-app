import { Injectable } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { AuditService } from '../common/audit.service.js';
import { conflict, DomainException, notFound } from '../common/errors.js';
import type { GlAccount } from '../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';

const SUBJECT = 'gl_account';
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

function toGlAccountOut(row: GlAccount) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isActive: row.isActive,
  };
}

@Injectable()
export class GlAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(includeInactive: boolean) {
    const rows = await this.prisma.glAccount.findMany({
      where: includeInactive
        ? undefined
        : { isActive: true, archivedAt: null },
      orderBy: { code: 'asc' },
    });
    return rows.map(toGlAccountOut);
  }

  async create(
    session: UserSession,
    body: { code: string; name: string; reason?: string },
  ) {
    const cleanedCode = requireCode(body.code);
    const cleanedName = requireName(body.name);
    const cleanedReason = optionalReason(
      body.reason,
      'Say why this GL account is being added.',
    );

    const existing = await this.prisma.glAccount.findUnique({
      where: { code: cleanedCode },
    });
    if (existing) {
      throw conflict('A GL account with that code already exists.');
    }

    const row = await this.prisma.glAccount.create({
      data: {
        code: cleanedCode,
        name: cleanedName,
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
        reason: cleanedReason ?? null,
      },
    });

    return toGlAccountOut(row);
  }

  async update(
    session: UserSession,
    id: string,
    body: { name?: string; reason?: string },
  ) {
    const row = await this.prisma.glAccount.findUnique({ where: { id } });
    if (!row) {
      throw notFound('GL account', id);
    }

    const cleanedReason = requireReason(
      body.reason,
      'Say why this GL account is changing.',
    );
    const beforeName = row.name;

    const updated = await this.prisma.glAccount.update({
      where: { id },
      data: body.name !== undefined ? { name: requireName(body.name) } : {},
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
        before: { name: beforeName },
        after: { name: updated.name },
        reason: cleanedReason,
      },
    });

    return toGlAccountOut(updated);
  }

  async setActive(
    session: UserSession,
    id: string,
    body: { isActive: boolean; reason?: string },
  ) {
    const row = await this.prisma.glAccount.findUnique({ where: { id } });
    if (!row) {
      throw notFound('GL account', id);
    }

    const cleanedReason = optionalReason(
      body.reason,
      'Say why this GL account is being changed.',
    );

    if (
      row.isActive === body.isActive &&
      ((body.isActive && row.archivedAt === null) ||
        (!body.isActive && row.archivedAt !== null))
    ) {
      return toGlAccountOut(row);
    }

    const now = new Date();
    const updated = await this.prisma.glAccount.update({
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

    return toGlAccountOut(updated);
  }
}
