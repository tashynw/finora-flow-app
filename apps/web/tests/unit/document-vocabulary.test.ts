import { describe, expect, it } from 'vitest';

import type {
  ConfidenceBand,
  DocumentSignal,
  ExtractionStatus,
  FieldOrigin,
  FieldReview,
} from '@finora/shared-types';

import {
  ASSIGNABLE_KINDS,
  CONFIDENCE_BAND,
  EXTRACTION_STATUS,
  FIELD_ORIGIN,
  FIELD_REVIEW,
  formatConfidence,
  signalHeadline,
  signalTone,
} from '@/features/documents/document-vocabulary';

const ALL_STATUSES: ExtractionStatus[] = [
  'pending',
  'extracting',
  'extracted',
  'needs_review',
  'accepted',
  'manual_entry_required',
  'failed',
];

const ALL_BANDS: ConfidenceBand[] = ['high', 'medium', 'low', 'none'];
const ALL_ORIGINS: FieldOrigin[] = ['rule', 'model', 'human', 'absent'];
const ALL_REVIEWS: FieldReview[] = ['unreviewed', 'confirmed', 'corrected', 'cleared'];

const ALL_SIGNALS: DocumentSignal[] = [
  'no_text_layer',
  'scanned_and_unreadable',
  'encrypted',
  'truncated_pages',
  'bank_details_present',
  'prompt_injection_suspected',
  'amounts_do_not_add_up',
  'ambiguous_date',
  'multiple_currencies',
  'kind_undetermined',
  'model_unavailable',
  'model_output_rejected',
  'model_assisted',
  'required_field_missing',
  'negative_total',
  'due_before_document_date',
];

describe('extraction status vocabulary', () => {
  it('covers every status the API can return', () => {
    for (const status of ALL_STATUSES) {
      expect(EXTRACTION_STATUS[status]).toBeDefined();
    }
  });

  it('says what to do next, not only what happened', () => {
    for (const status of ALL_STATUSES) {
      expect(EXTRACTION_STATUS[status].description.length).toBeGreaterThan(20);
    }
  });

  it('reserves the success tone for the one state a person has signed off', () => {
    // Nothing a machine reached is a success. `extracted` means the reading is
    // ready for a person, which is not the same as being trusted, and showing it
    // in green would invite exactly that reading.
    expect(EXTRACTION_STATUS.accepted.tone).toBe('success');
    for (const status of ALL_STATUSES.filter((item) => item !== 'accepted')) {
      expect(EXTRACTION_STATUS[status].tone).not.toBe('success');
    }
  });

  it('says the file survives a failed reading', () => {
    // Otherwise the first assumption is that the document itself was lost.
    expect(EXTRACTION_STATUS.failed.description).toMatch(/unharmed|stored|still/i);
  });
});

describe('confidence bands', () => {
  it('covers every band', () => {
    for (const band of ALL_BANDS) {
      expect(CONFIDENCE_BAND[band]).toBeDefined();
    }
  });

  it('never describes a confidence as accuracy', () => {
    // A high confidence means the value was found where this kind of document
    // puts it. Wording it as correctness would stop reviewers disagreeing with
    // it, which is the one thing they are there to do.
    for (const band of ALL_BANDS) {
      const text = `${CONFIDENCE_BAND[band].label} ${CONFIDENCE_BAND[band].description}`;
      expect(text.toLowerCase()).not.toMatch(/\b(accurate|correct|verified|certain)\b/);
    }
  });

  it('asks for a person at every band below the top one', () => {
    expect(CONFIDENCE_BAND.medium.description).toMatch(/compare|check/i);
    expect(CONFIDENCE_BAND.low.description).toMatch(/yourself|read/i);
  });
});

describe('field origin', () => {
  it('covers every origin', () => {
    for (const origin of ALL_ORIGINS) {
      expect(FIELD_ORIGIN[origin]).toBeDefined();
    }
  });

  it('never lets a model proposal read as a finding', () => {
    // The distinction the whole AI posture rests on: a rule found something, a
    // model suggested something.
    expect(FIELD_ORIGIN.model.label).toMatch(/proposed/i);
    expect(FIELD_ORIGIN.model.description).toMatch(/needs a person|confirm/i);
    expect(FIELD_ORIGIN.model.tone).not.toBe('success');
  });

  it('gives only a person the success tone', () => {
    expect(FIELD_ORIGIN.human.tone).toBe('success');
    expect(FIELD_ORIGIN.rule.tone).not.toBe('success');
  });
});

describe('field review states', () => {
  it('covers every review state', () => {
    for (const review of ALL_REVIEWS) {
      expect(FIELD_REVIEW[review]).toBeDefined();
    }
  });

  it('does not present an unchecked value as settled', () => {
    expect(FIELD_REVIEW.unreviewed.tone).toBe('neutral');
    expect(FIELD_REVIEW.unreviewed.label).toMatch(/not checked/i);
  });
});

describe('signal tone', () => {
  it('has an opinion about every warning the API can raise', () => {
    for (const signal of ALL_SIGNALS) {
      expect(signalTone(signal)).toBeTruthy();
      expect(signalHeadline(signal)).not.toBe(signal);
    }
  });

  it('shows the two warnings that block acceptance as dangers', () => {
    // These two are the ones a reviewer must act on outside this screen, and the
    // only ones acknowledgement exists for.
    expect(signalTone('bank_details_present')).toBe('danger');
    expect(signalTone('prompt_injection_suspected')).toBe('danger');
  });

  it('does not raise an alarm about a warning nobody can act on', () => {
    // An alarm a reviewer cannot answer teaches them to ignore alarms.
    expect(signalTone('model_unavailable')).toBe('info');
    expect(signalTone('model_assisted')).toBe('info');
  });

  it('over-reports rather than plays down a warning it does not recognise', () => {
    expect(signalTone('a_signal_added_later')).toBe('warning');
    expect(signalHeadline('a_signal_added_later')).toBe('a signal added later');
  });
});

describe('assignable kinds', () => {
  it('does not offer unknown as something a person can choose', () => {
    // `unknown` is a state the reader arrives at, never an answer to the question
    // "what is this document".
    expect(ASSIGNABLE_KINDS).not.toContain('unknown');
    expect(ASSIGNABLE_KINDS).toContain('invoice');
    expect(ASSIGNABLE_KINDS).toContain('estimate');
  });
});

describe('formatConfidence', () => {
  it('shows whole percentages only', () => {
    // Decimal places would invite an argument about a difference the number
    // cannot support.
    expect(formatConfidence(0.847)).toBe('85%');
    expect(formatConfidence(1)).toBe('100%');
    expect(formatConfidence(0)).toBe('0%');
  });
});
