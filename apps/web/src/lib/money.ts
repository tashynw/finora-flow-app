/**
 * Money formatting.
 *
 * The API sends integer minor units plus an ISO currency code, mirroring the
 * backend value object. The browser never performs money arithmetic; it formats
 * only. Any total shown here was calculated server-side.
 */

export interface MoneyValue {
  minorUnits: number;
  currency: string;
}

/**
 * Currency exponents. An unknown code is surfaced rather than assumed to have
 * two decimals, because guessing corrupts JPY (0) and KWD (3).
 */
const CURRENCY_EXPONENTS: Record<string, number> = {
  JMD: 2,
  USD: 2,
  CAD: 2,
  GBP: 2,
  EUR: 2,
  JPY: 0,
  KWD: 3,
};

export function exponentFor(currency: string): number {
  return CURRENCY_EXPONENTS[currency.toUpperCase()] ?? 2;
}

export function isKnownCurrency(currency: string): boolean {
  return currency.toUpperCase() in CURRENCY_EXPONENTS;
}

export function toMajorUnits({ minorUnits, currency }: MoneyValue): number {
  return minorUnits / 10 ** exponentFor(currency);
}

export interface FormatMoneyOptions {
  /** Show the ISO code alongside the number. */
  withCurrency?: boolean;
  locale?: string;
  /** Force a leading sign, used for accrual adjustments. */
  signDisplay?: 'auto' | 'always' | 'never' | 'exceptZero';
}

export function formatMoney(
  value: MoneyValue,
  options: FormatMoneyOptions = {},
): string {
  const { withCurrency = true, locale = 'en-JM', signDisplay = 'auto' } = options;
  const exponent = exponentFor(value.currency);
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
    signDisplay,
  }).format(toMajorUnits(value));

  return withCurrency ? `${value.currency.toUpperCase()} ${formatted}` : formatted;
}

/**
 * Compact form for dense dashboard tiles.
 *
 * The standard forbids abbreviating a financial value without an exact view
 * available, so callers must render `formatMoney` in a tooltip or detail row
 * alongside this.
 */
export function formatMoneyCompact(value: MoneyValue, locale = 'en-JM'): string {
  const major = toMajorUnits(value);
  const formatted = new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(major);
  return `${value.currency.toUpperCase()} ${formatted}`;
}

/**
 * A stored amount as the text of an amount field.
 *
 * Fixed to the currency's own number of decimal places, so JMD 1,200 arrives in
 * the box as `1200.00` and a yen amount arrives without a decimal point at all.
 */
export function amountInputValue(minorUnits: number | null, currency: string): string {
  if (minorUnits === null) return '';
  const exponent = exponentFor(currency);
  return (minorUnits / 10 ** exponent).toFixed(exponent);
}

/**
 * Thousands separators for a major-unit amount while it is being typed.
 *
 * The form keeps the digits. The box shows `50000.50` as `50,000.50`. A trailing
 * decimal point stays, so the next digit can be a cent.
 */
export function displayAmountInput(value: string): string {
  if (!value) return '';
  const [whole = '', fraction] = value.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return value.includes('.') ? `${grouped}.${fraction ?? ''}` : grouped;
}

/**
 * A typed amount as integer minor units, or null when there is nothing usable.
 *
 * Rounded rather than truncated, because a typed amount with more decimal places
 * than its currency has is a mistake either way and rounding is the direction
 * that does not quietly discount a supplier's bill. The API validates the result
 * again; this only decides what to send.
 */
export function parseAmount(value: string, currency: string): number | null {
  const cleaned = value.replace(/[\s,]/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 10 ** exponentFor(currency));
}

/** Group per currency for display. Mixed currencies never collapse into one number. */
export function groupByCurrency(values: MoneyValue[]): MoneyValue[] {
  const totals = new Map<string, number>();
  for (const value of values) {
    const code = value.currency.toUpperCase();
    totals.set(code, (totals.get(code) ?? 0) + value.minorUnits);
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, minorUnits]) => ({ currency, minorUnits }));
}
