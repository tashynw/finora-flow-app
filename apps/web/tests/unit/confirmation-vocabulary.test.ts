import { describe, expect, it } from 'vitest';

import {
  CHANNEL,
  CLAIM,
  REVIEW,
  STANDING,
  coverage,
  headlineStatus,
  mayConcludeCheckIn,
  waitingOn,
} from '@/features/vendor-confirmations/confirmation-vocabulary';

/**
 * These tests are mostly about wording, which is unusual and deliberate.
 *
 * The single failure mode this feature exists to prevent is somebody reading a
 * supplier's claim as a settled fact. That protection lives entirely in the
 * words and the colours, so the words and the colours are what is asserted.
 */

describe('what a supplier said', () => {
  it('never states a claim as though it were a fact', () => {
    // "Paid" attached to a claim is the whole bug. Every label has to attribute
    // the statement to the person who made it.
    for (const outcome of ['received', 'partly_received', 'not_received'] as const) {
      expect(CLAIM[outcome].label).toMatch(/^They /);
    }
  });

  it('does not colour a supplier saying yes as a success', () => {
    // Green is a conclusion. A supplier's word is evidence towards one.
    expect(CLAIM.received.tone).toBe('progress');
    expect(CLAIM.received.tone).not.toBe('success');
  });

  it('says outright that a yes still has to be checked', () => {
    expect(CLAIM.received.description).toMatch(/checked here/i);
  });

  it('treats a supplier saying nothing arrived as the serious case', () => {
    expect(CLAIM.not_received.tone).toBe('danger');
  });

  it('names the channel, because how an answer reached us is part of its weight', () => {
    // A staff member typing up a telephone call and a supplier clicking a link
    // are both claims, and they are not equally direct.
    expect(CHANNEL.recorded_by_staff).toMatch(/colleague/i);
    expect(CHANNEL.signed_link).not.toBe(CHANNEL.recorded_by_staff);
  });
});

describe('where a check-in has got to', () => {
  it('does not treat an answered check-in as finished', () => {
    // An answer is the beginning of the work. Success here would tell a queue
    // reader the row needs nothing from them, which is the opposite of true.
    expect(STANDING.vendor_answered.tone).toBe('progress');
    expect(STANDING.vendor_answered.description).toMatch(/decide/i);
  });

  it('says plainly that silence means nothing either way', () => {
    expect(STANDING.awaiting_vendor.description).toMatch(/silence is not payment/i);
  });
});

describe('headlineStatus', () => {
  it('shows the standing while a check-in is unreviewed, not the claim', () => {
    // A row cannot read "Paid" because a supplier said so.
    const status = headlineStatus('vendor_answered', 'Answered, needs review', null, null);

    expect(status.label).toBe('Answered, needs review');
    expect(status.tone).toBe('progress');
  });

  it('shows the conclusion once somebody here has reached one', () => {
    const status = headlineStatus('reviewed', 'Reviewed', 'paid', 'Paid');

    expect(status.label).toBe('Paid');
    expect(status.tone).toBe('success');
  });

  it('reserves the success tone for a reviewed outcome of paid', () => {
    // Every other combination, including a reviewed Outstanding, must not be
    // green.
    expect(headlineStatus('reviewed', 'Reviewed', 'outstanding', 'Still outstanding').tone).toBe(
      'danger',
    );
    expect(headlineStatus('not_sent', 'Not asked yet', null, null).tone).not.toBe('success');
    expect(headlineStatus('awaiting_vendor', 'Waiting on the supplier', null, null).tone).not.toBe(
      'success',
    );
  });

  it('falls back to its own wording when the API sends none', () => {
    // Defensive rather than expected. A blank label would leave a badge that is
    // a coloured dot and nothing else.
    expect(headlineStatus('not_sent', '', null, null).label).toBe('Not asked yet');
    expect(headlineStatus('reviewed', 'Reviewed', 'paid', null).label).toBe('Paid');
  });
});

describe('waitingOn', () => {
  it('says nothing about a concluded check-in', () => {
    // It is waiting on nobody, and a queue that labels finished work is a queue
    // people stop trusting to show them what is left.
    expect(waitingOn('reviewed')).toBeNull();
  });

  it('marks an answered check-in as the reader’s own work', () => {
    expect(waitingOn('vendor_answered')).toEqual({
      label: 'Needs your decision',
      tone: 'warning',
    });
  });

  it('distinguishes waiting on them from nobody having asked', () => {
    // Both are unanswered, and reporting them the same way hides a check-in
    // that was raised and then forgotten.
    expect(waitingOn('awaiting_vendor')?.label).toBe('Waiting on them');
    expect(waitingOn('not_sent')?.label).toBe('Nobody has asked yet');
  });
});

describe('the two conclusions', () => {
  it('says what each one does to the invoices, not just what it is called', () => {
    expect(REVIEW.paid.description).toMatch(/closes/i);
    expect(REVIEW.outstanding.description).toMatch(/back to being owed/i);
  });

  it('is the only place the word paid appears in a success tone', () => {
    expect(REVIEW.paid.tone).toBe('success');
    expect(REVIEW.outstanding.tone).toBe('danger');
  });
});

describe('who may conclude', () => {
  it('shows Conclude only to someone who can mark a payment paid', () => {
    expect(mayConcludeCheckIn(true, true)).toBe(true);
    expect(mayConcludeCheckIn(false, true)).toBe(false);
    expect(mayConcludeCheckIn(true, false)).toBe(false);
  });
});

describe('coverage', () => {
  it('says how many invoices sit behind one question', () => {
    // The bank pays a package as one credit, so a supplier with six invoices in
    // it saw one deposit. A reviewer needs to know they are concluding on six.
    expect(coverage(6)).toBe('6 invoices');
    expect(coverage(1)).toBe('1 invoice');
  });

  it('does not count to zero', () => {
    expect(coverage(0)).toBe('No invoices');
  });
});
