import { Injectable, Logger } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { actorLabel, moveInvoiceStatus } from '../common/invoice-status.js';
import { AuditService } from '../common/audit.service.js';
import { DomainException, notFound } from '../common/errors.js';
import { nextReference } from '../common/ids.js';
import { sendEmail } from '../mail/email.js';
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
  private readonly logger = new Logger(VendorCheckInsService.name);

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
        package: true,
        vendor: true,
        createdBy: { select: { id: true, name: true } },
        reviewedBy: { select: { id: true, name: true } },
      },
    });
    if (!row) throw notFound('Vendor check-in', id);

    const lines = await this.prisma.paymentPackageLine.findMany({
      where: {
        packageId: row.packageId,
        vendorId: row.vendorId,
      },
      include: {
        invoice: true,
        vendor: true,
      },
    });

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
    });
    if (!pkg) throw notFound('Payment package', packageId);
    if (pkg.status !== PaymentPackageStatus.SUBMITTED || !pkg.submittedAt) {
      throw new DomainException(
        'This package has not gone to the bank yet, so there is nothing a supplier could have received.',
      );
    }

    const [vendorGroups, existingCheckIns] = await Promise.all([
      this.prisma.paymentPackageLine.groupBy({
        by: ['vendorId'],
        where: { packageId },
        _count: { _all: true },
      }),
      this.prisma.vendorCheckIn.findMany({
        where: { packageId },
        select: {
          vendorId: true,
          vendor: { select: { name: true } },
        },
      }),
    ]);

    const existingByVendor = new Map(
      existingCheckIns.map((c) => [c.vendorId ?? null, c]),
    );

    const vendorIds = vendorGroups
      .map((g) => g.vendorId)
      .filter((id): id is string => id != null);
    const vendors = vendorIds.length
      ? await this.prisma.vendor.findMany({
          where: { id: { in: vendorIds } },
          select: { id: true, name: true },
        })
      : [];
    const vendorNameById = new Map(vendors.map((v) => [v.id, v.name]));

    const raised = [];
    const alreadyRaised: string[] = [];

    for (const group of vendorGroups) {
      const vendorId = group.vendorId;
      const vendorName =
        (vendorId ? vendorNameById.get(vendorId) : null) ?? 'Unknown supplier';

      if (existingByVendor.has(vendorId ?? null)) {
        alreadyRaised.push(
          existingByVendor.get(vendorId ?? null)?.vendor?.name ?? vendorName,
        );
        continue;
      }

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
          vendorId,
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
          vendorName,
          invoices: group._count._all,
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

    const email = row.vendor?.email?.trim();
    if (!email) {
      throw new DomainException(
        'This supplier has no email address, so the question cannot be sent.',
      );
    }

    const base = (process.env.WEB_APP_URL ?? 'http://localhost:5173').replace(
      /\/$/,
      '',
    );
    const link = `${base}/payment-check-in/${row.correlationTag}`;
    const vendorName = row.vendor?.name ?? 'there';
    const lines = row.lines
      .map((line) => {
        const number = line.invoiceNumber ?? line.invoiceReference;
        const amount = `${line.currency} ${(Number(line.amountMinorUnits) / 100).toFixed(2)}`;
        return `- ${number}: ${amount}`;
      })
      .join('\n');

    try {
      await sendEmail({
        to: email,
        subject: `Did this payment reach you? ${row.package.reference}`,
        text: `Hi ${vendorName},\n\nWe sent a payment for the following and need to know whether it reached you.\n\n${lines || '- (no invoices listed)'}\n\nOpen this link and tell us: ${link}\n\nFinora Flow`,
      });
    } catch (error) {
      this.logger.error(
        `Vendor check-in email to ${email} failed for ${row.reference}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new DomainException(
        'The email could not be sent, so this supplier has not been asked yet.',
      );
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
    return this.prisma.vendorCheckIn.findUnique({
      where: { correlationTag: token },
      include: {
        package: true,
        vendor: true,
      },
    });
  }

  async publicView(token: string) {
    const row = await this.findByToken(token);
    if (!row) {
      throw notFound('Check-in link');
    }

    const lines = await this.prisma.paymentPackageLine.findMany({
      where: {
        packageId: row.packageId,
        vendorId: row.vendorId,
      },
      select: {
        invoiceNumber: true,
        amountMinorUnits: true,
        currency: true,
        dueDate: true,
      },
    });

    return {
      vendorName: row.vendor?.name ?? 'Unknown supplier',
      packageReference: row.package.reference,
      lines,
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
