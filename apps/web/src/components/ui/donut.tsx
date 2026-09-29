import { TONE_HEX, type Tone } from '@/lib/tone';

export interface DonutSlice {
  label: string;
  count: number;
  tone: Tone;
}

/**
 * Donut.
 *
 * A compact status ring for a register stat band. Purely presentational and
 * `aria-hidden`: the figures it draws are always listed in the legend beside it,
 * so nothing here is the only place a number appears. An empty register draws a
 * single quiet ring rather than nothing, which reads as "counted, and zero"
 * instead of "failed to load".
 */
export function Donut({
  slices,
  size = 72,
  thickness = 12,
}: {
  slices: DonutSlice[];
  size?: number;
  thickness?: number;
}) {
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const total = slices.reduce((sum, slice) => sum + slice.count, 0);

  let offset = 0;
  const arcs = slices
    .filter((slice) => slice.count > 0)
    .map((slice) => {
      const fraction = slice.count / total;
      const length = fraction * circumference;
      const arc = {
        tone: slice.tone,
        dasharray: `${length} ${circumference - length}`,
        dashoffset: -offset,
      };
      offset += length;
      return arc;
    });

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      className="shrink-0 -rotate-90"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--color-surface-subtle)"
        strokeWidth={thickness}
      />
      {total > 0
        ? arcs.map((arc, index) => (
            <circle
              key={index}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={TONE_HEX[arc.tone]}
              strokeWidth={thickness}
              strokeDasharray={arc.dasharray}
              strokeDashoffset={arc.dashoffset}
              strokeLinecap="butt"
            />
          ))
        : null}
    </svg>
  );
}
