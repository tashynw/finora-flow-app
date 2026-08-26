/**
 * The words the interface uses for an invoice, its controls and its chasing.
 *
 * The API sends the label for every state and the explanation for every problem,
 * so none of those are repeated here. What it cannot send is tone, and what it
 * should not send is the judgement about how loud a thing ought to be. Both are
 * presentation decisions and both belong in one place, so an overdue invoice is
 * never amber in the register and red on the page.
 *
 * Two rules run through the wording.
 *
 * A control that has fired is described as a fact about the money, not as a
 * fault in the person reading the screen: "This is more than the approved
 * estimate" rather than "You have entered too much".
 *
 * Chasing is described from the point of view of the person being chased. Four
 * reminders and an escalation is an uncomfortable thing to display, and dressing
 * it up as a neutral counter would hide the one fact that justifies escalating.
 */

import type { StatusDescriptor } from '@/features/intake/intake-vocabulary';

/**
 * How a payment due date reads, given how many days are left.
 *
 * The thresholds are wider than they look. An invoice due in three days has to
 * clear sign-off and up to four approvals first, so "due soon" starts at a week
 * rather than at a day: by the time a single day is left, the warning has come
 * too late to act on.
 */
export function dueDescriptor(daysUntilDue: number | null): StatusDescriptor | null {
  if (daysUntilDue === null) return null;

  if (daysUntilDue < 0) {
    const days = Math.abs(daysUntilDue);
    return {
      label: days === 1 ? 'Overdue by a day' : `Overdue by ${days} days`,
      tone: 'danger',
      description: 'The date the supplier expected payment by has passed.',
    };
  }
  if (daysUntilDue === 0) {
    return {
      label: 'Due today',
      tone: 'danger',
      description: 'Payment is due today.',
    };
  }
  if (daysUntilDue <= 7) {
    return {
      label: daysUntilDue === 1 ? 'Due tomorrow' : `Due in ${daysUntilDue} days`,
      tone: 'warning',
      description: 'Little enough time left that any remaining approval needs chasing.',
    };
  }
  return {
    label: `Due in ${daysUntilDue} days`,
    tone: 'neutral',
    description: 'Time enough for the usual approvals.',
  };
}

/**
 * How the chasing of one person reads.
 *
 * `level` is the escalation level the reminder service has reached: 0 while only
 * the person asked is being written to, then one rung per tier above them.
 */
export function chasingDescriptor(remindersSent: number, level: number): StatusDescriptor {
  if (remindersSent === 0) {
    return {
      label: 'Asked',
      tone: 'progress',
      description: 'The request has gone out. Nobody has been chased yet.',
    };
  }
  if (level === 0) {
    return {
      label: remindersSent === 1 ? 'Chased once' : `Chased ${remindersSent} times`,
      tone: 'warning',
      description: 'Reminders are going out every three working hours.',
    };
  }
  return {
    label: `Escalated after ${remindersSent} reminders`,
    tone: 'danger',
    description: 'Reminders now copy in the line above the person who was asked.',
  };
}

/**
 * The register's summary of what is stopping an invoice.
 *
 * Blockers and unfinished fields are counted separately because they are
 * different kinds of work. An unfinished field is the drafter's to fill in; a
 * blocker is a control that has fired and usually needs somebody else — a
 * different amount, a wider estimate, an order reopened.
 */
export function blockerSummary(problemCount: number, blockerCount: number): string | null {
  if (blockerCount > 0) {
    return blockerCount === 1 ? '1 control to clear' : `${blockerCount} controls to clear`;
  }
  if (problemCount > 0) {
    return problemCount === 1 ? '1 field to finish' : `${problemCount} fields to finish`;
  }
  return null;
}
