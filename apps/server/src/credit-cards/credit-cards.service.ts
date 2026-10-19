import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { actorLabel } from '../common/invoice-status.js';
import { AuditService } from '../common/audit.service.js';
import { DomainException, conflict, notFound } from '../common/errors.js';
import { nextReference } from '../common/ids.js';
import { Currency } from '../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parseStatementCsv } from './statement-csv.js';

const PERIOD_SUBJECT = 'credit_card_period';
const CARD_SUBJECT = 'credit_card_account';

@Injectable()
export class CreditCardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listCards(activeOnly = true) {
    const rows = await this.prisma.creditCardAccount.findMany({
      where: {
        archivedAt: null,
        ...(activeOnly ? { isActive: true } : {}),
      },
      orderBy: [{ cardholderName: 'asc' }, { lastFour: 'asc' }],
    });
    return rows.map(toCard);
  }

  async createCard(
    session: UserSession,
    body: {
      label: string;
      lastFour?: string;
      last_four?: string;
      cardholderName?: string;
      cardholder_name?: string;
      currency?: string;
    },
  ) {
    const lastFour = (body.lastFour ?? body.last_four ?? '').replace(/\D/g, '').slice(-4);
    if (lastFour.length !== 4) {
      throw new DomainException('Enter the last four digits of the card.');
    }

    const cardholderName = (body.cardholderName ?? body.cardholder_name ?? '').trim();
    const currency = (body.currency ?? Currency.JMD).toUpperCase() as Currency;
    if (currency !== Currency.JMD && currency !== Currency.USD) {
      throw new DomainException('Currency must be JMD or USD.');
    }

    const row = await this.prisma.creditCardAccount.create({
      data: {
        label: body.label.trim(),
        lastFour,
        cardholderName,
        currency,
        isActive: true,
      },
    });

    await this.audit.append({
      action: 'record_created',
      actorId: session.user.id,
      actorLabel: actorLabel(session),
      subjectType: CARD_SUBJECT,
      subjectId: row.id,
      detail: { label: row.label, lastFour: row.lastFour },
    });

    return toCard(row);
  }

  async importStatement(
    session: UserSession,
    cardId: string,
    body: {
      csvText: string;
      filename: string;
      periodStart: string;
      periodEnd: string;
      statementDate: string;
    },
  ) {
    const card = await this.prisma.creditCardAccount.findUnique({
      where: { id: cardId },
    });
    if (!card) throw notFound('Credit card', cardId);
    if (body.periodEnd < body.periodStart) {
      throw new DomainException('The period end cannot be before its start.');
    }

    const lines = parseStatementCsv(body.csvText);
    const sourceSha256 = createHash('sha256').update(body.csvText, 'utf8').digest('hex');
    const existing = await this.prisma.creditCardPeriod.findUnique({
      where: { cardId_sourceSha256: { cardId, sourceSha256 } },
    });
    if (existing) {
      throw conflict('This statement file has already been imported for this card.');
    }

    const now = new Date();
    const period = await this.prisma.creditCardPeriod.create({
      data: {
        reference: nextReference('CCP'),
        periodStart: new Date(`${body.periodStart}T00:00:00.000Z`),
        periodEnd: new Date(`${body.periodEnd}T00:00:00.000Z`),
        statementDate: new Date(`${body.statementDate}T00:00:00.000Z`),
        currency: card.currency,
        sourceSha256,
        sourceFilename: body.filename.trim() || 'statement.csv',
        importedAt: now,
        cardId,
        importedById: session.user.id,
        transactions: {
          create: lines.map((line) => ({
            sourceRow: line.sourceRow,
            postedOn: new Date(`${line.postedOn}T00:00:00.000Z`),
            merchant: line.merchant,
            cardholder: line.cardholder,
            description: line.description,
            externalReference: line.externalReference,
            category: line.category,
            amountMinorUnits: line.amountMinorUnits,
            currency: card.currency,
          })),
        },
      },
      include: periodDetailInclude,
    });

    await this.audit.append({
      action: 'credit_card_statement_imported',
      actorId: session.user.id,
      actorLabel: actorLabel(session),
      subjectType: PERIOD_SUBJECT,
      subjectId: period.id,
      detail: {
        reference: period.reference,
        filename: period.sourceFilename,
        sha256: sourceSha256,
        transactionCount: period.transactions.length,
      },
    });

    return toPeriodDetail(period, session.user.id);
  }

  async listPeriods(standing?: string) {
    const rows = await this.prisma.creditCardPeriod.findMany({
      where:
        standing === 'closed'
          ? { closedAt: { not: null } }
          : standing === 'open'
            ? { closedAt: null }
            : {},
      orderBy: { periodEnd: 'desc' },
      include: periodDetailInclude,
    });
    return rows.map((row) => toPeriodSummary(row));
  }

  async getPeriod(id: string, userId?: string) {
    const period = await this.loadPeriod(id);
    return toPeriodDetail(period, userId);
  }

  async codeTransaction(
    session: UserSession,
    id: string,
    body: {
      glAccountId?: string | null;
      gl_account_id?: string | null;
      costCentreId?: string | null;
      cost_centre_id?: string | null;
      category?: string | null;
      exceptionReason?: string | null;
      exception_reason?: string | null;
      expectedVersion?: number;
      expected_version?: number;
    },
  ) {
    const tx = await this.prisma.creditCardTransaction.findUnique({
      where: { id },
      include: { period: true },
    });
    if (!tx) throw notFound('Transaction', id);
    if (tx.period.closedAt) {
      throw new DomainException('This period is closed.');
    }
    const expectedVersion = body.expectedVersion ?? body.expected_version;
    if (expectedVersion != null && expectedVersion !== tx.version) {
      throw conflict('This transaction changed since you opened it.');
    }

    const updated = await this.prisma.creditCardTransaction.update({
      where: { id },
      data: {
        glAccountId: body.glAccountId ?? body.gl_account_id ?? null,
        costCentreId: body.costCentreId ?? body.cost_centre_id ?? null,
        category: body.category?.trim() || null,
        exceptionReason: (body.exceptionReason ?? body.exception_reason)?.trim() || null,
        codedAt: new Date(),
        codedById: session.user.id,
        version: { increment: 1 },
      },
    });

    await this.audit.append({
      action: 'credit_card_transaction_coded',
      actorId: session.user.id,
      actorLabel: actorLabel(session),
      subjectType: 'credit_card_transaction',
      subjectId: id,
      detail: { periodId: tx.periodId },
    });

    return updated;
  }

  async attachReceipt(
    session: UserSession,
    id: string,
    body: {
      documentId?: string | null;
      document_id?: string | null;
      waived?: boolean;
      waiverReason?: string | null;
      waiver_reason?: string | null;
    },
  ) {
    const tx = await this.prisma.creditCardTransaction.findUnique({
      where: { id },
      include: { period: true },
    });
    if (!tx) throw notFound('Transaction', id);
    if (tx.period.closedAt) {
      throw new DomainException('This period is closed.');
    }

    const waived = body.waived === true;
    const waiverReason = body.waiverReason ?? body.waiver_reason;
    const documentId = body.documentId ?? body.document_id;
    if (waived && !waiverReason?.trim()) {
      throw new DomainException('Give a reason when waiving a receipt.');
    }
    if (!waived && !documentId) {
      throw new DomainException('Attach a receipt document or waive with a reason.');
    }

    return this.prisma.creditCardTransaction.update({
      where: { id },
      data: {
        receiptDocumentId: waived ? null : documentId ?? null,
        receiptWaived: waived,
        receiptWaiverReason: waived ? waiverReason?.trim() ?? null : null,
        matchedAt: new Date(),
        matchedById: session.user.id,
        version: { increment: 1 },
      },
    });
  }

  async closePeriod(
    session: UserSession,
    id: string,
    body: { reason: string },
  ) {
    const period = await this.loadPeriod(id);
    if (period.closedAt) {
      throw new DomainException('This period is already closed.');
    }

    const reason = body.reason?.trim();
    if (!reason || reason.length < 3) {
      throw new DomainException('Give a reason for closing this period.');
    }

    const uncodedCount = await this.prisma.creditCardTransaction.count({
      where: {
        periodId: id,
        glAccountId: null,
        exceptionReason: null,
      },
    });
    if (uncodedCount > 0) {
      throw new DomainException(
        `${uncodedCount} transaction(s) still need coding or an exception.`,
      );
    }

    await this.prisma.creditCardPeriod.update({
      where: { id },
      data: {
        closedAt: new Date(),
        closeReason: reason,
        closedById: session.user.id,
        version: { increment: 1 },
      },
    });

    await this.audit.append({
      action: 'credit_card_period_closed',
      actorId: session.user.id,
      actorLabel: actorLabel(session),
      subjectType: PERIOD_SUBJECT,
      subjectId: id,
      detail: { reference: period.reference, reason },
    });

    return this.getPeriod(id, session.user.id);
  }

  private async loadPeriod(id: string) {
    const period = await this.prisma.creditCardPeriod.findUnique({
      where: { id },
      include: periodDetailInclude,
    });
    if (!period) throw notFound('Credit card period', id);
    return period;
  }
}

