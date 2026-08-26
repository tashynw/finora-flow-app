/**
 * The words the interface uses about a supplier's answer.
 *
 * One idea has to survive every screen in this feature: what a supplier tells us
 * is a claim, and a claim is not a fact about money. The wording carries that on
 * its own, because a badge reading "Paid" in green beside a supplier's cheerful
 * "yes" would settle the matter in the reader's head before anybody had looked
 * at a bank statement — and once it is settled in the reader's head, the review
 * that follows is a formality rather than a check.
 *
 * So nothing here ever says "Paid" about a claim. A supplier who says the money
 * arrived produces "They say it arrived", attributed, in a tone that means
 * progress rather than success. Green is reserved for `confirmed_paid`, which
 * the API sets only when every invoice concerned is genuinely in `paid` — and
 * only a human review puts it there.
 */

import type {
  CheckInStanding,
  ClaimChannel,
  ClaimOutcome,
  ReviewOutcome,
} from '@finora/shared-types';

import type { StatusDescriptor } from '@/features/intake/intake-vocabulary';
import type { StatusTone } from '@/components/workflow/status-badge';

/** Where a check-in has got to, and what the reader should do about it. */
export const STANDING: Record<CheckInStanding, StatusDescriptor> = {
  not_sent: {
    label: 'Not asked yet',
    tone: 'neutral',
    description: 'The supplier has not been contacted. Nobody is waiting on anybody.',
  },
  awaiting_vendor: {
    label: 'Waiting on the supplier',
    tone: 'info',
    description:
      'We have asked and had no answer. Silence is not payment, and it is not a refusal either.',
  },
  vendor_answered: {
    label: 'Answered, needs review',
    // Progress rather than success. An answer is the beginning of the work, not
    // the end of it, and green here would say the opposite.
    tone: 'progress',
    description:
      'The supplier has told us something. Somebody here has to weigh it and decide.',
  },
  reviewed: {
    label: 'Reviewed',
    tone: 'neutral',
    description: 'Somebody here has concluded, and the invoices have moved accordingly.',
  },
};

/**
 * What the supplier said, phrased so it can never be read as what happened.
 *
 * Every label is attributed — "They say", "They have not" — because the
 * unattributed version of the first one is the word "Paid".
 */
export const CLAIM: Record<ClaimOutcome, StatusDescriptor> = {
  received: {
    label: 'They say it arrived',
    tone: 'progress',
    description: 'Their claim, not our confirmation. It still has to be checked here.',
  },
  partly_received: {
    label: 'They say part of it arrived',
    tone: 'warning',
    description:
      'Some of the money reached them and some did not. Worth reading their note before deciding.',
  },
  not_received: {
    label: 'They say nothing arrived',
    tone: 'danger',
    description: 'Treat as unpaid until somebody has looked at the bank record.',
  },
};

/** How the answer reached us, which is part of how much it is worth. */
export const CHANNEL: Record<ClaimChannel, string> = {
  signed_link: 'Through the link we emailed them',
  email_reply: 'By replying to our email',
  recorded_by_staff: 'Written down here by a colleague',
};

/** The two conclusions a reviewer can reach, and what each does. */
export const REVIEW: Record<ReviewOutcome, StatusDescriptor> = {
  paid: {
    label: 'Paid',
    tone: 'success',
    description: 'The money left us and reached them. Every invoice in this check-in closes.',
  },
  outstanding: {
    label: 'Still outstanding',
    tone: 'danger',
    description:
      'The payment did not land. The invoices go back to being owed, and somebody has to chase the bank.',
  },
};

/**
 * The one badge on a check-in, chosen from whichever fact is furthest along.
 *
 * A reviewed check-in shows its outcome, because that is the conclusion and it
 * supersedes everything before it. An unreviewed one shows its standing rather
 * than its claim, so a queue never displays a row that looks decided when it is
 * not.
 */
export function headlineStatus(
  standing: CheckInStanding,
  standingLabel: string,
  reviewOutcome: ReviewOutcome | null,
  reviewOutcomeLabel: string | null,
): { label: string; tone: StatusTone } {
  if (reviewOutcome) {
    return { label: reviewOutcomeLabel ?? REVIEW[reviewOutcome].label, tone: REVIEW[reviewOutcome].tone };
  }
  return { label: standingLabel || STANDING[standing].label, tone: STANDING[standing].tone };
}

/**
 * What this row is waiting on, for somebody scanning the queue.
 *
 * Returns null for a reviewed check-in: it is waiting on nothing, and a queue
 * that labels finished work is a queue nobody trusts to show them what is left.
 */
export function waitingOn(
  standing: CheckInStanding,
): { label: string; tone: StatusTone } | null {
  if (standing === 'reviewed') return null;
  if (standing === 'vendor_answered') return { label: 'Needs your decision', tone: 'warning' };
  if (standing === 'awaiting_vendor') return { label: 'Waiting on them', tone: 'info' };
  return { label: 'Nobody has asked yet', tone: 'neutral' };
}

/**
 * How many invoices this one conversation covers.
 *
 * A bank pays a package as one credit, so a supplier with six invoices in it saw
 * one deposit and is asked one question. Saying how many are behind that
 * question is what stops a reviewer concluding on a figure they have not seen
 * the parts of.
 */
export function coverage(invoiceCount: number): string {
  if (invoiceCount === 0) return 'No invoices';
  return invoiceCount === 1 ? '1 invoice' : `${invoiceCount} invoices`;
}
