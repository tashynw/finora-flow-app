import { describe, expect, it } from 'vitest';

import {
  exponentFor,
  formatMoney,
  formatMoneyCompact,
  groupByCurrency,
  isKnownCurrency,
  toMajorUnits,
} from '@/lib/money';

describe('currency exponents', () => {
  it('uses the real exponent for currencies that are not two-decimal', () => {
    expect(exponentFor('JPY')).toBe(0);
    expect(exponentFor('KWD')).toBe(3);
    expect(exponentFor('JMD')).toBe(2);
  });

  it('is case insensitive, because API and user input disagree on casing', () => {
    expect(exponentFor('jmd')).toBe(2);
    expect(isKnownCurrency('usd')).toBe(true);
  });

  it('reports an unknown currency instead of silently assuming two decimals', () => {
    expect(isKnownCurrency('XYZ')).toBe(false);
  });
});

describe('toMajorUnits', () => {
  it('scales by the currency exponent rather than a fixed 100', () => {
    expect(toMajorUnits({ minorUnits: 123456, currency: 'JMD' })).toBe(1234.56);
    expect(toMajorUnits({ minorUnits: 123456, currency: 'JPY' })).toBe(123456);
    expect(toMajorUnits({ minorUnits: 123456, currency: 'KWD' })).toBe(123.456);
  });
});

describe('formatMoney', () => {
  it('always shows the currency code so a figure is never ambiguous', () => {
    expect(formatMoney({ minorUnits: 5000000, currency: 'JMD' })).toBe(
      'JMD 50,000.00',
    );
  });

  it('renders exactly the currency exponent, padding trailing zeros', () => {
    expect(formatMoney({ minorUnits: 100, currency: 'JMD' })).toBe('JMD 1.00');
    expect(formatMoney({ minorUnits: 100, currency: 'JPY' })).toBe('JPY 100');
  });

  it('keeps negative amounts visibly negative', () => {
    expect(formatMoney({ minorUnits: -2550, currency: 'USD' })).toBe(
      'USD -25.50',
    );
  });

  it('can force a sign for accrual adjustments', () => {
    expect(
      formatMoney({ minorUnits: 2550, currency: 'USD' }, { signDisplay: 'always' }),
    ).toBe('USD +25.50');
  });

  it('can omit the code where a column header already states it', () => {
    expect(
      formatMoney({ minorUnits: 5000000, currency: 'JMD' }, { withCurrency: false }),
    ).toBe('50,000.00');
  });

  it('normalizes the code to upper case', () => {
    expect(formatMoney({ minorUnits: 100, currency: 'jmd' })).toBe('JMD 1.00');
  });

  it('does not round away sub-unit precision, because minor units are exact', () => {
    expect(formatMoney({ minorUnits: 1, currency: 'JMD' })).toBe('JMD 0.01');
  });
});

describe('formatMoneyCompact', () => {
  it('abbreviates for dense tiles while retaining the currency', () => {
    expect(formatMoneyCompact({ minorUnits: 125_000_000, currency: 'JMD' })).toBe(
      'JMD 1.3M',
    );
  });
});

describe('groupByCurrency', () => {
  it('never collapses mixed currencies into a single number', () => {
    const grouped = groupByCurrency([
      { minorUnits: 1000, currency: 'JMD' },
      { minorUnits: 500, currency: 'USD' },
      { minorUnits: 250, currency: 'JMD' },
    ]);

    expect(grouped).toEqual([
      { currency: 'JMD', minorUnits: 1250 },
      { currency: 'USD', minorUnits: 500 },
    ]);
  });

  it('treats differently cased codes as one currency', () => {
    expect(
      groupByCurrency([
        { minorUnits: 1000, currency: 'jmd' },
        { minorUnits: 1000, currency: 'JMD' },
      ]),
    ).toEqual([{ currency: 'JMD', minorUnits: 2000 }]);
  });

  it('returns nothing for no input rather than a zero of an assumed currency', () => {
    expect(groupByCurrency([])).toEqual([]);
  });
});
