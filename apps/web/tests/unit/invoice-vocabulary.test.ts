import { describe, expect, it } from 'vitest';

import {
  blockerSummary,
  chasingDescriptor,
  dueDescriptor,
} from '@/features/invoices/invoice-vocabulary';

describe('dueDescriptor', () => {
  it('says nothing when no due date is recorded', () => {
    expect(dueDescriptor(null)).toBeNull();
  });

  it('counts the days an invoice is overdue by', () => {
    expect(dueDescriptor(-4)?.label).toBe('Overdue by 4 days');
    expect(dueDescriptor(-1)?.label).toBe('Overdue by a day');
  });

  it('treats today and any day past as urgent', () => {
    expect(dueDescriptor(0)?.tone).toBe('danger');
    expect(dueDescriptor(-1)?.tone).toBe('danger');
  });

  it('warns a week ahead rather than the day before', () => {
    // An invoice still has sign-off and up to four approvals to clear, so a
    // warning that arrives with one day left has arrived too late to act on.
    expect(dueDescriptor(7)?.tone).toBe('warning');
    expect(dueDescriptor(8)?.tone).toBe('neutral');
  });

  it('reads naturally for one day', () => {
    expect(dueDescriptor(1)?.label).toBe('Due tomorrow');
    expect(dueDescriptor(0)?.label).toBe('Due today');
  });
});

describe('chasingDescriptor', () => {
  it('separates having been asked from having been chased', () => {
    expect(chasingDescriptor(0, 0).label).toBe('Asked');
    expect(chasingDescriptor(0, 0).tone).toBe('progress');
  });

  it('counts the reminders', () => {
    expect(chasingDescriptor(1, 0).label).toBe('Chased once');
    expect(chasingDescriptor(4, 0).label).toBe('Chased 4 times');
  });

  it('says plainly when somebody’s line manager has been brought in', () => {
    const escalated = chasingDescriptor(4, 1);

    expect(escalated.tone).toBe('danger');
    expect(escalated.label).toMatch(/escalated/i);
    expect(escalated.description).toMatch(/copy in|copies in/i);
  });
});

describe('blockerSummary', () => {
  it('says nothing when there is nothing outstanding', () => {
    expect(blockerSummary(0, 0)).toBeNull();
  });

  it('reports a control that has fired ahead of an unfinished field', () => {
    // Both are counted in problem_count, and reporting "3 fields to finish" for a
    // duplicate invoice number would send it to the wrong person entirely.
    expect(blockerSummary(3, 1)).toBe('1 control to clear');
  });

  it('reports unfinished fields when no control has fired', () => {
    expect(blockerSummary(3, 0)).toBe('3 fields to finish');
    expect(blockerSummary(1, 0)).toBe('1 field to finish');
  });
});
