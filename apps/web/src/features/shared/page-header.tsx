import { cn } from '@/lib/utils';

/**
 * PageHeader.
 *
 * Every page states its purpose in one line beneath the title, so a reader who
 * arrives from a link or a notification knows what they are looking at.
 */
export interface PageHeaderProps {
  title: string;
  purpose: string;
  actions?: React.ReactNode;
  meta?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  purpose,
  actions,
  meta,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        'mb-[var(--space-6)] flex flex-col gap-[var(--space-4)]',
        'md:flex-row md:items-start md:justify-between',
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-[length:var(--text-heading-1)] leading-[var(--text-heading-1--line-height)] font-bold">
          {title}
        </h1>
        <p className="mt-[var(--space-2)] m-0 max-w-prose text-[var(--text-body)] text-[var(--color-text-muted)]">
          {purpose}
        </p>
        {meta ? <div className="mt-[var(--space-3)]">{meta}</div> : null}
      </div>

      {actions ? (
        // Named, because a page's primary action is often repeated further down
        // as an empty-state prompt. Two buttons reading the same is fine when
        // they do the same thing, but a screen reader user listing them deserves
        // to know which one belongs to the page header.
        <div
          role="group"
          aria-label={`${title} actions`}
          className="flex shrink-0 flex-wrap items-center gap-[var(--space-3)]"
        >
          {actions}
        </div>
      ) : null}
    </header>
  );
}
