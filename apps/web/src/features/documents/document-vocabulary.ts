/**
 * The words the interface uses for a document reading.
 *
 * The API already sends the human label for a field name, a document kind and a
 * warning, so none of those are repeated here. What the API cannot send is tone:
 * how alarming a state should look. That is a presentation decision and it lives
 * here, in one place, so the same warning is never amber in a list and red on
 * the page.
 *
 * One rule runs through all of it. Nothing a machine produced is described in
 * language that suggests it was checked. A value read by a rule is "read from
 * the document", a value a model proposed is "proposed", and only a value a
 * person confirmed is "confirmed".
 */

import type {
  ConfidenceBand,
  DocumentSignal,
  ExtractionStatus,
  FieldOrigin,
  FieldReview,
} from '@finora/shared-types';

import type { StatusTone } from '@/components/workflow/status-badge';
import type { StatusDescriptor } from '@/features/intake/intake-vocabulary';

export const EXTRACTION_STATUS: Record<ExtractionStatus, StatusDescriptor> = {
  pending: {
    label: 'Waiting to be read',
    tone: 'neutral',
    description:
      'The document is stored and queued. Reading has not started yet, so no values exist for it.',
  },
  extracting: {
    label: 'Being read',
    tone: 'progress',
    description:
      'The document is being read now. Values will appear when it finishes, and nothing can be edited until then.',
  },
  extracted: {
    label: 'Ready to accept',
    tone: 'info',
    description:
      'Every value has either been read with confidence or checked by a person. It is ready for someone to accept.',
  },
  needs_review: {
    label: 'Needs review',
    tone: 'warning',
    description:
      'Something on this document needs a person: a value was read with low confidence, a value is missing, or a warning has to be acted on.',
  },
  accepted: {
    label: 'Accepted',
    tone: 'success',
    description:
      'A reviewer confirmed this reading. Its values are available to the rest of the platform and can no longer be edited here.',
  },
  manual_entry_required: {
    label: 'Type it in',
    tone: 'warning',
    description:
      'Nothing could be read from this document, so every value has to be entered by hand from what you see on the page.',
  },
  failed: {
    label: 'Could not be read',
    tone: 'danger',
    description:
      'Reading this document failed. The file itself is unharmed and can be opened, and reading can be tried again.',
  },
};

/**
 * How much weight to put on a value the reader produced.
 *
 * Deliberately not phrased as accuracy. A high confidence means the value was
 * found where this kind of document puts it, not that it is correct, and the
 * wording has to leave a reviewer willing to disagree with it.
 */
export const CONFIDENCE_BAND: Record<ConfidenceBand, StatusDescriptor> = {
  high: {
    label: 'Clear',
    tone: 'success',
    description: 'Found beside its own label, in the place this kind of document puts it.',
  },
  medium: {
    label: 'Check this',
    tone: 'warning',
    description:
      'Found, but not unambiguously. Compare it against the highlighted text on the page.',
  },
  low: {
    label: 'Unsure',
    tone: 'danger',
    description:
      'A guess offered only so you have somewhere to start. Read the value off the document yourself.',
  },
  none: {
    label: 'Not found',
    tone: 'neutral',
    description: 'Nothing on the pages that were read looked like this value.',
  },
};

/** Where a value came from. Never softened: a proposal is not a finding. */
export const FIELD_ORIGIN: Record<FieldOrigin, StatusDescriptor> = {
  rule: {
    label: 'Read from the document',
    tone: 'info',
    description: 'Found by a fixed rule that matched a label on the page.',
  },
  model: {
    label: 'Proposed by the assistive reader',
    tone: 'warning',
    description:
      'A model suggested this and the text was then located on the page. It still needs a person to confirm it.',
  },
  human: {
    label: 'Entered by a person',
    tone: 'success',
    description: 'A reviewer typed this value, and it takes precedence over anything read.',
  },
  absent: {
    label: 'Not on the document',
    tone: 'neutral',
    description: 'Nothing was found for this field.',
  },
};

