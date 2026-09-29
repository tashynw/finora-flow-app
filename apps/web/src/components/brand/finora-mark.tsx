import { cn } from '@/lib/utils';
import markUrl from '@/assets/brand/finora-mark.png';
import markMonoUrl from '@/assets/brand/finora-mark-mono.png';
import markWhiteUrl from '@/assets/brand/finora-mark-white.png';

type MarkVariant = 'color' | 'mono' | 'inverse';
type MarkSize = 'sm' | 'md' | 'lg';

const MARK_SRC: Record<MarkVariant, string> = {
  color: markUrl,
  mono: markMonoUrl,
  inverse: markWhiteUrl,
};

const MARK_SIZE: Record<MarkSize, string> = {
  sm: 'size-7',
  md: 'size-8',
  lg: 'size-10',
};

const WORD_SIZE: Record<MarkSize, string> = {
  sm: 'text-[17px]',
  md: 'text-[21px]',
  lg: 'text-[27px]',
};

/**
 * Product mark.
 *
 * The flowing double-stroke F — the approved brand artwork — beside a live-text
 * wordmark with "Flow" in brand blue. The wordmark is text so it stays crisp,
 * translatable and theme-aware. `mono` and `inverse` swap the artwork for the
 * single-colour and white silhouettes used in audit print, forced-colour
 * contexts and dark surfaces.
 */
export function FinoraMark({
  showWordmark = true,
  variant = 'color',
  size = 'sm',
  className,
}: {
  showWordmark?: boolean;
  variant?: MarkVariant;
  size?: MarkSize;
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
        className={cn('shrink-0 select-none object-contain', MARK_SIZE[size])}
        draggable={false}
      />

      {showWordmark ? (
        <span
          className={cn(
            'truncate font-bold leading-none tracking-[-0.02em]',
            WORD_SIZE[size],
            inverse ? 'text-[var(--color-text-inverse)]' : 'text-[var(--color-text-heading)]',
          )}
        >
          Finora{' '}
          <span
            className={
              inverse ? 'text-[var(--color-text-inverse)]' : 'text-[var(--color-primary-600)]'
            }
          >
            Flow
          </span>
        </span>
      ) : null}
    </span>
  );
}
