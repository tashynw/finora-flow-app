/**
 * Working-hours reminder clock.
 *
 * Three hours means three hours while the organisation is open (Mon–Fri,
 * 08:00–17:00 America/Jamaica). A reminder due at 16:30 on Friday is due at
 * 10:30 on Monday, not at 19:30 on Friday.
 */

import { TZDate } from '@date-fns/tz';
import {
  addDays,
  addMilliseconds,
  differenceInMilliseconds,
  getHours,
  isBefore,
  isWeekend,
} from 'date-fns';

const ZONE = 'America/Jamaica';
const START_HOUR = 8;
const END_HOUR = 17;

export const STAFF_INTERVAL_HOURS = 3;
export const STAFF_MAX_REMINDERS = 8;
export const ESCALATE_EVERY = 3;
export const MAX_ESCALATION_LEVEL = 3;

export const VENDOR_INTERVAL_DAYS = 5;
export const VENDOR_MAX_FOLLOW_UPS = 3;

export type Suppression =
  | 'not_yet_due'
  | 'outside_business_hours'
  | 'non_working_day'
  | 'maximum_reached'
  | 'already_actioned';

export type ReminderDecision = {
  send: boolean;
  nextDueAt: Date | null;
  suppression: Suppression | null;
  escalationLevel: number;
};

function zoned(moment: Date): TZDate {
  return new TZDate(moment, ZONE);
}

function asDate(moment: Date): Date {
  return new Date(moment.getTime());
}

function atLocalHour(moment: Date, hour: number): Date {
  const local = zoned(moment);
  return new TZDate(
    local.getFullYear(),
    local.getMonth(),
    local.getDate(),
    hour,
    0,
    0,
    0,
    ZONE,
  );
}

export function isWorkingDay(moment: Date): boolean {
  return !isWeekend(zoned(moment));
}

export function whyClosed(moment: Date): Suppression | null {
  if (!isWorkingDay(moment)) return 'non_working_day';
  const hour = getHours(zoned(moment));
  if (hour < START_HOUR || hour >= END_HOUR) return 'outside_business_hours';
  return null;
}

export function nextOpening(moment: Date): Date {
  const local = zoned(moment);
  const hour = getHours(local);
  if (isWorkingDay(local) && hour < START_HOUR) return asDate(atLocalHour(local, START_HOUR));
  if (isWorkingDay(local) && hour < END_HOUR) return asDate(moment);

  for (let i = 1; i <= 14; i += 1) {
    const day = addDays(local, i);
    if (isWorkingDay(day)) return asDate(atLocalHour(day, START_HOUR));
  }
  throw new Error('No working day was found. The business calendar is misconfigured.');
}

export function advanceWorkingHours(moment: Date, hours: number): Date {
  if (hours < 0) throw new Error('A reminder cannot fall due in the past.');
  let cursor = nextOpening(moment);
  let remaining = hours * 60 * 60 * 1000;

  while (remaining > 0) {
    const closes = atLocalHour(cursor, END_HOUR);
    const left = differenceInMilliseconds(closes, cursor);
    if (remaining < left) return asDate(addMilliseconds(cursor, remaining));
    remaining -= left;
    cursor = nextOpening(addMilliseconds(closes, 1000));
  }
  return asDate(cursor);
}

export function escalationLevelAfter(sent: number): number {
  return Math.min(Math.floor(sent / ESCALATE_EVERY), MAX_ESCALATION_LEVEL);
}

export function firstStaffDue(since: Date): Date {
  return advanceWorkingHours(since, STAFF_INTERVAL_HOURS);
}

export function decideStaffReminder(input: {
  now: Date;
  dueAt: Date | null;
  sent: number;
  stillWaiting: boolean;
}): ReminderDecision {
  const level = escalationLevelAfter(input.sent);
  if (!input.stillWaiting) {
    return { send: false, nextDueAt: null, suppression: 'already_actioned', escalationLevel: level };
  }
  if (input.sent >= STAFF_MAX_REMINDERS) {
    return { send: false, nextDueAt: null, suppression: 'maximum_reached', escalationLevel: level };
  }
  if (!input.dueAt || isBefore(input.now, input.dueAt)) {
    return { send: false, nextDueAt: input.dueAt, suppression: 'not_yet_due', escalationLevel: level };
  }
  const closed = whyClosed(input.now);
  if (closed) {
    return {
      send: false,
      nextDueAt: nextOpening(input.now),
      suppression: closed,
      escalationLevel: level,
    };
  }
  const after = input.sent + 1;
  return {
    send: true,
    nextDueAt:
      after >= STAFF_MAX_REMINDERS
        ? null
        : advanceWorkingHours(input.now, STAFF_INTERVAL_HOURS),
    suppression: null,
    escalationLevel: escalationLevelAfter(after),
  };
}

export function addCalendarDays(moment: Date, days: number): Date {
  return asDate(addDays(zoned(moment), days));
}

export function decideVendorFollowUp(input: {
  now: Date;
  dueAt: Date | null;
  sent: number;
  stillWaiting: boolean;
}): ReminderDecision {
  if (!input.stillWaiting) {
    return { send: false, nextDueAt: null, suppression: 'already_actioned', escalationLevel: 0 };
  }
  if (input.sent >= VENDOR_MAX_FOLLOW_UPS) {
    return { send: false, nextDueAt: null, suppression: 'maximum_reached', escalationLevel: 0 };
  }
  if (!input.dueAt || isBefore(input.now, input.dueAt)) {
    return { send: false, nextDueAt: input.dueAt, suppression: 'not_yet_due', escalationLevel: 0 };
  }
  const closed = whyClosed(input.now);
  if (closed) {
    return {
      send: false,
      nextDueAt: nextOpening(input.now),
      suppression: closed,
      escalationLevel: 0,
    };
  }
  const after = input.sent + 1;
  return {
    send: true,
    nextDueAt: after >= VENDOR_MAX_FOLLOW_UPS ? null : addCalendarDays(input.now, VENDOR_INTERVAL_DAYS),
    suppression: null,
    escalationLevel: 0,
  };
}
