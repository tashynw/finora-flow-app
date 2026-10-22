import { Injectable, Logger } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { actorLabel, moveInvoiceStatus } from '../common/invoice-status.js';
import { AuditService } from '../common/audit.service.js';
import { DomainException, notFound } from '../common/errors.js';
import { parseRoleField, permissionsForRoles } from '../common/roles.js';
import { nextReference } from '../common/ids.js';
import { sendEmail } from '../mail/email.js';
import { resolvePage, type PageQuery } from '../common/pagination.js';
import { TransitionsService } from '../common/transitions.service.js';
import {
  InvoiceStatus,
  PaymentPackageStatus,
  type Prisma,
} from '../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  deriveCheckInStanding,
  newCorrelationTag,
  type CheckInStanding,
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
    const where = checkInWhere(query.standing, query.search);
    const [rows, total] = await Promise.all([
      this.prisma.vendorCheckIn.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: page.take,
        skip: page.skip,
        include: {
          package: { select: { reference: true } },
          vendor: { select: { name: true, email: true } },
        },
      }),
      this.prisma.vendorCheckIn.count({ where }),
    ]);
    const lines = rows.length
      ? await this.prisma.paymentPackageLine.findMany({
          where: {
            OR: rows.map((row) => ({
              packageId: row.packageId,
              vendorId: row.vendorId,
            })),
          },
          select: {
            packageId: true,
            vendorId: true,
            amountMinorUnits: true,
            currency: true,
          },
        })
      : [];

    return {
      rows: rows.map((row) =>
        toSummary(
          row,
          lines.filter(
            (line) =>
              line.packageId === row.packageId && line.vendorId === row.vendorId,
          ),
        ),
      ),
      total,
      page: page.page ?? 1,
      pageSize: page.pageSize ?? page.take,
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

  async present(session: UserSession, id: string) {
    const row = await this.getById(id);
    const viewer = await this.viewer(session);
    return this.toDetail(row, viewer);
  }

  toDetail(
    row: Awaited<ReturnType<VendorCheckInsService['getById']>>,
    viewer: { id: string; role: string | null } | null,
  ) {
    const standing = deriveCheckInStanding(row);
    const lines = row.lines.map((line) => ({
      invoice_reference: line.invoiceReference,
      invoice_number: line.invoiceNumber,
      amount: moneyOut(line.amountMinorUnits, line.currency),
      due_date: dateOnly(line.dueDate),
      invoice_state: line.invoice.status.toLowerCase(),
      invoice_state_label: stateLabel(line.invoice.status),
    }));
    const claim = row.claim;
    const outcome = row.reviewOutcome;
    return {
      id: row.id,
      reference: row.reference,
      version: row.version,
      package_id: row.packageId,
      package_reference: row.package.reference,
      package_submitted_at: row.package.submittedAt?.toISOString() ?? null,
      submission_reference: row.package.submissionReference,
      vendor_name: row.vendor?.name ?? 'Unknown supplier',
      vendor_email: row.vendor?.email ?? null,
      standing,
      standing_label: STANDING_LABELS[standing],
      standing_description: STANDING_DESCRIPTIONS[standing],
      lines,
      totals: totalsOut(row.lines),
      sent_at: row.sentAt?.toISOString() ?? null,
      answered_at: row.answeredAt?.toISOString() ?? null,
      claim,
      claim_label: claim ? (CLAIM_LABELS[claim] ?? claim) : null,
      claim_description: claim ? (CLAIM_DESCRIPTIONS[claim] ?? null) : null,
      claim_channel: row.claimChannel,
      claim_channel_label: row.claimChannel
        ? (CHANNEL_LABELS[row.claimChannel] ?? row.claimChannel)
        : null,
      respondent_name: row.respondentName,
      respondent_note: row.respondentNote,
      reviewed_at: row.reviewedAt?.toISOString() ?? null,
      reviewed_by_label: row.reviewedBy?.name ?? null,
      review_outcome: outcome,
      review_outcome_label: outcome ? (REVIEW_LABELS[outcome] ?? outcome) : null,
      review_note: row.reviewNote,
      suggestion: suggest(claim, row.lines),
      confirmed_paid:
        row.lines.length > 0 &&
        row.lines.every((line) => line.invoice.status === InvoiceStatus.PAID),
      can_send: standing === 'not_sent' && Boolean(row.vendor?.email),
      can_record_answer:
        standing === 'not_sent' || standing === 'awaiting_vendor',
      can_review: this.mayConclude(viewer, row.package.submittedById, standing),
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

    return { raised, already_raised: alreadyRaised };
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
        subject: `Did this payment reach you? ${row.package.reference} [${row.correlationTag}]`,
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

    if (row.answeredAt) {
      throw new DomainException(
        'What the supplier said has already been written down.',
      );
    }
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
    const viewer = await this.viewer(session);
    if (
      !this.mayConclude(
        viewer,
        row.package.submittedById,
        deriveCheckInStanding(row),
      )
    ) {
      throw new DomainException(
        'Only finance can conclude whether this payment arrived, and not the person who sent it.',
      );
    }
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

    if (body.outcome === 'paid') {
      await this.completePackageIfSettled(session, row.packageId);
    }

    return this.getById(id);
  }

  private async viewer(session: UserSession) {
    return this.prisma.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, role: true },
    });
  }

  private mayConclude(
    viewer: { id: string; role: string | null } | null,
    submittedById: string | null | undefined,
    standing: CheckInStanding,
  ) {
    if (!viewer) return false;
    if (submittedById && submittedById === viewer.id) return false;
    if (standing !== 'vendor_answered' && standing !== 'awaiting_vendor') {
      return false;
    }
    return permissionsForRoles(parseRoleField(viewer.role)).includes(
      'payment:mark_paid',
    );
  }

  /** End of the payment flow: every invoice on the package has been marked paid. */
  private async completePackageIfSettled(session: UserSession, packageId: string) {
    const pkg = await this.prisma.paymentPackage.findUnique({
      where: { id: packageId },
      select: { id: true, status: true, reference: true },
    });
    if (!pkg || pkg.status !== PaymentPackageStatus.SUBMITTED) return;

    const unsettled = await this.prisma.paymentPackageLine.count({
      where: {
        packageId,
        invoice: { status: { not: InvoiceStatus.PAID } },
      },
    });
    if (unsettled > 0) return;

    await this.prisma.paymentPackage.update({
      where: { id: packageId },
      data: {
        status: PaymentPackageStatus.COMPLETED,
        completedAt: new Date(),
      },
    });

    await this.audit.append({
      action: 'payment_package.completed',
      actorId: session.user.id,
      actorLabel: actorLabel(session),
      subjectType: 'payment_package',
      subjectId: packageId,
      detail: { reference: pkg.reference },
    });
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
        invoiceReference: true,
        invoiceNumber: true,
        amountMinorUnits: true,
        currency: true,
        dueDate: true,
      },
    });

    return {
      reference: row.reference,
      vendor_name: row.vendor?.name ?? 'Unknown supplier',
      paid_on: row.package.submittedAt?.toISOString() ?? null,
      lines: lines.map((line) => ({
        invoice_number: line.invoiceNumber,
        our_reference: line.invoiceReference,
        amount: moneyOut(line.amountMinorUnits, line.currency),
        due_date: dateOnly(line.dueDate),
      })),
      totals: totalsOut(lines),
      already_answered: row.answeredAt !== null,
      answered_at: row.answeredAt?.toISOString() ?? null,
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
    if (row.answeredAt) {
      throw new DomainException(
        'We already have an answer from you for this payment.',
      );
    }
    if (row.reviewedAt) {
      throw new DomainException(
        'This payment has already been reviewed. Please write to us if something has changed.',
      );
    }
    await this.answer(row.id, body, {
      public: true,
      actorLabel: body.respondentName?.trim() || 'Supplier',
    });
    return {
      recorded: true,
      message:
        'Thank you — we have recorded your answer. Somebody in our accounts team will check it against our records. If anything does not add up we will be in touch.',
    };
  }
}

