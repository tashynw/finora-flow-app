import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type AuditWriteInput = {
  action: string;
  actorType?: string;
  actorId?: string | null;
  actorLabel: string;
  subjectType: string;
  subjectId?: string | null;
  correlationId?: string | null;
  detail?: Prisma.InputJsonValue;
  sourceIp?: string | null;
  userAgent?: string | null;
};

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async append(input: AuditWriteInput) {
    const latest = await this.prisma.auditEntry.findFirst({
      orderBy: { sequence: 'desc' },
      select: { sequence: true, entryHash: true },
    });

    const sequence = (latest?.sequence ?? 0n) + 1n;
    const previousHash = latest?.entryHash ?? 'genesis';
    const occurredAt = new Date();
    const detail = input.detail ?? {};

    const payload = [
      sequence.toString(),
      previousHash,
      occurredAt.toISOString(),
      input.action,
      input.actorType ?? 'user',
      input.actorId ?? '',
      input.actorLabel,
      input.subjectType,
      input.subjectId ?? '',
      input.correlationId ?? '',
      JSON.stringify(detail),
    ].join('|');

    const entryHash = createHash('sha256').update(payload).digest('hex');

    return this.prisma.auditEntry.create({
      data: {
        sequence,
        previousHash,
        entryHash,
        occurredAt,
        action: input.action,
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        actorLabel: input.actorLabel,
        subjectType: input.subjectType,
        subjectId: input.subjectId ?? null,
        correlationId: input.correlationId ?? null,
        detail,
        sourceIp: input.sourceIp ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  }

  async list(filters: {
    action?: string;
    subjectType?: string;
    limit?: number;
    offset?: number;
  }) {
    const where: Prisma.AuditEntryWhereInput = {};
    if (filters.action) where.action = filters.action;
    if (filters.subjectType) where.subjectType = filters.subjectType;

    const take = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const skip = Math.max(filters.offset ?? 0, 0);

    const [items, total] = await Promise.all([
      this.prisma.auditEntry.findMany({
        where,
        orderBy: { sequence: 'asc' },
        take,
        skip,
      }),
      this.prisma.auditEntry.count({ where }),
    ]);

    return { items, total, limit: take, offset: skip };
  }

  async getBySequence(sequence: bigint) {
    return this.prisma.auditEntry.findUnique({ where: { sequence } });
  }

  async verify(startSequence = 1n, limit = 500) {
    const entries = await this.prisma.auditEntry.findMany({
      where: { sequence: { gte: startSequence } },
      orderBy: { sequence: 'asc' },
      take: limit,
    });

    let expectedPrevious = 'genesis';
    if (startSequence > 1n) {
      const prior = await this.prisma.auditEntry.findUnique({
        where: { sequence: startSequence - 1n },
      });
      expectedPrevious = prior?.entryHash ?? 'genesis';
    }

    let checked = 0;
    for (const entry of entries) {
      checked += 1;
      if (entry.previousHash !== expectedPrevious) {
        return {
          ok: false,
          checkedCount: checked,
          firstBadSequence: entry.sequence.toString(),
          message: 'Hash chain broken',
          reason: 'previous_hash_mismatch',
        };
      }

      const payload = [
        entry.sequence.toString(),
        entry.previousHash,
        entry.occurredAt.toISOString(),
        entry.action,
        entry.actorType,
        entry.actorId ?? '',
        entry.actorLabel,
        entry.subjectType,
        entry.subjectId ?? '',
        entry.correlationId ?? '',
        JSON.stringify(entry.detail),
      ].join('|');

      const recomputed = createHash('sha256').update(payload).digest('hex');
      if (recomputed !== entry.entryHash) {
        return {
          ok: false,
          checkedCount: checked,
          firstBadSequence: entry.sequence.toString(),
          message: 'Entry hash mismatch',
          reason: 'entry_hash_mismatch',
        };
      }

      expectedPrevious = entry.entryHash;
    }

    return {
      ok: true,
      checkedCount: checked,
      message: 'Chain intact',
    };
  }
}
