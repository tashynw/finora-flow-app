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
  neutral: 'bg-[var(--color-neutral-50)] text-[var(--color-neutral-700)]',
  info: 'bg-[var(--color-info-50)] text-[var(--color-primary-700)]',
  progress: 'bg-[var(--color-warning-50)] text-[var(--color-warning-700)]',
  success: 'bg-[var(--color-success-50)] text-[var(--color-success-600)]',
  warning: 'bg-[var(--color-warning-50)] text-[var(--color-warning-700)]',
  danger: 'bg-[var(--color-danger-50)] text-[var(--color-danger-700)]',
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
        'motion-status inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-pill)]',
        'px-3 text-[11px] font-medium',
        TONE_CLASSES[tone],
        className,
      )}
    >
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