const STANDING_LABELS: Record<CheckInStanding, string> = {
  not_sent: 'Not asked yet',
  awaiting_vendor: 'Waiting on the supplier',
  vendor_answered: 'Needs review',
  reviewed: 'Reviewed',
};

const STANDING_DESCRIPTIONS: Record<CheckInStanding, string> = {
  not_sent: 'Nobody has asked this supplier whether the money reached them.',
  awaiting_vendor: 'We have asked and are chasing. Nothing has come back yet.',
  vendor_answered:
    'The supplier has answered. Somebody here has to decide what it means before anything is recorded as paid.',
  reviewed: 'Someone here has weighed the evidence and recorded a conclusion.',
};

const CLAIM_LABELS: Record<string, string> = {
  received: 'Says the money arrived',
  partly_received: 'Says only part of it arrived',
  not_received: 'Says nothing arrived',
};

const CLAIM_DESCRIPTIONS: Record<string, string> = {
  received:
    'The supplier says the payment reached their account. Their word, not a bank statement, and not yet a decision by anybody here.',
  partly_received:
    'The supplier says something arrived but not all of it. Which part is missing needs the remittance advice and a person.',
  not_received:
    'The supplier says nothing has reached them. Worth checking against the bank before assuming the instruction failed.',
};

const CHANNEL_LABELS: Record<string, string> = {
  signed_link: 'Answered the link we emailed',
  email_reply: 'Replied to our email',
  recorded_by_staff: 'Told us, and we wrote it down',
  manual: 'Told us, and we wrote it down',
  web_form: 'Answered the link we emailed',
};

