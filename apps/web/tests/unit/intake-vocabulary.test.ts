import { describe, expect, it } from 'vitest';

import type { IntakeStatus, ScanVerdict } from '@finora/shared-types';

import type { OperationalStateName } from '@/features/intake/intake-vocabulary';
import {
  INTAKE_SOURCE,
  INTAKE_STATUS,
  OPERATIONAL_STATE,
  SCAN_VERDICT,
  describeOperationalState,
  describeRejection,
  formatBytes,
  formatDuration,
} from '@/features/intake/intake-vocabulary';

const ALL_STATUSES: IntakeStatus[] = [
  'received',
  'scanning',
  'ready',
  'quarantined',
  'failed',
];

const ALL_VERDICTS: ScanVerdict[] = ['clean', 'infected', 'unscannable', 'error'];

describe('intake status vocabulary', () => {
  it('covers every status the API can return', () => {
    for (const status of ALL_STATUSES) {
      expect(INTAKE_STATUS[status]).toBeDefined();
    }
  });

  it('tells the reader what to do, not only what happened', () => {
    for (const status of ALL_STATUSES) {
      const descriptor = INTAKE_STATUS[status];
      expect(descriptor.label.length).toBeGreaterThan(0);
      // A status with no explanation is a support ticket waiting to happen.
      expect(descriptor.description.length).toBeGreaterThan(20);
    }
  });

  it('gives quarantine and refusal visually distinct tones', () => {
    // The two need different next actions: quarantine needs an administrator,
    // a refusal needs the sender to resend. Same tone would blur that.
    expect(INTAKE_STATUS.quarantined.tone).not.toBe(INTAKE_STATUS.failed.tone);
  });

  it('does not present ready and quarantined with the same tone', () => {
    expect(INTAKE_STATUS.ready.tone).not.toBe(INTAKE_STATUS.quarantined.tone);
  });
});

describe('scan verdict vocabulary', () => {
  it('covers every verdict', () => {
    for (const verdict of ALL_VERDICTS) {
      expect(SCAN_VERDICT[verdict]).toBeDefined();
    }
  });

  it('never tells the reader a non-clean file is fine', () => {
    // The rule this guards: an absent answer is not a clean answer. If the copy
    // for `unscannable` or `error` asserts the file is fine, a reviewer will
    // treat it that way regardless of what the code does.
    for (const verdict of ['unscannable', 'error'] as ScanVerdict[]) {
      const text = SCAN_VERDICT[verdict].description.toLowerCase();
      expect(text).not.toMatch(/\bis (clean|safe|fine)\b|\bno threat\b/);
      // And it must say what the platform did about it.
      expect(text).toMatch(/withheld|quarantined|not the same as clean/);
    }
    expect(SCAN_VERDICT.unscannable.description).toMatch(/not the same as clean/i);
  });

  it('marks only clean as a success tone', () => {
    expect(SCAN_VERDICT.clean.tone).toBe('success');
    for (const verdict of ['infected', 'unscannable', 'error'] as ScanVerdict[]) {
      expect(SCAN_VERDICT[verdict].tone).not.toBe('success');
    }
  });
});

describe('source labels', () => {
  it('distinguishes mailbox delivery from an upload', () => {
    expect(INTAKE_SOURCE.imap).not.toBe(INTAKE_SOURCE.manual_upload);
  });
});

describe('describeRejection', () => {
  it('prefers the detail the API wrote', () => {
    expect(
      describeRejection('too_large', 'The file is 40,000,000 bytes, above the limit.'),
    ).toBe('The file is 40,000,000 bytes, above the limit.');
  });

  it('falls back to a known reason', () => {
    expect(describeRejection('content_type_mismatch', null)).toMatch(
      /did not match/i,
    );
  });

  it('never returns an empty string for an unknown reason', () => {
    expect(describeRejection('something_new', null)).toBe(
      'The file was refused at intake.',
    );
    expect(describeRejection(null, null)).toBe('The file was refused at intake.');
    expect(describeRejection(undefined, undefined)).toBe(
      'The file was refused at intake.',
    );
  });
});

describe('operational state vocabulary', () => {
  const NOT_HEALTHY: OperationalStateName[] = ['attention', 'stalled', 'unknown'];

  it('does not let "never run" read as good news', () => {
    // Intake fails silently: a worker that never started produces the same empty
    // queue as a quiet week. If `unknown` looks calm, nobody investigates.
    expect(OPERATIONAL_STATE.unknown.tone).not.toBe('success');
    expect(OPERATIONAL_STATE.unknown.tone).not.toBe('neutral');
    expect(OPERATIONAL_STATE.unknown.description).toMatch(
      /does not mean an empty mailbox/i,
    );
  });

  it('reserves the success tone for the one state where nothing is wrong', () => {
    expect(OPERATIONAL_STATE.healthy.tone).toBe('success');
    for (const state of NOT_HEALTHY) {
      expect(OPERATIONAL_STATE[state].tone).not.toBe('success');
    }
  });

  it('says mail is accumulating rather than lost when collection stops', () => {
    // Whether mail is queued or gone decides how hard someone panics, so the
    // stalled copy has to answer it outright.
    expect(OPERATIONAL_STATE.stalled.description).toMatch(
      /accumulating in the mailbox rather than being lost/i,
    );
  });

  it('falls back to a visible state rather than nothing for an unrecognised one', () => {
    // A badge that vanishes when the API adds a state is how a real problem goes
    // unnoticed.
    expect(describeOperationalState('a_state_added_later')).toBe(
      OPERATIONAL_STATE.unknown,
    );
    expect(describeOperationalState('healthy')).toBe(OPERATIONAL_STATE.healthy);
  });
});

describe('formatDuration', () => {
  it('says "never" rather than showing a zero for a missing reading', () => {
    // A zero would read as "just polled", which is the opposite of the truth.
    expect(formatDuration(null)).toBe('never');
    expect(formatDuration(undefined)).toBe('never');
  });

  it('scales from seconds to days', () => {
    expect(formatDuration(30)).toBe('30s ago');
    expect(formatDuration(90)).toBe('1 min ago');
    expect(formatDuration(3 * 3600 + 25 * 60)).toBe('3 h 25 min ago');
    expect(formatDuration(50 * 3600)).toBe('2 d 2 h ago');
  });
});

describe('formatBytes', () => {
  it('reports small files in bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('uses binary units, matching what the operating system reports', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
  });

  it('drops the decimal once the number is large enough not to need it', () => {
    expect(formatBytes(1024 * 15)).toBe('15 KB');
  });
});
