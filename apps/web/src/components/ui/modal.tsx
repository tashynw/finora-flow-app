import { useCallback, useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Modal.
 *
 * Built on the native `<dialog>` element, which gives focus trapping, the top
 * layer and `Escape` handling from the platform rather than from hand-written
 * key handlers that are easy to get subtly wrong.
 *
 * Dismissal is by the Close button or by Escape only. There is deliberately no
 * backdrop-click dismissal: a stray click outside a part-filled form would
 * discard what the user typed, and these dialogs carry financial input. Escape
 * is also suppressed while a submission is in flight, because closing mid-request
 * would leave the user unsure whether the action took effect.
 */
export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Why the dialog exists, announced with the title. */
  description?: string | undefined;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Blocks dismissal while an action is in progress. */
  busy?: boolean | undefined;
  className?: string | undefined;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  busy = false,
  className,
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  // Generated rather than fixed: a page may hold several dialogs at once, only
  // one of them open. Repeating one id would put duplicates in the document and
  // leave `aria-labelledby` pointing at whichever came first.
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const descriptionId = `${baseId}-description`;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const handleCancel = useCallback(
    (event: React.SyntheticEvent<HTMLDialogElement>) => {
      // Always prevented: React state owns whether the dialog is open, so
      // letting the browser close it directly would desynchronise the two.
      event.preventDefault();
      if (!busy) onClose();
    },
    [busy, onClose],
  );

  return (
    <dialog
      ref={ref}
      onCancel={handleCancel}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={cn(
        'motion-panel m-auto w-[min(32rem,calc(100vw-2rem))] rounded-[var(--radius-lg)]',
        'border border-[var(--color-border)] bg-[var(--color-surface)] p-0',
        'text-[var(--color-text)] shadow-[var(--shadow-overlay)]',
        'backdrop:bg-[color-mix(in_srgb,var(--color-text-strong)_45%,transparent)]',
        'backdrop:backdrop-blur-sm',
        // The dialog itself never scrolls; its body does. A long form on a short
        // screen would otherwise push the buttons past the bottom edge, leaving
        // somebody looking at a filled-in form with no visible way to submit it.
        'max-h-[calc(100vh-2rem)] overflow-hidden',
        // Guarded by `open:`. A bare display rule would beat the user agent's
        // `display: none` on a closed dialog and lay every unopened dialog out
        // in the page, which looks like the page has simply grown extra forms.
        'open:grid grid-rows-[auto_minmax(0,1fr)_auto]',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-[var(--space-4)] border-b border-[var(--color-divider)] p-[var(--space-5)]">
        <div>
          <h2
            id={titleId}
            className="m-0 text-[length:var(--text-heading-3)] font-semibold text-[var(--color-text-strong)]"
          >
            {title}
          </h2>
          {description ? (
            <p
              id={descriptionId}
              className="mt-1 m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]"
            >
              {description}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className={cn(
            'motion-interactive -m-1 flex size-8 shrink-0 items-center justify-center',
            'rounded-[var(--radius-sm)] text-[var(--color-text-muted)]',
            'hover:bg-[var(--color-surface-subtle)] hover:text-[var(--color-text-strong)]',
            'focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          <X aria-hidden="true" className="size-4" />
          <span className="sr-only">Close</span>
        </button>
      </div>

      <div className="overflow-y-auto p-[var(--space-5)]">{children}</div>

      {footer ? (
        <div className="flex flex-wrap items-center justify-end gap-[var(--space-3)] border-t border-[var(--color-divider)] p-[var(--space-5)]">
          {footer}
        </div>
      ) : null}
    </dialog>
  );
}