const periodDetailInclude = {
  card: true,
  transactions: {
    orderBy: { sourceRow: 'asc' as const },
    include: {
      glAccount: true,
      costCentre: true,
      receiptDocument: true,
    },
  },
};

type PeriodRow = {
  id: string;
  reference: string;
  periodStart: Date;
  periodEnd: Date;
  statementDate: Date;
  currency: string;
  sourceFilename: string;
  closedAt: Date | null;
  closeReason: string | null;
  card: {
    id: string;
    label: string;
    lastFour: string;
    cardholderName: string;
    currency: string;
    isActive: boolean;
  };
  transactions: {
    id: string;
    sourceRow: number;
    postedOn: Date;
    merchant: string;
    cardholder: string;
    description: string | null;
    externalReference: string | null;
    amountMinorUnits: bigint;
    currency: string;
    category: string | null;
    exceptionReason: string | null;
    glAccountId: string | null;
    costCentreId: string | null;
    glAccount: { id: string; code: string; name: string } | null;
    costCentre: { id: string; code: string; name: string } | null;
    receiptDocumentId: string | null;
    receiptWaived: boolean;
    receiptWaiverReason: string | null;
    receiptMatchConfidence: number | null;
    suggestionDisposition: string | null;
    suggestedGlAccountId: string | null;
    suggestedCostCentreId: string | null;
    suggestionEvidence: unknown;
    codedById: string | null;
    version: number;
  }[];
};

