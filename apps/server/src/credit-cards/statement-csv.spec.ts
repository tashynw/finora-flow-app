import { describe, expect, it } from 'vitest';
import { DomainException } from '../common/errors.js';
import { parseStatementCsv } from './statement-csv.js';

const FILE = [
  'date,merchant,amount,cardholder,reference',
  '2026-03-01,Island Grill,"1,250.50",Ada Lovelace,REF-1',
  '2026-03-02,Office Depot,40,Ada Lovelace,',
].join('\n');

describe('parseStatementCsv', () => {
  it('reads required columns and keeps the file row number', () => {
    const lines = parseStatementCsv(FILE);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      sourceRow: 2,
      postedOn: '2026-03-01',
      merchant: 'Island Grill',
      cardholder: 'Ada Lovelace',
      amountMinorUnits: 125050n,
      externalReference: 'REF-1',
    });
    expect(lines[1]?.amountMinorUnits).toBe(4000n);
  });

  it('refuses the file when a required column is missing', () => {
    expect(() => parseStatementCsv('date,amount\n2026-03-01,10\n')).toThrow(DomainException);
  });

  it('refuses the file when one row has a bad date', () => {
    const text = 'date,merchant,amount,cardholder\n03/01/2026,Cafe,10,Ada\n';
    expect(() => parseStatementCsv(text)).toThrow(/Row 2/);
  });
});
