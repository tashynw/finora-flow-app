import { forwardRef, useId } from 'react';
import { AlertCircle } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Form field primitives.
 *
 * Every input has a visible persistent label. Placeholder text is never used as
 * a label, because it disappears the moment the user types and leaves them
 * unable to check what they entered.
 *
 * Errors appear beneath the field, explain what to do next, and are wired to the
 * input through `aria-describedby` so a screen reader announces them.
 *
 * An error is shown alongside the guidance rather than in place of it. The two
 * answer different questions — "what does this box want" and "what is wrong with
 * what is in it" — and a field is flagged precisely when the reader most needs
 * the format and the policy still in front of them.
 */

export interface FieldProps {
  label: string;
  /** What this box wants, and any policy attached to it. */
  help?: string | undefined;
  error?: string | undefined;
  required?: boolean | undefined;
  /** Hint about the expected format, for example "DD MMM YYYY". */
  formatHint?: string | undefined;
  children: (ids: {
    inputId: string;
    describedBy: string | undefined;
    invalid: boolean;
  }) => React.ReactNode;
  className?: string | undefined;
}

export function Field({
  label,
  help,
  error,
  required = false,
  formatHint,
  children,
  className,
}: FieldProps) {
  const inputId = useId();
  const helpId = `${inputId}-help`;
  const errorId = `${inputId}-error`;

  const describedBy =
    [help || formatHint ? helpId : null, error ? errorId : null]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <div className={cn('flex flex-col gap-[var(--space-2)]', className)}>
      <label
        htmlFor={inputId}
        className="text-[length:var(--text-body-sm)] font-semibold text-[var(--color-text-strong)]"
      >
        {label}
        {required ? (
          <>
            {' '}
            <span
              aria-hidden="true"
              className="text-[var(--color-danger-600)]"
            >
              *
            </span>
            <span className="sr-only">(required)</span>
          </>
        ) : (
          <span className="sr-only">(optional)</span>
        )}
      </label>

      {children({ inputId, describedBy, invalid: Boolean(error) })}

      {/* Above the guidance, because it is the more urgent of the two and sits
          closest to the box it is about. */}
      {error ? (
        <p
          id={errorId}
          // Polite, not `role="alert"`: an alert is assertive and interrupts a
          // user mid-sentence. Polite lets them finish the thought and still
          // hear the problem. Content present on first render is not announced
          // by either, which is why a form is never noisy just for opening.
          aria-live="polite"
          className="m-0 flex items-start gap-1.5 text-[length:var(--text-caption)] text-[var(--color-danger-700)]"
        >
          <AlertCircle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}

      {help || formatHint ? (
        <p
          id={helpId}
          className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]"
        >
          {help}
          {help && formatHint ? ' ' : ''}
          {formatHint ? <span className="font-mono">{formatHint}</span> : null}
        </p>
      ) : null}
    </div>
  );
}

const inputClasses = [
  'h-11 w-full rounded-[var(--radius-sm)] bg-[var(--color-surface)]',
  'border border-[var(--color-border-strong)]',
  'px-[var(--space-3)] text-[length:var(--text-body)] text-[var(--color-text-strong)]',
  'placeholder:text-[var(--color-text-subtle)]',
  'transition-[border-color,box-shadow] duration-[var(--duration-fast)]',
  'hover:border-[var(--color-primary-300)]',
  'focus:border-[var(--color-primary-600)] focus:outline-none',
  'focus:shadow-[var(--shadow-focus)]',
  'disabled:cursor-not-allowed disabled:bg-[var(--color-surface-subtle)]',
  'disabled:text-[var(--color-text-muted)]',
  'aria-[invalid=true]:border-[var(--color-danger-600)]',
].join(' ');

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  /** Right-align and use tabular figures for amounts and quantities. */
  numeric?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, numeric, ...props }, ref) => (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        inputClasses,
        numeric && 'tabular text-right font-[var(--font-mono)]',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

/**
 * A native select.
 *
 * Native rather than a custom listbox: it is keyboard accessible, screen-reader
 * accessible and touch-friendly without any of that being this codebase's to
 * maintain, and it opens as the platform picker on a phone. A custom control
 * would be warranted for search across hundreds of options, and the selectors
 * here are cost centres and currencies.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, invalid, children, ...props }, ref) => (
    <select
      ref={ref}
      aria-invalid={invalid || undefined}
      // `appearance-none` is deliberately not used: the platform's own arrow is
      // what tells a user this opens a list.
      className={cn(inputClasses, 'cursor-pointer pr-[var(--space-2)]', className)}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = 'Select';

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, invalid, rows = 4, ...props }, ref) => (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(inputClasses, 'h-auto py-[var(--space-3)] leading-relaxed', className)}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';
