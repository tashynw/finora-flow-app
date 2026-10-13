import { useEffect, useId } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import type { MoneyOut } from '@finora/shared-types';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { HookField } from '@/components/form/hook-field';
import { Modal } from '@/components/ui/modal';
import { requiredText } from '@/lib/form-schemas';
import { CurrencyTotals } from '@/features/payments/currency-totals';
import { contentsSummary } from '@/features/payments/payment-vocabulary';

/**
 * The last screen before the money goes.
 *
 * It restates the total rather than asking "are you sure". A confirmation that
 * only asks for confirmation is answered without being read; one that puts the
 * figure and the number of suppliers back in front of somebody is the last point
 * at which a package assembled this morning can be recognised as the wrong one.
 *
 * The reference is required and comes from outside this system — it is what the
 * bank or the file transfer gave back. Submitting records that the instruction
 * was sent; it does not itself send anything, and the wording is careful about
 * that, because nothing in this application can move money.
 */
export interface SubmitDialogProps {
  open: boolean;
  reference: string;
  totals: MoneyOut[];
  invoiceCount: number;
  vendorCount: number;
  digest: string | undefined;
  isPending: boolean;
  error: string | undefined;
  onClose: () => void;
  onConfirm: (submissionReference: string) => void;
}

const submitSchema = z.object({
  submissionReference: requiredText("The bank's reference is required.").max(
    120,
    'Keep the reference under 120 characters.',
  ),
});

type SubmitForm = z.infer<typeof submitSchema>;

export function SubmitDialog({
  open,
  reference,
  totals,
  invoiceCount,
  vendorCount,
  digest,
  isPending,
  error,
  onClose,
  onConfirm,
}: SubmitDialogProps) {
  const formId = `submit-${useId().replace(/:/g, '')}`;
  const { control, handleSubmit, reset, setError } = useForm<SubmitForm>({
    resolver: zodResolver(submitSchema),
    defaultValues: { submissionReference: '' },
  });

  useEffect(() => {
    if (!open) return;
    reset({ submissionReference: '' });
  }, [open, reset]);

  useEffect(() => {
    if (!error) return;
    setError('submissionReference', { message: error });
  }, [error, setError]);

  const onSubmit = handleSubmit((values) => {
    onConfirm(values.submissionReference);
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Send ${reference} to the bank`}
      description="Recording this closes the package. What it contains can no longer change."
      busy={isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            Back
          </Button>
          <Button type="submit" form={formId} variant="primary" isLoading={isPending} loadingLabel="Recording">
            Record it as sent
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} noValidate>
      <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-[var(--space-4)]">
        <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
          {contentsSummary(invoiceCount, vendorCount)}, coming to
        </p>
        <CurrencyTotals totals={totals} emphasis className="mt-[var(--space-2)]" />
        {totals.length > 1 ? (
          <p className="mt-[var(--space-2)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
            Two currencies, so two figures. They are separate amounts and there is no total that
            combines them.
          </p>
        ) : null}
      </div>

      <p className="mt-[var(--space-4)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-text)]">
        Send the manifest to the bank first, then record here what came back. Every invoice in the
        package moves to Submitted, and each supplier is then asked to confirm the payment
        arrived.
      </p>

      <div className="mt-[var(--space-4)]">
        <HookField
          control={control}
          name="submissionReference"
          label="The bank's reference"
          required
          help="Whatever identifies this instruction at the bank: a batch number, a file name, a transfer reference. It is how a payment is traced back to this package months later."
        >
          {({ inputId, describedBy, invalid }, field) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              maxLength={120}
              disabled={isPending}
              autoComplete="off"
              {...field}
            />
          )}
        </HookField>
      </div>

      {digest ? (
        <p className="mt-[var(--space-4)] m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
          The manifest going with this hashes to{' '}
          <span className="font-mono break-all">{digest}</span>. That fingerprint is stored with
          the package, so the file can be proved later to be the one that was sent.
        </p>
      ) : null}
      </form>
    </Modal>
  );
}
