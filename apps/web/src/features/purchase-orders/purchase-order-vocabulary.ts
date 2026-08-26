/**
 * The words the interface uses for a purchase order.
 *
 * "Open" and "closed" are labels rather than states. An order is approved or it
 * is not, and closing it says nobody expects any more invoices against it. The
 * API sends the label it has decided on; what it cannot send is tone, and the
 * one judgement worth making here is that an order still taking invoices is a
 * live commitment and everything else is history.
 *
 * The distinction the wording has to carry is between closing and cancelling.
 * Closing says the commitment was honoured and is finished. Cancelling says it
 * should never have existed, which is a claim an invoice billed against the
 * order contradicts. Two endings that read the same would let somebody choose
 * the wrong one, and the wrong one erases a commitment the supplier acted on.
 */

import type { StatusDescriptor } from '@/features/intake/intake-vocabulary';

/** How an order's standing reads, given whether it is still taking invoices. */
export function orderStanding(label: string, isOpen: boolean): StatusDescriptor {
  return {
    label,
    tone: isOpen ? 'success' : 'neutral',
    description: isOpen
      ? 'Still receiving invoices against this commitment.'
      : 'Not receiving invoices. Nothing further should be billed against it.',
  };
}

/**
 * How much of an order is left, said in the way a reviewer needs to hear it.
 *
 * An order with nothing left is not an error, so it is not red. An order that
 * has been billed past its figure is, because somebody committed to one amount
 * and is being asked to pay more.
 */
export function capacityDescriptor(
  remainingMinorUnits: number | null,
  formatted: string | null,
): StatusDescriptor | null {
  if (remainingMinorUnits === null || formatted === null) return null;

  if (remainingMinorUnits < 0) {
    return {
      label: `${formatted} over`,
      tone: 'danger',
      description: 'Invoices against this order exceed what was committed.',
    };
  }
  if (remainingMinorUnits === 0) {
    return {
      label: 'Fully billed',
      tone: 'neutral',
      description: 'The whole commitment has been invoiced.',
    };
  }
  return {
    label: `${formatted} left`,
    tone: 'success',
    description: 'Still available to bill against.',
  };
}

/**
 * What an order is waiting on, for a register row.
 *
 * Ordered by what stops progress rather than by severity, because a register is
 * read to decide what to pick up next.
 */
export function waitingOn(
  state: string,
  problemCount: number,
): { label: string; tone: StatusDescriptor['tone'] } | null {
  if (state === 'draft' && problemCount > 0) {
    return {
      label: problemCount === 1 ? '1 thing to finish' : `${problemCount} things to finish`,
      tone: 'warning',
    };
  }
  if (state === 'draft') return { label: 'Ready to commit', tone: 'info' };
  if (state === 'pending_approval') return { label: 'With approvers', tone: 'info' };
  return null;
}
