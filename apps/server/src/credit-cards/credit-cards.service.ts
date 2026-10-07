import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { actorLabel } from '../common/invoice-status.js';
import { AuditService } from '../common/audit.service.js';
import { DomainException, conflict, notFound } from '../common/errors.js';
import { nextReference } from '../common/ids.js';
import { Currency } from '../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';

const PERIOD_SUBJECT = 'credit_card_period';
const CARD_SUBJECT = 'credit_card_account';

@Injectable()
export class CreditCardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listCards(activeOnly = true) {
    return this.prisma.creditCardAccount.findMany({
      where: {
        archivedAt: null,
        ...(activeOnly ? { isActive: true } : {}),
      },
      orderBy: [{ cardholderName: 'asc' }, { lastFour: 'asc' }],
    });
  }

  async createCard(
    session: UserSession,
    body: {
      label: string;
      lastFour: string;
      cardholderName: string;
      currency?: string;
    },
  ) {
    const lastFour = body.lastFour.replace(/\D/g, '').slice(-4);
    if (lastFour.length !== 4) {
      throw new DomainException('Enter the last four digits of the card.');
    }

    const currency = (body.currency ?? Currency.JMD).toUpperCase() as Currency;
    if (currency !== Currency.JMD && currency !== Currency.USD) {
      throw new DomainException('Currency must be JMD or USD.');
    }

    const row = await this.prisma.creditCardAccount.create({
      data: {
        label: body.label.trim(),
        lastFour,
        cardholderName: body.cardholderName.trim(),
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

    return row;
  }

  async importStatement(
    session: UserSession,
    cardId: string,
    body: {
      periodStart: string;
      periodEnd: string;
      statementDate: string;
      sourceFilename: string;
      transactions: {
        postedOn: string;
        merchant: string;
        cardholder: string;
        description?: string;
        amountMinorUnits: string | number;
        externalReference?: string;
      }[];
    },
  ) {
    const card = await this.prisma.creditCardAccount.findUnique({
      where: { id: cardId },
    });
    if (!card) throw notFound('Credit card', cardId);

    const payload = JSON.stringify(body.transactions);
    const sourceSha256 = createHash('sha256').update(payload, 'utf8').digest('hex');

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
        periodStart: new Date(body.periodStart),
        periodEnd: new Date(body.periodEnd),
        statementDate: new Date(body.statementDate),
        currency: card.currency,
        sourceSha256,
        sourceFilename: body.sourceFilename.trim(),
        importedAt: now,
        cardId,
        importedById: session.user.id,
        transactions: {
          create: body.transactions.map((tx, index) => ({
            sourceRow: index + 1,
            postedOn: new Date(tx.postedOn),
            merchant: tx.merchant.trim(),
            cardholder: tx.cardholder.trim(),
            description: tx.description?.trim() || null,
            externalReference: tx.externalReference?.trim() || null,
            amountMinorUnits: BigInt(tx.amountMinorUnits),
            currency: card.currency,
          })),
        },
      },
      include: { transactions: true },
    });

    await this.audit.append({
      action: 'credit_card_statement_imported',
      actorId: session.user.id,
      actorLabel: actorLabel(session),
      subjectType: PERIOD_SUBJECT,
      subjectId: period.id,
      detail: {
        reference: period.reference,
        transactionCount: period.transactions.length,
      },
    });

    return period;
  }

  async listPeriods() {
    return this.prisma.creditCardPeriod.findMany({
      orderBy: { periodEnd: 'desc' },
      include: { card: true },
    });
  }

  async getPeriod(id: string) {
    const period = await this.prisma.creditCardPeriod.findUnique({
      where: { id },
      include: {
        card: true,
        transactions: {
          orderBy: { sourceRow: 'asc' },
          include: {
            glAccount: true,
            costCentre: true,
            receiptDocument: true,
          },
        },
      },
    });
    if (!period) throw notFound('Credit card period', id);
    return period;
  }

  async codeTransaction(
    session: UserSession,
    id: string,
    body: {
      glAccountId?: string | null;
      costCentreId?: string | null;
      category?: string | null;
      exceptionReason?: string | null;
      expectedVersion?: number;
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
    if (
      body.expectedVersion != null &&
      body.expectedVersion !== tx.version
    ) {
      throw conflict('This transaction changed since you opened it.');
    }

    const updated = await this.prisma.creditCardTransaction.update({
      where: { id },
      data: {
        glAccountId: body.glAccountId ?? null,
        costCentreId: body.costCentreId ?? null,
        category: body.category?.trim() || null,
        exceptionReason: body.exceptionReason?.trim() || null,
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
      waived?: boolean;
      waiverReason?: string | null;
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
    if (waived && !body.waiverReason?.trim()) {
      throw new DomainException('Give a reason when waiving a receipt.');
    }
    if (!waived && !body.documentId) {
      throw new DomainException('Attach a receipt document or waive with a reason.');
    }

    return this.prisma.creditCardTransaction.update({
      where: { id },
      data: {
        receiptDocumentId: waived ? null : body.documentId ?? null,
        receiptWaived: waived,
        receiptWaiverReason: waived ? body.waiverReason?.trim() ?? null : null,
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
    const period = await this.getPeriod(id);
    if (period.closedAt) {
      throw new DomainException('This period is already closed.');
    }

    const reason = body.reason?.trim();
    if (!reason || reason.length < 3) {
      throw new DomainException('Give a reason for closing this period.');
    }

    const uncoded = period.transactions.filter(
      (tx) => !tx.glAccountId && !tx.exceptionReason,
    );
    if (uncoded.length) {
      throw new DomainException(
        `${uncoded.length} transaction(s) still need coding or an exception.`,
      );
    }

    const updated = await this.prisma.creditCardPeriod.update({
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

    return updated;
  }
}
