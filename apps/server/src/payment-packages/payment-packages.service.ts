import { HttpStatus, Injectable } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { actorLabel, moveInvoiceStatus } from '../common/invoice-status.js';
import { AuditService } from '../common/audit.service.js';
import { DomainException, notFound } from '../common/errors.js';
import { nextReference } from '../common/ids.js';
import { resolvePage, type PageQuery } from '../common/pagination.js';
import { TransitionsService } from '../common/transitions.service.js';
import {
  InvoiceStatus,
  PaymentPackageStatus,
  type PaymentPackage,
} from '../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  renderManifest,
  validateSubmissionReference,
  type ManifestLine,
} from './payment-manifest.js';

const PACKAGE_SUBJECT = 'payment_package';

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
    return this.prisma.invoice.findMany({
      where: {
        status: InvoiceStatus.APPROVED,
        archivedAt: null,
        totalMinorUnits: { not: null },
        currency: { not: null },
        paymentPackageLine: { is: null },
      },
      orderBy: [{ dueDate: 'asc' }, { reference: 'asc' }],
      take: Math.min(limit, 200),
      include: { vendor: true },
    });
  }

  async list(query: PageQuery) {
    const page = resolvePage(query);
    const [rows, total] = await Promise.all([
      this.prisma.paymentPackage.findMany({
        orderBy: { createdAt: 'desc' },
        take: page.take,
        skip: page.skip,
        include: {
          lines: { include: { invoice: true, vendor: true } },
        },
      }),
      this.prisma.paymentPackage.count(),
    ]);
    return { rows, total, ...page };
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

    return row;
  }

  async getById(id: string) {
    const row = await this.prisma.paymentPackage.findUnique({
      where: { id },
      include: {
        lines: {
          include: { vendor: true, invoice: true },
          orderBy: { createdAt: 'asc' },
        },
        createdBy: { select: { id: true, name: true, email: true } },
        submittedBy: { select: { id: true, name: true, email: true } },
        cancelledBy: { select: { id: true, name: true, email: true } },
      },
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
