import { describe, expect, it } from 'vitest';

import { waitedFor } from '@/features/approvals/approval-vocabulary';

describe('waitedFor', () => {
  it('says something just arrived rather than showing zero hours', () => {
    expect(waitedFor(0).label).toBe('Just arrived');
  });

  it('stays quiet within a working day', () => {
    // Everything in a queue would be flagged otherwise, which is the same as
    // nothing being flagged.
    expect(waitedFor(1).tone).toBe('neutral');
    expect(waitedFor(7).tone).toBe('neutral');
  });

  it('warns once it has outlasted a working day', () => {
    expect(waitedFor(8).tone).toBe('warning');
    expect(waitedFor(47).tone).toBe('warning');
  });

  it('escalates past two days and switches to days', () => {
    const waited = waitedFor(53);

    expect(waited.tone).toBe('danger');
    // Days, because "53 hours" makes the reader do the arithmetic to reach the
    // fact they actually wanted.
    expect(waited.label).toBe('Waiting 2 days');
  });

  it('rounds days down, so it never overstates how late something is', () => {
    expect(waitedFor(71).label).toBe('Waiting 2 days');
    expect(waitedFor(72).label).toBe('Waiting 3 days');
  });
});
