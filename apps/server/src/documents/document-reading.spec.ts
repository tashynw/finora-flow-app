import { describe, expect, it } from 'vitest';
import { attentionBlocker, fieldNeedsAttention } from './document-reading.js';

describe('field review attention', () => {
  it('asks for a required field that has no value', () => {
    expect(fieldNeedsAttention('vendor_name', '', 'unreviewed')).toBe(true);
    expect(attentionBlocker('vendor_name')).toBe('Vendor is needed and has no value.');
  });

  it('stops asking once a person clears the field', () => {
    expect(fieldNeedsAttention('vendor_name', '', 'cleared')).toBe(false);
  });

  it('ignores an optional field that was not on the document', () => {
    expect(fieldNeedsAttention('due_date', '', 'unreviewed')).toBe(false);
  });
});