function toCard(card: PeriodRow['card']) {
  return {
    id: card.id,
    label: card.label,
    last_four: card.lastFour,
    cardholder_name: card.cardholderName,
    currency: card.currency,
    is_active: card.isActive,
  };
}

function isoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function formatMoney(minor: bigint, currency: string) {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return `${currency} ${negative ? '-' : ''}${whole}.${fraction}`;
}

function toPeriodSummary(period: PeriodRow) {
  const standing = period.closedAt ? 'closed' : 'open';
  const uncoded = period.transactions.filter(
    (row) => !row.glAccountId && !row.exceptionReason?.trim(),
  ).length;
  const missingReceipts = period.transactions.filter(
    (row) => !row.receiptDocumentId && !row.receiptWaived,
  ).length;
  return {
    id: period.id,
    reference: period.reference,
    card: toCard(period.card),
    period_start: isoDate(period.periodStart),
    period_end: isoDate(period.periodEnd),
    statement_date: isoDate(period.statementDate),
    currency: period.currency,
    standing,
    standing_label: standing === 'closed' ? 'Closed' : 'Open',
    standing_description:
      standing === 'closed'
        ? 'Closed. Coding and matches are fixed, and the period cannot be reopened from here.'
        : 'Still being coded. Lines can change; nothing is locked.',
    transaction_count: period.transactions.length,
    uncoded_count: uncoded,
    missing_receipt_count: missingReceipts,
    closed_at: period.closedAt?.toISOString() ?? null,
    source_filename: period.sourceFilename,
  };
}

function toTransaction(row: PeriodRow['transactions'][number]) {
  const excepted = Boolean(row.exceptionReason?.trim());
  const coded = Boolean(row.glAccountId && row.costCentreId);
  const coding = excepted ? 'excepted' : coded ? 'coded' : 'uncoded';
  const receipt = row.receiptDocumentId ? 'matched' : row.receiptWaived ? 'waived' : 'missing';
  return {
    id: row.id,
    source_row: row.sourceRow,
    posted_on: isoDate(row.postedOn),
    merchant: row.merchant,
    cardholder: row.cardholder,
    description: row.description,
    external_reference: row.externalReference,
    amount: {
      currency: row.currency,
      minor_units: Number(row.amountMinorUnits),
      formatted: formatMoney(row.amountMinorUnits, row.currency),
    },
    category: row.category,
    coding_standing: coding,
    coding_label: excepted ? 'Excepted' : coded ? 'Coded' : 'Needs coding',
    gl_account: row.glAccount,
    cost_centre: row.costCentre,
    exception_reason: row.exceptionReason,
    receipt_status: receipt,
    receipt_label:
      receipt === 'matched' ? 'Receipt matched' : receipt === 'waived' ? 'Receipt waived' : 'No receipt',
    receipt_document_id: row.receiptDocumentId,
    receipt_waived: row.receiptWaived,
    receipt_waiver_reason: row.receiptWaiverReason,
    receipt_match_confidence: row.receiptMatchConfidence,
    suggestion_disposition: row.suggestionDisposition,
    suggested_gl_account_id: row.suggestedGlAccountId,
    suggested_cost_centre_id: row.suggestedCostCentreId,
    suggestion_evidence: row.suggestionEvidence,
    version: row.version,
  };
}

function toPeriodDetail(period: PeriodRow, userId?: string) {
  const summary = toPeriodSummary(period);
  const codedByViewer = period.transactions.some((row) => row.codedById === userId);
  const open = summary.standing === 'open';
  return {
    ...summary,
    transactions: period.transactions.map(toTransaction),
    close_reason: period.closeReason,
    actions: {
      code: open,
      close: open && !codedByViewer,
    },
  };
}
