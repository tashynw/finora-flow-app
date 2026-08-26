import { motion, useReducedMotion } from 'motion/react';

const ELEMENTS = {
  div: motion.div,
  li: motion.li,
  section: motion.section,
  span: motion.span,
} as const;

type RevealElement = keyof typeof ELEMENTS;

/**
 * Reveal.
 *
 * A single entrance: fade with a short rise and a brief de-blur. `delay` lets a
 * caller stagger a group by index. Under prefers-reduced-motion the content is
 * rendered in its final state immediately — motion is an enhancement here, never
 * a gate on seeing the figure.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  y = 12,
  blur = 8,
  duration = 0.5,
  as = 'div',
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  y?: number;
  blur?: number;
  duration?: number;
  as?: RevealElement;
}) {
  const reduce = useReducedMotion();
  const Component = ELEMENTS[as];

  return (
    <Component
      className={className}
      initial={reduce ? false : { opacity: 0, y, filter: `blur(${blur}px)` }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ duration, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </Component>
  );
}
