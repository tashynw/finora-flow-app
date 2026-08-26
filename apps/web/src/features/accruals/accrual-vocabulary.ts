/**
 * Labels for the accrual register and period workspace.
 *
 * Period standing is derived from a lock timestamp. Candidate standing is
 * proposed → adjusted → finalized (or excluded). The words here are what the
 * screen shows; the API's values stay machine-readable.
 */

export const PERIOD_PURPOSE =
  'An accrual is a claim that something is owed at period end even though it has not been paid. Generating candidates, finalizing them and locking the period are what make the pack accountable.';

export function periodWaitingOn(
  openCount: number,
  candidateCount: number,
  standing: string,
): string {
  if (standing === 'locked') {
    return 'Locked. Candidates are fixed.';
  }
  if (candidateCount === 0) {
    return 'No candidates yet — generate from unpaid invoices';
  }
  if (openCount > 0) {
    return openCount === 1
      ? '1 candidate still needs a decision'
      : `${openCount} candidates still need a decision`;
  }
  return 'Ready to lock';
}
