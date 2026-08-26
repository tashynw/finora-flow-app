/**
 * The words the approvals queue uses.
 *
 * The only judgement here is when waiting becomes a problem, and it is made in
 * one place so the queue, a dashboard tile and a notification cannot disagree
 * about whether the same item is late.
 */

export type WaitTone = 'neutral' | 'warning' | 'danger';

/**
 * How long something has waited, in words.
 *
 * Hours up to two days and days after that. "Waiting 53 hours" makes the reader
 * do arithmetic to arrive at "over two days", which is the fact they wanted.
 *
 * The thresholds are a working day and two calendar days. Under a working day is
 * not late by any reading; past two days somebody downstream is being held up,
 * and the record is showing red on somebody's register whether or not it shows
 * red here.
 */
export function waitedFor(hours: number): { label: string; tone: WaitTone } {
  if (hours < 1) return { label: 'Just arrived', tone: 'neutral' };
  if (hours < 8) return { label: `Waiting ${hours}h`, tone: 'neutral' };
  if (hours < 48) return { label: `Waiting ${hours}h`, tone: 'warning' };

  const days = Math.floor(hours / 24);
  return { label: `Waiting ${days} days`, tone: 'danger' };
}
