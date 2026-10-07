import type { Currency } from '../generated/prisma/index.js';

export function formatMinorUnits(
  minorUnits: bigint | number,
  currency: Currency | string,
  withCurrency = true,
): string {
  const minor = typeof minorUnits === 'bigint' ? Number(minorUnits) : minorUnits;
  const major = (minor / 100).toFixed(2);
  return withCurrency ? `${currency} ${major}` : major;
}
