import type { UserSession } from '@thallesp/nestjs-better-auth';
import {
  InvoiceStatus,
  type Invoice,
} from '../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from './audit.service.js';
import { TransitionsService } from './transitions.service.js';

const INVOICE_RECORD = 'invoice';

export function actorLabel(session: UserSession): string {
  return session.user.name ?? session.user.email ?? session.user.id;
}

export async function moveInvoiceStatus(
  deps: {
    prisma: PrismaService;
    transitions: TransitionsService;
    audit: AuditService;
  },
  invoice: Invoice,
  target: InvoiceStatus,
  session: UserSession,
  reason: string,
  correlationId?: string,
) {
  const from = invoice.status;
  if (from === target) {
    return invoice;
  }

  const updated = await deps.prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: target, version: { increment: 1 } },
  });

  await deps.transitions.record({
    recordType: INVOICE_RECORD,
    recordId: invoice.id,
    fromState: from,
    toState: target,
    actorId: session.user.id,
    actorLabel: actorLabel(session),
    reason,
    correlationId,
    context: { reference: invoice.reference },
  });

  await deps.audit.append({
    action: 'state_changed',
    actorId: session.user.id,
    actorLabel: actorLabel(session),
    subjectType: INVOICE_RECORD,
    subjectId: invoice.id,
    correlationId: correlationId ?? null,
    detail: {
      reference: invoice.reference,
      from,
      to: target,
      reason,
    },
  });

  return updated;
}
