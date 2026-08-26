import { cn } from '@/lib/utils';
import {
  type WorkflowState,
  WORKFLOW_STATE_LABELS,
} from '@/lib/workflow';

/**
 * StatusBadge.
 *
 * Status is never conveyed by colour alone: every badge carries its label text,
 * and the tone map exists to reinforce, not to replace, that text.
 */
export type StatusTone =
  | 'neutral'
  | 'info'
  | 'progress'
  | 'success'
  | 'warning'
  | 'danger';

const STATE_TONES: Record<WorkflowState, StatusTone> = {
  draft: 'neutral',
  pending_sign_off: 'progress',
  pending_approval: 'progress',
  approved: 'info',
  ready_for_submission: 'info',
  submitted: 'info',
  paid: 'success',
  outstanding: 'warning',
  exception: 'danger',
  accrual_needed: 'warning',
  rejected: 'danger',
  cancelled: 'neutral',
};

const TONE_CLASSES: Record<StatusTone, string> = {
  neutral:
    'bg-[var(--color-surface-subtle)] text-[var(--color-text-muted)] border-[var(--color-border-strong)]',
  info: 'bg-[var(--color-info-50)] text-[var(--color-info-600)] border-[var(--color-primary-200)]',
  progress:
    'bg-[var(--color-primary-50)] text-[var(--color-primary-700)] border-[var(--color-primary-200)]',
  success:
    'bg-[var(--color-success-50)] text-[var(--color-success-700)] border-[color-mix(in_srgb,var(--color-success-600)_28%,white)]',
  warning:
    'bg-[var(--color-warning-50)] text-[var(--color-warning-700)] border-[color-mix(in_srgb,var(--color-warning-600)_28%,white)]',
  danger:
    'bg-[var(--color-danger-50)] text-[var(--color-danger-700)] border-[color-mix(in_srgb,var(--color-danger-600)_28%,white)]',
};

export interface ToneBadgeProps {
  label: string;
  tone: StatusTone;
  className?: string | undefined;
  /** Adds a short qualifier, for example "Step 2 of 3". */
  detail?: string | undefined;
}

/**
 * The badge itself, for any labelled state.
 *
 * Separate from `StatusBadge` so intake, scan and workflow states share one
 * visual language instead of each growing their own colours.
 */
export function ToneBadge({ label, tone, detail, className }: ToneBadgeProps) {
  return (
    <span
      className={cn(
        'motion-status inline-flex items-center gap-1.5 rounded-[var(--radius-pill)]',
        'border px-2.5 py-1 text-[var(--text-caption)] font-semibold',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {/* Decorative: the label beside it carries the meaning. */}
      <span
        aria-hidden="true"
        className="size-1.5 rounded-full bg-current opacity-70"
      />
      {label}
      {detail ? (
        <span className="font-normal opacity-80">· {detail}</span>
      ) : null}
    </span>
  );
}

export interface StatusBadgeProps {
  state: WorkflowState;
  className?: string | undefined;
  /** Adds a short qualifier, for example "Step 2 of 3". */
  detail?: string | undefined;
}

export function StatusBadge({ state, detail, className }: StatusBadgeProps) {
  return (
    <ToneBadge
      label={WORKFLOW_STATE_LABELS[state]}
      tone={STATE_TONES[state]}
      detail={detail}
      className={className}
    />
  );
}