export const FIELD_REVIEW: Record<FieldReview, StatusDescriptor> = {
  unreviewed: {
    label: 'Not checked',
    tone: 'neutral',
    description: 'Nobody has looked at this value yet.',
  },
  confirmed: {
    label: 'Confirmed',
    tone: 'success',
    description: 'A reviewer checked this against the document and agreed with it.',
  },
  corrected: {
    label: 'Corrected',
    tone: 'info',
    description: 'A reviewer replaced what was read with what the document actually says.',
  },
  cleared: {
    label: 'Not present',
    tone: 'neutral',
    description: 'A reviewer confirmed this document does not carry this value.',
  },
};

/**
 * How loudly each warning should be shown.
 *
 * The two that can stop an acceptance, bank details and suspected instructions
 * to a machine, are the two that read as danger. Everything a reviewer can
 * simply take account of reads as a caution, and the two that only describe how
 * the reading was produced read as information, because a reviewer cannot act
 * on them and an alarm they cannot act on teaches them to ignore alarms.
 */
const SIGNAL_TONES: Record<DocumentSignal, StatusTone> = {
  encrypted: 'danger',
  bank_details_present: 'danger',
  prompt_injection_suspected: 'danger',
  amounts_do_not_add_up: 'danger',
  negative_total: 'warning',
  due_before_document_date: 'warning',
  ambiguous_date: 'warning',
  multiple_currencies: 'warning',
  required_field_missing: 'warning',
  kind_undetermined: 'warning',
  no_text_layer: 'warning',
  scanned_and_unreadable: 'warning',
  truncated_pages: 'warning',
  model_output_rejected: 'warning',
  model_unavailable: 'info',
  model_assisted: 'info',
};

/**
 * The tone for a warning the API reported.
 *
 * An unrecognised name is treated as a caution rather than as information, so a
 * warning added to the API before it is added here is over-reported instead of
 * quietly played down.
 */
export function signalTone(signal: string): StatusTone {
  return SIGNAL_TONES[signal as DocumentSignal] ?? 'warning';
}

/** Short names for warnings, for the places a full explanation will not fit. */
const SIGNAL_HEADLINES: Record<DocumentSignal, string> = {
  no_text_layer: 'No readable text',
  scanned_and_unreadable: 'Scan, not readable',
  encrypted: 'Password protected',
  truncated_pages: 'Later pages not read',
  bank_details_present: 'Bank details on the document',
  prompt_injection_suspected: 'Text aimed at an automated reader',
  amounts_do_not_add_up: 'Amounts do not add up',
  ambiguous_date: 'A date could be read two ways',
  multiple_currencies: 'More than one currency',
  kind_undetermined: 'Kind of document unclear',
  model_unavailable: 'Assistive reader unavailable',
  model_output_rejected: 'Assistive reader output refused',
  model_assisted: 'A model proposed values here',
  required_field_missing: 'A required value is missing',
  negative_total: 'The total is negative',
  due_before_document_date: 'Due before it was issued',
};

export function signalHeadline(signal: string): string {
  return (
    SIGNAL_HEADLINES[signal as DocumentSignal] ??
    // Better a name the reader half-recognises than a blank row where a
    // warning should be.
    signal.replace(/_/g, ' ')
  );
}

/**
 * Confidence as a percentage.
 *
 * Rounded to whole numbers. The reader's own precision does not justify decimal
 * places, and showing 84.7% invites a conversation about the difference between
 * that and 85% that the number cannot support.
 */
export function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * The kinds a reviewer may set by hand.
 *
 * `unknown` is missing on purpose. It is a state the reader arrives at, never a
 * decision a person makes, and offering it would let a reviewer answer the
 * question with the question.
 */
export const ASSIGNABLE_KINDS = [
  'invoice',
  'estimate',
  'credit_note',
  'receipt',
  'purchase_order',
  'statement',
  'remittance_advice',
] as const;

/**
 * What a value looks like, for the hint beside a correction box.
 *
 * The API decides what it will accept; this only tells the person typing what
 * shape to type, so a rejected correction is rare rather than a surprise.
 */
export const FIELD_FORMAT_HINT: Record<string, string> = {
  document_date: 'YYYY-MM-DD',
  due_date: 'YYYY-MM-DD',
  currency: 'Three letters, for example JMD',
  subtotal: '1234.56',
  tax_total: '1234.56',
  total: '1234.56',
};
