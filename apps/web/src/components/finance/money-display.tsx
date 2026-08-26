import { cn } from '@/lib/utils';
import {
  formatMoney,
  formatMoneyCompact,
  isKnownCurrency,
  type MoneyValue,
} from '@/lib/money';

/**
 * MoneyDisplay.
 *
 * Amounts use tabular figures so digits align down a column. Compact form is
 * offered only with the exact value attached, because the standard forbids
 * abbreviating a financial figure without an exact view available.
 */
export interface MoneyDisplayProps {
  value: MoneyValue;
  size?: 'sm' | 'md' | 'lg';
  /** Abbreviate for dense tiles. The exact value is exposed on hover and to
   * assistive technology regardless. */
  compact?: boolean;
  /** Show the ISO code. Keep on wherever more than one currency can appear. */
  withCurrency?: boolean;
  /** Colour negatives. Off by default: not every negative is a problem. */
  emphasiseNegative?: boolean;
  className?: string;
}

const SIZE_CLASSES = {
  sm: 'text-[var(--text-body-sm)] font-semibold',
  md: 'text-[length:var(--text-money)] font-[weight:var(--text-money--font-weight)]',
  lg: 'text-[length:var(--text-money-lg)] font-[weight:var(--text-money-lg--font-weight)] leading-[var(--text-money-lg--line-height)]',
} as const;

export function MoneyDisplay({
  value,
  size = 'md',
  compact = false,
  withCurrency = true,
  emphasiseNegative = false,
  className,
}: MoneyDisplayProps) {
  const exact = formatMoney(value, { withCurrency: true });
  const shown = compact
    ? formatMoneyCompact(value)
    : formatMoney(value, { withCurrency });

  const isNegative = value.minorUnits < 0;
  const unknownCurrency = !isKnownCurrency(value.currency);

  return (
    <span
      className={cn(
        'tabular whitespace-nowrap text-[var(--color-text-strong)]',
        SIZE_CLASSES[size],
        emphasiseNegative && isNegative && 'text-[var(--color-danger-700)]',
        className,
      )}
      // The exact figure is always reachable, even when the visible text is
      // abbreviated.
      title={compact ? exact : undefined}
    >
      {shown}
      {compact ? <span className="sr-only"> (exactly {exact})</span> : null}
      {unknownCurrency ? (
        <span
          className="ml-1 text-[var(--text-caption)] font-normal text-[var(--color-warning-700)]"
          title={`${value.currency} is not a configured currency. The number of decimal places shown may be wrong.`}
        >
          unverified currency
        </span>
      ) : null}
    </span>
  );
}

/**
 * Per-currency totals.
 *
 * A mixed-currency package has no single meaningful total, so each currency is
 * listed separately rather than summed.
 */
export function MoneyTotals({
  values,
  className,
}: {
  values: MoneyValue[];
  className?: string;
}) {
  if (values.length === 0) {
    return (
      <span className={cn('text-[var(--color-text-muted)]', className)}>
        No amounts
      </span>
    );
  }

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {values.map((value) => (
        <MoneyDisplay key={value.currency} value={value} size="md" />
      ))}
    </div>
  );
}
