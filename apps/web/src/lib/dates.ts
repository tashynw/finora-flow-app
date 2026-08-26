/**
 * Dates and times, as a person reads them.
 *
 * Everything here formats in the reader's own locale rather than a fixed one.
 * A date written 03/08/2026 means the third of August to most of the people who
 * will use this and the eighth of March to the rest, and the browser already
 * knows which. Where the distinction matters the month is named, not numbered.
 *
 * The API sends a date as a plain `YYYY-MM-DD` and a moment as an ISO timestamp
 * in UTC. The two are formatted differently on purpose: a moment is shown in
 * local time because it records when somebody did something, and a date has no
 * time of day to shift.
 */

/** A calendar date the API sent as `YYYY-MM-DD`. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  // Parsed by hand rather than by `new Date(value)`, which reads a bare
  // YYYY-MM-DD as midnight UTC and so shows the day before to anyone west of
  // Greenwich. A quotation dated the 3rd is dated the 3rd everywhere.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const [, year, month, day] = match;
  const parsed = new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** A point in time the API sent as an ISO timestamp, shown in local time. */
export function formatMoment(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * How long ago, in the roughest terms that are still true.
 *
 * Only ever shown beside the absolute time, never instead of it. "2 hours ago"
 * is what makes a queue scannable and is useless in an audit conversation.
 */
export function formatRelative(value: string): string {
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / (60 * 24))} d ago`;
}

/** Today as `YYYY-MM-DD` in the reader's own timezone, for a date input. */
export function todayInputValue(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}
