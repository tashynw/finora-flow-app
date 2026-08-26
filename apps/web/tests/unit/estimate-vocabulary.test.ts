import { describe, expect, it } from 'vitest';

import type { RouteState, StepState } from '@finora/shared-types';

import { ROUTE_STATE, STEP_STATE } from '@/features/estimates/estimate-vocabulary';
import { amountInputValue, parseAmount } from '@/lib/money';

const ALL_ROUTE_STATES: RouteState[] = ['open', 'approved', 'rejected', 'withdrawn'];
const ALL_STEP_STATES: StepState[] = [
  'waiting',
  'ready',
  'approved',
  'rejected',
  'withdrawn',
];

describe('route state vocabulary', () => {
  it('covers every state a route can be in', () => {
    for (const state of ALL_ROUTE_STATES) {
      expect(ROUTE_STATE[state]).toBeDefined();
      expect(ROUTE_STATE[state].description.length).toBeGreaterThan(20);
    }
  });

  it('reserves success for a route that is fully approved', () => {
    expect(ROUTE_STATE.approved.tone).toBe('success');
    for (const state of ALL_ROUTE_STATES.filter((item) => item !== 'approved')) {
      expect(ROUTE_STATE[state].tone).not.toBe('success');
    }
  });

  it('does not describe a withdrawn route as a verdict', () => {
    // Withdrawing is the requester taking the request back. Wording it as a
    // decision would make it look as though somebody refused it.
    expect(ROUTE_STATE.withdrawn.tone).toBe('neutral');
    expect(ROUTE_STATE.withdrawn.description).toMatch(/without a verdict/i);
  });

  it('says a withdrawn route keeps the approvals already given', () => {
    expect(ROUTE_STATE.withdrawn.description).toMatch(/still recorded/i);
  });

  it('names a person as the one who rejected, not a state the record reached', () => {
    expect(ROUTE_STATE.rejected.description).toMatch(/approver/i);
  });
});

describe('step state vocabulary', () => {
  it('covers every state a step can be in', () => {
    for (const state of ALL_STEP_STATES) {
      expect(STEP_STATE[state]).toBeDefined();
    }
  });

  it('does not treat a step that is not yet due as a problem', () => {
    // Otherwise every route with more than one step shows amber from the moment
    // it opens, and amber stops meaning anything.
    expect(STEP_STATE.waiting.tone).toBe('neutral');
  });

  it('marks the open step as the one being waited on', () => {
    expect(STEP_STATE.ready.tone).toBe('progress');
    expect(STEP_STATE.ready.label).toMatch(/waiting/i);
  });

  it('says an approval came from the person named beside it', () => {
    expect(STEP_STATE.approved.description).toMatch(/person named/i);
  });
});

describe('amountInputValue', () => {
  it('fills the box to the currency’s own number of decimal places', () => {
    expect(amountInputValue(120_000, 'JMD')).toBe('1200.00');
    expect(amountInputValue(1200, 'JPY')).toBe('1200');
    expect(amountInputValue(1_234_567, 'KWD')).toBe('1234.567');
  });

  it('leaves the box empty when there is no amount', () => {
    // Not '0.00'. A quotation with no total entered yet is not a quotation for
    // nothing, and pre-filling a zero invites it through unchanged.
    expect(amountInputValue(null, 'JMD')).toBe('');
  });
});

describe('parseAmount', () => {
  it('reads a typed amount as integer minor units', () => {
    expect(parseAmount('1200.00', 'JMD')).toBe(120_000);
    expect(parseAmount('1200', 'JPY')).toBe(1200);
    expect(parseAmount('1234.567', 'KWD')).toBe(1_234_567);
  });

  it('accepts the separators people actually type', () => {
    expect(parseAmount('1,200.00', 'JMD')).toBe(120_000);
    expect(parseAmount(' 1 200.00 ', 'JMD')).toBe(120_000);
  });

  it('rounds rather than discounts a supplier', () => {
    // More decimal places than the currency has is a mistake either way, and
    // truncating is the direction that quietly reduces what is being approved.
    expect(parseAmount('1200.005', 'JMD')).toBe(120_001);
    expect(parseAmount('1200.994', 'JMD')).toBe(120_099);
  });

  it('reports nothing usable rather than guessing', () => {
    expect(parseAmount('', 'JMD')).toBeNull();
    expect(parseAmount('   ', 'JMD')).toBeNull();
    expect(parseAmount('about two thousand', 'JMD')).toBeNull();
  });

  it('round-trips a stored amount through the box unchanged', () => {
    for (const minorUnits of [1, 999, 120_000, 5_000_000]) {
      expect(parseAmount(amountInputValue(minorUnits, 'JMD'), 'JMD')).toBe(minorUnits);
    }
  });
});
