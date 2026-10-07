import { Injectable } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { AuditService } from '../common/audit.service.js';
import { DomainException, notFound } from '../common/errors.js';
import { serialize } from '../common/serialize.js';
import { Currency } from '../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class AdminThresholdsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(includeInactive: boolean) {
    const rows = await this.prisma.purchaseOrderThreshold.findMany({
      where: includeInactive ? undefined : { isActive: true },
      orderBy: { currency: 'asc' },
    });
    return serialize(rows.map((row) => this.toOut(row)));
  }

  async upsert(
    body: { currency: string; applies_above_minor_units: number; reason: string },
    session: UserSession,
  ) {
    this.requireReason(body.reason);
    const currency = this.parseCurrency(body.currency);
    const appliesAbove = BigInt(body.applies_above_minor_units);

    const existing = await this.prisma.purchaseOrderThreshold.findUnique({
      where: { currency },
    });

    const row = existing
      ? await this.prisma.purchaseOrderThreshold.update({
          where: { currency },
          data: {
            appliesAboveMinorUnits: appliesAbove,
            isActive: true,
            version: { increment: 1 },
          },
        })
      : await this.prisma.purchaseOrderThreshold.create({
          data: {
            currency,
            appliesAboveMinorUnits: appliesAbove,
            isActive: true,
          },
        });

    await this.audit.append({
      action: existing ? 'threshold.updated' : 'threshold.created',
      actorId: session.user.id,
      actorLabel: session.user.name ?? session.user.email,
      subjectType: 'purchase_order_threshold',
      subjectId: row.id,
      detail: {
        currency,
        applies_above_minor_units: body.applies_above_minor_units,
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
    const before = await this.prisma.purchaseOrderThreshold.findUnique({ where: { id } });
    if (!before) throw notFound('Purchase order threshold', id);

    const row = await this.prisma.purchaseOrderThreshold.update({
      where: { id },
      data: {
        isActive: body.is_active,
        version: { increment: 1 },
      },
    });

    await this.audit.append({
      action: 'threshold.active_set',
      actorId: session.user.id,
      actorLabel: session.user.name ?? session.user.email,
      subjectType: 'purchase_order_threshold',
      subjectId: row.id,
      detail: { is_active: body.is_active, reason: body.reason.trim() },
    });

    return serialize(this.toOut(row));
  }

  private toOut(row: {
    id: string;
    currency: Currency;
    appliesAboveMinorUnits: bigint;
    isActive: boolean;
  }) {
    return {
      id: row.id,
      currency: row.currency,
      applies_above_minor_units: row.appliesAboveMinorUnits.toString(),
      is_active: row.isActive,
    };
  }

  private parseCurrency(code: string): Currency {
    const upper = code.trim().toUpperCase();
    if (upper === Currency.JMD || upper === Currency.USD) return upper as Currency;
    throw new DomainException('Currency must be JMD or USD.');
  }

  private requireReason(reason: string) {
    if (!reason?.trim() || reason.trim().length < 3) {
      throw new DomainException('A reason of at least 3 characters is required.');
    }
  }
}
