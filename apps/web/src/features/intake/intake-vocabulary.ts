/**
 * The words the interface uses for intake states.
 *
 * Kept in one place because the same status appears in a list, a badge, a filter
 * and an empty state, and a status that reads differently in two of them makes
 * users doubt which one is true.
 *
 * Every label says what happened, and every description says what to do next. A
 * status the user cannot act on is a support ticket.
 */

import type { IntakeSource, IntakeStatus, ScanVerdict } from '@finora/shared-types';

import type { StatusTone } from '@/components/workflow/status-badge';

export interface StatusDescriptor {
  label: string;
  tone: StatusTone;
  description: string;
}

export const INTAKE_STATUS: Record<IntakeStatus, StatusDescriptor> = {
  received: {
    label: 'Received',
    tone: 'neutral',
    description: 'The message has arrived and is queued for scanning.',
  },
  scanning: {
    label: 'Scanning',
    tone: 'info',
    description: 'Attachments are being checked for malware. Nothing opens until this finishes.',
  },
  ready: {
    label: 'Ready',
    tone: 'success',
    description: 'Scanned and clean. Ready to be reviewed and turned into a record.',
  },
  quarantined: {
    label: 'Quarantined',
    tone: 'danger',
    description:
      'At least one attachment failed scanning and cannot be opened. An administrator must review it.',
  },
  failed: {
    label: 'Needs attention',
    tone: 'warning',
    description:
      'One or more attachments were refused at intake. The original message was kept so it can be re-sent correctly.',
  },
};

export const SCAN_VERDICT: Record<ScanVerdict, StatusDescriptor> = {
  clean: {
    label: 'Clean',
    tone: 'success',
    description: 'The scanner found nothing.',
  },
  infected: {
    label: 'Infected',
    tone: 'danger',
    description: 'The scanner matched a known signature. The file is quarantined.',
  },
  unscannable: {
    label: 'Could not be scanned',
    tone: 'warning',
    // Stated explicitly, because "could not be scanned" is easy to read as
    // "probably fine" and it is not the same as clean.
    description:
      'The scanner could not inspect the file, for example because it is encrypted. This is not the same as clean, so the file is withheld.',
  },
  error: {
    label: 'Scan failed',
    tone: 'warning',
    description:
      'The scanner could not be reached or did not answer. The file is withheld rather than assumed safe.',
  },
};

export const INTAKE_SOURCE: Record<IntakeSource, string> = {
  imap: 'Mailbox',
  manual_upload: 'Uploaded',
};

/**
 * The states the API reports for intake. Kept as a closed union so a state the
 * interface has no words for is a build error rather than a blank badge.
 */
export type OperationalStateName =
  | 'healthy'
  | 'attention'
  | 'stalled'
  | 'unknown';

/**
 * Operational states for intake.
 *
 * `unknown` deliberately does not read as good news. Intake's failure mode is
 * silence, so "we have never heard from the worker" has to look like a problem
 * rather than like an empty queue.
 */
export const OPERATIONAL_STATE: Record<OperationalStateName, StatusDescriptor> = {
  healthy: {
    label: 'Collecting',
    tone: 'success',
    description: 'The mailbox is being polled and nothing is waiting on a person.',
  },
  attention: {
    label: 'Needs attention',
    tone: 'warning',
    description:
      'Collection is running, but something is waiting on a person and is not moving on its own.',
  },
  stalled: {
    label: 'Not collecting',
    tone: 'danger',
    description:
      'Mail is not being collected. It is accumulating in the mailbox rather than being lost, but nothing new will appear here until this is fixed.',
  },
  unknown: {
    label: 'Never run',
    tone: 'danger',
    description:
      'No poll has ever been recorded, so an empty queue here does not mean an empty mailbox.',
  },
};

/**
 * The descriptor for a reported state.
 *
 * Falls back to `unknown` rather than rendering nothing, because a badge that
 * silently disappears when the API adds a state is how a real problem goes
 * unnoticed.
 */
export function describeOperationalState(state: string): StatusDescriptor {
  return (
    OPERATIONAL_STATE[state as OperationalStateName] ?? OPERATIONAL_STATE.unknown
  );
}

/** Coarse duration for an operational reading, where minutes matter and seconds do not. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'never';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min ago`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h ago`;
}

/** Reasons intake refuses a file, in terms the person who has to fix it can act on. */
export const REJECTION_REASON: Record<string, string> = {
  empty_file: 'The file was empty.',
  too_large: 'The file was larger than the size limit.',
  disallowed_type: 'That file type is not accepted.',
  content_type_mismatch:
    'The file contents did not match the type it claimed to be, so it was not stored.',
  encrypted_document: 'The file is password-protected and could not be read.',
  archive_too_many_entries: 'The archive contained too many files.',
  archive_expansion_ratio: 'The archive expanded to an unreasonable size.',
  malformed: 'The file was damaged or incomplete.',
};

export function describeRejection(
  reason: string | null | undefined,
  detail: string | null | undefined,
): string {
  if (detail) return detail;
  const known = reason ? REJECTION_REASON[reason] : undefined;
  return known ?? 'The file was refused at intake.';
}

/** Human file size. Binary units, matching what the operating system reports. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
