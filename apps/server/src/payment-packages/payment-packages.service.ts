import { HttpStatus, Injectable } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { actorLabel, moveInvoiceStatus } from '../common/invoice-status.js';
import { AuditService } from '../common/audit.service.js';
import { DomainException, notFound } from '../common/errors.js';
import { nextReference } from '../common/ids.js';
import { resolvePage, type PageQuery } from '../common/pagination.js';
import { TransitionsService } from '../common/transitions.service.js';
import { toWorkflowState } from '../common/workflow-state.js';
import {
  InvoiceStatus,
  PaymentPackageStatus,
  type PaymentPackage,
  type Prisma,
} from '../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  renderManifest,
  validateSubmissionReference,
  type ManifestLine,
} from './payment-manifest.js';

const PACKAGE_SUBJECT = 'payment_package';

const detailInclude = {
  lines: {
    include: { vendor: true, invoice: true },
    orderBy: { createdAt: 'asc' as const },
  },
  createdBy: { select: { id: true, name: true, email: true } },
  submittedBy: { select: { id: true, name: true, email: true } },
  cancelledBy: { select: { id: true, name: true, email: true } },
} satisfies Prisma.PaymentPackageInclude;

type PackageRow = Prisma.PaymentPackageGetPayload<{ include: typeof detailInclude }>;

const METHOD_LABELS: Record<string, string> = {
  bank_transfer: 'Bank transfer',
  cheque: 'Cheque',
  wire: 'Wire',
  direct_debit: 'Direct debit',
};

const STANDING_LABELS = {
  open: 'Open',
  submitted: 'Submitted',
  cancelled: 'Abandoned',
} as const;

const STANDING_DESCRIPTIONS = {
  open: 'Still being put together. Nothing has left the account.',
  submitted: 'Sent to the bank. What it contained can no longer change.',
  cancelled: 'Abandoned. Everything in it went back to being approved and unpaid.',
} as const;

const PROBLEM_COPY: Record<
  string,
  { field: string; explanation: string; blocking: boolean }
> = {
  nothing_in_it: {
    field: 'lines',
    explanation:
      'There is nothing in this package. Add the approved invoices it is meant to pay.',
    blocking: false,
  },
  payment_method_missing: {
    field: 'payment_method',
    explanation:
      'Say how the money leaves. The bank needs it, and it decides what the manifest carries.',
    blocking: false,
  },
  payment_date_missing: {
    field: 'intended_payment_date',
    explanation:
      'Give the date the money is meant to leave, so a supplier chasing payment can be told when rather than soon.',
    blocking: false,
  },
  payment_date_in_the_past: {
    field: 'intended_payment_date',
    explanation:
      'The intended payment date has gone by. Move it forward, or this package goes to the bank already saying it is late.',
    blocking: false,
  },
  line_no_longer_payable: {
    field: 'lines',
    explanation:
      'Something in this package is no longer payable. It was approved when it was added and has moved on since, so it has to come out before the rest can go.',
    blocking: true,
  },
  repeated_invoice_number: {
    field: 'lines',
    explanation:
      'The same supplier appears twice with the same invoice number. That is how one invoice gets paid twice, so it needs looking at even if both are right.',
    blocking: true,
  },
};

type ManifestLineSource = {
  invoiceId: string;
  invoiceReference: string;
  invoiceNumber: string | null;
  vendorId: string | null;
  vendor?: { name: string } | null;
  amountMinorUnits: bigint;
  currency: ManifestLine['currency'];
  dueDate: Date | null;
  invoice: { status: InvoiceStatus };
};

