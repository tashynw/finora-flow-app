import { cn } from '@/lib/utils';

const TONE_GRADIENT: Record<'inverse' | 'primary', string> = {
  // A soft light glare for text that sits on the signature gradient.
  inverse:
    'linear-gradient(110deg, rgb(255 255 255 / 0.55) 40%, #ffffff 50%, rgb(255 255 255 / 0.55) 60%)',
  // A blue-violet glare for light surfaces (e.g. the AI insight pill).
  primary:
    'linear-gradient(110deg, rgb(37 99 235 / 0.55) 40%, #7c3aed 50%, rgb(37 99 235 / 0.55) 60%)',
};

/**
 * A restrained light-sweep across text. Paired with meaning (an AI label, a
 * live status), never left shimmering as decoration on its own. Falls back to a
 * solid colour under prefers-reduced-motion via the `.shiny-text` rule.
 */
export function ShinyText({
  children,
  tone = 'inverse',
  className,
}: {
  children: React.ReactNode;
  tone?: 'inverse' | 'primary';
  className?: string;
}) {
  return (
    <span
      className={cn('shiny-text', className)}
      style={{ backgroundImage: TONE_GRADIENT[tone] }}
    >
      {children}
    </span>
  );
}
