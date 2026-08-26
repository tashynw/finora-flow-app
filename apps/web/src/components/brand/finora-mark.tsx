import { cn } from '@/lib/utils';
import markUrl from '@/assets/brand/finora-mark.png';
import markMonoUrl from '@/assets/brand/finora-mark-mono.png';
import markWhiteUrl from '@/assets/brand/finora-mark-white.png';

type MarkVariant = 'color' | 'mono' | 'inverse';

const MARK_SRC: Record<MarkVariant, string> = {
  color: markUrl,
  mono: markMonoUrl,
  inverse: markWhiteUrl,
};

/**
 * Product mark.
 *
 * The flowing double-stroke F is the approved brand artwork, decoded from the
 * supplied logo to a transparent raster so it composites cleanly on the light
 * shell. `variant` selects the full-gradient art, a single-colour silhouette
 * for audit print and forced-colour contexts (5.3), or a white silhouette for
 * the gradient hero. The wordmark is drawn as live text so it stays crisp,
 * translatable and theme-aware.
 */
export function FinoraMark({
  showWordmark = true,
  variant = 'color',
  className,
}: {
  showWordmark?: boolean;
  variant?: MarkVariant;
  className?: string;
}) {
  const inverse = variant === 'inverse';
  return (
    <span className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <img
        src={MARK_SRC[variant]}
        // When the wordmark follows, the image is decorative; the text names the
        // product. Icon-only, it carries the accessible name itself.
        alt={showWordmark ? '' : 'Finora Flow'}
        aria-hidden={showWordmark ? true : undefined}
        width={32}
        height={32}
        className="size-8 shrink-0 select-none"
        draggable={false}
      />

      {showWordmark ? (
        <span className="flex min-w-0 flex-col leading-none">
          <span
            className={cn(
              'truncate text-[15px] font-bold tracking-tight',
              inverse ? 'text-[var(--color-text-inverse)]' : 'gradient-text',
            )}
          >
            Finora Flow
          </span>
          <span
            className={cn(
              'truncate text-[10px] font-medium uppercase tracking-wider',
              inverse
                ? 'text-[var(--color-text-inverse)] opacity-80'
                : 'text-[var(--color-text-subtle)]',
            )}
          >
            Invoice automation
          </span>
        </span>
      ) : null}
    </span>
  );
}
