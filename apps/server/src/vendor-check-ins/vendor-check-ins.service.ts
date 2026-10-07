import { Injectable } from '@nestjs/common';
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
} from '../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  deriveCheckInStanding,
  newCorrelationTag,
} from './vendor-check-ins.helpers.js';

const SUBJECT = 'vendor_check_in';

@Injectable()
export class VendorCheckInsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly transitions: TransitionsService,
  ) {}

  async list(query: PageQuery) {
    const page = resolvePage(query);
    const [rows, total] = await Promise.all([
      this.prisma.vendorCheckIn.findMany({
        orderBy: { createdAt: 'desc' },
        take: page.take,
        skip: page.skip,
        include: {
          package: { select: { reference: true, submittedAt: true } },
          vendor: { select: { id: true, name: true, email: true } },
        },
      }),
      this.prisma.vendorCheckIn.count(),
    ]);

    return {
      rows: rows.map((row) => ({
        ...row,
        standing: deriveCheckInStanding(row),
        vendorName: row.vendor?.name ?? 'Unknown supplier',
      })),
      total,
      ...page,
    };
  }

  async getById(id: string) {
    const row = await this.prisma.vendorCheckIn.findUnique({
      where: { id },
      include: {
        package: {
          include: {
            lines: {
              include: {
                invoice: true,
                vendor: true,
              },
            },
          },
        },
        vendor: true,
        createdBy: { select: { id: true, name: true } },
        reviewedBy: { select: { id: true, name: true } },
      },
    });
    if (!row) throw notFound('Vendor check-in', id);

    const vendorKey = row.vendorId ?? '__none__';
    const lines = row.package.lines.filter(
      (line) => (line.vendorId ?? '__none__') === vendorKey,
    );

    return {
      ...row,
      standing: deriveCheckInStanding(row),
      vendorName: row.vendor?.name ?? 'Unknown supplier',
      lines,
    };
  }

  async raiseForPackage(session: UserSession, packageId: string) {
    const pkg = await this.prisma.paymentPackage.findUnique({
      where: { id: packageId },
      include: {
        lines: { include: { vendor: true, invoice: { include: { vendor: true } } } },
        checkIns: true,
      },
    });
    if (!pkg) throw notFound('Payment package', packageId);
    if (pkg.status !== PaymentPackageStatus.SUBMITTED || !pkg.submittedAt) {
      throw new DomainException(
        'This package has not gone to the bank yet, so there is nothing a supplier could have received.',
      );
    }

    const existingVendorIds = new Set(
      pkg.checkIns.map((c) => c.vendorId ?? '__none__'),
    );

    const grouped = new Map<string, typeof pkg.lines>();
    for (const line of pkg.lines) {
      const key = line.vendorId ?? '__none__';
      const bucket = grouped.get(key) ?? [];
      bucket.push(line);
      grouped.set(key, bucket);
    }

    const raised = [];
    const alreadyRaised: string[] = [];

    for (const [vendorKey, lines] of grouped) {
      if (existingVendorIds.has(vendorKey)) {
        const name =
          lines[0]?.vendor?.name ??
          lines[0]?.invoice.vendor?.name ??
          'Unknown supplier';
        alreadyRaised.push(name);
        continue;
      }

      const vendor = lines[0]?.vendor ?? lines[0]?.invoice.vendor ?? null;

      let tag = newCorrelationTag();
      for (let i = 0; i < 5; i += 1) {
        const clash = await this.prisma.vendorCheckIn.findUnique({
          where: { correlationTag: tag },
        });
        if (!clash) break;
        tag = newCorrelationTag();
      }

      const checkIn = await this.prisma.vendorCheckIn.create({
        data: {
          reference: nextReference('VCI'),
          correlationTag: tag,
          packageId,
          vendorId: vendor?.id ?? null,
          createdById: session.user.id,
        },
      });

      await this.audit.append({
        action: 'record_created',
        actorId: session.user.id,
        actorLabel: actorLabel(session),
        subjectType: SUBJECT,
        subjectId: checkIn.id,
        detail: {
          reference: checkIn.reference,
          package: pkg.reference,
          vendorName: vendor?.name ?? 'Unknown supplier',
          invoices: lines.length,
        },
      });

      raised.push(checkIn);
    }

    return { raised, alreadyRaised };
  }

  async send(session: UserSession, id: string) {
    const row = await this.getById(id);
    if (row.sentAt) {
      throw new DomainException('This supplier has already been asked.');
    }

    const updated = await this.prisma.vendorCheckIn.update({
      where: { id },
      data: { sentAt: new Date(), version: { increment: 1 } },
    });

    await this.audit.append({
      action: 'vendor_confirmation_requested',
      actorId: session.user.id,
      actorLabel: actorLabel(session),
      subjectType: SUBJECT,
      subjectId: id,
      detail: { reference: row.reference },
    });

    return { ...updated, correlationTag: row.correlationTag };
  }

  async answer(
    id: string,
    body: { claim: string; respondentName: string; note?: string },
    options?: { public?: boolean; actorLabel?: string },
  ) {
    const row = await this.prisma.vendorCheckIn.findUnique({ where: { id } });
    if (!row) throw notFound('Vendor check-in', id);

    const standing = deriveCheckInStanding(row);
    if (standing === 'reviewed') {
      throw new DomainException(
        'This check-in has already been reviewed.',
      );
    }

    const claim = body.claim?.trim();
    const respondentName = body.respondentName?.trim();
    if (!claim || !respondentName) {
      throw new DomainException('A claim and respondent name are required.');
    }

    const updated = await this.prisma.vendorCheckIn.update({
      where: { id },
      data: {
        claim,
        claimChannel: options?.public ? 'web_form' : 'manual',
        respondentName,
        respondentNote: body.note?.trim() || null,
        answeredAt: new Date(),
        version: { increment: 1 },
      },
    });

    await this.audit.append({
      action: 'vendor_claim_recorded',
      actorType: options?.public ? 'vendor' : 'user',
      actorLabel: options?.actorLabel ?? respondentName,
      subjectType: SUBJECT,
      subjectId: id,
      detail: { claim, respondentName },
    });

    return updated;
  }

  async review(
    session: UserSession,
    id: string,
    body: { outcome: 'paid' | 'outstanding'; note?: string },
  ) {
    const row = await this.getById(id);
    if (!row.sentAt && !row.answeredAt) {
      throw new DomainException(
        'Record what the supplier said before concluding.',
      );
    }
    if (row.reviewedAt) {
      throw new DomainException('This check-in has already been reviewed.');
    }

    const updated = await this.prisma.vendorCheckIn.update({
      where: { id },
      data: {
        reviewOutcome: body.outcome,
        reviewNote: body.note?.trim() || null,
        reviewedAt: new Date(),
        reviewedById: session.user.id,
        version: { increment: 1 },
      },
    });

    if (body.outcome === 'paid') {
      for (const line of row.lines) {
        const invoice = await this.prisma.invoice.findUnique({
          where: { id: line.invoiceId },
        });
        if (invoice && invoice.status !== InvoiceStatus.PAID) {
          await moveInvoiceStatus(
            {
              prisma: this.prisma,
              transitions: this.transitions,
              audit: this.audit,
            },
            invoice,
            InvoiceStatus.PAID,
            session,
            `Vendor check-in ${row.reference} marked paid.`,
          );
        }
      }
    } else {
      for (const line of row.lines) {
        const invoice = await this.prisma.invoice.findUnique({
          where: { id: line.invoiceId },
        });
        if (
          invoice &&
          invoice.status !== InvoiceStatus.OUTSTANDING &&
          invoice.status !== InvoiceStatus.PAID
        ) {
          await moveInvoiceStatus(
            {
              prisma: this.prisma,
              transitions: this.transitions,
              audit: this.audit,
            },
            invoice,
            InvoiceStatus.OUTSTANDING,
            session,
            `Vendor check-in ${row.reference} marked outstanding.`,
          );
        }
      }
    }

    await this.audit.append({
      action: 'vendor_confirmation_reviewed',
      actorId: session.user.id,
      actorLabel: actorLabel(session),
      subjectType: SUBJECT,
      subjectId: id,
      detail: { outcome: body.outcome },
    });

    return this.getById(id);
  }

  async findByToken(token: string) {
    const row = await this.prisma.vendorCheckIn.findUnique({
      where: { correlationTag: token },
      include: {
        package: {
          include: {
            lines: {
              include: { invoice: true, vendor: true },
            },
          },
        },
        vendor: true,
      },
    });
    return row;
  }

  async publicView(token: string) {
    const row = await this.findByToken(token);
    if (!row) {
      throw notFound('Check-in link');
    }

    const vendorKey = row.vendorId ?? '__none__';
    const lines = row.package.lines.filter(
      (line) => (line.vendorId ?? '__none__') === vendorKey,
    );

    return {
      vendorName: row.vendor?.name ?? 'Unknown supplier',
      packageReference: row.package.reference,
      lines: lines.map((line) => ({
        invoiceNumber: line.invoiceNumber,
        amountMinorUnits: line.amountMinorUnits,
        currency: line.currency,
        dueDate: line.dueDate,
      })),
      answeredAt: row.answeredAt,
      canAnswer: !row.reviewedAt,
    };
  }

  async publicAnswer(
    token: string,
    body: { claim: string; respondentName: string; note?: string },
  ) {
    const row = await this.findByToken(token);
    if (!row) {
      throw new DomainException('This link is not valid.');
    }
    return this.answer(row.id, body, {
      public: true,
      actorLabel: body.respondentName?.trim() || 'Supplier',
    });
  }
}
