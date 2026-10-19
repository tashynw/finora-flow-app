export const FIELD_DEFS = [
  { name: 'vendor_name', label: 'Vendor', required: true },
  { name: 'vendor_tax_id', label: 'Tax registration', required: false },
  { name: 'document_number', label: 'Document number', required: true },
  { name: 'document_date', label: 'Document date', required: true },
  { name: 'due_date', label: 'Due date', required: false },
  { name: 'purchase_order_number', label: 'Purchase order', required: false },
  { name: 'estimate_reference', label: 'Estimate', required: false },
  { name: 'currency', label: 'Currency', required: true },
  { name: 'subtotal', label: 'Subtotal', required: false },
  { name: 'tax_total', label: 'Tax', required: false },
  { name: 'total', label: 'Total', required: true },
  { name: 'payment_terms', label: 'Payment terms', required: false },
] as const;

export type FieldName = (typeof FIELD_DEFS)[number]['name'];
export type FieldReviewState = 'unreviewed' | 'confirmed' | 'corrected' | 'cleared';

const FIELD_NAMES = new Set<string>(FIELD_DEFS.map((field) => field.name));

export function isFieldName(value: string): value is FieldName {
  return FIELD_NAMES.has(value);
}

export function fieldLabel(name: string): string {
  return FIELD_DEFS.find((field) => field.name === name)?.label ?? name;
}

export function isRequiredField(name: string): boolean {
  return FIELD_DEFS.find((field) => field.name === name)?.required ?? false;
}

/**
 * A required field still needs a person when it has no value and nobody has
 * recorded that the document does not carry it.
 */
export function fieldNeedsAttention(
  name: string,
  text: string,
  review: FieldReviewState,
): boolean {
  if (!isRequiredField(name)) return false;
  if (review === 'cleared') return false;
  return text.trim() === '';
}

export function attentionBlocker(name: string): string {
  return `${fieldLabel(name)} is needed and has no value.`;
}
