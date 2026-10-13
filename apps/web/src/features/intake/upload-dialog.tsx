import { useEffect, useId, useState } from 'react';
import { AlertTriangle, CheckCircle2, ShieldAlert, Upload } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate } from '@/lib/app-link';

import type { UploadAccepted } from '@finora/shared-types';

import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { HookField } from '@/components/form/hook-field';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { formatBytes } from '@/features/intake/intake-vocabulary';
import { useUploadDocument } from '@/features/intake/use-intake';

const DOCUMENT_KINDS = [
  ['unknown', 'Not identified'],
  ['invoice', 'Invoice'],
  ['estimate', 'Estimate or quotation'],
  ['credit_note', 'Credit note'],
  ['receipt', 'Receipt'],
  ['purchase_order', 'Purchase order'],
  ['statement', 'Statement of account'],
  ['remittance_advice', 'Remittance advice'],
] as const;

const uploadSchema = z.object({
  kind: z.enum([
    'unknown',
    'invoice',
    'estimate',
    'credit_note',
    'receipt',
    'purchase_order',
    'statement',
    'remittance_advice',
  ]),
  note: z.string(),
  file: z.custom<File>((value) => value instanceof File, 'Choose a document.'),
});

type UploadForm = z.infer<typeof uploadSchema>;

/** Mirrors the API's allow-list. Kept in sync deliberately rather than fetched:
 * this only makes the file picker helpful, and the API remains the authority
 * that actually decides. */
const ACCEPTED =
  '.pdf,.jpg,.jpeg,.png,.tif,.tiff,.heic,.xlsx,.xls,.docx,.doc,.csv,.txt,.eml';

export interface UploadDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Manual document upload.
 *
 * An upload takes the same path as a forwarded message: it is scanned before it
 * can be opened, and a file the scanner will not clear is accepted and
 * quarantined rather than silently discarded. The result panel says which of
 * those happened, because "uploaded successfully" over a quarantined file would
 * be a lie.
 */
