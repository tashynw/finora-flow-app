import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { OverviewTone, SliceOut, TrendOut } from './use-overview';

/**
 * Chart colours are literal hex rather than CSS variables: Recharts renders SVG
 * fills and strokes that do not resolve `var(--…)` reliably. The values are the
 * same ones the token file defines, kept in step by hand.
 */
export const TONE_HEX: Record<OverviewTone, string> = {
  neutral: '#8c98ad',
  primary: '#2563eb',
  info: '#06b6d4',
  success: '#059669',
  warning: '#ea580c',
  danger: '#dc2626',
};

const AXIS_TICK = { fontSize: 12, fill: '#66738c' };
const TOOLTIP_STYLE = {
  borderRadius: 12,
  border: '1px solid #e2e8f2',
  boxShadow: '0 10px 30px rgba(30,64,175,.09)',
  fontSize: 13,
} as const;

export function ActivityChart({ data }: { data: TrendOut[] }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id="fill-invoices" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2563eb" stopOpacity={0.32} />
            <stop offset="100%" stopColor="#2563eb" stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="fill-estimates" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.28} />
            <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#e9eef5" vertical={false} />
        <XAxis
          dataKey="label"
          tick={AXIS_TICK}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          allowDecimals={false}
          width={30}
          tick={AXIS_TICK}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Area
          type="monotone"
          dataKey="invoices"
          name="Invoices"
          stroke="#2563eb"
          strokeWidth={2}
          fill="url(#fill-invoices)"
        />
        <Area
          type="monotone"
          dataKey="estimates"
          name="Estimates"
          stroke="#8b5cf6"
          strokeWidth={2}
          fill="url(#fill-estimates)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function StateBars({ data }: { data: SliceOut[] }) {
  const rows = data.map((row) => ({ ...row, fill: TONE_HEX[row.tone] }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart
        data={rows}
        layout="vertical"
        margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
      >
        <CartesianGrid horizontal={false} stroke="#e9eef5" />
        <XAxis
          type="number"
          allowDecimals={false}
          tick={AXIS_TICK}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          type="category"
          dataKey="label"
          width={92}
          tick={{ fontSize: 12, fill: '#24324d' }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip cursor={{ fill: '#f4f7fb' }} contentStyle={TOOLTIP_STYLE} />
        <Bar dataKey="count" radius={[0, 6, 6, 0]} barSize={16}>
          {rows.map((row) => (
            <Cell key={row.label} fill={row.fill} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
