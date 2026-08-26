import type { ComponentType } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  CalendarClock,
  CheckCheck,
  FileStack,
  Inbox,
  PackageOpen,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Wallet,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { NumberTicker } from '@/components/ui/number-ticker';
import { BorderBeam } from '@/components/ui/border-beam';
import { Reveal } from '@/components/ui/reveal';
import { ShinyText } from '@/components/ui/shiny-text';
import { Skeleton } from '@/components/ui/skeleton';
import { waitedFor } from '@/features/approvals/approval-vocabulary';
import { PageHeader } from '@/features/shared/page-header';
import { useAuth } from '@/features/auth/auth-context';
import { useHealth } from '@/features/operations/use-health';
import { useWorkDashboard } from '@/features/work/use-work';
import { visibleGroups } from '@/layouts/navigation';
import { ActivityChart, StateBars, TONE_HEX } from './overview-charts';
import {
  useOverview,
  type KpiOut,
  type OverviewOut,
  type OverviewTone,
  type SliceOut,
} from './use-overview';

type IconType = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;

const KPI_ICON: Record<string, IconType> = {
  awaiting_decision: Inbox,
  payable: Wallet,
  settled: CheckCheck,
  open_po: FileStack,
  open_packages: PackageOpen,
  open_periods: CalendarClock,
};

const ROLE_PURPOSE: Record<string, string> = {
  requester:
    'Raise estimates and confirm that goods or services were received before payment.',
  approver: 'Review and decide on estimates and invoices routed to you.',
  payment_coordinator:
    'Assemble payment packages, submit them and track vendor confirmations.',
  finance:
    'Validate invoices, code transactions, reconcile credit cards and prepare accruals.',
  administrator:
    'Configure users, roles, approval routing, thresholds and reference data.',
  operations: 'Monitor intake, retry failures and keep the pipeline healthy.',
  auditor: 'Read the complete record of decisions without changing anything.',
};

const KPI_ACCENT: Record<OverviewTone, { bar: string; value: string }> = {
  neutral: { bar: 'var(--color-border-strong)', value: 'var(--color-text-strong)' },
  primary: { bar: 'var(--gradient-signature)', value: 'var(--color-primary-700)' },
  info: { bar: 'var(--color-cyan-500)', value: 'var(--color-info-600)' },
  success: { bar: 'var(--color-success-600)', value: 'var(--color-success-700)' },
  warning: { bar: 'var(--color-warning-600)', value: 'var(--color-warning-700)' },
  danger: { bar: 'var(--color-danger-600)', value: 'var(--color-danger-700)' },
};