@Injectable()
export class PaymentPackagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly transitions: TransitionsService,
  ) {}

  async eligibleInvoices(limit = 200) {
    const rows = await this.prisma.invoice.findMany({
      where: {
        status: InvoiceStatus.APPROVED,
        archivedAt: null,
        totalMinorUnits: { not: null },
        currency: { not: null },
        paymentPackageLine: { is: null },
      },
      orderBy: [{ dueDate: 'asc' }, { reference: 'asc' }],
      take: Math.min(limit, 200),
      include: { vendor: true, department: true },
    });
    return rows.map((invoice) => ({
      id: invoice.id,
      reference: invoice.reference,
      invoice_number: invoice.invoiceNumber,
      vendor_name: invoice.vendor?.name ?? '',
      amount: moneyOut(invoice.totalMinorUnits ?? 0n, invoice.currency ?? 'JMD'),
      due_date: dateOnly(invoice.dueDate),
      department: invoice.department?.name ?? null,
    }));
  }

  async list(
    query: PageQuery & {
      standing?: string | string[];
      search?: string;
      page_size?: string | number;
    },
  ) {
    const page = resolvePage({
      ...query,
      page: query.page != null ? Number(query.page) : undefined,
      pageSize:
        query.pageSize ??
        (query.page_size != null ? Number(query.page_size) : undefined),
    });
    const where = packageWhere(query.standing, query.search);
    const [rows, total] = await Promise.all([
      this.prisma.paymentPackage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: page.take,
        skip: page.skip,
        include: detailInclude,
      }),
      this.prisma.paymentPackage.count({ where }),
    ]);
    return {
      rows: rows.map((row) => this.toSummary(row)),
      total,
      page: page.page ?? 1,
      pageSize: page.pageSize ?? page.take,
    };
  }

  async create(
    session: UserSession,
    body: {
      description?: string;
      paymentMethod?: string;
      intendedPaymentDate?: string;
    },
  ) {
    const row = await this.prisma.paymentPackage.create({
      data: {
        reference: nextReference('PAY'),
        status: PaymentPackageStatus.OPEN,
        description: (body.description ?? '').trim().slice(0, 500),
        paymentMethod: body.paymentMethod?.trim() || null,
        intendedPaymentDate: body.intendedPaymentDate
          ? new Date(body.intendedPaymentDate)
          : null,
        createdById: session.user.id,
      },
    });

    await this.audit.append({
      action: 'record_created',
      actorId: session.user.id,
      actorLabel: actorLabel(session),
      subjectType: PACKAGE_SUBJECT,
      subjectId: row.id,
      detail: { reference: row.reference },
    });

    return this.getById(row.id);
  }

  async getById(id: string) {
    const row = await this.prisma.paymentPackage.findUnique({
      where: { id },
      include: detailInclude,
    });
    if (!row) throw notFound('Payment package', id);
    return row;
  }

  async updateHeader(
    session: UserSession,
    id: string,
    body: {
      description?: string;
      paymentMethod?: string | null;
      intendedPaymentDate?: string | null;
    },
  ) {
    const pkg = await this.getById(id);
    this.assertOpen(pkg);

    const data: {
      description?: string;
      paymentMethod?: string | null;
      intendedPaymentDate?: Date | null;
      version?: { increment: number };
    } = { version: { increment: 1 } };

    if (body.description !== undefined) {
      data.description = body.description.trim().slice(0, 500);
    }
    if (body.paymentMethod !== undefined) {
      data.paymentMethod = body.paymentMethod?.trim() || null;
    }
    if (body.intendedPaymentDate !== undefined) {
      data.intendedPaymentDate = body.intendedPaymentDate
        ? new Date(body.intendedPaymentDate)
        : null;
    }

    const updated = await this.prisma.paymentPackage.update({
      where: { id },
      data,
    });

    await this.audit.append({
      action: 'record_updated',
      actorId: session.user.id,
      actorLabel: actorLabel(session),
      subjectType: PACKAGE_SUBJECT,
      subjectId: id,
      detail: { reference: updated.reference },
    });

    return this.getById(id);
  }

  async addLines(
    session: UserSession,
    id: string,
    invoiceIds: string[],
  ) {
    const pkg = await this.getById(id);
    this.assertOpen(pkg);

    const added: unknown[] = [];
    const refused: {
      invoiceId: string;
      reference: string;
      reason: string;
    }[] = [];

    const uniqueIds = [...new Set(invoiceIds)];

    for (const invoiceId of uniqueIds) {
      const invoice = await this.prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { vendor: true, paymentPackageLine: true },
      });

      if (!invoice || invoice.archivedAt) {
        refused.push({
          invoiceId,
          reference: '',
          reason: 'That invoice is not on the system, or has been archived.',
        });
        continue;
      }

      if (invoice.paymentPackageLine) {
        refused.push({
          invoiceId,
          reference: invoice.reference,
          reason: 'This invoice is already in another package.',
        });
        continue;
      }

      if (invoice.status !== InvoiceStatus.APPROVED) {
        refused.push({
          invoiceId,
          reference: invoice.reference,
          reason: 'Only approved invoices can be added.',
        });
        continue;
      }

      if (invoice.totalMinorUnits == null || !invoice.currency) {
        refused.push({
          invoiceId,
          reference: invoice.reference,
          reason: 'This invoice has no amount on it.',
        });
        continue;
      }

      const line = await this.prisma.paymentPackageLine.create({
        data: {
          packageId: id,
          invoiceId: invoice.id,
          invoiceReference: invoice.reference,
          invoiceNumber: invoice.invoiceNumber,
          vendorId: invoice.vendorId,
          currency: invoice.currency,
          amountMinorUnits: invoice.totalMinorUnits,
          dueDate: invoice.dueDate,
          addedById: session.user.id,
        },
      });

      await moveInvoiceStatus(
        {
          prisma: this.prisma,
          transitions: this.transitions,
          audit: this.audit,
        },
        invoice,
        InvoiceStatus.READY_FOR_SUBMISSION,
        session,
        `Added to payment package ${pkg.reference}.`,
      );

      added.push(line);
    }

    if (added.length) {
      await this.audit.append({
        action: 'record_updated',
        actorId: session.user.id,
        actorLabel: actorLabel(session),
        subjectType: PACKAGE_SUBJECT,
        subjectId: id,
        detail: { reference: pkg.reference, addedCount: added.length },
      });
    }

    return { added, refused };
  }

  async removeLine(session: UserSession, id: string, invoiceId: string) {
    const pkg = await this.getById(id);
    this.assertOpen(pkg);

    const line = await this.prisma.paymentPackageLine.findFirst({
      where: { packageId: id, invoiceId },
    });
    if (!line) {
      throw new DomainException('That invoice is not in this package.');
    }

    await this.prisma.paymentPackageLine.delete({ where: { id: line.id } });

    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
    });
    if (invoice?.status === InvoiceStatus.READY_FOR_SUBMISSION) {
      await moveInvoiceStatus(
        {
          prisma: this.prisma,
          transitions: this.transitions,
          audit: this.audit,
        },
        invoice,
        InvoiceStatus.APPROVED,
        session,
        `Taken out of payment package ${pkg.reference}.`,
      );
    }

    await this.audit.append({
      action: 'record_updated',
      actorId: session.user.id,
      actorLabel: actorLabel(session),
      subjectType: PACKAGE_SUBJECT,
      subjectId: id,
      detail: { reference: pkg.reference, removed: line.invoiceReference },
    });

    return this.getById(id);
  }

  async buildManifestLines(
    pkg: PaymentPackage & { lines: ManifestLineSource[] },
  ): Promise<ManifestLine[]> {
    return pkg.lines.map((line: ManifestLineSource) => ({
      invoiceId: line.invoiceId,
      reference: line.invoiceReference,
      invoiceNumber: line.invoiceNumber,
      vendorId: line.vendorId,
      vendorName: line.vendor?.name ?? 'Unknown supplier',
      totalMinorUnits: line.amountMinorUnits,
      currency: line.currency,
      dueDate: line.dueDate,
      invoiceStatus: line.invoice.status,
    }));
  }

  async manifest(id: string) {
    const pkg = await this.getById(id);
    if (!pkg.paymentMethod || !pkg.intendedPaymentDate) {
      return null;
    }
    const lines = await this.buildManifestLines(pkg);
    const rendered = renderManifest({
      packageReference: pkg.reference,
      paymentMethod: pkg.paymentMethod,
      intendedPaymentDate: pkg.intendedPaymentDate,
      lines,
    });
    return {
      ...rendered,
      filename: `${pkg.reference}-manifest.csv`,
      submittedDigest: pkg.manifestSha256,
      matchesSubmitted:
        pkg.manifestSha256 != null
          ? pkg.manifestSha256 === rendered.digest
          : null,
      lines,
    };
  }

  async submit(
    session: UserSession,
    id: string,
    submissionReference: string,
  ) {
    const pkg = await this.getById(id);
    this.assertOpen(pkg);

    if (!pkg.lines.length) {
      throw new DomainException('There is nothing in this package.', HttpStatus.BAD_REQUEST);
    }
    if (!pkg.paymentMethod) {
      throw new DomainException('Say how the money leaves.');
    }
    if (!pkg.intendedPaymentDate) {
      throw new DomainException('Give the intended payment date.');
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const payDate = new Date(pkg.intendedPaymentDate);
    payDate.setHours(0, 0, 0, 0);
    if (payDate < today) {
      throw new DomainException('The intended payment date has gone by.');
    }

    for (const line of pkg.lines) {
      if (line.invoice.status !== InvoiceStatus.READY_FOR_SUBMISSION) {
        throw new DomainException(
          'Something in this package is no longer payable.',
        );
      }
    }

    let reference: string;
    try {
      reference = validateSubmissionReference(submissionReference);
    } catch (error) {
      throw new DomainException(
        error instanceof Error ? error.message : 'Invalid submission reference.',
      );
    }

    const manifestLines = await this.buildManifestLines(pkg);
    const rendered = renderManifest({
      packageReference: pkg.reference,
      paymentMethod: pkg.paymentMethod,
      intendedPaymentDate: pkg.intendedPaymentDate,
      lines: manifestLines,
    });

    const now = new Date();
    await this.prisma.paymentPackage.update({
      where: { id },
      data: {
        status: PaymentPackageStatus.SUBMITTED,
        submittedAt: now,
        submittedById: session.user.id,
        submissionReference: reference,
        manifestSha256: rendered.digest,
        manifestLineCount: rendered.lineCount,
        version: { increment: 1 },
      },
    });

    for (const line of pkg.lines) {
      const invoice = await this.prisma.invoice.findUniqueOrThrow({
        where: { id: line.invoiceId },
      });
      await moveInvoiceStatus(
        {
          prisma: this.prisma,
          transitions: this.transitions,
          audit: this.audit,
        },
        invoice,
        InvoiceStatus.SUBMITTED,
        session,
        `Submitted in payment package ${pkg.reference}, reference ${reference}.`,
      );
    }

    await this.audit.append({
      action: 'package_submitted',
      actorId: session.user.id,
      actorLabel: actorLabel(session),
      subjectType: PACKAGE_SUBJECT,
      subjectId: id,
      detail: {
        reference: pkg.reference,
        submissionReference: reference,
        manifestSha256: rendered.digest,
      },
    });

    return { manifest: rendered, package: await this.getById(id) };
  }

  async cancel(session: UserSession, id: string, reason: string) {
    const pkg = await this.getById(id);
    this.assertOpen(pkg);

    if (!reason.trim()) {
      throw new DomainException('Give a reason for abandoning this package.');
    }

    for (const line of pkg.lines) {
      const invoice = await this.prisma.invoice.findUnique({
        where: { id: line.invoiceId },
      });
      if (invoice?.status === InvoiceStatus.READY_FOR_SUBMISSION) {
        await moveInvoiceStatus(
          {
            prisma: this.prisma,
            transitions: this.transitions,
            audit: this.audit,
          },
          invoice,
          InvoiceStatus.APPROVED,
          session,
          `Payment package ${pkg.reference} was abandoned.`,
        );
      }
    }

    await this.prisma.paymentPackageLine.deleteMany({ where: { packageId: id } });

    const now = new Date();
    await this.prisma.paymentPackage.update({
      where: { id },
      data: {
        status: PaymentPackageStatus.CANCELLED,
        cancelledAt: now,
        cancelledById: session.user.id,
        cancelledReason: reason.trim(),
        version: { increment: 1 },
      },
    });

    await this.audit.append({
      action: 'state_changed',
      actorId: session.user.id,
      actorLabel: actorLabel(session),
      subjectType: PACKAGE_SUBJECT,
      subjectId: id,
      detail: {
        reference: pkg.reference,
        from: PaymentPackageStatus.OPEN,
        to: PaymentPackageStatus.CANCELLED,
        reason: reason.trim(),
      },
    });

    return this.getById(id);
  }

  toSummary(row: PackageRow) {
    const standing = standingOf(row.status);
    const problems = packageProblems(row);
    const vendors = new Set(
      row.lines.map((line) => line.vendor?.name ?? 'Unknown supplier'),
    );
    return {
      id: row.id,
      reference: row.reference,
      description: row.description || '',
      standing,
      standing_label: STANDING_LABELS[standing],
      payment_method: row.paymentMethod,
      payment_method_label: row.paymentMethod
        ? (METHOD_LABELS[row.paymentMethod] ?? row.paymentMethod)
        : null,
      intended_payment_date: dateOnly(row.intendedPaymentDate),
      invoice_count: row.lines.length,
      vendor_count: vendors.size,
      totals: totalsOut(row.lines),
      submitted_at: row.submittedAt?.toISOString() ?? null,
      submission_reference: row.submissionReference,
      created_at: row.createdAt.toISOString(),
      blocker_count: problems.filter((problem) => problem.is_blocking).length,
    };
  }

  toDetail(row: PackageRow) {
    const standing = standingOf(row.status);
    const problems = packageProblems(row);
    const open = standing === 'open';
    const vendors = new Set(
      row.lines.map((line) => line.vendor?.name ?? 'Unknown supplier'),
    );
    return {
      ...this.toSummary(row),
      version: row.version,
      standing_description: STANDING_DESCRIPTIONS[standing],
      lines: row.lines.map((line) => {
        const payable =
          line.invoice.status === InvoiceStatus.READY_FOR_SUBMISSION ||
          line.invoice.status === InvoiceStatus.SUBMITTED;
        return {
          invoice_id: line.invoiceId,
          invoice_reference: line.invoiceReference,
          invoice_number: line.invoiceNumber,
          vendor_name: line.vendor?.name ?? 'Unknown supplier',
          amount: moneyOut(line.amountMinorUnits, line.currency),
          due_date: dateOnly(line.dueDate),
          invoice_state: toWorkflowState(line.invoice.status),
          invoice_state_label: stateLabel(line.invoice.status),
          is_still_payable: payable,
        };
      }),
      problems,
      blockers: problems.filter((problem) => problem.is_blocking),
      created_by_label: row.createdBy?.name ?? '',
      submitted_by_label: row.submittedBy?.name ?? null,
      manifest_sha256: row.manifestSha256,
      manifest_line_count: row.manifestLineCount,
      cancelled_at: row.cancelledAt?.toISOString() ?? null,
      cancelled_reason: row.cancelledReason,
      can_edit: open,
      can_submit: open && problems.length === 0,
      can_cancel: open,
      vendor_count: vendors.size,
    };
  }

  private assertOpen(pkg: PaymentPackage) {
    if (pkg.status === PaymentPackageStatus.OPEN) return;
    const message =
      pkg.status === PaymentPackageStatus.SUBMITTED
        ? 'This package has already gone to the bank.'
        : pkg.status === PaymentPackageStatus.COMPLETED
          ? 'This package is already complete.'
          : 'This package was cancelled.';
    throw new DomainException(message, HttpStatus.CONFLICT);
  }
}

