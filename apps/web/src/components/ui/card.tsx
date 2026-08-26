import { cn } from '@/lib/utils';

/**
 * Card.
 *
 * Solid surface by default. Glass is reserved for AI summaries, launch visuals
 * and executive callouts, and must never sit behind a table, a form or document
 * text where it would harm legibility.
 */
export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'solid' | 'glass';
  interactive?: boolean;
}

export function Card({
  className,
  variant = 'solid',
  interactive = false,
  ...props
}: CardProps) {
  return (
    <div
      className={cn(
        variant === 'glass' ? 'surface-glass' : 'surface-card',
        interactive && 'motion-card-hover cursor-pointer',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 border-b border-[var(--color-divider)]',
        'px-[var(--space-5)] py-[var(--space-4)]',
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({
  className,
  as: Component = 'h2',
  ...props
}: React.HTMLAttributes<HTMLHeadingElement> & {
  as?: 'h1' | 'h2' | 'h3' | 'h4';
}) {
  return (
    <Component
      className={cn(
        'text-[length:var(--text-heading-3)] leading-[var(--text-heading-3--line-height)]',
        'font-semibold text-[var(--color-text-strong)]',
        className,
      )}
      {...props}
    />
  );
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        'm-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]',
        className,
      )}
      {...props}
    />
  );
}

export function CardContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('px-[var(--space-5)] py-[var(--space-5)]', className)}
      {...props}
    />
  );
}

export function CardFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-[var(--space-3)]',
        'border-t border-[var(--color-divider)]',
        'bg-[var(--color-surface-subtle)]',
        'px-[var(--space-5)] py-[var(--space-4)]',
        'rounded-b-[var(--radius-lg)]',
        className,
      )}
      {...props}
    />
  );
}
