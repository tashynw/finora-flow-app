import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';

/**
 * Changing the figure on a live order.
 *
 * Separate from the ordinary reason dialog because this one changes an amount as
 * well as recording why, and because the consequence differs by direction in a
 * way the person doing it has to be told before they do it: raising the figure
 * takes the order back through approval, since the signature it already has was
 * given for a smaller number and does not carry.
 *
 * What has already been billed is shown rather than merely enforced. The server
 * refuses a figure below it, but a refusal after the fact is a worse experience
 * than the number being on screen while the amount is being typed.
 */
export interface AmendDialogProps {
  open: boolean;
  currency: string;
  currentFormatted: string;
  billedFormatted: string | null;
  isPending: boolean;
  error: string | undefined;
  onClose: () => void;
  onConfirm: (change: { amount: string; reason: string }) => void;
}

export function AmendDialog({
  open,
  currency,
  currentFormatted,
  billedFormatted,
  isPending,
  error,
  onClose,
  onConfirm,
}: AmendDialogProps) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  // Cleared when the dialog opens rather than when it closes, so a refusal from
  // the server leaves what was typed on screen to correct.
  useEffect(() => {
    if (open) {
      setAmount('');
      setReason('');
    }
  }, [open]);

  const ready = amount.trim().length > 0 && reason.trim().length > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Change the figure on this order"
      description="Raising it takes the order back through approval, because the approval it has was given for the current amount. Lowering it does not."
      busy={isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            Back
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            isLoading={isPending}
            loadingLabel="Recording"
            onClick={() => onConfirm({ amount: amount.trim(), reason: reason.trim() })}
          >
            Change it
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-[var(--space-5)]">
        <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
          Currently {currentFormatted}
          {billedFormatted ? `, of which ${billedFormatted} has been billed.` : '.'}
        </p>

        <Field
          label={`New order total (${currency})`}
          required
          help="The new most this order commits to. It cannot be less than what suppliers have already billed against it. Figures only, in the form"
          formatHint="1234.56"
          error={error}
        >
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              numeric
              inputMode="decimal"
              value={amount}
              disabled={isPending}
              onChange={(event) => setAmount(event.target.value)}
            />
          )}
        </Field>

        <Field
          label="Why it is changing"
          required
          help="Approvers see this when the order comes back to them. “The supplier revised the quote” is more use than “correction”."
        >
          {({ inputId, describedBy, invalid }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              rows={3}
              value={reason}
              maxLength={500}
              disabled={isPending}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}
