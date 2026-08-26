import { useMemo } from 'react';

import { cn } from '@/lib/utils';

/**
 * AuroraBackground.
 *
 * A decorative ambience layer for launch surfaces (section 8.4): two oversized,
 * slowly drifting colour fields, a faint dot grid masked toward the top, and a
 * few slow meteor streaks. It is purely presentational — `aria-hidden`, no
 * pointer events — and every part is stilled under prefers-reduced-motion by the
 * rules in motion.css, leaving a calm static gradient behind the content.
 */
export function AuroraBackground({
  className,
  meteors = 7,
}: {
  className?: string;
  meteors?: number;
}) {
  const streaks = useMemo(
    () =>
      Array.from({ length: meteors }, (_, i) => ({
        id: i,
        top: `${Math.random() * 38}%`,
        left: `${25 + Math.random() * 78}%`,
        delay: `${(i * 0.8 + Math.random() * 0.6).toFixed(2)}s`,
        duration: `${(4 + Math.random() * 4).toFixed(2)}s`,
      })),
    [meteors],
  );

  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute inset-0 overflow-hidden',
        className,
      )}
    >
      <div
        className="aurora-blob animate-aurora-a"
        style={{
          width: '46rem',
          height: '46rem',
          top: '-18rem',
          left: '-12rem',
          background:
            'radial-gradient(circle at 30% 30%, rgb(96 165 250 / 0.55), transparent 62%)',
        }}
      />
      <div
        className="aurora-blob animate-aurora-b"
        style={{
          width: '42rem',
          height: '42rem',
          bottom: '-16rem',
          right: '-10rem',
          background:
            'radial-gradient(circle at 60% 60%, rgb(139 92 246 / 0.5), transparent 64%)',
        }}
      />
      <div
        className="aurora-blob animate-float"
        style={{
          width: '26rem',
          height: '26rem',
          top: '22%',
          right: '14%',
          background:
            'radial-gradient(circle, rgb(56 189 248 / 0.32), transparent 62%)',
        }}
      />

      {/* Faint dot grid, faded out toward the lower edge. */}
      <div
        className="absolute inset-0 opacity-20"
        style={{
          backgroundImage:
            'radial-gradient(rgb(255 255 255 / 0.6) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
          WebkitMaskImage:
            'radial-gradient(130% 100% at 50% 0%, #000 42%, transparent 100%)',
          maskImage:
            'radial-gradient(130% 100% at 50% 0%, #000 42%, transparent 100%)',
        }}
      />

      {streaks.map((streak) => (
        <span
          key={streak.id}
          className="meteor"
          style={{
            top: streak.top,
            left: streak.left,
            animationDelay: streak.delay,
            animationDuration: streak.duration,
          }}
        />
      ))}
    </div>
  );
}
