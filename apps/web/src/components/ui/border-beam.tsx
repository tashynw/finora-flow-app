import { motion, useReducedMotion, type Transition } from 'motion/react';

import { cn } from '@/lib/utils';

/**
 * Border beam.
 *
 * Adapted from MagicUI (`border-beam`). The standard permits an animated
 * gradient border on a single AI insight card and nowhere else, so this is used
 * once, on the dashboard insight. Renders nothing under `prefers-reduced-motion`
 * — the card keeps its static border and loses only the decoration.
 *
 * The host element must be `position: relative` with a rounded radius; the beam
 * inherits that radius and rides the border via `offset-path`.
 */
interface BorderBeamProps {
  size?: number;
  duration?: number;
  delay?: number;
  colorFrom?: string;
  colorTo?: string;
  transition?: Transition;
  className?: string;
  reverse?: boolean;
  initialOffset?: number;
  borderWidth?: number;
}

export function BorderBeam({
  className,
  size = 60,
  delay = 0,
  duration = 7,
  colorFrom = '#2563eb',
  colorTo = '#8b5cf6',
  transition,
  reverse = false,
  initialOffset = 0,
  borderWidth = 1.5,
}: BorderBeamProps) {
  const reduce = useReducedMotion();
  if (reduce) return null;

  return (
    <div
      className="pointer-events-none absolute inset-0 rounded-[inherit] [border:calc(var(--border-beam-width)*1px)_solid_transparent] [mask-clip:padding-box,border-box] [mask-composite:intersect] [mask:linear-gradient(transparent,transparent),linear-gradient(#000,#000)]"
      style={
        {
          '--border-beam-width': borderWidth,
          '--beam-from': colorFrom,
          '--beam-to': colorTo,
        } as React.CSSProperties
      }
    >
      <motion.div
        className={cn(
          'absolute aspect-square',
          'bg-gradient-to-l from-[var(--beam-from)] via-[var(--beam-to)] to-transparent',
          className,
        )}
        style={{
          width: size,
          offsetPath: `rect(0 auto auto 0 round ${size}px)`,
        }}
        initial={{ offsetDistance: `${initialOffset}%` }}
        animate={{
          offsetDistance: reverse
            ? [`${100 - initialOffset}%`, `${-initialOffset}%`]
            : [`${initialOffset}%`, `${100 + initialOffset}%`],
        }}
        transition={{
          repeat: Infinity,
          ease: 'linear',
          duration,
          delay: -delay,
          ...transition,
        }}
      />
    </div>
  );
}
