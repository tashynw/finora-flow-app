import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainException } from '../common/errors.js';
import {
  auditMock,
  compile,
  provideAudit,
  providePrisma,
  session,
} from '../testing/fixtures.js';
import { CreditCardsService } from './credit-cards.service.js';

describe('CreditCardsService', () => {
  const prisma = {
    creditCardAccount: { create: vi.fn(), findMany: vi.fn() },
    creditCardPeriod: { findUnique: vi.fn(), update: vi.fn() },
    creditCardTransaction: { count: vi.fn(), update: vi.fn() },
  };
  const audit = auditMock();

  beforeEach(() => vi.clearAllMocks());

  async function service() {
    return compile(CreditCardsService, [
      providePrisma(prisma),
      provideAudit(audit),
    ]);
  }

  it('stores only the last four digits of a card', async () => {
    prisma.creditCardAccount.create.mockResolvedValue({ id: 'card-1', lastFour: '4242' });

    await (await service()).createCard(session, {
      label: 'Ops',
      lastFour: 'ACCT-4242',
      cardholderName: 'Ada',
      currency: 'JMD',
    });

    expect(prisma.creditCardAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastFour: '4242', currency: 'JMD' }),
      }),
    );
  });

  it('refuses to close a period that still has uncoded transactions', async () => {
    prisma.creditCardPeriod.findUnique.mockResolvedValue({
      id: 'period-1',
      closedAt: null,
      card: {},
      transactions: [],
    });
    prisma.creditCardTransaction.count.mockResolvedValue(2);

    await expect(
      (await service()).closePeriod(session, 'period-1', { reason: 'Month end' }),
    ).rejects.toBeInstanceOf(DomainException);
    expect(prisma.creditCardPeriod.update).not.toHaveBeenCalled();
  });
});
