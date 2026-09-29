import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

export interface StatCardItem {
  key: string;
  label: string;
  value: React.ReactNode;
  meta?: React.ReactNode | undefined;
}

/**
 * StatCards.
 *
 * The row of headline cards at the top of a register or overview: a small
 * uppercase label, the figure, and one line saying what it counts. Up to four
 * across on desktop, two on tablet, one on a phone.
 */
export function StatCards({
  items,
  isLoading = false,
  className,
}: {
  items: StatCardItem[];
  isLoading?: boolean | undefined;
  className?: string | undefined;
}) {
  if (isLoading && items.length === 0) {
    return (
      <div
        className={cn(
          'mb-[var(--space-6)] grid gap-5 sm:grid-cols-2 xl:grid-cols-4',
          className,
        )}
      >
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-[82px] rounded-[var(--radius-lg)]" />
        ))}
      </div>
    );
  }
  if (items.length === 0) return null;

  return (
    <ul
      className={cn(
        'm-0 mb-[var(--space-6)] grid list-none gap-5 p-0 sm:grid-cols-2 xl:grid-cols-4',
        className,
      )}
    >
      {items.map((item) => (
        <li
          key={item.key}
          className={cn(
            'surface-card flex min-h-[82px] flex-col justify-center px-4 py-3.5',
          )}
        >
          <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
            {item.label}
          </span>
          <span className="mt-1.5 text-[24px] font-semibold leading-tight tabular text-[var(--color-text-strong)]">
            {item.value}
          </span>
          {item.meta ? (
            <span className="mt-1 truncate text-[11px] text-[var(--color-text-muted)]">
              {item.meta}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
