/**
 * Labels for the credit-card register and statement workspace.
 *
 * Standing is derived from a timestamp, and coding standing is derived from
 * whether a GL and cost centre (or an exception) are present. The words here
 * are what the screen shows; the API's values stay machine-readable.
 */

export const PERIOD_PURPOSE =
  'A statement is a list of charges that already happened. Coding each line and closing the period are what make them accountable.';

export function periodWaitingOn(uncoded: number, missingReceipts: number, standing: string): string {
  if (standing === 'closed') {
    return 'Closed. Coding is fixed.';
  }
  if (uncoded > 0) {
    return uncoded === 1
      ? '1 line still needs coding'
      : `${uncoded} lines still need coding`;
  }
  if (missingReceipts > 0) {
    return missingReceipts === 1
      ? 'Coded, 1 receipt still missing'
      : `Coded, ${missingReceipts} receipts still missing`;
  }
  return 'Ready to close';
}
