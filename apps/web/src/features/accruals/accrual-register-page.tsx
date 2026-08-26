import { useState } from 'react';
import { BookOpen, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';

import type { AccrualPeriodSummary, AccrualStanding } from '@finora/shared-types';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { SkeletonText } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/workflow/status-badge';
import { useAuth } from '@/features/auth/auth-context';
import { PageHeader } from '@/features/shared/page-header';
import {
  PERIOD_PURPOSE,
  periodWaitingOn,
} from '@/features/accruals/accrual-vocabulary';
import {
  useAccrualPeriods,
  useOpenAccrualPeriod,
} from '@/features/accruals/use-accruals';

interface RegisterView {
  id: string;
  label: string;
  standing?: AccrualStanding;
  empty: string;
  emptyExplanation: string;
}

const VIEWS: RegisterView[] = [
  {
    id: 'open',
    label: 'Open',
    standing: 'open',
    empty: 'No open accrual periods',
    emptyExplanation:
      'Open a period to begin raising accruals. Generating candidates, finalising them and locking the period are what make the pack accountable.',
  },
  {
    id: 'locked',
    label: 'Locked',
    standing: 'locked',
    empty: 'Nothing has been locked yet',
    emptyExplanation:
      'A locked period freezes candidates. The person who raised the accruals cannot be the person who locks the period.',
  },
  {
    id: 'all',
    label: 'Everything',
    empty: 'No accrual periods yet',
    emptyExplanation: PERIOD_PURPOSE,
  },
];

function standingTone(standing: string): 'neutral' | 'warning' {
  return standing === 'locked' ? 'neutral' : 'warning';
}

function PeriodRow({ row }: { row: AccrualPeriodSummary }) {
  return (
    <li className="border-b border-[var(--color-divider)] last:border-b-0">
      <Link
        to={`/accruals/${row.id}`}
        className={cn(
          'motion-interactive flex flex-col gap-[var(--space-2)] px-[var(--space-5)] py-[var(--space-4)]',
          'no-underline hover:bg-[var(--color-surface-subtle)]',
          'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-focus-ring)]',
          'sm:flex-row sm:items-center sm:gap-[var(--space-5)]',
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="m-0 flex flex-wrap items-baseline gap-x-[var(--space-2)]">
            <span className="tabular text-[var(--text-caption)] text-[var(--color-text-subtle)]">
              {row.reference}
            </span>
            <span className="truncate font-semibold text-[var(--color-text-strong)]">
              {row.label}
            </span>
          </p>
          <p className="m-0 truncate text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
            {row.period_start} – {row.period_end} · {row.candidate_count}{' '}
            {row.candidate_count === 1 ? 'candidate' : 'candidates'} ·{' '}
            {periodWaitingOn(row.open_candidate_count, row.candidate_count, row.standing)}
          </p>
        </div>
        <ToneBadge tone={standingTone(row.standing)} label={row.standing_label} />
      </Link>
    </li>
  );
}

export function AccrualRegisterPage() {
  const { user } = useAuth();
  const canEdit = user?.permissions.includes('accrual:edit') ?? false;
  const [viewId, setViewId] = useState('open');
  const view: RegisterView = VIEWS.find((item) => item.id === viewId) ?? VIEWS[0]!;
  const periods = useAccrualPeriods(view.standing);
  const openPeriod = useOpenAccrualPeriod();

  const [showOpen, setShowOpen] = useState(false);
  const [newPeriod, setNewPeriod] = useState({
    period_start: '',
    period_end: '',
    label: '',
  });

  const rows = periods.data ?? [];

  return (
    <div className="flex flex-col gap-[var(--space-6)]">
      <PageHeader
        title="Accruals"
        purpose={PERIOD_PURPOSE}
        actions={
          canEdit ? (
            <Button type="button" onClick={() => setShowOpen((open) => !open)}>
              <Plus className="size-4" aria-hidden />
              Open period
            </Button>
          ) : null
        }
      />

      {showOpen && canEdit ? (
        <Card className="surface-card">
          <CardContent className="flex flex-col gap-[var(--space-4)] p-[var(--space-5)]">
            <h2 className="m-0 text-[var(--text-title-sm)] text-[var(--color-text-strong)]">
              Open a period
            </h2>
            <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
              The period dates determine which unpaid invoices are candidates. The
              label appears in the pack and in the export filename.
            </p>
            <form
              className="grid gap-[var(--space-3)] sm:grid-cols-3"
              onSubmit={(event) => {
                event.preventDefault();
                openPeriod.mutate(newPeriod, {
                  onSuccess: () => {
                    setShowOpen(false);
                    setNewPeriod({ period_start: '', period_end: '', label: '' });
                  },
                });
              }}
            >
              <Field label="Period start">
                {({ inputId, describedBy, invalid }) => (
                  <Input
                    id={inputId}
                    type="date"
                    required
                    aria-describedby={describedBy}
                    invalid={invalid}
                    value={newPeriod.period_start}
                    onChange={(event) =>
                      setNewPeriod((current) => ({
                        ...current,
                        period_start: event.target.value,
                      }))
                    }
                  />
                )}
              </Field>
              <Field label="Period end">
                {({ inputId, describedBy, invalid }) => (
                  <Input
                    id={inputId}
                    type="date"
                    required
                    aria-describedby={describedBy}
                    invalid={invalid}
                    value={newPeriod.period_end}
                    onChange={(event) =>
                      setNewPeriod((current) => ({
                        ...current,
                        period_end: event.target.value,
                      }))
                    }
                  />
                )}
              </Field>
              <Field label="Label">
                {({ inputId, describedBy, invalid }) => (
                  <Input
                    id={inputId}
                    required
                    aria-describedby={describedBy}
                    invalid={invalid}
                    placeholder="e.g. June 2026"
                    value={newPeriod.label}
                    onChange={(event) =>
                      setNewPeriod((current) => ({
                        ...current,
                        label: event.target.value,
                      }))
                    }
                  />
                )}
              </Field>
              <div className="sm:col-span-3">
                <Button
                  type="submit"
                  disabled={
                    openPeriod.isPending ||
                    !newPeriod.period_start ||
                    !newPeriod.period_end ||
                    !newPeriod.label
                  }
                >
                  Open period
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <div
        role="group"
        aria-label="Choose a view"
        className="flex flex-wrap gap-[var(--space-2)]"
      >
        {VIEWS.map((item) => (
          <Button
            key={item.id}
            type="button"
            size="sm"
            variant={item.id === view.id ? 'primary' : 'secondary'}
            aria-pressed={item.id === view.id}
            onClick={() => setViewId(item.id)}
          >
            {item.label}
          </Button>
        ))}
      </div>

      <Card className="surface-card overflow-hidden">
        {periods.isLoading ? (
          <CardContent className="p-[var(--space-5)]">
            <SkeletonText lines={4} />
          </CardContent>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title={view.empty}
            explanation={view.emptyExplanation}
            nextStep={
              canEdit
                ? 'Open a period to begin raising accruals.'
                : 'Periods are opened by the people who raise accruals. Nothing is needed from you here.'
            }
            {...(viewId === 'all'
              ? {}
              : {
                  secondaryAction: {
                    label: 'Show everything',
                    onClick: () => setViewId('all'),
                  },
                })}
          />
        ) : (
          <ul className="m-0 list-none p-0">
            {rows.map((row) => (
              <PeriodRow key={row.id} row={row} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
