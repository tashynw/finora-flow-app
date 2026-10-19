import { Injectable } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { AuditService } from '../common/audit.service.js';
import { conflict, DomainException, notFound } from '../common/errors.js';
import { Currency, type Vendor } from '../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';

const SUBJECT = 'vendor';
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

function parseCurrency(value: string | undefined, fallback: Currency) {
  const cleaned = (value ?? fallback).trim().toUpperCase();
  if (cleaned !== Currency.JMD && cleaned !== Currency.USD) {
    throw new DomainException('Currency must be JMD or USD.');
  }
  return cleaned as Currency;
}

function toVendorOut(row: Vendor) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    email: row.email,
    phone: row.phone,
    defaultCurrency: row.defaultCurrency,
    paymentTermsDays: row.paymentTermsDays,
    isActive: row.isActive,
  };
}

@Injectable()
export class VendorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(includeInactive: boolean) {
    const rows = await this.prisma.vendor.findMany({
      where: includeInactive
        ? undefined
        : { isActive: true, archivedAt: null },
      orderBy: { code: 'asc' },
    });
    return rows.map(toVendorOut);
  }

  async create(
    session: UserSession,
    body: {
      code: string;
      name: string;
      email?: string | null;
      phone?: string | null;
      defaultCurrency?: string;
      paymentTermsDays?: number | null;
      reason?: string;
    },
  ) {
    const cleanedCode = requireCode(body.code);
    const cleanedName = requireName(body.name);
    const cleanedReason = optionalReason(
      body.reason,
      'Say why this vendor is being added.',
    );
    const defaultCurrency = parseCurrency(body.defaultCurrency, Currency.JMD);

    if (body.paymentTermsDays != null && body.paymentTermsDays < 0) {
      throw new DomainException('Payment terms cannot be negative.');
    }

    const existing = await this.prisma.vendor.findUnique({
      where: { code: cleanedCode },
    });
    if (existing) {
      throw conflict('A vendor with that code already exists.');
    }

    const row = await this.prisma.vendor.create({
      data: {
        code: cleanedCode,
        name: cleanedName,
        email: body.email?.trim() || null,
        phone: body.phone?.trim() || null,
        defaultCurrency,
        paymentTermsDays: body.paymentTermsDays ?? null,
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

    return toVendorOut(row);
  }

  async update(
    session: UserSession,
    id: string,
    body: {
      name?: string;
      email?: string | null;
      phone?: string | null;
      defaultCurrency?: string;
      paymentTermsDays?: number | null;
      reason?: string;
    },
  ) {
    const row = await this.prisma.vendor.findUnique({ where: { id } });
    if (!row) {
      throw notFound('Vendor', id);
    }

    const cleanedReason = requireReason(
      body.reason,
      'Say why this vendor is changing.',
    );

    const before = {
      name: row.name,
      email: row.email,
      phone: row.phone,
      defaultCurrency: row.defaultCurrency,
      paymentTermsDays: row.paymentTermsDays,
    };

    const data: {
      name?: string;
      email?: string | null;
      phone?: string | null;
      defaultCurrency?: Currency;
      paymentTermsDays?: number | null;
    } = {};

    if (body.name !== undefined) {
      data.name = requireName(body.name);
    }
    if (body.email !== undefined) {
      data.email = body.email?.trim() || null;
    }
    if (body.phone !== undefined) {
      data.phone = body.phone?.trim() || null;
    }
    if (body.defaultCurrency !== undefined) {
      data.defaultCurrency = parseCurrency(body.defaultCurrency, row.defaultCurrency);
    }
    if (body.paymentTermsDays !== undefined) {
      if (body.paymentTermsDays != null && body.paymentTermsDays < 0) {
        throw new DomainException('Payment terms cannot be negative.');
      }
      data.paymentTermsDays = body.paymentTermsDays;
    }

    const updated = await this.prisma.vendor.update({
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
          email: updated.email,
          phone: updated.phone,
          defaultCurrency: updated.defaultCurrency,
          paymentTermsDays: updated.paymentTermsDays,
        },
        reason: cleanedReason,
      },
    });

    return toVendorOut(updated);
  }

  async setActive(
    session: UserSession,
    id: string,
    body: { isActive: boolean; reason?: string },
  ) {
    const row = await this.prisma.vendor.findUnique({ where: { id } });
    if (!row) {
      throw notFound('Vendor', id);
    }

    const cleanedReason = optionalReason(
      body.reason,
      'Say why this vendor is being changed.',
    );

    if (
      row.isActive === body.isActive &&
      ((body.isActive && row.archivedAt === null) ||
        (!body.isActive && row.archivedAt !== null))
    ) {
      return toVendorOut(row);
    }

    const now = new Date();
    const updated = await this.prisma.vendor.update({
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

    return toVendorOut(updated);
  }
}
