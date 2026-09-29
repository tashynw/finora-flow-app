import { useEffect, useState } from 'react';

import type { CheckInDetailOut, ReviewOutcome } from '@finora/shared-types';

import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { errorMessage } from '@/lib/api-client';
import { ChoiceList, type Choice } from '@/features/vendor-confirmations/choice-list';
import { REVIEW } from '@/features/vendor-confirmations/confirmation-vocabulary';
import { useReviewCheckIn } from '@/features/vendor-confirmations/use-vendor-check-ins';

const OUTCOMES: readonly Choice<ReviewOutcome>[] = (['paid', 'outstanding'] as const).map(
  (value) => ({ value, label: REVIEW[value].label, help: REVIEW[value].description }),
);

/**
 * Concluding. The only route in the platform to Paid.
 *
 * Two things are deliberately awkward here.
 *
 * *Nothing is preselected.* The API sends a suggestion and the suggestion is
 * shown, in words, above the choices — but never as a filled-in radio button. A
 * form that opens with an answer already in it produces a decision the platform
 * made and a person's name attached to it, and the whole point of this screen is
 * that a person decided.
 *
 * *Disagreeing costs a sentence.* Concluding against what the supplier told us
 * requires a note. Somebody reading this in six months needs to know why the
 * supplier's account was set aside, and "the reviewer must have had a reason" is
 * not a record.
 */
export function ReviewDialog({
  checkIn,
  open,
  onClose,
}: {
  checkIn: CheckInDetailOut;
  open: boolean;
  onClose: () => void;
}) {
  const review = useReviewCheckIn(checkIn.id);
  const [outcome, setOutcome] = useState<ReviewOutcome | null>(null);
  const [note, setNote] = useState('');
  const [attempted, setAttempted] = useState(false);

  // Cleared on open rather than on close, so a dialog reopened after a refusal
  // starts blank instead of showing the choice that was just rejected.
  const { reset } = review;
  useEffect(() => {
    if (!open) return;
    setOutcome(null);
    setNote('');
    setAttempted(false);
    reset();
  }, [open, reset]);

  // A claim of "received" contradicts a conclusion of outstanding, and either
  // "not received" or "partly received" contradicts paid. Silence contradicts
  // nothing: concluding without an answer is a judgement call, not a dispute.
  const contradicts =
    outcome !== null &&
    checkIn.claim !== null &&
    (outcome === 'paid' ? checkIn.claim !== 'received' : checkIn.claim === 'received');

  const noteRequired = contradicts;
  const noteMissing = attempted && noteRequired && note.trim().length === 0;
  const outcomeMissing = attempted && outcome === null;

  const submit = () => {
    setAttempted(true);
    if (outcome === null) return;
    if (noteRequired && note.trim().length === 0) return;
    review.mutate({ outcome, note: note.trim() }, { onSuccess: onClose });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={review.isPending}
      title={`Conclude on ${checkIn.reference}`}
      description={`${checkIn.vendor_name}. This moves every invoice in the check-in, and cannot be undone from here.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={review.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            isLoading={review.isPending}
            loadingLabel="Recording"
          >
            Record this decision
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-[var(--space-5)]">
        {/* Said in a sentence, not set as a default. */}
        <p className="m-0 rounded-[var(--radius-md)] bg-[var(--color-surface-subtle)] p-[var(--space-4)] text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
          <span className="font-semibold text-[var(--color-text-strong)]">
            What the evidence looks like:
          </span>{' '}
          {checkIn.suggestion.because}
          {checkIn.suggestion.outcome_label
            ? ` That points towards ${checkIn.suggestion.outcome_label.toLowerCase()}, but it is not a decision until you make it.`
            : ''}
        </p>

        <ChoiceList
          legend="What did happen?"
          name="outcome"
          choices={OUTCOMES}
          value={outcome}
          onChange={setOutcome}
          error={outcomeMissing ? 'Choose one of the two conclusions.' : undefined}
        />

        <Field
          label="Why"
          required={noteRequired}
          help={
            noteRequired
              ? 'This goes against what the supplier told us, so say what you checked and what you found.'
              : 'What you looked at, for whoever reads this later.'
          }
          error={
            noteMissing
              ? 'A reason is needed when the conclusion differs from what the supplier said.'
              : undefined
          }
        >
          {({ inputId, describedBy, invalid }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          )}
        </Field>

        {review.isError ? (
          <p
            role="alert"
            className="m-0 rounded-[var(--radius-md)] border border-[var(--color-danger-600)] p-[var(--space-4)] text-[length:var(--text-body-sm)] text-[var(--color-danger-700)]"
          >
            {errorMessage(review.error) ?? 'The decision was not recorded.'}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
