import type { LucideIcon } from 'lucide-react';
import { Link } from '@/lib/app-link';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * EmptyState.
 *
 * The standard requires every empty state to explain the cause and offer a next
 * step. "No records found" on its own is not acceptable, so `explanation` and
 * `nextStep` are both required.
 */
/**
 * An offered next step.
 *
 * Somewhere to go is a link and something to do is a button, kept apart here
 * rather than made uniform, because a next step that navigates should behave like
 * every other link in the product: openable in a new tab, and reported as a link
 * by a screen reader.
 */
export type EmptyStateAction =
  | { label: string; onClick: () => void; to?: undefined }
  | { label: string; to: string; onClick?: undefined };

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  /** Why the reader is seeing nothing. */
  explanation: string;
  /** What they can do about it. */
  nextStep: string;
  action?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  /**
   * Heading level of the title. A page-level empty state sits under the page's
   * h1; one inside a titled card or section should be a level below that.
   */
  titleAs?: 'h1' | 'h2' | 'h3';
  className?: string;
}

function ActionButton({
  action,
  variant,
}: {
  action: EmptyStateAction;
  variant: 'primary' | 'secondary' | 'ghost';
}) {
  if (action.to !== undefined) {
    return (
      <Button variant={variant} asChild>
        <Link to={action.to}>{action.label}</Link>
      </Button>
    );
  }
  return (
    <Button variant={variant} onClick={action.onClick}>
      {action.label}
    </Button>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  explanation,
  nextStep,
  action,
  secondaryAction,
  titleAs: Title = 'h2',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-[var(--space-3)]',
        'px-[var(--space-6)] py-[var(--space-12)] text-center',
        className,
      )}
    >
      {Icon ? (
        <span
          aria-hidden="true"
          className={cn(
            'mb-1 flex size-12 items-center justify-center rounded-[var(--radius-lg)]',
            'bg-[image:var(--gradient-signature-soft)] text-[var(--color-primary-700)]',
          )}
        >
          <Icon className="size-6" />
        </span>
      ) : null}

      <Title className="text-[length:var(--text-heading-3)] font-semibold text-[var(--color-text-strong)]">
        {title}
      </Title>

      <p className="m-0 max-w-prose text-[length:var(--text-body)] text-[var(--color-text-muted)]">
        {explanation}
      </p>
      <p className="m-0 max-w-prose text-[length:var(--text-body-sm)] text-[var(--color-text)]">
        {nextStep}
      </p>

      {action || secondaryAction ? (
        <div className="mt-[var(--space-3)] flex flex-wrap items-center justify-center gap-[var(--space-3)]">
          {action ? <ActionButton action={action} variant="primary" /> : null}
          {secondaryAction ? (
            // On its own, a ghost button reads as a line of text.
            <ActionButton action={secondaryAction} variant={action ? 'ghost' : 'secondary'} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
