import { describe, expect, it } from 'vitest';

import { periodWaitingOn } from '@/features/credit-cards/credit-card-vocabulary';

describe('periodWaitingOn', () => {
  it('says coding is fixed once a period is closed', () => {
    expect(periodWaitingOn(3, 2, 'closed')).toBe('Closed. Coding is fixed.');
  });

  it('puts uncoded lines ahead of missing receipts', () => {
    expect(periodWaitingOn(1, 4, 'open')).toBe('1 line still needs coding');
    expect(periodWaitingOn(5, 0, 'open')).toBe('5 lines still need coding');
  });

  it('reports missing receipts only after every line is coded', () => {
    expect(periodWaitingOn(0, 1, 'open')).toBe('Coded, 1 receipt still missing');
    expect(periodWaitingOn(0, 3, 'open')).toBe('Coded, 3 receipts still missing');
  });

  it('distinguishes a period that is ready to close from one still blocked', () => {
    expect(periodWaitingOn(0, 0, 'open')).toBe('Ready to close');
  });
});
