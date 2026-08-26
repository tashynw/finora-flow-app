import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { MoneyOut } from '@finora/shared-types';

import { CurrencyTotals, toMoneyValue, totalsSentence } from '@/features/payments/currency-totals';

const JMD: MoneyOut = { currency: 'JMD', minor_units: 400_000_000, formatted: 'JMD 4,000,000.00' };
const USD: MoneyOut = { currency: 'USD', minor_units: 1_200_000, formatted: 'USD 12,000.00' };

describe('CurrencyTotals', () => {
  it('shows one figure per currency', () => {
    render(<CurrencyTotals totals={[JMD, USD]} />);

    expect(screen.getByText('JMD 4,000,000.00')).toBeInTheDocument();
    expect(screen.getByText('USD 12,000.00')).toBeInTheDocument();
  });

  it('never renders a figure that combines currencies', () => {
    // The whole reason totals are a list is that JMD 4,000,000 plus USD 12,000
    // is a number denominated in nothing. This asserts the component adds no
    // such row of its own: two amounts in, two amounts out.
    const { container } = render(<CurrencyTotals totals={[JMD, USD]} />);

    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.textContent).toBe('JMD 4,000,000.00USD 12,000.00');
  });

  it('keeps the currency code on a single-currency total', () => {
    // The same obligation is a very different magnitude in JMD and in USD, so a
    // bare "4,000,000" invites the wrong reading even when there is only one.
    render(<CurrencyTotals totals={[JMD]} />);

    expect(screen.getByText(/JMD/)).toBeInTheDocument();
  });

  it('says an empty package has nothing rather than showing zero', () => {
    // "JMD 0.00" reads as a package that is going out for nothing; "Nothing
    // yet" reads as one that has not been filled in.
    render(<CurrencyTotals totals={[]} />);

    expect(screen.getByText('Nothing yet')).toBeInTheDocument();
    expect(screen.queryByText(/0\.00/)).not.toBeInTheDocument();
  });
});

describe('toMoneyValue', () => {
  it('carries the minor units and the currency across unchanged', () => {
    expect(toMoneyValue(JMD)).toEqual({ minorUnits: 400_000_000, currency: 'JMD' });
  });
});

describe('totalsSentence', () => {
  it('joins the last with "and", not another comma', () => {
    // Read aloud, a comma-separated list of amounts could plausibly be one sum.
    expect(totalsSentence([JMD, USD])).toBe('JMD 4,000,000.00 and USD 12,000.00');
  });

  it('leaves a single figure alone', () => {
    expect(totalsSentence([USD])).toBe('USD 12,000.00');
  });

  it('says nothing rather than an empty string', () => {
    expect(totalsSentence([])).toBe('nothing');
  });
});
