/**
 * The words the interface uses for a payment package.
 *
 * A package is the one record in the platform with no workflow state, and the
 * wording has to carry that. It is open, submitted or cancelled, and none of
 * those is a decision anybody made about the money: every invoice inside was
 * approved before it could be added. The screens therefore never say "approved"
 * or "pending" about a package, because both would suggest a judgement that
 * does not exist and that nobody is waiting to give.
 *
 * The distinction the wording most has to protect is between the package and
 * what is in it. "Submitted" said of a package means the instruction went to the
 * bank; said of an invoice it means that invoice is now with the bank and not
 * yet confirmed paid. Two different facts, and confusing them is how somebody
 * concludes a supplier has been paid when nothing has cleared.
 */

import type { PackageStanding } from '@finora/shared-types';

import type { StatusDescriptor } from '@/features/intake/intake-vocabulary';

/** How a package's standing reads, and how loudly. */
export function packageStanding(standing: PackageStanding, label: string): StatusDescriptor {
  if (standing === 'submitted') {
    return {
      label,
      tone: 'progress',
      description: 'Sent to the bank. What it contained can no longer change.',
    };
  }
  if (standing === 'cancelled') {
    return {
      label,
      tone: 'neutral',
      description: 'Abandoned. Everything in it went back to being approved and unpaid.',
    };
  }
  return {
    label,
    tone: 'info',
    description: 'Still being put together. Nothing has left the account.',
  };
}

/**
 * What a package is waiting on, for a register row.
 *
 * A submitted package is waiting on the bank and says nothing here: the next
 * thing that happens to it is a vendor confirming payment, which is not this
 * screen's business. An open one is waiting on the person reading the row.
 */
export function waitingOn(
  standing: PackageStanding,
  invoiceCount: number,
  blockerCount: number,
): { label: string; tone: StatusDescriptor['tone'] } | null {
  if (standing !== 'open') return null;
  if (blockerCount > 0) {
    return {
      label: blockerCount === 1 ? '1 thing to look at' : `${blockerCount} things to look at`,
      tone: 'warning',
    };
  }
  if (invoiceCount === 0) return { label: 'Nothing in it yet', tone: 'neutral' };
  return { label: 'Ready to send', tone: 'info' };
}

/**
 * How many invoices and how many suppliers, in a sentence.
 *
 * Both, because they are different numbers and each answers a question the
 * other cannot. Eighty invoices across three suppliers and eighty across eighty
 * are the same size of payment run and nothing like the same amount of risk.
 */
export function contentsSummary(invoiceCount: number, vendorCount: number): string {
  if (invoiceCount === 0) return 'Empty';
  const invoices = invoiceCount === 1 ? '1 invoice' : `${invoiceCount} invoices`;
  const vendors = vendorCount === 1 ? '1 supplier' : `${vendorCount} suppliers`;
  return `${invoices}, ${vendors}`;
}

/**
 * Whether a line is still what the package thought it was.
 *
 * An invoice can be sent back for a correction or cancelled after it was added,
 * and the line then quotes a figure nobody owes. Said plainly rather than shown
 * as a state chip, because the reader's next action is to take it out.
 */
export function lineStanding(
  isStillPayable: boolean,
  stateLabel: string,
): StatusDescriptor | null {
  if (isStillPayable) return null;
  return {
    label: stateLabel,
    tone: 'danger',
    description: 'This is no longer payable and has to come out before the rest can go.',
  };
}
