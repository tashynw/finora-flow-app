import { useEffect, useId, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { auditReason } from '@/lib/form-schemas';
import { HookField } from '@/components/form/hook-field';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';

const reasonSchema = z.object({ reason: auditReason });
const openSchema = z.object({ reason: z.string() });

/**
 * Confirmation for deactivating or reactivating a record.
 *
 * The written reason is required wherever the change is audited. A caller that
 * does not store a reason leaves the field out.
 */
export function ActiveChangeModal({
  open,
  title,
  description,
  nextActive,
  confirmLabel,
  reasonPlaceholder,
  collectReason = true,
  pending,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description?: string | undefined;
  nextActive: boolean;
  confirmLabel: string;
  reasonPlaceholder?: string | undefined;
  collectReason?: boolean | undefined;
  pending: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const formId = useId();
  const schema = useMemo(() => (collectReason ? reasonSchema : openSchema), [collectReason]);
  const { control, handleSubmit, reset } = useForm<{ reason: string }>({
    resolver: zodResolver(schema),
    defaultValues: { reason: '' },
  });

  useEffect(() => {
    if (!open) return;
    reset({ reason: '' });
  }, [open, title, reset]);

  function close() {
    reset({ reason: '' });
    onClose();
  }

  const onSubmit = handleSubmit((values) => {
    onConfirm(values.reason.trim());
  });

  return (
    <Modal
      open={open}
      onClose={close}
      busy={pending}
      title={title}
      description={description}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant={nextActive ? 'primary' : 'danger'}
            isLoading={pending}
            loadingLabel={nextActive ? 'Reactivating' : 'Deactivating'}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {collectReason ? (
        <form id={formId} className="flex flex-col gap-[var(--space-4)]" onSubmit={onSubmit} noValidate>
          <HookField control={control} name="reason" label="Why" required>
            {({ inputId, describedBy, invalid }, field) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                invalid={invalid}
                rows={3}
                placeholder={reasonPlaceholder}
                {...field}
              />
            )}
          </HookField>
        </form>
      ) : (
        <form id={formId} onSubmit={onSubmit} />
      )}
    </Modal>
  );
}
