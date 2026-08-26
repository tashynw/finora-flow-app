import { useEffect, useState } from 'react';

import type { CheckInDetailOut, ClaimOutcome } from '@finora/shared-types';

import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { errorMessage } from '@/lib/api-client';
import { ChoiceList, type Choice } from '@/features/vendor-confirmations/choice-list';
import { CLAIM } from '@/features/vendor-confirmations/confirmation-vocabulary';
import { useRecordAnswer } from '@/features/vendor-confirmations/use-vendor-check-ins';

// The internal wording rather than the supplier's, because a colleague typing
// this is classifying what they were told, not answering the question.
const CLAIMS: readonly Choice<ClaimOutcome>[] = (
  ['received', 'partly_received', 'not_received'] as const
).map((value) => ({ value, label: CLAIM[value].label, help: CLAIM[value].description }));

/**
 * Writing down what a supplier said on the telephone.
 *
 * The same kind of record as the one their own page produces, filed with the
 * channel saying a colleague typed it — which is part of how much it is worth.
 * It concludes nothing and moves nothing. The person who takes the call is very
 * often not the person allowed to mark a payment paid, and this dialog exists
 * precisely so taking the call does not become deciding.
 */
export function RecordAnswerDialog({
  checkIn,
  open,
  onClose,
}: {
  checkIn: CheckInDetailOut;
  open: boolean;
  onClose: () => void;
}) {
  const record = useRecordAnswer(checkIn.id);
  const [claim, setClaim] = useState<ClaimOutcome | null>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [attempted, setAttempted] = useState(false);

  const { reset } = record;
  useEffect(() => {
    if (!open) return;
    setClaim(null);
    setName('');
    setNote('');
    setAttempted(false);
    reset();
  }, [open, reset]);

  const nameMissing = attempted && name.trim().length === 0;
  const claimMissing = attempted && claim === null;

  const submit = () => {
    setAttempted(true);
    if (claim === null || name.trim().length === 0) return;
    record.mutate(
      { claim, respondentName: name.trim(), note: note.trim() },
      { onSuccess: onClose },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={record.isPending}
      title="Write down what they said"
      description="For an answer that came by telephone, or in an email nobody could read automatically. This records their claim and settles nothing."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={record.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            isLoading={record.isPending}
            loadingLabel="Recording"
          >
            Record what they said
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-[var(--space-5)]">
        <ChoiceList
          legend={`What did ${checkIn.vendor_name} tell you?`}
          name="claim"
          choices={CLAIMS}
          value={claim}
          onChange={setClaim}
          error={claimMissing ? 'Choose what they said.' : undefined}
        />

        <Field
          label="Who at the supplier told you"
          required
          help="Their name, so this can be followed up with the person who said it."
          error={nameMissing ? 'Say who told you.' : undefined}
        >
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>

        <Field
          label="What else they said"
          help="Dates, amounts, or anything that would matter to whoever reviews this."
        >
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          )}
        </Field>

        {record.isError ? (
          <p
            role="alert"
            className="m-0 rounded-[var(--radius-md)] border border-[var(--color-danger-600)] p-[var(--space-4)] text-[var(--text-body-sm)] text-[var(--color-danger-700)]"
          >
            {errorMessage(record.error) ?? 'That was not recorded.'}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
