import { useEffect, useId } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import { HookField } from '@/components/form/hook-field';
import { Modal } from '@/components/ui/modal';
import { requiredText } from '@/lib/form-schemas';

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
const reasonSchema = z.object({
  reason: requiredText('A reason is required.').max(1000, 'Keep the reason under 1000 characters.'),
});

type ReasonForm = z.infer<typeof reasonSchema>;

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
  const formId = `reason-${useId().replace(/:/g, '')}`;
  const { control, handleSubmit, reset, setError, clearErrors } = useForm<ReasonForm>({
    resolver: zodResolver(reasonSchema),
    defaultValues: { reason: '' },
  });

  useEffect(() => {
    if (!open) return;
    reset({ reason: '' });
    clearErrors();
  }, [open, reset, clearErrors]);

  useEffect(() => {
    if (!error) return;
    setError('reason', { message: error });
  }, [error, setError]);

  const onSubmit = handleSubmit((values) => {
    onConfirm(values.reason);
  });

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
            type="submit"
            form={formId}
            variant={danger ? 'danger' : 'primary'}
            isLoading={isPending}
            loadingLabel="Recording"
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} noValidate>
        <HookField control={control} name="reason" label={label} required help={help}>
          {({ inputId, describedBy, invalid }, field) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              rows={4}
              maxLength={1000}
              disabled={isPending}
              {...field}
            />
          )}
        </HookField>
      </form>
    </Modal>
  );
}
