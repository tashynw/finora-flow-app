import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { actorLabel } from '../common/invoice-status.js';
import { AuditService } from '../common/audit.service.js';
import { DomainException, notFound } from '../common/errors.js';
import { nextReference } from '../common/ids.js';
import { formatMinorUnits } from '../common/money-format.js';
import {
  parseRoleField,
  permissionsForRoles,
} from '../common/roles.js';
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

const PERIOD_STANDING = {
  open: {
    label: 'Open',
    description:
      'Still being reviewed. Candidates can change; nothing is locked for export.',
  },
  locked: {
    label: 'Locked',
    description:
      'Locked. Candidates are fixed, and the period cannot be reopened from here.',
  },
} as const;

const CANDIDATE_STANDING_LABELS: Record<string, string> = {
  proposed: 'Proposed',
  adjusted: 'Adjusted',
  finalized: 'Finalized',
  excluded: 'Excluded',
};

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

const periodInclude = {
  candidates: {
    include: {
      invoice: true,
      glAccount: true,
      costCentre: true,
      department: true,
    },
    orderBy: { reference: 'asc' as const },
  },
  exports: { orderBy: { version: 'desc' as const } },
};

type PeriodRow = {
  id: string;
  reference: string;
  periodStart: Date;
  periodEnd: Date;
  label: string;
  lockedAt: Date | null;
  lockReason: string | null;
  openedById: string;
  candidates: Array<{
    id: string;
    reference: string;
    standing: string;
    currency: string;
    amountMinorUnits: bigint;
    originalAmountMinorUnits: bigint;
    vendorName: string;
    invoiceNumber: string | null;
    invoiceReference: string | null;
    description: string;
    editReason: string | null;
    note: string | null;
    finalizedAt: Date | null;
    version: number;
    invoiceId: string | null;
    glAccount: { id: string; code: string; name: string } | null;
    costCentre: { id: string; code: string; name: string } | null;
    department: { id: string; name: string } | null;
  }>;
  exports: Array<{
    id: string;
    version: number;
    format: string;
    official: boolean;
    filename: string;
    sha256: string;
    byteSize: number;
    rowCount: number;
    generatedAt: Date;
  }>;
};

@Injectable()
export class AccrualsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listPeriods(standing?: string | null) {
    const rows = await this.prisma.accrualPeriod.findMany({
      include: {
        candidates: { select: { standing: true } },
      },
      orderBy: { periodEnd: 'desc' },
    });

