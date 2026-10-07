import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { actorLabel } from '../common/invoice-status.js';
import { AuditService } from '../common/audit.service.js';
import { DomainException, notFound } from '../common/errors.js';
import { nextReference } from '../common/ids.js';
import { formatMinorUnits } from '../common/money-format.js';
import { InvoiceStatus } from '../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';

const SUBJECT = 'accrual_period';
const CANDIDATE_SOURCE_STATUSES: InvoiceStatus[] = [
  InvoiceStatus.APPROVED,
  InvoiceStatus.OUTSTANDING,
  InvoiceStatus.EXCEPTION,
  InvoiceStatus.ACCRUAL_NEEDED,
  InvoiceStatus.READY_FOR_SUBMISSION,
];

const EXPORT_COLUMNS = [
  'reference',
  'standing',
  'invoice_reference',
  'invoice_number',
  'vendor',
  'description',
  'currency',
  'amount',
  'department',
  'gl_code',
  'cost_centre_code',
  'edit_reason',
  'note',
] as const;

@Injectable()
export class AccrualsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listPeriods() {
    return this.prisma.accrualPeriod.findMany({
      orderBy: { periodEnd: 'desc' },
    });
  }

  async createPeriod(
    session: UserSession,
    body: {
      periodStart: string;
      periodEnd: string;
      label: string;
    },
  ) {
    const periodStart = new Date(body.periodStart);
    const periodEnd = new Date(body.periodEnd);
    if (periodEnd < periodStart) {
      throw new DomainException('The period end must be on or after the period start.');
    }

    const row = await this.prisma.accrualPeriod.create({
      data: {
        reference: nextReference('ACP'),
        periodStart,
        periodEnd,
        label: body.label.trim(),
        openedAt: new Date(),
        openedById: session.user.id,
      },
    });

    await this.audit.append({
      action: 'accrual_period_opened',
      actorId: session.user.id,
      actorLabel: actorLabel(session),
      subjectType: SUBJECT,
      subjectId: row.id,
      detail: { reference: row.reference },
    });

    return row;
  }

  async getPeriod(id: string) {
    const period = await this.prisma.accrualPeriod.findUnique({
      where: { id },
      include: {
        candidates: {
          include: {
            invoice: true,
            glAccount: true,
            costCentre: true,
            department: true,
          },
        },
        exports: { orderBy: { version: 'desc' } },
      },
    });
    if (!period) throw notFound('Accrual period', id);
    return period;
  }

  async generateCandidates(session: UserSession, periodId: string) {
    const period = await this.prisma.accrualPeriod.findUnique({
      where: { id: periodId },
    });
    if (!period) throw notFound('Accrual period', periodId);
    if (period.lockedAt) {
      throw new DomainException('This period is locked.');
    }

    const invoices = await this.prisma.invoice.findMany({
      where: {
        status: { in: CANDIDATE_SOURCE_STATUSES },
        archivedAt: null,
        invoiceDate: { lte: period.periodEnd },
        totalMinorUnits: { not: null },
        currency: { not: null },
        accrualCandidates: { none: { periodId } },
      },
      include: { vendor: true },
    });

    if (invoices.length) {
      await this.prisma.accrualCandidate.createMany({
        data: invoices.map((invoice) => ({
          reference: nextReference('ACC'),
          standing: 'proposed',
          currency: invoice.currency!,
          amountMinorUnits: invoice.totalMinorUnits!,
          originalAmountMinorUnits: invoice.totalMinorUnits!,
          vendorName: invoice.vendor?.name ?? 'Unknown supplier',
          invoiceNumber: invoice.invoiceNumber,
          invoiceReference: invoice.reference,
          description: invoice.description,
          periodId,
          invoiceId: invoice.id,
          glAccountId: invoice.glAccountId,
          costCentreId: invoice.costCentreId,
          departmentId: invoice.departmentId,
        })),
      });
    }

    await this.audit.append({
      action: 'accrual_candidates_generated',
      actorId: session.user.id,
      actorLabel: actorLabel(session),
      subjectType: SUBJECT,
      subjectId: periodId,
      detail: { count: invoices.length },
    });

    return this.getPeriod(periodId);
  }

  async patchCandidate(
    session: UserSession,
    id: string,
    body: {
      amountMinorUnits?: string | number;
      exclude?: boolean;
      note?: string | null;
      editReason?: string;
    },
  ) {
    const candidate = await this.prisma.accrualCandidate.findUnique({
      where: { id },
      include: { period: true },
    });
    if (!candidate) throw notFound('Accrual candidate', id);
    if (candidate.period.lockedAt) {
      throw new DomainException('The period is locked.');
    }
    if (candidate.finalizedAt) {
      throw new DomainException('This candidate is already finalized.');
    }

    const data: {
      amountMinorUnits?: bigint;
      standing?: string;
      note?: string | null;
      editReason?: string | null;
      version?: { increment: number };
    } = { version: { increment: 1 } };

    if (body.exclude === true) {
      data.standing = 'excluded';
    } else if (body.amountMinorUnits != null) {
      data.amountMinorUnits = BigInt(body.amountMinorUnits);
      data.standing = 'adjusted';
      data.editReason = body.editReason?.trim() || null;
    }

    if (body.note !== undefined) {
      data.note = body.note?.trim() || null;
    }

    await this.prisma.accrualCandidate.update({ where: { id }, data });

    await this.audit.append({
      action: 'accrual_candidate_updated',
      actorId: session.user.id,
      actorLabel: actorLabel(session),
      subjectType: 'accrual_candidate',
      subjectId: id,
      detail: {},
    });

    return this.prisma.accrualCandidate.findUniqueOrThrow({
      where: { id },
      include: { invoice: true, glAccount: true, costCentre: true },
    });
  }

  async finalizeCandidate(session: UserSession, id: string) {
    const candidate = await this.prisma.accrualCandidate.findUnique({
      where: { id },
      include: { period: true },
    });
    if (!candidate) throw notFound('Accrual candidate', id);
    if (candidate.period.lockedAt) {
      throw new DomainException('The period is locked.');
    }
    if (candidate.standing === 'excluded') {
      throw new DomainException('Excluded candidates cannot be finalized.');
    }
    if (candidate.finalizedAt) {
      return candidate;
    }

    return this.prisma.accrualCandidate.update({
      where: { id },
      data: {
        standing: 'finalized',
        finalizedAt: new Date(),
        finalizedById: session.user.id,
        version: { increment: 1 },
      },
    });
  }

  async lockPeriod(session: UserSession, id: string, body: { reason: string }) {
    const period = await this.prisma.accrualPeriod.findUnique({
      where: { id },
    });
    if (!period) throw notFound('Accrual period', id);
    if (period.lockedAt) {
      throw new DomainException('This period is already locked.');
    }

    const candidateCount = await this.prisma.accrualCandidate.count({
      where: { periodId: id },
    });
    if (!candidateCount) {
      throw new DomainException('Generate candidates before locking.');
    }

    const openCount = await this.prisma.accrualCandidate.count({
      where: {
        periodId: id,
        standing: { notIn: ['finalized', 'excluded'] },
      },
    });
    if (openCount > 0) {
      throw new DomainException(
        'Every candidate must be finalized or excluded before locking.',
      );
    }

    const reason = body.reason?.trim();
    if (!reason || reason.length < 3) {
      throw new DomainException('Give a reason for locking this period.');
    }

    const updated = await this.prisma.accrualPeriod.update({
      where: { id },
      data: {
        lockedAt: new Date(),
        lockReason: reason,
        lockedById: session.user.id,
        version: { increment: 1 },
      },
    });

    await this.audit.append({
      action: 'accrual_period_locked',
      actorId: session.user.id,
      actorLabel: actorLabel(session),
      subjectType: SUBJECT,
      subjectId: id,
      detail: { reason },
    });

    return updated;
  }

  async exportPeriod(
    session: UserSession,
    id: string,
    body: { format: string; official?: boolean },
  ) {
    const period = await this.prisma.accrualPeriod.findUnique({
      where: { id },
    });
    if (!period) throw notFound('Accrual period', id);
    if (body.official && !period.lockedAt) {
      throw new DomainException('Lock the period before producing an official export.');
    }

    const rows = await this.prisma.accrualCandidate.findMany({
      where: { periodId: id, standing: { not: 'excluded' } },
      include: {
        department: true,
        glAccount: true,
        costCentre: true,
      },
      orderBy: { reference: 'asc' },
    });
    const lines: string[] = [EXPORT_COLUMNS.join(',')];

    for (const c of rows) {
      lines.push(
        [
          c.reference,
          c.standing,
          c.invoiceReference ?? '',
          c.invoiceNumber ?? '',
          c.vendorName,
          c.description,
          c.currency,
          formatMinorUnits(c.amountMinorUnits, c.currency, false),
          c.department?.name ?? '',
          c.glAccount?.code ?? '',
          c.costCentre?.code ?? '',
          c.editReason ?? '',
          c.note ?? '',
        ]
          .map((cell) =>
            /[",\n]/.test(String(cell))
              ? `"${String(cell).replace(/"/g, '""')}"`
              : String(cell),
          )
          .join(','),
      );
    }

    const csv = lines.join('\n');
    const sha256 = createHash('sha256').update(csv, 'utf8').digest('hex');
    const byteSize = Buffer.byteLength(csv, 'utf8');

    const latest = await this.prisma.accrualExport.findFirst({
      where: { periodId: id },
      orderBy: { version: 'desc' },
    });
    const version = (latest?.version ?? 0) + 1;
    const filename = `${period.reference}-export-v${version}.${body.format === 'csv' ? 'csv' : body.format}`;

    const exportRow = await this.prisma.accrualExport.create({
      data: {
        format: body.format,
        official: body.official === true,
        filename,
        sha256,
        byteSize,
        rowCount: rows.length,
        generatedAt: new Date(),
        version,
        periodId: id,
        generatedById: session.user.id,
      },
    });

    await this.audit.append({
      action: 'accrual_export_generated',
      actorId: session.user.id,
      actorLabel: actorLabel(session),
      subjectType: SUBJECT,
      subjectId: id,
      detail: { exportId: exportRow.id, filename },
    });

    return { export: exportRow, csv };
  }
}
