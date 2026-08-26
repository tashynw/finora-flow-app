import { describe, expect, it } from 'vitest';

import { periodWaitingOn } from '@/features/accruals/accrual-vocabulary';

describe('periodWaitingOn', () => {
  it('names a locked period as fixed', () => {
    expect(periodWaitingOn(0, 3, 'locked')).toBe('Locked. Candidates are fixed.');
  });

  it('asks for generation when there are no candidates', () => {
    expect(periodWaitingOn(0, 0, 'open')).toMatch(/generate/i);
  });

  it('counts what still needs a decision', () => {
    expect(periodWaitingOn(2, 5, 'open')).toBe('2 candidates still need a decision');
  });

  it('says ready to lock when everything is settled', () => {
    expect(periodWaitingOn(0, 4, 'open')).toBe('Ready to lock');
  });
});
