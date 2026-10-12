import { useId, useMemo, useState } from 'react';
import { Link } from '@/lib/app-link';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  ClipboardList,
  Clock3,
  Coins,
  CreditCard,
  FileText,
  HeartPulse,
  ListChecks,
  Mail,
  Package,
  Receipt,
  Send,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatRelative } from '@/lib/dates';
import { formatMoney, formatMoneyCompact } from '@/lib/money';
import { Skeleton } from '@/components/ui/skeleton';
import { waitedFor } from '@/features/approvals/approval-vocabulary';
import { useAuth } from '@/features/auth/auth-context';
import { DEPENDENCY_INFO, useHealth } from '@/features/operations/use-health';
import { useWorkDashboard, type WorkItemOut } from '@/features/work/use-work';
import {
  useOverview,
  type ActivityOut,
  type MonthlySpendOut,
  type OverviewOut,
  type SpendCardOut,
  type VendorSpendOut,
} from './use-overview';

/* ----------------------------------------------------------------- shared */

const PANEL =
  'rounded-[18px] border border-[rgb(226_233_248_/_0.95)] bg-white/80 shadow-[0_10px_30px_rgb(70_100_180_/_0.08)] backdrop-blur-xl';

function IconTile({
  icon: Icon,
  className,
}: {
  icon: LucideIcon;
  className: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn('flex size-10 shrink-0 items-center justify-center rounded-[12px]', className)}
    >
      <Icon className="size-5" strokeWidth={2.2} />
    </span>
  );
}

function PanelTitle({
  icon,
  tile,
  title,
  subtitle,
  id,
  aside,
}: {
  icon: LucideIcon;
  tile: string;
  title: string;
  subtitle?: string;
  id: string;
  aside?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <IconTile icon={icon} className={tile} />
        <div className="min-w-0">
          <h2 id={id} className="m-0 text-[16px] font-semibold text-[var(--color-text-heading)]">
            {title}
          </h2>
          {subtitle ? (
            <p className="m-0 mt-0.5 text-[12px] text-[var(--color-text-muted)]">{subtitle}</p>
          ) : null}
        </div>
      </div>
      {aside ? <div className="flex flex-wrap items-center gap-2">{aside}</div> : null}
    </div>
  );
}

/** A quiet dropdown in the pill style of the reference board. */
function PillSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      className={cn(
        'h-8 shrink-0 cursor-pointer rounded-[9px] border border-[var(--color-border)] bg-white/90 pl-2 pr-1',
        'text-[12px] font-medium text-[#3b4868]',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary-600)]',
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** A non-interactive pill that says which period a figure covers. */
function PeriodPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-8 items-center rounded-[9px] border border-[var(--color-border)] bg-white/90 px-2.5 text-[12px] font-medium text-[#3b4868]">
      {children}
    </span>
  );
}

function ViewAll({ to, label = 'View all' }: { to: string; label?: string }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 text-[13px] font-semibold text-[var(--color-primary-600)] no-underline hover:underline"
    >
      {label}
      <ArrowRight aria-hidden="true" className="size-3.5" />
    </Link>
  );
}

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/* ------------------------------------------------------------- priorities */

