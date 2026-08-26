import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';

/**
 * A confirmation that will not proceed without a written reason.
 *
 * Used wherever somebody undoes something other people have already acted on:
 * withdrawing from approval, cancelling a record, declining to confirm receipt.
 * The reason is mandatory in every case, because each of these leaves somebody
 * else — an approver who has already decided, a supplier waiting on payment —
 * with a change they did not make and no explanation of it.
 *
 * The box is cleared when the dialog opens rather than when it closes, so a
 * refusal from the server leaves the typed reason on screen to correct rather
 * than making the person write it again.
 */
export interface ReasonDialogProps {
  open: boolean;
  title: string;
  description: string;
  label: string;
  help: string;
  confirmLabel: string;
  danger?: boolean;
  isPending: boolean;
  error: string | undefined;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}

export function ReasonDialog({
  open,
  title,
  description,
  label,
  help,
  confirmLabel,
  danger = false,
  isPending,
  error,
  onClose,
  onConfirm,
}: ReasonDialogProps) {
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      busy={isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            Back
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={reason.trim().length === 0}
            isLoading={isPending}
            loadingLabel="Recording"
            onClick={() => onConfirm(reason.trim())}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <Field label={label} required help={help} error={error}>
        {({ inputId, describedBy, invalid }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            invalid={invalid}
            rows={4}
            value={reason}
            maxLength={1000}
            disabled={isPending}
            onChange={(event) => setReason(event.target.value)}
          />
        )}
      </Field>
    </Modal>
  );
}