function KpiCard({ kpi }: { kpi: KpiOut }) {
  const accent = KPI_ACCENT[kpi.tone];
  const isMoney = kpi.money !== null;
  const Icon = KPI_ICON[kpi.key] ?? Sparkles;
  const chipColor = TONE_HEX[kpi.tone];
  return (
    <Card className="motion-card-hover relative h-full overflow-hidden">
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-1"
        style={{ background: accent.bar }}
      />
      <CardContent className="flex flex-col gap-[var(--space-2)] pl-[var(--space-6)]">
        <div className="flex items-start justify-between gap-[var(--space-3)]">
          <span className="text-[length:var(--text-overline)] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
            {kpi.label}
          </span>
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-md)]"
            style={{ backgroundColor: `${chipColor}1f`, color: chipColor }}
          >
            <Icon className="size-[18px]" />
          </span>
        </div>
        {isMoney ? (
          <>
            <span className="text-[length:var(--text-money-lg)] font-bold tabular-nums text-[var(--color-text-strong)]">
              {kpi.money?.formatted}
            </span>
            <span className="text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
              <NumberTicker value={kpi.value} className="font-semibold" />{' '}
              {kpi.value === 1 ? 'record' : 'records'}
            </span>
          </>
        ) : (
          <>
            <span
              className="text-[length:var(--text-money-lg)] font-bold"
              style={{ color: accent.value }}
            >
              <NumberTicker value={kpi.value} />
            </span>
            <span className="text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
              {kpi.hint}
            </span>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AgingRow({ row, max }: { row: SliceOut; max: number }) {
  const width = max > 0 ? Math.round((row.count / max) * 100) : 0;
  const accent = KPI_ACCENT[row.tone];
  return (
    <li className="flex items-center gap-[var(--space-3)]">
      <span className="w-32 shrink-0 text-[var(--text-body-sm)] text-[var(--color-text)]">
        {row.label}
      </span>
      <span className="relative h-2 flex-1 overflow-hidden rounded-[var(--radius-pill)] bg-[var(--color-surface-subtle)]">
        <span
          className="absolute inset-y-0 left-0 rounded-[var(--radius-pill)]"
          style={{ width: `${width}%`, background: accent.value }}
        />
      </span>
      <span className="w-8 shrink-0 text-right text-[var(--text-body-sm)] font-semibold tabular-nums text-[var(--color-text-strong)]">
        <NumberTicker value={row.count} />
      </span>
    </li>
  );
}

function insightSentence(overview: OverviewOut): string {
  const overdue = overview.aging.find((row) => row.label === 'Overdue')?.count ?? 0;
  const awaiting =
    overview.kpis.find((kpi) => kpi.key === 'awaiting_decision')?.value ?? 0;
  const payable = overview.kpis.find((kpi) => kpi.key === 'payable');

  if (overdue > 0) {
    return `${overdue} invoice${overdue === 1 ? ' is' : 's are'} past due${
      payable?.money ? `, of ${payable.money.formatted} outstanding` : ''
    }. Clear these first.`;
  }
  if (awaiting > 0) {
    return `${awaiting} record${
      awaiting === 1 ? ' is' : 's are'
    } waiting on a decision. Nothing is overdue.`;
  }
  return 'Nothing overdue and nothing waiting — the ledger is current.';
}

/**
 * Dashboard.
 *
 * An executive overview built entirely from live aggregates: KPI band, six-month
 * activity, invoice state mix and payment aging, then the caller's own next
 * actions, platform health and access. Every figure can be reached by opening the
 * register behind it — nothing here is projected or invented.
 */
export function DashboardPage() {
  const { user } = useAuth();
  const { data: health } = useHealth();
  const work = useWorkDashboard(5);

  const canReport = user ? new Set(user.permissions).has('report:view') : false;
  const overview = useOverview(canReport);

  if (!user) return null;

  const permissions = new Set(user.permissions);
  const groups = visibleGroups(permissions);
  const firstName = user.display_name.split(' ')[0] ?? user.display_name;

  const degraded =
    health?.dependencies.filter(
      (dependency) =>
        dependency.state === 'down' || dependency.state === 'degraded',
    ) ?? [];

  const items = work.data?.items ?? [];
  const waiting = work.data?.total ?? 0;

  const metrics = overview.data;
  const agingMax = metrics
    ? Math.max(1, ...metrics.aging.map((row) => row.count))
    : 1;

  return (
    <>
      <PageHeader
        title={`Good day, ${firstName}`}
        purpose="Where the money and the work stand right now, then what needs you next."
      />

      {canReport ? (
        <section aria-label="Key figures" className="mb-[var(--space-5)]">
          {overview.isLoading ? (
            <div className="grid gap-[var(--space-4)] sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} className="h-[104px]" />
              ))}
            </div>
          ) : metrics ? (
            <div className="grid gap-[var(--space-4)] sm:grid-cols-2 xl:grid-cols-3">
              {metrics.kpis.map((kpi, index) => (
                <Reveal key={kpi.key} delay={index * 0.06}>
                  <KpiCard kpi={kpi} />
                </Reveal>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {canReport && metrics ? (
        <div className="mb-[var(--space-5)] grid gap-[var(--space-5)] lg:grid-cols-3">
          <Reveal className="lg:col-span-2" delay={0.05}>
            <Card className="h-full">
              <CardHeader>
                <CardTitle as="h2" className="flex items-center gap-2">
                  <TrendingUp
                    aria-hidden="true"
                    className="size-[18px] text-[var(--color-primary-600)]"
                  />
                  Activity, last six months
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ActivityChart data={metrics.monthly_activity} />
                <div className="mt-[var(--space-3)] flex items-center gap-[var(--space-5)] text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="size-2.5 rounded-full bg-[var(--color-primary-600)]"
                    />
                    Invoices
                  </span>
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="size-2.5 rounded-full bg-[var(--color-violet-500)]"
                    />
                    Estimates
                  </span>
                </div>
              </CardContent>
            </Card>
          </Reveal>

          <Reveal delay={0.12}>
            <Card variant="glass" className="relative h-full overflow-hidden">
              <BorderBeam />
              <CardContent className="flex h-full flex-col gap-[var(--space-3)]">
                <span
                  aria-hidden="true"
                  className="flex size-10 items-center justify-center rounded-[var(--radius-md)] bg-[image:var(--gradient-ai)] text-[var(--color-text-inverse)]"
                >
                  <Sparkles className="size-5" />
                </span>
                <h2 className="m-0 text-[length:var(--text-heading-3)] font-semibold">
                  <ShinyText tone="primary">Finora insight</ShinyText>
                </h2>
                <p className="m-0 text-[var(--text-body)] text-[var(--color-text)]">
                  {insightSentence(metrics)}
                </p>
                <p className="mt-auto m-0 text-[var(--text-caption)] text-[var(--color-text-subtle)]">
                  Computed from live records, not an AI claim. Every figure opens
                  the register behind it.
                </p>
              </CardContent>
            </Card>
          </Reveal>
        </div>
      ) : null}

      <div className="grid gap-[var(--space-5)] lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle as="h2" className="flex items-center gap-2">
              <Sparkles
                aria-hidden="true"
                className="size-[18px] text-[var(--color-primary-600)]"
              />
              What needs you
            </CardTitle>
          </CardHeader>
          <CardContent>
            {work.isLoading ? (
              <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                Checking what needs you.
              </p>
            ) : items.length === 0 ? (
              <div className="flex items-start gap-[var(--space-3)]">
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-md)]',
                    'bg-[image:var(--gradient-ai)] text-[var(--color-text-inverse)]',
                  )}
                >
                  <CheckCheck className="size-5" />
                </span>
                <div className="min-w-0">
                  <h3 className="m-0 text-[length:var(--text-body-lg)] font-semibold text-[var(--color-text-strong)]">
                    Nothing needs your attention
                  </h3>
                  <p className="mt-[var(--space-2)] m-0 text-[var(--text-body)] text-[var(--color-text-muted)]">
                    When something is routed to you — an approval, a receipt to
                    confirm, a document to check or a vendor answer to weigh — it
                    will appear here first, oldest at the top.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-[var(--space-4)]">
                <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                  Oldest first. Open one to act on it where the evidence is.
                </p>
                <ul className="m-0 flex list-none flex-col gap-[var(--space-2)] p-0">
                  {items.map((item) => {
                    const waited = waitedFor(item.waiting_hours);
                    return (
                      <li key={`${item.kind}:${item.record_id}`}>
                        <Link
                          to={item.record_path}
                          className={cn(
                            'motion-interactive flex flex-col gap-1 rounded-[var(--radius-md)]',
                            'border border-[var(--color-border)] px-[var(--space-4)] py-[var(--space-3)]',
                            'no-underline hover:bg-[var(--color-surface-subtle)]',
                            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]',
                            'sm:flex-row sm:items-center sm:justify-between sm:gap-[var(--space-4)]',
                          )}
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-semibold text-[var(--color-text-strong)]">
                              {item.kind_label}: {item.title}
                            </span>
                            <span className="block truncate text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                              {item.reference}
                              {item.subtitle ? ` · ${item.subtitle}` : ''}
                            </span>
                          </span>
                          <span
                            className={cn(
                              'shrink-0 text-[var(--text-body-sm)]',
                              waited.tone === 'danger'
                                ? 'font-semibold text-[var(--color-danger-700)]'
                                : waited.tone === 'warning'
                                  ? 'font-semibold text-[var(--color-warning-700)]'
                                  : 'text-[var(--color-text-subtle)]',
                            )}
                          >
                            {waited.label}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
                <Link
                  to="/work"
                  className="text-[var(--text-body-sm)] font-semibold text-[var(--color-primary-700)] underline underline-offset-4"
                >
                  {waiting > items.length
                    ? `See all ${waiting} on My work`
                    : 'Open My work'}
                </Link>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2" className="flex items-center gap-2">
              <Activity
                aria-hidden="true"
                className="size-[18px] text-[var(--color-primary-600)]"
              />
              Platform health
            </CardTitle>
          </CardHeader>
          <CardContent>
            {health ? (
              <>
                <p
                  className={cn(
                    'm-0 font-semibold',
                    health.ready
                      ? 'text-[var(--color-success-700)]'
                      : 'text-[var(--color-danger-700)]',
                  )}
                >
                  {health.ready ? 'Accepting work' : 'Not accepting work'}
                </p>
                <p className="mt-1 m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                  {degraded.length === 0
                    ? 'All services are responding.'
                    : `${degraded.length} service${degraded.length === 1 ? '' : 's'} need attention.`}
                </p>
                {permissions.has('operations:view') ? (
                  <Link
                    to="/operations"
                    className="mt-[var(--space-3)] inline-block text-[var(--text-body-sm)] font-semibold text-[var(--color-primary-700)] underline underline-offset-4"
                  >
                    View operational health
                  </Link>
                ) : null}
              </>
            ) : (
              <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                Checking service status.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {canReport && metrics ? (
        <div className="mt-[var(--space-5)] grid gap-[var(--space-5)] lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle as="h2">Invoices by state</CardTitle>
            </CardHeader>
            <CardContent>
              <StateBars data={metrics.invoice_states} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle as="h2">Payment aging</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="m-0 flex list-none flex-col gap-[var(--space-4)] p-0">
                {metrics.aging.map((row) => (
                  <AgingRow key={row.label} row={row} max={agingMax} />
                ))}
              </ul>
              <p className="mt-[var(--space-4)] m-0 text-[var(--text-caption)] text-[var(--color-text-subtle)]">
                Invoices approved through to outstanding, grouped by due date.
              </p>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <Card className="mt-[var(--space-5)]">
        <CardHeader>
          <CardTitle as="h2" className="flex items-center gap-2">
            <ShieldCheck
              aria-hidden="true"
              className="size-[18px] text-[var(--color-primary-600)]"
            />
            Your access
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-[var(--space-5)] md:grid-cols-2">
          <div>
            <h3 className="text-[var(--text-body-sm)] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
              Roles
            </h3>
            <ul className="mt-[var(--space-3)] m-0 flex list-none flex-col gap-[var(--space-3)] p-0">
              {user.roles.map((role) => (
                <li key={role}>
                  <p className="m-0 font-semibold capitalize text-[var(--color-text-strong)]">
                    {role.replaceAll('_', ' ')}
                  </p>
                  <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                    {ROLE_PURPOSE[role] ?? 'Access granted by an administrator.'}
                  </p>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="text-[var(--text-body-sm)] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
              Sections available to you
            </h3>
            <ul className="mt-[var(--space-3)] m-0 flex list-none flex-wrap gap-2 p-0">
              {groups.flatMap((group) =>
                group.items.map((item) => (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      className={cn(
                        'inline-flex min-h-9 items-center gap-1.5 rounded-[var(--radius-pill)]',
                        'border border-[var(--color-border-strong)] px-3',
                        'text-[var(--text-body-sm)] transition-colors',
                        'hover:bg-[var(--color-surface-subtle)]',
                      )}
                    >
                      <item.icon aria-hidden="true" className="size-4" />
                      {item.label}
                    </Link>
                  </li>
                )),
              )}
            </ul>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
