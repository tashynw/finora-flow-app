import { useEffect, useRef, useState } from 'react';
import { Check, Eye, Pencil, Slash, X } from 'lucide-react';

import type { FieldOut } from '@finora/shared-types';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { ToneBadge } from '@/components/workflow/status-badge';
import {
  CONFIDENCE_BAND,
  FIELD_FORMAT_HINT,
  FIELD_ORIGIN,
  FIELD_REVIEW,
  formatConfidence,
} from '@/features/documents/document-vocabulary';

export interface FieldCardProps {
  field: FieldOut;
  /** Whether this field's evidence is the one currently shown on the page. */
  isSelected: boolean;
  /** No edits are possible once a reading has been accepted. */
  isLocked: boolean;
  onSelect: () => void;
  onCorrect: (text: string, reason: string | undefined) => Promise<void>;
  onConfirm: () => Promise<void>;
  onClear: () => Promise<void>;
  /** The message from a refused correction, shown against the input. */
  error?: string | undefined;
  isSaving: boolean;
}

/**
 * One field of a reading, with everything needed to agree or disagree with it.
 *
 * Four things are always visible: the value, where it came from, how sure the
 * reader was, and the text on the page it came from. A reviewer asked to confirm
 * a total they cannot trace is being asked to rubber-stamp, and this card exists
 * so that never happens.
 *
 * Confirming and correcting are separate actions rather than one editable box
 * that saves on blur. Agreeing with a machine and overruling it are different
 * decisions, they are recorded differently in the audit trail, and a reviewer
 * should have to mean each of them.
 */
