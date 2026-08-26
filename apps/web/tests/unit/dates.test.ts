import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatDate, formatMoment, formatRelative, todayInputValue } from '@/lib/dates';

describe('formatDate', () => {
  it('names the month, so a day and a month cannot be read the wrong way round', () => {
    // 03/08/2026 is the third of August to most readers and the eighth of March
    // to the rest. A named month cannot be read either way.
    const rendered = formatDate('2026-08-03');
    expect(rendered).toMatch(/Aug/);
    expect(rendered).toMatch(/3/);
    expect(rendered).toMatch(/2026/);
  });

  it('shows the day the API sent, whatever the reader’s timezone', () => {
    // `new Date('2026-08-03')` is midnight UTC, which is the 2nd of August
    // anywhere west of Greenwich. A quotation dated the 3rd is dated the 3rd.
    expect(formatDate('2026-08-03')).toMatch(/\b3\b/);
    expect(formatDate('2026-01-01')).toMatch(/\b1\b/);
  });

  it('shows a dash where there is no date, rather than a fabricated one', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('')).toBe('—');
  });

  it('shows whatever it was given when it cannot be read as a date', () => {
    // Better a value a reader recognises as wrong than "Invalid Date", which
    // reads as a fault in this software rather than in the data.
    expect(formatDate('sometime in August')).toBe('sometime in August');
  });
});

describe('formatMoment', () => {
  it('includes the time of day, because it records when somebody acted', () => {
    const rendered = formatMoment('2026-08-03T14:35:00Z');
    expect(rendered).toMatch(/Aug/);
    expect(rendered).toMatch(/:/);
  });

  it('shows a dash where there is no timestamp', () => {
    expect(formatMoment(null)).toBe('—');
  });
});

describe('formatRelative', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gets rougher as it gets older, because that is all the precision helps with', () => {
    expect(formatRelative('2026-08-05T11:59:40Z')).toBe('just now');
    expect(formatRelative('2026-08-05T11:45:00Z')).toBe('15 min ago');
    expect(formatRelative('2026-08-05T09:00:00Z')).toBe('3 h ago');
    expect(formatRelative('2026-08-02T12:00:00Z')).toBe('3 d ago');
  });
});

describe('todayInputValue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Late evening local time, which is already tomorrow in UTC. A date input
    // filled from UTC would offer the wrong day.
    vi.setSystemTime(new Date(2026, 7, 5, 23, 30));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives today in the reader’s own timezone, padded for a date input', () => {
    expect(todayInputValue()).toBe('2026-08-05');
  });
});
