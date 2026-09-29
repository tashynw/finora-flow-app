import type { MoneyOut } from '@finora/shared-types';

import { cn } from '@/lib/utils';
import type { MoneyValue } from '@/lib/money';
import { MoneyDisplay } from '@/components/finance/money-display';

/** The API's money shape in the units `MoneyDisplay` expects. */
export function toMoneyValue(amount: MoneyOut): MoneyValue {
  return { minorUnits: amount.minor_units, currency: amount.currency };
}

export interface CurrencyTotalsProps {
  totals: MoneyOut[];
  align?: 'left' | 'right';
  /** Larger, for the one place on a screen that answers "what does this come to". */
  emphasis?: boolean;
  className?: string | undefined;
}

/**
 * What a package comes to, one line per currency.
 *
 * There is deliberately no combined figure and nowhere to put one. Adding
 * JMD 4,000,000 to USD 12,000 produces a number denominated in nothing, and the
 * surest way to stop somebody reading such a number as money is never to
 * compute it. A package holding two currencies therefore shows two totals of
 * equal weight, leaving the reader to understand — correctly — that two
 * instructions of two different sizes are going to the bank.
 *
 * Each figure keeps its ISO code even when there is only one, because the same
 * obligation is two very different magnitudes in JMD and in USD, and a bare
 * "4,000,000" invites the wrong reading of both.
 */
export function CurrencyTotals({
  totals,
  align = 'left',
  emphasis = false,
  className,
}: CurrencyTotalsProps) {
  if (totals.length === 0) {
    return (
      <p
        className={cn(
          'm-0 text-[length:var(--text-body-sm)] text-[var(--color-text-subtle)]',
          align === 'right' && 'text-right',
          className,
        )}
      >
        Nothing yet
      </p>
    );
  }

  return (
    <ul
      className={cn(
        'm-0 flex list-none flex-col gap-[var(--space-1)] p-0',
        align === 'right' && 'items-end',
        className,
      )}
    >
      {totals.map((total) => (
        <li key={total.currency}>
          <MoneyDisplay value={toMoneyValue(total)} size={emphasis ? 'lg' : 'md'} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The same totals as a sentence, for announcements and for places too narrow
 * for a stack.
 *
 * The last is joined with "and" rather than another comma, because
 * "JMD 4,000,000, USD 12,000" read aloud is one list that could plausibly be
 * one sum.
 */
export function totalsSentence(totals: MoneyOut[]): string {
  if (totals.length === 0) return 'nothing';
  if (totals.length === 1) return totals[0]!.formatted;
  const heads = totals.slice(0, -1).map((total) => total.formatted);
  return `${heads.join(', ')} and ${totals[totals.length - 1]!.formatted}`;
}
