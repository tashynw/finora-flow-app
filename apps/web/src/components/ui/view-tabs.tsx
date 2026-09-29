import { cn } from '@/lib/utils';

export interface ViewTab {
  id: string;
  label: string;
}

/**
 * ViewTabs.
 *
 * The views of a register or queue. The chosen view is a dark pill and the
 * rest are plain text, so the current one reads at a glance without colour.
 * Each is a real button with `aria-pressed`, not a styled link, because
 * choosing a view filters in place rather than navigating.
 */
export function ViewTabs({
  tabs,
  value,
  onChange,
  label = 'Choose a view',
  className,
}: {
  tabs: ViewTab[];
  value: string;
  onChange: (id: string) => void;
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('flex flex-wrap items-center gap-1', className)}
    >
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(tab.id)}
            className={cn(
              'inline-flex h-9 items-center rounded-[var(--radius-md)] px-3.5',
              'text-[12px] font-medium whitespace-nowrap',
              'transition-colors duration-[var(--duration-fast)]',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary-600)]',
              active
                ? 'bg-[var(--color-text-strong)] text-[var(--color-text-inverse)]'
                : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text-strong)]',
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
