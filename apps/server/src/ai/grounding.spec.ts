import { describe, expect, it } from 'vitest';
import { fenceDocument, findInDocument, normalise } from './grounding.js';

describe('grounding', () => {
  it('matches values after normalising dashes and whitespace', () => {
    expect(findInDocument('Total — JMD 12.50', 'Total - JMD 12.50')).toBe(true);
    expect(normalise('  Acme\u00a0Supplies  ')).toBe('acme supplies');
  });

  it('rejects proposals that are not in the document', () => {
    expect(findInDocument('TAX INVOICE\nAcme', 'Bogus Vendor')).toBe(false);
  });

  it('fences the document text for the model', () => {
    const prompt = fenceDocument('TAX INVOICE', 'Copy the vendor name.');
    expect(prompt).toContain('Copy the vendor name.');
    expect(prompt).toContain('TAX INVOICE');
    expect(prompt).toMatch(/<<<DOC_[A-Z0-9]+/);
  });
});