function Priorities({
  counts,
  overview,
  isLoading,
}: {
  counts: Record<string, number>;
  overview: OverviewOut | undefined;
  isLoading: boolean;
}) {
  const approvals = counts.approval ?? 0;
  const receipts = counts.sign_off ?? 0;
  const packages = overview?.kpis.find((kpi) => kpi.key === 'open_packages')?.value ?? 0;
  const blockers =
    overview?.invoice_states.find((slice) => slice.label === 'Exception')?.count ?? 0;

  const tiles: {
    icon: LucideIcon;
    tile: string;
    count: number;
    label: [string, string];
    to: string;
  }[] = [
    {
      icon: ClipboardCheck,
      tile: 'bg-[#e6eeff] text-[#3569f4]',
      count: approvals,
      label: ['Review', 'approvals'],
      to: '/approvals',
    },
    {
      icon: Receipt,
      tile: 'bg-[#e3f7ec] text-[#16a66a]',
      count: receipts,
      label: ['Confirm', 'receipts'],
      to: '/invoices',
    },
    {
      icon: Send,
      tile: 'bg-[#efe8ff] text-[#7c3aed]',
      count: packages,
      label: ['Submit', packages === 1 ? 'package' : 'packages'],
      to: '/payments',
    },
    {
      icon: AlertTriangle,
      tile: 'bg-[#fff0e3] text-[#e06a2c]',
      count: blockers,
      label: ['View', 'blockers'],
      to: '/invoices',
    },
  ];

  const summary = [
    `${approvals} approval${approvals === 1 ? '' : 's'} waiting`,
    `${receipts} invoice${receipts === 1 ? ' needs' : 's need'} receipt confirmation`,
    `${packages} payment package${packages === 1 ? '' : 's'} being assembled`,
  ].join(' · ');

  return (
    <section aria-labelledby="priorities-heading" className={cn(PANEL, 'w-full p-4 xl:w-[440px]')}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex size-8 items-center justify-center rounded-[9px] bg-[#e6eeff] text-[#3569f4]"
          >
            <CalendarDays className="size-4" />
          </span>
          <h2
            id="priorities-heading"
            className="m-0 text-[15px] font-semibold text-[var(--color-text-heading)]"
          >
            Today&rsquo;s priorities
          </h2>
        </div>
        <ViewAll to="/work" />
      </div>
      <p className="m-0 mt-2 line-clamp-2 text-[12px] text-[var(--color-text-muted)]">
        {isLoading ? 'Checking what is waiting on you.' : summary}
      </p>
      <ul className="m-0 mt-3 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-4">
        {tiles.map((tile) => (
          <li key={tile.label.join(' ')}>
            <Link
              to={tile.to}
              className="group flex h-full items-start gap-2 rounded-[12px] border border-[var(--color-border)] bg-white/85 p-2.5 no-underline transition-colors hover:border-[var(--color-primary-200)]"
            >
              <span
                aria-hidden="true"
                className={cn('flex size-7 shrink-0 items-center justify-center rounded-[8px]', tile.tile)}
              >
                <tile.icon className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between">
                  <span className="text-[17px] font-bold leading-none tabular text-[var(--color-text-heading)]">
                    {tile.count}
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-[var(--color-text-subtle)] transition-transform group-hover:translate-x-0.5"
                  />
                </span>
                <span className="mt-1 block text-[11px] leading-tight text-[var(--color-text-muted)]">
                  {tile.label[0]} {tile.label[1]}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------- stat cards */

type Period = 'month' | 'all';

const CARD_STYLE: Record<
  string,
  { icon: LucideIcon; tile: string; stroke: string; fill: string }
> = {
  total_spend: {
    icon: Coins,
    tile: 'bg-[#e6eeff] text-[#3569f4]',
    stroke: '#3569f4',
    fill: 'rgb(53 105 244 / 0.18)',
  },
  approved_amount: {
    icon: CheckCircle2,
    tile: 'bg-[#e3f7ec] text-[#16a66a]',
    stroke: '#16a66a',
    fill: 'rgb(22 166 106 / 0.16)',
  },
  pending_approvals: {
    icon: Clock3,
    tile: 'bg-[#fff0e3] text-[#e06a2c]',
    stroke: '#f08a3c',
    fill: 'rgb(240 138 60 / 0.16)',
  },
  open_items: {
    icon: ClipboardList,
    tile: 'bg-[#efe8ff] text-[#7c3aed]',
    stroke: '#8b6cf0',
    fill: 'rgb(139 108 240 / 0.18)',
  },
};

function Sparkline({
  values,
  stroke,
  fill,
  label,
}: {
  values: number[];
  stroke: string;
  fill: string;
  label: string;
}) {
  const gradientId = useId();
  if (values.length < 2 || values.every((value) => value === 0)) return null;
  const width = 120;
  const height = 44;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const points = values.map((value, index) => [
    (index / (values.length - 1)) * width,
    height - 4 - ((value - min) / span) * (height - 10),
  ]);
  const line = points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${height}`}
      className="h-11 w-[120px] overflow-visible"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={fill} stopOpacity={1} />
          <stop offset="100%" stopColor={fill} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function MiniBars({ values, color, label }: { values: number[]; color: string; label: string }) {
  const max = Math.max(1, ...values);
  if (values.every((value) => value === 0)) return null;
  return (
    <span role="img" aria-label={label} className="flex h-11 items-end gap-[5px]">
      {values.map((value, index) => (
        <span
          key={index}
          className="w-[5px] rounded-full"
          style={{
            height: `${Math.max(12, Math.round((value / max) * 100))}%`,
            backgroundColor: color,
            opacity: 0.35 + (value / max) * 0.65,
          }}
        />
      ))}
    </span>
  );
}

function StatCard({
  card,
  openCount,
  kindCounts,
}: {
  card: SpendCardOut;
  openCount: number;
  kindCounts: number[];
}) {
  const style = CARD_STYLE[card.key] ?? CARD_STYLE.total_spend!;
  const hasPeriods = card.month_money !== null;
  const [period, setPeriod] = useState<Period>(
    hasPeriods && (card.month_money?.minor_units ?? 0) > 0 ? 'month' : 'all',
  );

  const money = period === 'month' && card.month_money ? card.month_money : card.money;
  const value = money ? money.formatted : String(card.count ?? 0);
  const [currency, ...amountParts] = value.split(' ');
  const amount = amountParts.join(' ');

  let meta: React.ReactNode;
  if (period === 'month' && hasPeriods) {
    const previous = card.previous_money?.formatted;
    meta =
      card.delta_pct !== null ? (
        <>
          <span
            className={cn(
              'font-semibold',
              card.delta_pct >= 0 ? 'text-[#16a66a]' : 'text-[#dc2626]',
            )}
          >
            {card.delta_pct >= 0 ? '▲' : '▼'} {Math.abs(card.delta_pct)}%
          </span>{' '}
          vs. last month{previous ? ` (${previous})` : ''}
        </>
      ) : (
        <>Nothing recorded last month</>
      );
  } else if (card.key === 'pending_approvals') {
    meta = `across ${openCount} item${openCount === 1 ? '' : 's'}`;
  } else if (card.key === 'open_items') {
    meta = 'Require attention';
  } else {
    meta = card.hint;
  }

  return (
    <li className={cn(PANEL, 'flex min-h-[132px] flex-col justify-between p-4')}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <IconTile icon={style.icon} className={style.tile} />
          <span className="text-[14px] font-semibold leading-tight text-[var(--color-text-heading)]">
            {card.label}
          </span>
        </div>
        {hasPeriods ? (
          <PillSelect<Period>
            label={`${card.label} period`}
            value={period}
            onChange={setPeriod}
            options={[
              { value: 'month', label: 'This month' },
              { value: 'all', label: 'All time' },
            ]}
          />
        ) : (
          <PeriodPill>{card.key === 'open_items' ? 'All queues' : 'Now'}</PeriodPill>
        )}
      </div>
      <p className="m-0 mt-3 whitespace-nowrap text-[24px] font-bold leading-none tabular text-[var(--color-text-heading)]">
        {money ? (
          <>
            <span className="text-[18px]">{currency}</span> {amount}
          </>
        ) : (
          value
        )}
      </p>
      <div className="mt-1 flex items-end justify-between gap-3">
        <p className="m-0 min-w-0 pb-1 text-[12px] leading-snug text-[var(--color-text-muted)]">{meta}</p>
        {card.series.length > 1 ? (
          <Sparkline
            values={card.series}
            stroke={style.stroke}
            fill={style.fill}
            label={`${card.label}, one point per month`}
          />
        ) : card.key === 'open_items' ? (
          <MiniBars values={kindCounts} color={style.stroke} label="Open items by kind of work" />
        ) : null}
      </div>
    </li>
  );
}

/* ---------------------------------------------------------- spend activity */

const SOURCES = [
  { key: 'invoices', label: 'Invoices', color: '#3569f4' },
  { key: 'purchase_orders', label: 'Purchase orders', color: '#a78bfa' },
  { key: 'credit_cards', label: 'Credit cards', color: '#4fd6ee' },
  { key: 'accruals', label: 'Accruals', color: '#c7b8fb' },
] as const;

type SourceKey = (typeof SOURCES)[number]['key'];

function SpendActivity({
  data,
  currency,
  months,
  onMonths,
}: {
  data: MonthlySpendOut[];
  currency: string;
  months: number;
  onMonths: (months: number) => void;
}) {
  const [source, setSource] = useState<'all' | SourceKey>('all');
  const shown = source === 'all' ? SOURCES : SOURCES.filter((entry) => entry.key === source);
  const rows = data.map((row) => ({ ...row, label: row.label.replace(/ (\d{4})$/, ' $1') }));
  const compact = (minor: number) => formatMoneyCompact({ minorUnits: minor, currency });

  return (
    <section aria-labelledby="spend-heading" className={cn(PANEL, 'min-w-0 p-5')}>
      <PanelTitle
        id="spend-heading"
        icon={BarChart3}
        tile="bg-[#e6eeff] text-[#3569f4]"
        title="Spend activity"
        subtitle={`Total spend across all payment types (${currency})`}
        aside={
          <>
            <PillSelect
              label="Months shown"
              value={String(months)}
              onChange={(value) => onMonths(Number(value))}
              options={[
                { value: '6', label: 'Last 6 months' },
                { value: '12', label: 'Last 12 months' },
              ]}
            />
            <PillSelect<'all' | SourceKey>
              label="Payment type"
              value={source}
              onChange={setSource}
              options={[
                { value: 'all', label: 'All payment types' },
                ...SOURCES.map((entry) => ({ value: entry.key, label: entry.label })),
              ]}
            />
          </>
        }
      />
      <div className="mt-4 h-[236px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 8, left: 8, bottom: 0 }} barCategoryGap="34%">
            <CartesianGrid vertical={false} stroke="#e8edf7" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: '#6b7898' }}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={72}
              tick={{ fontSize: 11, fill: '#6b7898' }}
              tickFormatter={(value: number) => compact(value)}
            />
            <Tooltip
              cursor={{ fill: 'rgb(53 105 244 / 0.06)' }}
              contentStyle={{
                borderRadius: 12,
                border: '1px solid #e2e8f5',
                boxShadow: '0 12px 30px rgb(70 100 180 / 0.14)',
                fontSize: 12,
              }}
              formatter={(value: number, name: string) => [
                formatMoney({ minorUnits: value, currency }),
                SOURCES.find((entry) => entry.key === name)?.label ?? name,
              ]}
            />
            {shown.map((entry, index) => (
              <Bar
                key={entry.key}
                dataKey={entry.key}
                stackId="spend"
                fill={entry.color}
                radius={index === shown.length - 1 ? [6, 6, 0, 0] : [0, 0, 0, 0]}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ul className="m-0 mt-2 flex list-none flex-wrap justify-center gap-x-5 gap-y-1 p-0">
        {SOURCES.map((entry) => (
          <li key={entry.key} className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">
            <span aria-hidden="true" className="size-2.5 rounded-[3px]" style={{ backgroundColor: entry.color }} />
            {entry.label}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------ top vendors */

function TopVendors({
  vendors,
  approvedMinor,
  canSeeVendors,
}: {
  vendors: VendorSpendOut[];
  approvedMinor: number;
  canSeeVendors: boolean;
}) {
  return (
    <section aria-labelledby="vendors-heading" className={cn(PANEL, 'flex min-w-0 flex-col p-5')}>
      <PanelTitle
        id="vendors-heading"
        icon={Building2}
        tile="bg-[#e6eeff] text-[#3569f4]"
        title="Top vendors by spend"
        aside={<PeriodPill>All time</PeriodPill>}
      />
      {vendors.length === 0 ? (
        <p className="m-0 mt-6 text-[13px] text-[var(--color-text-muted)]">No approved spend yet.</p>
      ) : (
        <ul className="m-0 mt-5 flex list-none flex-col gap-4 p-0">
          {vendors.slice(0, 5).map((vendor) => {
            const pct =
              approvedMinor > 0 ? Math.round((vendor.money.minor_units / approvedMinor) * 100) : 0;
            return (
              <li key={vendor.name} className="grid grid-cols-[minmax(0,1.3fr)_auto_minmax(0,1fr)_2.5rem] items-center gap-3">
                <span className="truncate text-[13px] text-[#3b4868]">{vendor.name}</span>
                <span className="text-[13px] font-semibold tabular text-[var(--color-text-heading)]">
                  {vendor.money.formatted}
                </span>
                <span className="relative h-2 overflow-hidden rounded-full bg-[#e8eefb]">
                  <span
                    className="absolute inset-y-0 left-0 rounded-full bg-[linear-gradient(90deg,#3569f4,#5b7cfa)]"
                    style={{ width: `${Math.max(pct, 3)}%` }}
                  />
                </span>
                <span className="text-right text-[12px] tabular text-[var(--color-text-muted)]">{pct}%</span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="m-0 mt-3 text-[11px] text-[var(--color-text-subtle)]">Share of approved spend.</p>
      {canSeeVendors ? (
        <Link
          to="/settings/reference"
          className="mt-auto flex h-10 items-center justify-center gap-1.5 rounded-[12px] border border-[var(--color-primary-100)] bg-[#f3f7ff] text-[13px] font-semibold text-[var(--color-primary-600)] no-underline hover:bg-[#e9f0ff]"
        >
          View all vendors
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------- work queue */

const RECORD_TYPE: { prefix: string; label: string; tab: string; icon: LucideIcon; tile: string }[] = [
  { prefix: '/invoices', label: 'Invoice', tab: 'Invoices', icon: FileText, tile: 'bg-[#e6eeff] text-[#3569f4]' },
  { prefix: '/purchase-orders', label: 'Purchase order', tab: 'POs', icon: Package, tile: 'bg-[#e3f7ec] text-[#16a66a]' },
  { prefix: '/estimates', label: 'Estimate', tab: 'Estimates', icon: ClipboardList, tile: 'bg-[#efe8ff] text-[#7c3aed]' },
  { prefix: '/vendor-confirmations', label: 'Vendor confirmation', tab: 'Vendor conf.', icon: ShieldCheck, tile: 'bg-[#fff0e3] text-[#e06a2c]' },
  { prefix: '/payments', label: 'Payment package', tab: 'Packages', icon: CreditCard, tile: 'bg-[#e6f9fc] text-[#0891b2]' },
  { prefix: '/documents', label: 'Document', tab: 'Documents', icon: FileText, tile: 'bg-[#f2f4f7] text-[#475467]' },
  { prefix: '/intake', label: 'Message', tab: 'Inbox', icon: Mail, tile: 'bg-[#f2f4f7] text-[#475467]' },
];

function recordType(item: WorkItemOut) {
  return RECORD_TYPE.find((entry) => item.record_path.startsWith(entry.prefix)) ?? RECORD_TYPE[0]!;
}

const KIND_PILL: Record<string, string> = {
  approval: 'bg-[#e6eeff] text-[#2449b8]',
  sign_off: 'bg-[#fff4e5] text-[#b45309]',
  document_review: 'bg-[#efe8ff] text-[#6d28d9]',
  vendor_review: 'bg-[#fff4e5] text-[#b45309]',
  intake: 'bg-[#f2f4f7] text-[#475467]',
};

function WorkQueue({ items, total }: { items: WorkItemOut[]; total: number }) {
  const [tab, setTab] = useState('all');
  const tabs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const type = recordType(item);
      counts.set(type.prefix, (counts.get(type.prefix) ?? 0) + 1);
    }
    return RECORD_TYPE.filter((entry) => counts.has(entry.prefix)).map((entry) => ({
      id: entry.prefix,
      label: entry.tab,
      count: counts.get(entry.prefix) ?? 0,
    }));
  }, [items]);

  const shown = tab === 'all' ? items : items.filter((item) => recordType(item).prefix === tab);

  return (
    <section aria-labelledby="queue-heading" className={cn(PANEL, 'min-w-0 p-5')}>
      <PanelTitle
        id="queue-heading"
        icon={ListChecks}
        tile="bg-[#e6eeff] text-[#3569f4]"
        title="My work queue"
        aside={<ViewAll to="/work" />}
      />
      <div role="group" aria-label="Filter by record type" className="mt-4 flex flex-wrap gap-1.5">
        {[{ id: 'all', label: 'All items', count: total }, ...tabs].map((entry) => {
          const active = tab === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              aria-pressed={active}
              onClick={() => setTab(entry.id)}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-[9px] px-3 text-[12px] font-medium transition-colors',
                active
                  ? 'bg-[#3569f4] text-white'
                  : 'border border-[var(--color-border)] bg-white/85 text-[#3b4868] hover:border-[var(--color-primary-200)]',
              )}
            >
              {entry.label}
              <span
                className={cn(
                  'rounded-full px-1.5 text-[11px] tabular',
                  active ? 'bg-white/25 text-white' : 'bg-[#eef2f8] text-[#5b6a92]',
                )}
              >
                {entry.count}
              </span>
            </button>
          );
        })}
      </div>

      {shown.length === 0 ? (
        <p className="m-0 mt-6 text-[13px] text-[var(--color-text-muted)]">
          Nothing is waiting on you right now.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-[12px]" aria-label="Work waiting on you">
            <thead>
              <tr className="text-left text-[11px] font-medium text-[var(--color-text-muted)]">
                <th scope="col" className="py-2 pr-3 font-medium">Type</th>
                <th scope="col" className="py-2 pr-3 font-medium">Item / Description</th>
                <th scope="col" className="hidden py-2 pr-3 font-medium 2xl:table-cell">Vendor</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Amount</th>
                <th scope="col" className="py-2 pr-3 font-medium">Status</th>
                <th scope="col" className="py-2 font-medium">Waiting</th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 6).map((item) => {
                const type = recordType(item);
                const waited = waitedFor(item.waiting_hours);
                return (
                  <tr key={`${item.kind}:${item.record_id}`} className="relative border-t border-[var(--color-divider)] hover:bg-[#f7f9ff]">
                    <td className="py-2.5 pr-3">
                      <span className="flex items-center gap-2">
                        <span aria-hidden="true" className={cn('flex size-7 items-center justify-center rounded-[8px]', type.tile)}>
                          <type.icon className="size-3.5" />
                        </span>
                        <span className="whitespace-nowrap text-[#3b4868]">{type.label}</span>
                      </span>
                    </td>
                    <td className="py-2.5 pr-3">
                      <Link
                        to={item.record_path}
                        className="block font-semibold text-[var(--color-text-heading)] no-underline after:absolute after:inset-0 after:content-[''] hover:underline"
                      >
                        {item.reference}
                      </Link>
                      <span className="block max-w-[180px] truncate text-[11px] text-[var(--color-text-muted)]">
                        {item.subtitle}
                      </span>
                    </td>
                    <td className="hidden max-w-[160px] truncate py-2.5 pr-3 text-[#3b4868] 2xl:table-cell">
                      {item.title}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-3 text-right tabular text-[var(--color-text-heading)]">
                      {item.amount_formatted ?? '—'}
                    </td>
                    <td className="py-2.5 pr-3">
                      <span
                        className={cn(
                          'inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 text-[11px] font-medium',
                          KIND_PILL[item.kind] ?? KIND_PILL.intake,
                        )}
                      >
                        {item.kind_label}
                      </span>
                    </td>
                    <td
                      className={cn(
                        'whitespace-nowrap py-2.5 text-[12px]',
                        waited.tone === 'danger'
                          ? 'font-semibold text-[#dc2626]'
                          : waited.tone === 'warning'
                            ? 'text-[#b45309]'
                            : 'text-[var(--color-text-muted)]',
                      )}
                    >
                      {waited.label.replace('Waiting ', '')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* --------------------------------------------------------- recent activity */

function RecentActivity({ entries, canAudit }: { entries: ActivityOut[]; canAudit: boolean }) {
  return (
    <section aria-labelledby="activity-heading" className={cn(PANEL, 'min-w-0 p-5')}>
      <PanelTitle
        id="activity-heading"
        icon={ListChecks}
        tile="bg-[#e6eeff] text-[#3569f4]"
        title="Recent activity"
        aside={canAudit ? <ViewAll to="/audit" /> : undefined}
      />
      {entries.length === 0 ? (
        <p className="m-0 mt-6 text-[13px] text-[var(--color-text-muted)]">Nothing recorded yet.</p>
      ) : (
        <ol className="relative m-0 mt-4 list-none p-0">
          <span aria-hidden="true" className="absolute bottom-3 left-[13px] top-3 w-px bg-[var(--color-divider)]" />
          {entries.slice(0, 6).map((entry) => {
            const done = entry.tone === 'success' || entry.tone === 'info';
            return (
              <li key={`${entry.kind}:${entry.reference}`} className="relative flex gap-3 py-2">
                <span
                  aria-hidden="true"
                  className={cn(
                    'relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-white',
                    done ? 'bg-[#16a66a] text-white' : 'bg-[#e6eeff] text-[#3569f4]',
                  )}
                >
                  {done ? <CheckCircle2 className="size-3.5" /> : <FileText className="size-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-[var(--color-text-heading)]">
                    {entry.kind_label} {entry.state_label.toLowerCase()}
                  </span>
                  <span className="block truncate text-[11px] text-[var(--color-text-muted)]">
                    {entry.reference} · {entry.title}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  {entry.amount_formatted ? (
                    <span className="block text-[12px] font-semibold tabular text-[var(--color-text-heading)]">
                      {entry.amount_formatted}
                    </span>
                  ) : null}
                  <span className="block text-[11px] text-[var(--color-text-subtle)]">
                    {formatRelative(entry.when)}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/* ----------------------------------------------------------- system health */

const DEPENDENCY_STATE: Record<string, { label: string; className: string }> = {
  up: { label: 'Operational', className: 'text-[#16a66a]' },
  degraded: { label: 'Degraded', className: 'text-[#b45309]' },
  down: { label: 'Down', className: 'text-[#dc2626]' },
  not_configured: { label: 'Not configured', className: 'text-[var(--color-text-subtle)]' },
};

function SystemHealth({ canOperate }: { canOperate: boolean }) {
  const health = useHealth();
  const dependencies = health.data?.dependencies ?? [];
  const troubled = dependencies.filter((dependency) => dependency.state === 'down' || dependency.state === 'degraded');
  const checked = health.dataUpdatedAt ? new Date(health.dataUpdatedAt).toISOString() : null;

  return (
    <section aria-labelledby="health-heading" className={cn(PANEL, 'flex min-w-0 flex-col p-5')}>
      <PanelTitle
        id="health-heading"
        icon={HeartPulse}
        tile="bg-[#e6eeff] text-[#3569f4]"
        title="System health"
        aside={
          canOperate ? (
            <Link to="/operations" aria-label="Open operational health" className="text-[var(--color-text-subtle)] hover:text-[var(--color-text-strong)]">
              <ChevronRight aria-hidden="true" className="size-5" />
            </Link>
          ) : undefined
        }
      />
      {health.isLoading ? (
        <Skeleton className="mt-4 h-40 rounded-[12px]" />
      ) : (
        <ul className="m-0 mt-4 flex list-none flex-col gap-2.5 p-0">
          {dependencies.map((dependency) => {
            const state = DEPENDENCY_STATE[dependency.state] ?? DEPENDENCY_STATE.not_configured!;
            const ok = dependency.state === 'up';
            return (
              <li key={dependency.name} className="flex items-center gap-2.5 text-[13px]">
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center rounded-full',
                    ok ? 'bg-[#16a66a] text-white' : 'bg-[#e5e7eb] text-[#667085]',
                  )}
                >
                  <CheckCircle2 className="size-3" />
                </span>
                <span className="min-w-0 flex-1 truncate text-[#3b4868]">
                  {DEPENDENCY_INFO[dependency.name]?.label ?? dependency.name}
                </span>
                <span className={cn('shrink-0 text-[12px] font-medium', state.className)}>
                  {state.label}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {health.data ? (
        <div
          className={cn(
            'mt-auto flex items-center gap-3 rounded-[12px] px-3 py-2.5',
            troubled.length === 0 ? 'bg-[#e8f8ef]' : 'bg-[#fff4e5]',
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'flex size-7 items-center justify-center rounded-full text-white',
              troubled.length === 0 ? 'bg-[#16a66a]' : 'bg-[#e06a2c]',
            )}
          >
            {troubled.length === 0 ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold text-[var(--color-text-heading)]">
              {troubled.length === 0
                ? 'All systems operational'
                : `${troubled.length} service${troubled.length === 1 ? '' : 's'} need attention`}
            </span>
            {checked ? (
              <span className="block text-[11px] text-[var(--color-text-muted)]">
                Last checked {formatRelative(checked)}
              </span>
            ) : null}
          </span>
        </div>
      ) : null}
    </section>
  );
}

/* --------------------------------------------------------------- the page */

/**
 * Dashboard.
 *
 * Today's priorities, the spend headlines with honest month-over-month
 * deltas and sparklines, spend by payment type, top vendors, the work waiting
 * on this person, recent activity and service health. Every figure is counted
 * or summed from live records and can be reached by opening the register
 * behind it. People without reporting access see their queue and health only.
 */
export function DashboardPage() {
  const { user, can } = useAuth();
  const [months, setMonths] = useState(6);
  const work = useWorkDashboard(20);

  const canReport = user ? new Set(user.permissions).has('report:view') : false;
  const overview = useOverview(canReport, months);

  if (!user) return null;

  const firstName = user.display_name.split(' ')[0] ?? user.display_name;
  const metrics = overview.data;
  const counts = work.data?.counts_by_kind ?? {};
  const items = work.data?.items ?? [];
  const approvedMinor =
    metrics?.spend_cards.find((card) => card.key === 'approved_amount')?.money?.minor_units ?? 0;
  const openCount = metrics?.spend_cards.find((card) => card.key === 'open_items')?.count ?? 0;
  const kindCounts = ['approval', 'sign_off', 'document_review', 'vendor_review', 'intake'].map(
    (kind) => counts[kind] ?? 0,
  );

  const today = new Date();
  const dateLine = today.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0 pt-2">
          <p className="m-0 text-[14px] font-medium text-[#4a5a86]">{dateLine}</p>
          <h1 className="mt-1 text-[38px] font-bold leading-tight tracking-[-0.02em] text-[#0e1a4b]">
            {greeting(today)}, {firstName}
          </h1>
          <p className="mt-1 m-0 text-[15px] text-[#5b6a92]">
            Here&rsquo;s what&rsquo;s happening across your finance operations today.
          </p>
        </div>
        {canReport ? (
          <Priorities counts={counts} overview={metrics} isLoading={work.isLoading || overview.isLoading} />
        ) : null}
      </section>

      {canReport ? (
        <>
          <section aria-label="Key figures">
            {overview.isLoading && !metrics ? (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {Array.from({ length: 4 }, (_, index) => (
                  <Skeleton key={index} className="h-[132px] rounded-[18px]" />
                ))}
              </div>
            ) : metrics ? (
              <ul className="m-0 grid list-none gap-4 p-0 sm:grid-cols-2 xl:grid-cols-4">
                {metrics.spend_cards.map((card) => (
                  <StatCard key={card.key} card={card} openCount={openCount} kindCounts={kindCounts} />
                ))}
              </ul>
            ) : null}
          </section>

          {metrics ? (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)]">
              <SpendActivity
                data={metrics.monthly_spend}
                currency={metrics.primary_currency}
                months={months}
                onMonths={setMonths}
              />
              <TopVendors
                vendors={metrics.top_vendors}
                approvedMinor={approvedMinor}
                canSeeVendors={can('admin:reference_data')}
              />
            </div>
          ) : null}
        </>
      ) : null}

      <div
        className={cn(
          'grid gap-4',
          canReport
            ? 'xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1.05fr)_minmax(0,0.85fr)]'
            : 'xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]',
        )}
      >
        {work.isLoading ? (
          <Skeleton className="h-[320px] rounded-[18px]" />
        ) : (
          <WorkQueue items={items} total={work.data?.total ?? 0} />
        )}
        {canReport && metrics ? (
          <RecentActivity entries={metrics.recent_activity} canAudit={can('audit:view')} />
        ) : null}
        <SystemHealth canOperate={can('operations:view')} />
      </div>
    </div>
  );
}