function standingOf(
  status: PaymentPackageStatus,
): keyof typeof STANDING_LABELS {
  if (
    status === PaymentPackageStatus.SUBMITTED ||
    status === PaymentPackageStatus.COMPLETED
  ) {
    return 'submitted';
  }
  if (status === PaymentPackageStatus.CANCELLED) return 'cancelled';
  return 'open';
}

function packageWhere(
  standing: string | string[] | undefined,
  search: string | undefined,
): Prisma.PaymentPackageWhereInput {
  const where: Prisma.PaymentPackageWhereInput = {};
  const wanted = (Array.isArray(standing) ? standing : standing ? [standing] : [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (wanted.length) {
    const statuses: PaymentPackageStatus[] = [];
    if (wanted.includes('open')) statuses.push(PaymentPackageStatus.OPEN);
    if (wanted.includes('submitted')) {
      statuses.push(
        PaymentPackageStatus.SUBMITTED,
        PaymentPackageStatus.COMPLETED,
      );
    }
    if (wanted.includes('cancelled')) statuses.push(PaymentPackageStatus.CANCELLED);
    if (statuses.length) where.status = { in: statuses };
  }
  const term = search?.trim();
  if (term) {
    where.OR = [
      { reference: { contains: term, mode: 'insensitive' } },
      { description: { contains: term, mode: 'insensitive' } },
      { submissionReference: { contains: term, mode: 'insensitive' } },
    ];
  }
  return where;
}

function packageProblems(row: PackageRow) {
  if (standingOf(row.status) !== 'open') return [];
  const found: string[] = [];
  if (row.lines.length === 0) found.push('nothing_in_it');
  if (!row.paymentMethod) found.push('payment_method_missing');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (!row.intendedPaymentDate) {
    found.push('payment_date_missing');
  } else if (row.intendedPaymentDate < today) {
    found.push('payment_date_in_the_past');
  }
  if (
    row.lines.some(
      (line) => line.invoice.status !== InvoiceStatus.READY_FOR_SUBMISSION,
    )
  ) {
    found.push('line_no_longer_payable');
  }
  const seen = new Set<string>();
  for (const line of row.lines) {
    const number = (line.invoiceNumber ?? '').trim().toUpperCase();
    if (!number || !line.vendorId) continue;
    const key = `${line.vendorId}:${number}`;
    if (seen.has(key)) {
      found.push('repeated_invoice_number');
      break;
    }
    seen.add(key);
  }
  return found.map((problem) => {
    const copy = PROBLEM_COPY[problem]!;
    return {
      problem,
      field: copy.field,
      explanation: copy.explanation,
      is_blocking: copy.blocking,
    };
  });
}

function totalsOut(
  lines: Array<{ amountMinorUnits: bigint; currency: string }>,
) {
  const totals = new Map<string, bigint>();
  for (const line of lines) {
    totals.set(
      line.currency,
      (totals.get(line.currency) ?? 0n) + line.amountMinorUnits,
    );
  }
  return [...totals.keys()]
    .sort()
    .map((currency) => moneyOut(totals.get(currency) ?? 0n, currency));
}

function moneyOut(minor: bigint, currency: string) {
  return {
    currency,
    minor_units: Number(minor),
    formatted: new Intl.NumberFormat('en-JM', {
      style: 'currency',
      currency,
      currencyDisplay: 'code',
    }).format(Number(minor) / 100),
  };
}

function dateOnly(value: Date | null) {
  return value ? value.toISOString().slice(0, 10) : null;
}

function stateLabel(status: string) {
  const label = status.toLowerCase().replaceAll('_', ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}