    const summaries = rows.map((row) =>
      toPeriodSummary(row, row.candidates),
    );
    if (!standing) return summaries;
    return summaries.filter((row) => row.standing === standing);
  }

  async createPeriod(
    session: UserSession,
    body: {
      periodStart?: string;
      periodEnd?: string;
      period_start?: string;
      period_end?: string;
      label: string;
    },
  ) {
    const periodStartRaw = body.period_start ?? body.periodStart;
    const periodEndRaw = body.period_end ?? body.periodEnd;
    if (!periodStartRaw || !periodEndRaw) {
      throw new DomainException('Enter the period start and period end.');
    }
    if (!body.label?.trim()) {
      throw new DomainException('Give the period a label.');
    }

    const periodStart = parseDateOnly(periodStartRaw);
    const periodEnd = parseDateOnly(periodEndRaw);
    if (periodEnd < periodStart) {
      throw new DomainException(
        'The period end must be on or after the period start.',
      );
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

    return this.getPeriod(row.id, session);
  }

  async getPeriod(id: string, session?: UserSession) {
    const period = await this.prisma.accrualPeriod.findUnique({
      where: { id },
      include: periodInclude,
    });
    if (!period) throw notFound('Accrual period', id);
    return toPeriodDetail(period as PeriodRow, await this.actionsFor(period as PeriodRow, session));
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

    return this.getPeriod(periodId, session);
  }

  async patchCandidate(
    session: UserSession,
    id: string,
    body: {
      amountMinorUnits?: string | number | null;
      amount_minor?: string | number | null;
      exclude?: boolean;
      note?: string | null;
      editReason?: string;
      reason?: string;
      description?: string | null;
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

    const amountRaw = body.amount_minor ?? body.amountMinorUnits;
    const reason = (body.reason ?? body.editReason)?.trim() ?? '';
    const excluding = body.exclude === true;
    const adjusting = amountRaw != null && amountRaw !== '';

    if ((excluding || adjusting) && reason.length < 1) {
      throw new DomainException('Give a reason for changing this candidate.');
    }

    const data: {
      amountMinorUnits?: bigint;
      standing?: string;
      note?: string | null;
      editReason?: string | null;
      description?: string;
      version?: { increment: number };
    } = { version: { increment: 1 } };

    if (excluding) {
      data.standing = 'excluded';
      data.editReason = reason;
    } else if (adjusting) {
      data.amountMinorUnits = BigInt(amountRaw);
      data.standing = 'adjusted';
      data.editReason = reason;
    }

    if (body.note !== undefined) {
      data.note = body.note?.trim() || null;
    }
    if (body.description !== undefined && body.description != null) {
      data.description = body.description.trim().slice(0, 500);
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

    const updated = await this.prisma.accrualCandidate.findUniqueOrThrow({
      where: { id },
      include: {
        glAccount: true,
        costCentre: true,
        department: true,
      },
    });
    return toCandidate(updated);
  }

  async finalizeCandidate(session: UserSession, id: string) {
    const candidate = await this.prisma.accrualCandidate.findUnique({
      where: { id },
      include: {
        period: true,
        glAccount: true,
        costCentre: true,
        department: true,
      },
    });
    if (!candidate) throw notFound('Accrual candidate', id);
    if (candidate.period.lockedAt) {
      throw new DomainException('The period is locked.');
    }
    if (candidate.standing === 'excluded') {
      throw new DomainException('Excluded candidates cannot be finalized.');
    }
    if (candidate.finalizedAt) {
      return toCandidate(candidate);
    }

    const updated = await this.prisma.accrualCandidate.update({
      where: { id },
      data: {
        standing: 'finalized',
        finalizedAt: new Date(),
        finalizedById: session.user.id,
        version: { increment: 1 },
      },
      include: {
        glAccount: true,
        costCentre: true,
        department: true,
      },
    });
    return toCandidate(updated);
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

    await this.prisma.accrualPeriod.update({
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

    return this.getPeriod(id, session);
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
      throw new DomainException(
        'Lock the period before producing an official export.',
      );
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

    return { csv, filename, sha256, byteSize, version };
  }

  private async actionsFor(period: PeriodRow, session?: UserSession) {
    const isOpen = period.lockedAt == null;
    const candidateCount = period.candidates.length;
    const openCandidateCount = period.candidates.filter(
      (c) => c.standing !== 'finalized' && c.standing !== 'excluded',
    ).length;
    const allSettled = candidateCount > 0 && openCandidateCount === 0;

    if (!session) {
      return {
        edit: false,
        generate: false,
        finalize: false,
        lock: false,
        export: false,
      };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });
    const perms = new Set(
      permissionsForRoles(parseRoleField(user?.role)),
    );

    const mayEdit = perms.has('accrual:edit') && isOpen;
    const mayFinalize = perms.has('accrual:finalize') && isOpen;
    const mayLock =
      perms.has('accrual:lock_period') &&
      isOpen &&
      allSettled &&
      period.openedById !== session.user.id;
    const mayExport = perms.has('accrual:export');

    return {
      edit: mayEdit,
      generate: mayEdit,
      finalize: mayFinalize,
      lock: mayLock,
      export: mayExport,
    };
  }
}

function parseDateOnly(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new DomainException('Enter dates as YYYY-MM-DD.');
    }
    return parsed;
  }
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function isoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function moneyOut(minorUnits: bigint, currency: string) {
  return {
    minor_units: Number(minorUnits),
    currency,
    formatted: formatMinorUnits(minorUnits, currency, true),
  };
}

function toRef(
  row: { id: string; code: string; name: string } | null | undefined,
) {
  if (!row) return null;
  return { id: row.id, code: row.code, name: row.name };
}

function toCandidate(row: {
  id: string;
  reference: string;
  standing: string;
  currency: string;
  amountMinorUnits: bigint;
  originalAmountMinorUnits: bigint;
  vendorName: string;
  invoiceNumber: string | null;
  invoiceReference: string | null;
  description: string;
  editReason: string | null;
  note: string | null;
  finalizedAt: Date | null;
  version: number;
  invoiceId: string | null;
  glAccount?: { id: string; code: string; name: string } | null;
  costCentre?: { id: string; code: string; name: string } | null;
  department?: { id: string; name: string } | null;
}) {
  return {
    id: row.id,
    reference: row.reference,
    invoice_id: row.invoiceId,
    invoice_reference: row.invoiceReference,
    invoice_number: row.invoiceNumber,
    standing: row.standing,
    standing_label: CANDIDATE_STANDING_LABELS[row.standing] ?? row.standing,
    currency: row.currency,
    amount: moneyOut(row.amountMinorUnits, row.currency),
    original_amount: moneyOut(row.originalAmountMinorUnits, row.currency),
    vendor_name: row.vendorName,
    description: row.description,
    department: row.department?.name ?? null,
    gl_account: toRef(row.glAccount),
    cost_centre: toRef(row.costCentre),
    edit_reason: row.editReason,
    note: row.note,
    finalized_at: row.finalizedAt?.toISOString() ?? null,
    version: row.version,
  };
}

function toPeriodSummary(
  period: {
    id: string;
    reference: string;
    periodStart: Date;
    periodEnd: Date;
    label: string;
    lockedAt: Date | null;
    lockReason: string | null;
  },
  candidates: Array<{ standing: string }>,
) {
  const standing = period.lockedAt ? 'locked' : 'open';
  const meta = PERIOD_STANDING[standing];
  return {
    id: period.id,
    reference: period.reference,
    period_start: isoDate(period.periodStart),
    period_end: isoDate(period.periodEnd),
    label: period.label,
    standing,
    standing_label: meta.label,
    standing_description: meta.description,
    candidate_count: candidates.length,
    open_candidate_count: candidates.filter(
      (c) => c.standing !== 'finalized' && c.standing !== 'excluded',
    ).length,
    locked_at: period.lockedAt?.toISOString() ?? null,
    lock_reason: period.lockReason,
  };
}

function toPeriodDetail(
  period: PeriodRow,
  actions: Record<string, boolean>,
) {
  return {
    ...toPeriodSummary(period, period.candidates),
    candidates: period.candidates.map(toCandidate),
    exports: period.exports.map((row) => ({
      id: row.id,
      version: row.version,
      format: row.format,
      official: row.official,
      filename: row.filename,
      sha256: row.sha256,
      byte_size: row.byteSize,
      row_count: row.rowCount,
      generated_at: row.generatedAt.toISOString(),
    })),
    actions,
  };
}