const REVIEW_LABELS: Record<string, string> = {
  paid: 'Paid',
  outstanding: 'Outstanding',
};

function checkInWhere(
  standing: string | string[] | undefined,
  search: string | undefined,
): Prisma.VendorCheckInWhereInput {
  const where: Prisma.VendorCheckInWhereInput = {};
  const wanted = (Array.isArray(standing) ? standing : standing ? [standing] : [])
    .map((value) => value.trim())
    .filter(Boolean);
  if (wanted.length) {
    where.OR = wanted.map(standingClause);
  }
  const term = search?.trim();
  if (term) {
    const searchClause: Prisma.VendorCheckInWhereInput = {
      OR: [
        { reference: { contains: term, mode: 'insensitive' } },
        { vendor: { name: { contains: term, mode: 'insensitive' } } },
      ],
    };
    where.AND = searchClause;
  }
  return where;
}

function standingClause(standing: string): Prisma.VendorCheckInWhereInput {
  if (standing === 'reviewed') return { reviewedAt: { not: null } };
  if (standing === 'vendor_answered') {
    return { reviewedAt: null, answeredAt: { not: null } };
  }
  if (standing === 'awaiting_vendor') {
    return { reviewedAt: null, answeredAt: null, sentAt: { not: null } };
  }
  if (standing === 'not_sent') {
    return { reviewedAt: null, answeredAt: null, sentAt: null };
  }
  return {};
}

function toSummary(
  row: {
    id: string;
    reference: string;
    sentAt: Date | null;
    answeredAt: Date | null;
    reviewedAt: Date | null;
    claim: string | null;
    reviewOutcome: string | null;
    package: { reference: string };
    vendor: { name: string; email: string | null } | null;
  },
  lines: Array<{ amountMinorUnits: bigint; currency: string }>,
) {
  const standing = deriveCheckInStanding(row);
  return {
    id: row.id,
    reference: row.reference,
    package_reference: row.package.reference,
    vendor_name: row.vendor?.name ?? 'Unknown supplier',
    vendor_email: row.vendor?.email ?? null,
    standing,
    standing_label: STANDING_LABELS[standing],
    invoice_count: lines.length,
    totals: totalsOut(lines),
    sent_at: row.sentAt?.toISOString() ?? null,
    answered_at: row.answeredAt?.toISOString() ?? null,
    claim: row.claim,
    claim_label: row.claim ? (CLAIM_LABELS[row.claim] ?? row.claim) : null,
    reviewed_at: row.reviewedAt?.toISOString() ?? null,
    review_outcome: row.reviewOutcome,
    review_outcome_label: row.reviewOutcome
      ? (REVIEW_LABELS[row.reviewOutcome] ?? row.reviewOutcome)
      : null,
  };
}

function suggest(
  claim: string | null,
  lines: Array<{ invoice: { status: InvoiceStatus } }>,
) {
  const stillSubmitted = lines.every(
    (line) => line.invoice.status === InvoiceStatus.SUBMITTED,
  );
  if (lines.length > 0 && !stillSubmitted) {
    return {
      outcome: null,
      outcome_label: null,
      because:
        'One of these invoices has been moved since the package was sent, so this check-in and the record no longer describe the same thing. Work out what happened to it before concluding anything.',
    };
  }
  if (claim === 'received') {
    return {
      outcome: 'paid',
      outcome_label: REVIEW_LABELS.paid,
      because:
        'The supplier says the money reached them. That is their claim rather than a bank statement, so it is worth a glance at the account before you agree with it.',
    };
  }
  if (claim === 'partly_received') {
    return {
      outcome: 'outstanding',
      outcome_label: REVIEW_LABELS.outstanding,
      because:
        'The supplier says only part of it arrived. Until it is known which part, none of this is settled.',
    };
  }
  if (claim === 'not_received') {
    return {
      outcome: 'outstanding',
      outcome_label: REVIEW_LABELS.outstanding,
      because:
        'The supplier says nothing arrived. Either the instruction did not go through or it went somewhere else, and both need chasing at the bank.',
    };
  }
  return {
    outcome: null,
    outcome_label: null,
    because:
      'Nothing has come back from the supplier yet, and the chasing has not run out. There is no evidence here to draw a conclusion from.',
  };
}

function totalsOut(lines: Array<{ amountMinorUnits: bigint; currency: string }>) {
  const totals = new Map<string, bigint>();
  for (const line of lines) {
    totals.set(line.currency, (totals.get(line.currency) ?? 0n) + line.amountMinorUnits);
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
