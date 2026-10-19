import { describe, expect, it } from 'vitest';
import { documentObjectKey, originalExtension } from './document-keys.js';

const id = '11111111-1111-4111-8111-111111111111';

describe('document object keys', () => {
  it('keeps the original extension under the classified folder', () => {
    expect(documentObjectKey('Invoice', id, 'scan.PDF')).toBe(`Invoice/${id}.pdf`);
    expect(documentObjectKey('StatementOfAccount', id, 'march.statement.pdf')).toBe(
      `StatementOfAccount/${id}.pdf`,
    );
    expect(originalExtension('no-extension')).toBe('bin');
  });

  it('refuses a folder that is not one of the document kinds', () => {
    expect(() => documentObjectKey('invoices', id, 'a.pdf')).toThrow(
      'That document folder is not allowed.',
    );
  });
});
