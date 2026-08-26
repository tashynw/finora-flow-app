import { cn } from '@/lib/utils';

/**
 * Skeleton.
 *
 * Loading placeholders mirror the shape of the content that will replace them,
 * so the layout does not jump. Every skeleton region announces itself, because a
 * silent busy state leaves a screen reader user with nothing to read.
 */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'motion-shimmer rounded-[var(--radius-sm)] bg-[var(--color-surface-subtle)]',
        className,
      )}
      {...props}
    />
  );
}

export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className={cn('h-3.5', index === lines - 1 ? 'w-3/5' : 'w-full')}
        />
      ))}
    </div>
  );
}

/**
 * One large placeholder for a single piece of content, such as a document page.
 *
 * Announces itself, unlike `Skeleton`, because it stands in for the whole of what
 * the region will contain rather than for one line within it.
 */
export function SkeletonBlock({
  className,
  label = 'Loading',
}: {
  className?: string;
  label?: string;
}) {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      <Skeleton className={className} />
    </div>
  );
}

export function SkeletonTable({
  rows = 6,
  columns = 5,
  label = 'Loading records',
}: {
  rows?: number;
  columns?: number;
  label?: string;
}) {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div className="flex flex-col">
        <div className="flex gap-[var(--space-4)] border-b border-[var(--color-divider)] px-[var(--density-cell-padding-x)] py-[var(--space-3)]">
          {Array.from({ length: columns }, (_, index) => (
            <Skeleton key={index} className="h-3 flex-1" />
          ))}
        </div>
        {Array.from({ length: rows }, (_, rowIndex) => (
          <div
            key={rowIndex}
            className="flex items-center gap-[var(--space-4)] border-b border-[var(--color-divider)] px-[var(--density-cell-padding-x)]"
            style={{ height: 'var(--density-row-height)' }}
          >
            {Array.from({ length: columns }, (_, columnIndex) => (
              <Skeleton key={columnIndex} className="h-3.5 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