export function FieldCard({
  field,
  isSelected,
  isLocked,
  onSelect,
  onCorrect,
  onConfirm,
  onClear,
  error,
  isSaving,
}: FieldCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(field.text);
  const [reason, setReason] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reopened by a rejected correction, so the reviewer keeps what they typed and
  // the message beside it rather than losing both to a closed editor.
  useEffect(() => {
    if (error) setIsEditing(true);
  }, [error]);

  useEffect(() => {
    if (isEditing) inputRef.current?.focus();
  }, [isEditing]);

  const band = CONFIDENCE_BAND[field.band];
  const origin = FIELD_ORIGIN[field.origin];
  const review = FIELD_REVIEW[field.review];
  const hasEvidence = field.evidence !== null && field.evidence.boxes.length > 0;

  const startEditing = () => {
    setDraft(field.text);
    setReason('');
    setIsEditing(true);
  };

  const submit = async () => {
    await onCorrect(draft, reason.trim() || undefined);
    // Left open on failure; the effect above reopens it if the API refused.
    setIsEditing(false);
  };

  return (
    <li
      className={cn(
        'border-b border-[var(--color-divider)] px-[var(--space-5)] py-[var(--space-4)] last:border-b-0',
        isSelected && 'bg-[var(--color-primary-50)]',
        field.needs_attention && !isSelected && 'bg-[var(--color-warning-50)]',
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-[var(--space-2)]">
        <p className="m-0 font-semibold text-[var(--color-text-strong)]">{field.label}</p>
        <div className="flex flex-wrap items-center gap-[var(--space-2)]">
          {field.review === 'unreviewed' ? (
            <ToneBadge
              label={band.label}
              tone={band.tone}
              detail={field.text ? formatConfidence(field.confidence) : undefined}
            />
          ) : (
            <ToneBadge label={review.label} tone={review.tone} />
          )}
        </div>
      </div>

      {isEditing ? (
        <div className="mt-[var(--space-3)] flex flex-col gap-[var(--space-3)]">
          <Field
            label={`${field.label} as it appears on the document`}
            error={error}
            formatHint={FIELD_FORMAT_HINT[field.name]}
            required
          >
            {({ inputId, describedBy, invalid }) => (
              <Input
                ref={inputRef}
                id={inputId}
                aria-describedby={describedBy}
                invalid={invalid}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submit();
                  if (event.key === 'Escape') setIsEditing(false);
                }}
              />
            )}
          </Field>

          <Field
            label="Why it was changed"
            help="Recorded in the audit trail. Useful to whoever reads this months from now."
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
          </Field>

          <div className="flex gap-[var(--space-2)]">
            <Button
              variant="primary"
              size="sm"
              onClick={() => void submit()}
              isLoading={isSaving}
              loadingLabel="Saving"
              disabled={draft.trim() === ''}
            >
              <Check aria-hidden="true" className="size-4" />
              Save this value
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setIsEditing(false)}>
              <X aria-hidden="true" className="size-4" />
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p
            className={cn(
              'mt-[var(--space-2)] mb-0 text-[length:var(--text-body-lg)]',
              field.text
                ? 'font-[var(--font-mono)] text-[var(--color-text-strong)]'
                : 'text-[var(--color-text-muted)] italic',
            )}
          >
            {field.text || 'Nothing was found for this'}
          </p>

          {field.amount_minor_units !== null && field.currency ? (
            <p className="mt-1 mb-0 text-[length:var(--text-caption)] text-[var(--color-text-subtle)]">
              Stored as {field.amount_minor_units} minor units of {field.currency}.
            </p>
          ) : null}

          {/* The badge above already gives the band and the score. Spelling out
              what a clear reading means as well repeats the same sentence down
              the whole column, and a page of identical explanations is a page
              nobody reads, including on the one field that needed attention. */}
          <p className="mt-[var(--space-2)] mb-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
            {origin.label}
            {field.review !== 'unreviewed'
              ? `. ${review.description}`
              : field.needs_attention
                ? `. ${band.description}`
                : ''}
          </p>

          {field.reader_text && field.reader_text !== field.text ? (
            <p className="mt-[var(--space-2)] mb-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              The reader had{' '}
              <span className="font-[var(--font-mono)] line-through">{field.reader_text}</span>
              {field.correction_reason ? `. Changed because: ${field.correction_reason}` : '.'}
            </p>
          ) : null}

          {field.adjustments.length > 0 ? (
            <ul className="mt-[var(--space-2)] mb-0 flex list-none flex-col gap-0.5 p-0">
              {field.adjustments.map((adjustment) => (
                <li
                  key={adjustment.reason}
                  className="text-[length:var(--text-caption)] text-[var(--color-text-subtle)]"
                >
                  {adjustment.reason}
                </li>
              ))}
            </ul>
          ) : null}

          {field.notes.length > 0 ? (
            <ul className="mt-[var(--space-2)] mb-0 flex list-none flex-col gap-0.5 p-0">
              {field.notes.map((note) => (
                <li
                  key={note}
                  className="text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]"
                >
                  {note}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="mt-[var(--space-3)] flex flex-wrap gap-[var(--space-2)]">
            {hasEvidence ? (
              <Button
                variant={isSelected ? 'primary' : 'secondary'}
                size="sm"
                onClick={onSelect}
                aria-pressed={isSelected}
              >
                <Eye aria-hidden="true" className="size-4" />
                Show on the document
              </Button>
            ) : null}

            {!isLocked ? (
              <>
                {field.text && field.review === 'unreviewed' ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void onConfirm()}
                    isLoading={isSaving}
                    loadingLabel="Saving"
                  >
                    <Check aria-hidden="true" className="size-4" />
                    This is correct
                  </Button>
                ) : null}

                <Button variant="secondary" size="sm" onClick={startEditing}>
                  <Pencil aria-hidden="true" className="size-4" />
                  {field.text ? 'Change it' : 'Type it in'}
                </Button>

                {field.review !== 'cleared' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void onClear()}
                    isLoading={isSaving}
                    loadingLabel="Saving"
                  >
                    <Slash aria-hidden="true" className="size-4" />
                    Not on this document
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        </>
      )}
    </li>
  );
}
