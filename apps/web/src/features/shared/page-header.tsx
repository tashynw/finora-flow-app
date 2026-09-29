import { cn } from '@/lib/utils';

/**
 * PageHeader.
 *
 * Every page states its purpose in one line beneath the title, so a reader who
 * arrives from a link or a notification knows what they are looking at. The
 * row beneath carries the page's views on the left and its primary action on
 * the right.
 */
export interface PageHeaderProps {
  title: string;
  purpose: string;
  actions?: React.ReactNode;
  /** Views, filters or a search field, laid out left of the actions. */
  toolbar?: React.ReactNode;
  meta?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  purpose,
  actions,
  toolbar,
  meta,
  className,
}: PageHeaderProps) {
  const hasRow = Boolean(actions || toolbar);

  return (
    <header className={cn('mb-[var(--space-5)]', className)}>
      <div className="min-w-0">
        <h1 className="text-[31px] leading-tight font-semibold text-[var(--color-text-heading)]">
          {title}
        </h1>
        <p className="mt-1.5 m-0 max-w-[850px] text-[length:var(--text-body)] text-[#5a6891]">
          {purpose}
        </p>
        {meta ? <div className="mt-[var(--space-3)]">{meta}</div> : null}
      </div>

      {hasRow ? (
        <div className="mt-[var(--space-5)] flex flex-col gap-[var(--space-3)] lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0 flex-1">{toolbar}</div>
          {actions ? (
            // Named, because a page's primary action is often repeated further
            // down as an empty-state prompt. Two buttons reading the same is
            // fine when they do the same thing, but a screen reader user
            // listing them deserves to know which one belongs to the header.
            <div
              role="group"
              aria-label={`${title} actions`}
              className="flex shrink-0 flex-wrap items-center gap-[var(--space-3)]"
            >
              {actions}
            </div>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