export function UploadDialog({ open, onClose }: UploadDialogProps) {
  const navigate = useNavigate();
  const formId = useId().replace(/:/g, '');
  const [result, setResult] = useState<UploadAccepted | null>(null);
  const upload = useUploadDocument();
  const { control, handleSubmit, reset, watch } = useForm<UploadForm>({
    resolver: zodResolver(uploadSchema),
    defaultValues: { kind: 'unknown', note: '', file: undefined as unknown as File },
  });
  const file = watch('file');

  useEffect(() => {
    if (!open) return;
    reset({ kind: 'unknown', note: '', file: undefined as unknown as File });
    setResult(null);
    upload.reset();
  }, [open, reset, upload.reset]);

  const close = () => {
    reset({ kind: 'unknown', note: '', file: undefined as unknown as File });
    setResult(null);
    upload.reset();
    onClose();
  };

  const onSubmit = handleSubmit(async (values) => {
    try {
      const accepted = await upload.mutateAsync({
        file: values.file,
        kind: values.kind,
        ...(values.note.trim() ? { note: values.note.trim() } : {}),
      });
      setResult(accepted);
    } catch {
      // The error is rendered from the mutation state below.
    }
  });

  // The API's own wording is shown rather than a friendlier substitute: it names
  // the reason the file was refused, and a duplicate names the existing record.
  const errorMessage =
    upload.error instanceof ApiError || upload.error instanceof Error
      ? upload.error.message
      : upload.error
        ? 'The upload did not complete. Nothing was stored.'
        : undefined;
  const chosenFile = file instanceof File ? file : null;

  if (result) {
    const quarantined = result.quarantined_attachments > 0;
    const rejected = result.rejected_attachments > 0;
    const warnings = result.warnings ?? [];

    return (
      <Modal
        open={open}
        onClose={close}
        title={
          quarantined
            ? 'Uploaded, but quarantined'
            : rejected
              ? 'Uploaded, but not accepted'
              : 'Uploaded'
        }
        description="The original has been stored either way, so nothing is lost."
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                reset({ kind: 'unknown', note: '', file: undefined as unknown as File });
                setResult(null);
                upload.reset();
              }}
            >
              Upload another
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                close();
                void navigate(`/intake/${result.message_id}`);
              }}
            >
              Open it
            </Button>
          </>
        }
      >
        <div className="flex items-start gap-[var(--space-3)]">
          {quarantined ? (
            <ShieldAlert
              aria-hidden="true"
              className="mt-0.5 size-5 shrink-0 text-[var(--color-danger-600)]"
            />
          ) : rejected ? (
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 size-5 shrink-0 text-[var(--color-warning-600)]"
            />
          ) : (
            <CheckCircle2
              aria-hidden="true"
              className="mt-0.5 size-5 shrink-0 text-[var(--color-success-600)]"
            />
          )}

          <div className="min-w-0">
            <p className="m-0 text-[length:var(--text-body)] text-[var(--color-text-strong)]">
              {quarantined
                ? 'The malware scanner flagged this file, so it cannot be opened. An administrator can review it from the quarantine workflow.'
                : rejected
                  ? 'The file was refused at intake, so it was not stored as a document. The details below explain why.'
                  : 'The file was scanned, found clean, and is ready to review.'}
            </p>

            {warnings.length > 0 ? (
              <ul className="mt-[var(--space-3)] m-0 flex list-none flex-col gap-1 p-0">
                {warnings.map((warning) => (
                  <li
                    key={warning}
                    className="text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]"
                  >
                    {warning}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Upload a document"
      description="Use this when an invoice or estimate did not arrive by email. It is scanned before anyone can open it."
      busy={upload.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={upload.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            isLoading={upload.isPending}
            loadingLabel="Uploading"
          >
            <Upload aria-hidden="true" className="size-4" />
            Upload
          </Button>
        </>
      }
    >
      <form id={formId} className="flex flex-col gap-[var(--space-4)]" onSubmit={onSubmit} noValidate>
        <HookField control={control} name="kind" label="Document type" required>
          {({ inputId, describedBy, invalid }, field) => (
            <select
              id={inputId}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              className="h-10 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3"
              {...field}
            >
              {DOCUMENT_KINDS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </HookField>
        <HookField
          control={control}
          name="file"
          label="Document"
          required
          help="PDF, image, or Office document. Stored as Folder/id.original-extension."
        >
          {({ inputId, describedBy, invalid }, field) => (
            <Input
              id={inputId}
              type="file"
              accept={ACCEPTED}
              aria-describedby={describedBy}
              invalid={invalid}
              disabled={upload.isPending}
              name={field.name}
              ref={field.ref}
              onBlur={field.onBlur}
              onChange={(event) => {
                field.onChange(event.target.files?.[0]);
                upload.reset();
              }}
              className={cn(
                'h-auto py-[var(--space-2)]',
                'file:mr-[var(--space-3)] file:rounded-[var(--radius-sm)]',
                'file:border-0 file:bg-[var(--color-surface-subtle)]',
                'file:px-[var(--space-3)] file:py-[var(--space-2)]',
                'file:text-[length:var(--text-body-sm)] file:font-semibold',
                'file:text-[var(--color-text-strong)]',
              )}
            />
          )}
        </HookField>

        {chosenFile ? (
          <p className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
            {chosenFile.name} · {formatBytes(chosenFile.size)}
          </p>
        ) : null}

        <HookField
          control={control}
          name="note"
          label="Note"
          help="Context for whoever reviews this, for example where the document came from."
        >
          {({ inputId, describedBy, invalid }, field) => (
            <Textarea
              id={inputId}
              rows={3}
              aria-describedby={describedBy}
              invalid={invalid}
              disabled={upload.isPending}
              {...field}
            />
          )}
        </HookField>
        {errorMessage ? (
          <p role="alert" className="m-0 text-[var(--color-danger-700)]">
            {errorMessage}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
