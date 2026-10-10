import { describe, expect, it } from 'vitest';
import {
  advanceWorkingHours,
  decideStaffReminder,
  decideVendorFollowUp,
  nextOpening,
} from './reminder-clock.js';

describe('reminder clock', () => {
  it('counts three working hours across a Friday evening into Monday', () => {
    const fridayAfternoon = new Date('2026-10-09T21:30:00.000Z');
    const due = advanceWorkingHours(fridayAfternoon, 3);
    expect(due.toISOString()).toBe('2026-10-12T15:30:00.000Z');
  });

  it('does not send a due staff reminder before the office opens', () => {
    const decision = decideStaffReminder({
      now: new Date('2026-10-12T11:00:00.000Z'),
      dueAt: new Date('2026-10-12T10:00:00.000Z'),
      sent: 0,
      stillWaiting: true,
    });
    expect(decision.send).toBe(false);
    expect(decision.suppression).toBe('outside_business_hours');
    expect(decision.nextDueAt?.toISOString()).toBe('2026-10-12T13:00:00.000Z');
  });

  it('sends a vendor follow-up once the day interval has passed during working hours', () => {
    const decision = decideVendorFollowUp({
      now: new Date('2026-10-13T15:00:00.000Z'),
      dueAt: new Date('2026-10-13T14:00:00.000Z'),
      sent: 0,
      stillWaiting: true,
    });
    expect(decision.send).toBe(true);
    expect(decision.nextDueAt?.toISOString()).toBe('2026-10-18T15:00:00.000Z');
  });

  it('stops once the vendor has answered', () => {
    const decision = decideVendorFollowUp({
      now: new Date('2026-10-13T15:00:00.000Z'),
      dueAt: new Date('2026-10-13T14:00:00.000Z'),
      sent: 1,
      stillWaiting: false,
    });
    expect(decision.send).toBe(false);
    expect(decision.suppression).toBe('already_actioned');
  });

  it('waits until Monday when a reminder comes due on Saturday', () => {
    const decision = decideStaffReminder({
      now: new Date('2026-10-10T15:00:00.000Z'),
      dueAt: new Date('2026-10-10T14:00:00.000Z'),
      sent: 1,
      stillWaiting: true,
    });
    expect(decision.send).toBe(false);
    expect(decision.suppression).toBe('non_working_day');
    expect(decision.nextDueAt?.toISOString()).toBe('2026-10-12T13:00:00.000Z');
    expect(nextOpening(new Date('2026-10-10T15:00:00.000Z')).toISOString()).toBe(
      '2026-10-12T13:00:00.000Z',
    );
  });

  it('sends during office hours and schedules the next one three working hours later', () => {
    const decision = decideStaffReminder({
      now: new Date('2026-10-12T15:00:00.000Z'),
      dueAt: new Date('2026-10-12T14:00:00.000Z'),
      sent: 2,
      stillWaiting: true,
    });
    expect(decision.send).toBe(true);
    expect(decision.escalationLevel).toBe(1);
    expect(decision.nextDueAt?.toISOString()).toBe('2026-10-12T18:00:00.000Z');
  });

  it('stops staff chasing after eight reminders', () => {
    const decision = decideStaffReminder({
      now: new Date('2026-10-12T15:00:00.000Z'),
      dueAt: new Date('2026-10-12T14:00:00.000Z'),
      sent: 8,
      stillWaiting: true,
    });
    expect(decision.send).toBe(false);
    expect(decision.suppression).toBe('maximum_reached');
    expect(decision.nextDueAt).toBeNull();
  });

  it('ends vendor chasing on the third follow-up', () => {
    const decision = decideVendorFollowUp({
      now: new Date('2026-10-13T15:00:00.000Z'),
      dueAt: new Date('2026-10-13T14:00:00.000Z'),
      sent: 2,
      stillWaiting: true,
    });
    expect(decision.send).toBe(true);
    expect(decision.nextDueAt).toBeNull();
  });
});
