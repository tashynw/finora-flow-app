import { useEffect, useRef, type ComponentPropsWithoutRef } from 'react';
import { useMotionValue, useReducedMotion, useSpring } from 'motion/react';

import { cn } from '@/lib/utils';

/**
 * Number ticker.
 *
 * Adapted from MagicUI (`number-ticker`) to consume our tokens and to obey
 * `prefers-reduced-motion`: the standard requires KPI values to appear
 * immediately when motion is reduced rather than counting up. Tabular numerals
 * keep the figure from reflowing as it animates.
 *
 * Unlike the upstream component this animates on mount rather than on scroll
 * into view. A KPI below the fold must still read its true value without the
 * user scrolling to it — a dashboard figure stuck at zero is a wrong figure.
 */
interface NumberTickerProps extends ComponentPropsWithoutRef<'span'> {
  value: number;
  startValue?: number;
  delay?: number;
  decimalPlaces?: number;
}

export function NumberTicker({
  value,
  startValue = 0,
  delay = 0,
  className,
  decimalPlaces = 0,
  ...props
}: NumberTickerProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  const motionValue = useMotionValue(startValue);
  const springValue = useSpring(motionValue, { damping: 60, stiffness: 100 });

  const format = (input: number) =>
    Intl.NumberFormat('en-US', {
      minimumFractionDigits: decimalPlaces,
      maximumFractionDigits: decimalPlaces,
    }).format(Number(input.toFixed(decimalPlaces)));

  useEffect(() => {
    if (reduce) return;
    const timer = setTimeout(() => motionValue.set(value), delay * 1000);
    return () => clearTimeout(timer);
  }, [motionValue, delay, value, reduce]);

  useEffect(() => {
    if (reduce) return;
    return springValue.on('change', (latest) => {
      if (ref.current) ref.current.textContent = format(latest);
    });
  }, [springValue, decimalPlaces, reduce]);

  return (
    <span
      ref={ref}
      className={cn('inline-block tabular-nums', className)}
      {...props}
    >
      {format(reduce ? value : startValue)}
    </span>
  );
}
