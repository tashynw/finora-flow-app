import { cn } from '@/lib/utils';

/**
 * A required choice between a few mutually exclusive answers, none preselected.
 *
 * Native radios in a real fieldset, so arrow keys move between the options, the
 * legend is announced with each one, and the group is a single tab stop. The
 * whole card is the label rather than just the words beside the dot, because
 * these are read on a phone by a supplier who has never seen the page before.
 *
 * Nothing is ever preselected by design, here or by any caller. Every use of
 * this asks somebody to state what happened to money, and a form that opens with
 * an answer already chosen produces a record of a decision nobody made.
 */
export interface Choice<T extends string> {
  value: T;
  label: string;
  help: string;
}

export function ChoiceList<T extends string>({
  legend,
  name,
  choices,
  value,
  onChange,
  error,
}: {
  legend: string;
  name: string;
  choices: readonly Choice<T>[];
  value: T | null;
  onChange: (next: T) => void;
  error?: string | undefined;
}) {
  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="m-0 p-0 text-[var(--text-body-sm)] font-semibold text-[var(--color-text-strong)]">
        {legend}{' '}
        <span aria-hidden="true" className="text-[var(--color-danger-600)]">
          *
        </span>
        <span className="sr-only">(required)</span>
      </legend>

      {error ? (
        <p
          // Polite rather than an alert, matching every other field in the
          // application: an assertive announcement interrupts somebody
          // mid-sentence to tell them about a box they have not reached.
          aria-live="polite"
          className="mt-[var(--space-2)] m-0 text-[var(--text-caption)] text-[var(--color-danger-700)]"
        >
          {error}
        </p>
      ) : null}

      <div className="mt-[var(--space-3)] flex flex-col gap-[var(--space-2)]">
        {choices.map((choice) => (
          <label
            key={choice.value}
            className={cn(
              'grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start',
              'gap-x-[var(--space-3)] gap-y-1 rounded-[var(--radius-md)]',
              'border border-[var(--color-border-strong)] p-[var(--space-4)]',
              'has-[:checked]:border-[var(--color-primary-600)]',
              'has-[:checked]:bg-[var(--color-primary-50)]',
              'has-[:focus-visible]:shadow-[var(--shadow-focus)]',
            )}
          >
            <input
              type="radio"
              name={name}
              value={choice.value}
              checked={value === choice.value}
              onChange={() => onChange(choice.value)}
              className="row-span-2 mt-1 size-4 shrink-0 accent-[var(--color-primary-600)]"
            />
            <span className="font-semibold text-[var(--color-text-strong)]">
              {choice.label}
            </span>
            <span className="text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
              {choice.help}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
