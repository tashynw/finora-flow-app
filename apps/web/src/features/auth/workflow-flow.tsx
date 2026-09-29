import { useEffect, useId, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { Check, CreditCard, FileText, Receipt, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * The four stages Finora carries work through, drawn as a living flow on the
 * sign-in page: a glowing path winds through the stage cards, light travels
 * along it from Estimates to Payments, and each card lights up as the flow
 * reaches it. Decorative only — hidden from assistive technology, and still
 * whenever the reader has asked for reduced motion.
 */

const STAGES: { label: string; icon: LucideIcon; tile: string }[] = [
  { label: 'Estimates', icon: FileText, tile: 'bg-[#2f6bf2]' },
  { label: 'Invoices', icon: Receipt, tile: 'bg-[#2f6bf2]' },
  { label: 'Approvals', icon: Check, tile: 'bg-[#22b45a] rounded-full' },
  { label: 'Payments', icon: CreditCard, tile: 'bg-[#2f6bf2]' },
];

/** One full pass of the light along the path, in seconds. */
const LOOP_SECONDS = 8;

/** Which stage the travelling light is at, cycling in step with the loop. */
function useActiveStage(enabled: boolean): number {
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const step = (LOOP_SECONDS * 1000) / STAGES.length;
    const timer = window.setInterval(
      () => setActive((current) => (current + 1) % STAGES.length),
      step,
    );
    return () => window.clearInterval(timer);
  }, [enabled]);
  return enabled ? active : -1;
}

/* Card centres in the spiral's 440 × 620 coordinate space. */
const CENTRES: [number, number][] = [
  [150, 100],
  [292, 240],
  [148, 382],
  [292, 522],
];

const SPIRAL_PATH =
  'M 40,40 C 80,70 110,92 150,100 ' +
  'C 260,120 330,170 292,240 ' +
  'C 256,306 110,300 148,382 ' +
  'C 180,452 330,450 292,522 ' +
  'C 270,566 330,600 410,610';

