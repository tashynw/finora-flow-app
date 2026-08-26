import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ShieldAlert, Upload } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import type { UploadAccepted } from '@finora/shared-types';

import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { formatBytes } from '@/features/intake/intake-vocabulary';
import { useUploadDocument } from '@/features/intake/use-intake';

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
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<UploadAccepted | null>(null);

  const upload = useUploadDocument();

  const reset = () => {
    setFile(null);
    setNote('');
    setResult(null);
    upload.reset();
  };

  const close = () => {
    reset();
    onClose();
  };

  const submit = async () => {
    if (!file) return;
    try {
      const accepted = await upload.mutateAsync(note ? { file, note } : { file });
      setResult(accepted);
    } catch {
      // The error is rendered from the mutation state below. Swallowing it here
      // keeps an unhandled rejection out of the console without hiding it from
      // the user.
    }
  };

  // The API's own wording is shown rather than a friendlier substitute: it names
  // the reason the file was refused, and a duplicate names the existing record.
  const errorMessage =
    upload.error instanceof ApiError || upload.error instanceof Error
      ? upload.error.message
      : upload.error
        ? 'The upload did not complete. Nothing was stored.'
        : undefined;

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
            <Button variant="ghost" onClick={reset}>
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
            <p className="m-0 text-[var(--text-body)] text-[var(--color-text-strong)]">
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
                    className="text-[var(--text-body-sm)] text-[var(--color-text-muted)]"
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
            onClick={() => void submit()}
            disabled={!file}
            isLoading={upload.isPending}
            loadingLabel="Scanning"
          >
            <Upload aria-hidden="true" className="size-4" />
            Upload
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-[var(--space-4)]">
        <Field
          label="Document"
          required
          help="PDF, image, or Office document."
          error={errorMessage}
        >
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              type="file"
              accept={ACCEPTED}
              aria-describedby={describedBy}
              invalid={invalid}
              disabled={upload.isPending}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                upload.reset();
              }}
              className={cn(
                'h-auto py-[var(--space-2)]',
                'file:mr-[var(--space-3)] file:rounded-[var(--radius-sm)]',
                'file:border-0 file:bg-[var(--color-surface-subtle)]',
                'file:px-[var(--space-3)] file:py-[var(--space-2)]',
                'file:text-[var(--text-body-sm)] file:font-semibold',
                'file:text-[var(--color-text-strong)]',
              )}
            />
          )}
        </Field>

        {file ? (
          <p className="m-0 text-[var(--text-caption)] text-[var(--color-text-muted)]">
            {file.name} · {formatBytes(file.size)}
          </p>
        ) : null}

        <Field
          label="Note"
          help="Context for whoever reviews this, for example where the document came from."
        >
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              rows={3}
              value={note}
              aria-describedby={describedBy}
              disabled={upload.isPending}
              onChange={(event) => setNote(event.target.value)}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}
