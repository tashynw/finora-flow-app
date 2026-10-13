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

const FIELD_NAMES = new Set<string>(FIELD_DEFS.map((field) => field.name));

export type StoredField = {
  name: FieldName;
  text: string;
  origin: 'absent' | 'human';
  confidence: number;
  review: 'unreviewed' | 'confirmed' | 'corrected' | 'cleared';
  readerText: string | null;
  readerConfidence: number | null;
  correctedAt: string | null;
  correctionReason: string | null;
  notes: string[];
};

export type StoredReading = {
  fields: StoredField[];
  textNotes: string[];
};

export function blankReading(): StoredReading {
  return {
    textNotes: [],
    fields: FIELD_DEFS.map((field) => ({
      name: field.name,
      text: '',
      origin: 'absent',
      confidence: 0,
      review: 'unreviewed',
      readerText: null,
      readerConfidence: null,
      correctedAt: null,
      correctionReason: null,
      notes: [],
    })),
  };
}

export function parseReading(notes: unknown): StoredReading {
  if (!notes || typeof notes !== 'object' || Array.isArray(notes)) {
    const reading = blankReading();
    if (Array.isArray(notes)) {
      reading.textNotes = notes.filter((note): note is string => typeof note === 'string');
    }
    return reading;
  }
  const raw = notes as { fields?: unknown; textNotes?: unknown };
  const reading = blankReading();
  if (Array.isArray(raw.textNotes)) {
    reading.textNotes = raw.textNotes.filter((note): note is string => typeof note === 'string');
  }
  if (!Array.isArray(raw.fields)) return reading;
  for (const item of raw.fields) {
    if (!item || typeof item !== 'object') continue;
    const field = item as Partial<StoredField>;
    if (!field.name || !FIELD_NAMES.has(field.name)) continue;
    const target = reading.fields.find((row) => row.name === field.name);
    if (!target) continue;
    target.text = typeof field.text === 'string' ? field.text : '';
    target.origin = field.origin === 'human' ? 'human' : 'absent';
    target.confidence = typeof field.confidence === 'number' ? field.confidence : 0;
    target.review =
      field.review === 'confirmed' ||
      field.review === 'corrected' ||
      field.review === 'cleared'
        ? field.review
        : 'unreviewed';
    target.readerText = typeof field.readerText === 'string' ? field.readerText : null;
    target.readerConfidence =
      typeof field.readerConfidence === 'number' ? field.readerConfidence : null;
    target.correctedAt = typeof field.correctedAt === 'string' ? field.correctedAt : null;
    target.correctionReason =
      typeof field.correctionReason === 'string' ? field.correctionReason : null;
    target.notes = Array.isArray(field.notes)
      ? field.notes.filter((note): note is string => typeof note === 'string')
      : [];
  }
  return reading;
}

export function isFieldName(value: string): value is FieldName {
  return FIELD_NAMES.has(value);
}

export function fieldNeedsAttention(field: StoredField): boolean {
  const def = FIELD_DEFS.find((row) => row.name === field.name);
  if (!def?.required) return false;
  if (field.review === 'confirmed' || field.review === 'corrected' || field.review === 'cleared') {
    return false;
  }
  return field.text.trim() === '';
}

export function toFieldOut(field: StoredField) {
  const def = FIELD_DEFS.find((row) => row.name === field.name);
  const needsAttention = fieldNeedsAttention(field);
  return {
    name: field.name,
    label: def?.label ?? field.name,
    text: field.text,
    origin: field.origin,
    confidence: field.confidence,
    reader_confidence: field.readerConfidence,
    reader_text: field.readerText,
    review: field.review,
    needs_attention: needsAttention,
    band: needsAttention ? 'low' : field.text ? 'high' : 'none',
    amount_minor_units: null,
    currency: null,
    value_date: null,
    corrected_at: field.correctedAt,
    correction_reason: field.correctionReason,
    evidence: null,
    adjustments: [],
    notes: field.notes,
  };
}