export function WorkflowSpiral({ className }: { className?: string }) {
  const reduceMotion = useReducedMotion() ?? false;
  const active = useActiveStage(!reduceMotion);
  const id = useId().replace(/:/g, '');

  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none relative aspect-[440/620] w-full max-w-[440px] [container-type:inline-size]',
        className,
      )}
    >
      <svg viewBox="0 0 440 620" className="absolute inset-0 h-full w-full overflow-visible">
        <defs>
          <linearGradient id={`${id}-stroke`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#8fb2ff" />
            <stop offset="55%" stopColor="#6d7cff" />
            <stop offset="100%" stopColor="#a78bfa" />
          </linearGradient>
          <linearGradient id={`${id}-beam`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="100%" stopColor="#c7d6ff" />
          </linearGradient>
          <filter id={`${id}-glow`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <path id={`${id}-path`} d={SPIRAL_PATH} />
        </defs>

        {/* The ribbon itself: a soft wide glow under a crisp core. */}
        <use href={`#${id}-path`} stroke={`url(#${id}-stroke)`} strokeWidth="14" strokeOpacity="0.16" fill="none" strokeLinecap="round" />
        <use href={`#${id}-path`} stroke={`url(#${id}-stroke)`} strokeWidth="2.5" strokeOpacity="0.55" fill="none" strokeLinecap="round" />

        {reduceMotion ? null : (
          <>
            {/* Beams of light running down the ribbon. */}
            {[0, 0.5].map((offset) => (
              <use
                key={offset}
                href={`#${id}-path`}
                pathLength={1000}
                stroke={`url(#${id}-beam)`}
                strokeWidth="4"
                fill="none"
                strokeLinecap="round"
                strokeDasharray="110 890"
                filter={`url(#${id}-glow)`}
                className="flow-dash"
                style={{
                  animationDuration: `${LOOP_SECONDS}s`,
                  animationDelay: `-${offset * LOOP_SECONDS}s`,
                }}
              />
            ))}
            {/* Particles riding the path at staggered offsets. */}
            {[0, 1.3, 2.6, 4, 5.3, 6.6].map((delay, index) => (
              <circle
                key={delay}
                r={index % 2 === 0 ? 3.5 : 2.2}
                fill="#ffffff"
                filter={`url(#${id}-glow)`}
                opacity={index % 2 === 0 ? 0.95 : 0.7}
              >
                <animateMotion
                  dur={`${LOOP_SECONDS}s`}
                  begin={`-${delay}s`}
                  repeatCount="indefinite"
                  rotate="auto"
                >
                  <mpath href={`#${id}-path`} />
                </animateMotion>
              </circle>
            ))}
          </>
        )}

        {/* Light orbs where each card meets the ribbon. */}
        {CENTRES.map(([x, y], index) => (
          <circle
            key={index}
            cx={x + 34}
            cy={y + 34}
            r={active === index ? 7 : 5}
            fill="#ffffff"
            filter={`url(#${id}-glow)`}
            opacity={active === index ? 1 : 0.75}
            style={{ transition: 'r 400ms ease, opacity 400ms ease' }}
          />
        ))}
      </svg>

      {STAGES.map((stage, index) => {
        const [x, y] = CENTRES[index]!;
        const lit = active === index;
        return (
          <span
            key={stage.label}
            className={cn(
              'absolute flex items-center rounded-[4cqw] border px-[3.6cqw]',
              'h-[16.8cqw] w-[47cqw] gap-[3.6cqw]',
              'bg-[linear-gradient(135deg,rgb(255_255_255_/_0.82),rgb(233_240_255_/_0.56))] backdrop-blur-md',
              'transition-[transform,box-shadow,border-color] duration-500 ease-out',
              lit
                ? 'border-white shadow-[0_22px_44px_rgb(58_92_190_/_0.30),0_0_0_4px_rgb(143_178_255_/_0.35),inset_0_1px_0_rgb(255_255_255_/_0.95)]'
                : 'border-white/80 shadow-[0_16px_32px_rgb(58_92_190_/_0.20),inset_0_1px_0_rgb(255_255_255_/_0.9)]',
              !reduceMotion && 'flow-float',
            )}
            style={{
              left: `${(x / 440) * 100}%`,
              top: `${(y / 620) * 100}%`,
              transform: `translate(-50%, -50%) rotate(6deg) skewX(-4deg) scale(${lit ? 1.05 : 1})`,
              animationDelay: `${index * -1.4}s`,
            }}
          >
            <span
              className={cn(
                'flex size-[9.4cqw] shrink-0 items-center justify-center rounded-[2.4cqw] text-white',
                'shadow-[0_6px_14px_rgb(47_107_242_/_0.35)]',
                stage.tile,
              )}
            >
              <stage.icon className="size-[5cqw]" strokeWidth={2.4} />
            </span>
            <span className="text-[4.4cqw] font-semibold text-[#0e1a4b]">{stage.label}</span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * The same flow as a compact strip, for screens too narrow for the spiral:
 * four chips joined by a line that a pulse of light travels along.
 */
export function WorkflowStrip({ className }: { className?: string }) {
  const reduceMotion = useReducedMotion() ?? false;
  const active = useActiveStage(!reduceMotion);

  return (
    <div aria-hidden="true" className={cn('relative', className)}>
      <span className="absolute inset-x-6 top-1/2 h-[2px] -translate-y-1/2 rounded-full bg-[linear-gradient(90deg,#8fb2ff,#6d7cff,#a78bfa)] opacity-50" />
      {reduceMotion ? null : (
        <span className="flow-strip-pulse absolute top-1/2 h-[3px] w-16 -translate-y-1/2 rounded-full bg-[linear-gradient(90deg,transparent,#ffffff,transparent)] shadow-[0_0_12px_4px_rgb(143_178_255_/_0.7)]" style={{ animationDuration: `${LOOP_SECONDS}s` }} />
      )}
      <ol className="relative m-0 grid list-none grid-cols-4 gap-2 p-0">
        {STAGES.map((stage, index) => {
          const lit = active === index;
          return (
            <li
              key={stage.label}
              className={cn(
                'flex flex-col items-center gap-1.5 rounded-[14px] border px-1.5 py-2.5 text-center',
                'bg-[linear-gradient(135deg,rgb(255_255_255_/_0.86),rgb(233_240_255_/_0.6))] backdrop-blur-md',
                'transition-[transform,box-shadow,border-color] duration-500',
                lit
                  ? 'scale-105 border-white shadow-[0_12px_26px_rgb(58_92_190_/_0.26),0_0_0_3px_rgb(143_178_255_/_0.35)]'
                  : 'border-white/80 shadow-[0_8px_18px_rgb(58_92_190_/_0.16)]',
              )}
            >
              <span
                className={cn(
                  'flex size-8 items-center justify-center rounded-[9px] text-white shadow-[0_4px_10px_rgb(47_107_242_/_0.3)]',
                  stage.tile,
                )}
              >
                <stage.icon className="size-4" strokeWidth={2.4} />
              </span>
              <span className="text-[11px] font-semibold text-[#0e1a4b]">{stage.label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
