import { useEffect, useId } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/field';
import { HookField } from '@/components/form/hook-field';
import { Modal } from '@/components/ui/modal';
import { requiredText } from '@/lib/form-schemas';

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

const amendSchema = z.object({
  amount: requiredText('A new total is required.'),
  reason: requiredText('A reason is required.').max(500, 'Keep the reason under 500 characters.'),
});

type AmendForm = z.infer<typeof amendSchema>;

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
  const formId = `amend-${useId().replace(/:/g, '')}`;
  const { control, handleSubmit, reset, setError } = useForm<AmendForm>({
    resolver: zodResolver(amendSchema),
    defaultValues: { amount: '', reason: '' },
  });

  // Cleared when the dialog opens rather than when it closes, so a refusal from
  // the server leaves what was typed on screen to correct.
  useEffect(() => {
    if (!open) return;
    reset({ amount: '', reason: '' });
  }, [open, reset]);

  useEffect(() => {
    if (!error) return;
    setError('amount', { message: error });
  }, [error, setError]);

  const onSubmit = handleSubmit((values) => {
    onConfirm(values);
  });

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
          <Button type="submit" form={formId} variant="primary" isLoading={isPending} loadingLabel="Recording">
            Change it
          </Button>
        </>
      }
    >
      <form id={formId} className="flex flex-col gap-[var(--space-5)]" onSubmit={onSubmit} noValidate>
        <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
          Currently {currentFormatted}
          {billedFormatted ? `, of which ${billedFormatted} has been billed.` : '.'}
        </p>

        <HookField
          control={control}
          name="amount"
          label={`New order total (${currency})`}
          required
          help="The new most this order commits to. It cannot be less than what suppliers have already billed against it. Figures only, in the form"
          formatHint="1234.56"
        >
          {({ inputId, describedBy, invalid }, field) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              numeric
              inputMode="decimal"
              disabled={isPending}
              {...field}
            />
          )}
        </HookField>

        <HookField
          control={control}
          name="reason"
          label="Why it is changing"
          required
          help="Approvers see this when the order comes back to them. “The supplier revised the quote” is more use than “correction”."
        >
          {({ inputId, describedBy, invalid }, field) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              rows={3}
              maxLength={500}
              disabled={isPending}
              {...field}
            />
          )}
        </HookField>
      </form>
    </Modal>
  );
}
