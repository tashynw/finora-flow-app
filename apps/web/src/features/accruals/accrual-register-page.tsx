import { useState } from 'react';
import { BookOpen, Plus } from 'lucide-react';

import type { AccrualPeriodSummary, AccrualStanding } from '@finora/shared-types';

import { formatDate } from '@/lib/dates';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { ViewTabs } from '@/components/ui/view-tabs';
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

const periodColumns: Column<AccrualPeriodSummary>[] = [
  {
    key: 'reference',
    header: 'Reference',
    width: 'w-44',
    cell: (row) => (
      <span className="tabular font-medium text-[var(--color-text-strong)]">
        {row.reference}
      </span>
    ),
  },
  {
    key: 'period',
    header: 'Period',
    cell: (row) => (
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{row.label}</span>
        <span className="tabular truncate text-[11px] text-[var(--color-text-subtle)]">
          {formatDate(row.period_start)} – {formatDate(row.period_end)}
        </span>
      </span>
    ),
  },
  {
    key: 'candidates',
    header: 'Candidates',
    width: 'w-32',
    cell: (row) => (
      <span className="flex flex-col">
        <span className="tabular">{row.candidate_count}</span>
        {row.open_candidate_count > 0 ? (
          <span className="text-[11px] text-[var(--color-text-subtle)]">
            {row.open_candidate_count} open
          </span>
        ) : null}
      </span>
    ),
  },
  {
    key: 'waiting',
    header: 'Waiting on',
    hideBelow: 'md',
    cell: (row) => (
      <span>
        {periodWaitingOn(row.open_candidate_count, row.candidate_count, row.standing)}
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    width: 'w-36',
    cell: (row) => <ToneBadge tone={standingTone(row.standing)} label={row.standing_label} />,
  },
  {
    key: 'locked',
    header: 'Locked',
    width: 'w-40',
    hideBelow: 'lg',
    cell: (row) =>
      row.locked_at ? (
        <span className="flex min-w-0 flex-col">
          <span className="tabular">{formatDate(row.locked_at)}</span>
          {row.lock_reason ? (
            <span className="truncate text-[11px] text-[var(--color-text-subtle)]">
              {row.lock_reason}
            </span>
          ) : null}
        </span>
      ) : (
        <span>—</span>
      ),
  },
];

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
    <>
      <PageHeader
        title="Accruals"
        purpose="Month-end obligations and period close."
        toolbar={<ViewTabs tabs={VIEWS} value={view.id} onChange={setViewId} />}
        actions={
          canEdit ? (
            <Button
              type="button"
              variant="primary"
              size="sm"
              aria-expanded={showOpen}
              onClick={() => setShowOpen((open) => !open)}
            >
              <Plus className="size-4" aria-hidden />
              Open period
            </Button>
          ) : null
        }
      />

      {showOpen && canEdit ? (
        <Card className="surface-card mb-[var(--space-5)]">
          <CardContent className="flex flex-col gap-[var(--space-4)] p-[var(--space-5)]">
            <h2 className="m-0 text-[length:var(--text-title-sm)] text-[var(--color-text-strong)]">
              Open a period
            </h2>
            <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
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

      {periods.isLoading ? (
        <Card>
          <CardContent>
            <SkeletonText lines={4} />
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="p-0">
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
          </CardContent>
        </Card>
      ) : (
        <DataTable
          ariaLabel="Accrual periods"
          columns={periodColumns}
          rows={rows}
          getRowKey={(row) => row.id}
          getRowHref={(row) => `/accruals/${row.id}`}
        />
      )}
    </>
  );
}
