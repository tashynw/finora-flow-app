import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DomainException } from './errors.js';

@Injectable()
export class TransitionsService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: {
    recordType: string;
    recordId: string;
    fromState: string;
    toState: string;
    source?: string;
    actorId?: string | null;
    actorLabel: string;
    reason?: string | null;
    correlationId?: string;
    context?: Prisma.InputJsonValue;
  }) {
    return this.prisma.stateTransition.create({
      data: {
        recordType: input.recordType,
        recordId: input.recordId,
        fromState: input.fromState,
        toState: input.toState,
        source: input.source ?? 'user',
        actorId: input.actorId ?? null,
        actorLabel: input.actorLabel,
        reason: input.reason ?? null,
        correlationId: input.correlationId ?? crypto.randomUUID(),
        context: input.context ?? {},
      },
    });
  }

  assertTransition(
    allowed: Record<string, readonly string[]>,
    from: string,
    to: string,
  ) {
    const targets = allowed[from] ?? [];
    if (!targets.includes(to)) {
      throw new DomainException(
        `Transition from ${from} to ${to} is not allowed`,
        undefined,
        'INVALID_TRANSITION',
      );
    }
  }
}
