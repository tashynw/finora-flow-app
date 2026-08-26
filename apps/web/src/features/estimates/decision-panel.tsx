import { useState } from 'react';
import { Check, X } from 'lucide-react';

import type { ApprovalOutcome, StepOut } from '@finora/shared-types';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/field';

/**
 * Where an approver decides one step.
 *
 * Reject is a full-size, solid, plainly labelled button beside approve, not a
 * faint link underneath it. An approver whose only prominent option is to agree
 * has been told what is expected of them, and the value of the step is that it
 * could go either way.
 *
 * A reason is required to reject and offered to approve. That asymmetry is the
 * real one: a refusal has to be answerable by the person whose request it was,
 * and an approval with a note is a courtesy.
 *
 * Nothing is submitted on a single click. Both buttons open a confirmation of
 * what is about to be recorded, in whose name, because this is the moment the
 * organisation commits and there is no undo afterwards — a decision can only be
 * followed by another decision.
 */

export interface DecisionPanelProps {
  step: StepOut;
  amountFormatted: string;
  onDecide: (decision: { outcome: ApprovalOutcome; comment: string | undefined }) => void;
  isPending: boolean;
  error?: string | undefined;
}

export function DecisionPanel({
  step,
  amountFormatted,
  onDecide,
  isPending,
  error,
}: DecisionPanelProps) {
  const [outcome, setOutcome] = useState<ApprovalOutcome | null>(null);
  const [comment, setComment] = useState('');

  const rejecting = outcome === 'rejected';
  const reasonMissing = rejecting && comment.trim().length === 0;

  return (
    <div
      className={cn(
        'mt-[var(--space-4)] rounded-[var(--radius-md)] border p-[var(--space-4)]',
        'border-[var(--color-primary-200)] bg-[var(--color-primary-50)]',
      )}
    >
      <p className="m-0 font-semibold text-[var(--color-text-strong)]">
        Your decision as {step.level_label}
      </p>
      <p className="mt-[var(--space-1)] m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
        You are deciding {amountFormatted}. Your name and the time are recorded against this step
        and cannot be removed.
      </p>

      {outcome === null ? (
        <div className="mt-[var(--space-4)] flex flex-wrap gap-[var(--space-3)]">
          <Button variant="primary" onClick={() => setOutcome('approved')}>
            <Check aria-hidden="true" className="size-4" />
            Approve
          </Button>
          <Button variant="danger" onClick={() => setOutcome('rejected')}>
            <X aria-hidden="true" className="size-4" />
            Reject
          </Button>
        </div>
      ) : (
        <div className="mt-[var(--space-4)] flex flex-col gap-[var(--space-4)]">
          <Field
            label={rejecting ? 'Why you are rejecting this' : 'Anything to add'}
            required={rejecting}
            error={error}
            help={
              rejecting
                ? 'The requester reads this. Say what would have to change for it to be approved.'
                : 'Optional. Anything a later reader should know about why this was right.'
            }
          >
            {({ inputId, describedBy, invalid }) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                invalid={invalid}
                rows={3}
                value={comment}
                maxLength={2000}
                disabled={isPending}
                onChange={(event) => setComment(event.target.value)}
              />
            )}
          </Field>

          <div className="flex flex-wrap items-center gap-[var(--space-3)]">
            <Button
              variant={rejecting ? 'danger' : 'primary'}
              disabled={reasonMissing}
              isLoading={isPending}
              loadingLabel="Recording"
              onClick={() =>
                onDecide({ outcome, comment: comment.trim() || undefined })
              }
            >
              {rejecting ? 'Record the rejection' : 'Record the approval'}
            </Button>
            <Button
              variant="ghost"
              disabled={isPending}
              onClick={() => {
                setOutcome(null);
                setComment('');
              }}
            >
              Back
            </Button>
            {reasonMissing ? (
              <p className="m-0 text-[var(--text-caption)] text-[var(--color-text-muted)]">
                A rejection needs a reason.
              </p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
