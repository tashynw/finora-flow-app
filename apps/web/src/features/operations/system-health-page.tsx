import { RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { SkeletonText } from '@/components/ui/skeleton';
import { StatCards, type StatCardItem } from '@/components/ui/stat-cards';
import { ToneBadge, type StatusTone } from '@/components/workflow/status-badge';
import { PageHeader } from '@/features/shared/page-header';
import {
  DEPENDENCY_INFO,
  type DependencyReport,
  type DependencyState,
  type ReadinessResponse,
  useHealth,
} from '@/features/operations/use-health';

const STATE_PRESENTATION: Record<DependencyState, { label: string; tone: StatusTone }> = {
  up: { label: 'Working', tone: 'success' },
  degraded: { label: 'Degraded', tone: 'warning' },
  down: { label: 'Unavailable', tone: 'danger' },
  not_configured: { label: 'Not configured', tone: 'neutral' },
};

function infoFor(name: string) {
  return (
    DEPENDENCY_INFO[name] ?? {
      label: name,
      impact: 'Impact is not documented for this service.',
    }
  );
}

const dependencyColumns: Column<DependencyReport>[] = [
  {
    key: 'dependency',
    header: 'Dependency',
    width: 'w-52',
    cell: (dependency) => (
      <span className="font-semibold text-[var(--color-text-strong)]">
        {infoFor(dependency.name).label}
      </span>
    ),
  },
  {
    key: 'impact',
    header: 'If it fails',
    hideBelow: 'md',
    cell: (dependency) => (
      <span className="text-[var(--color-text-muted)]">{infoFor(dependency.name).impact}</span>
    ),
  },
  {
    key: 'detail',
    header: 'Detail',
    width: 'w-64',
    hideBelow: 'lg',
    cell: (dependency) =>
      dependency.detail ? (
        <span className="font-mono text-[11px] text-[var(--color-text-subtle)]">
          {dependency.detail}
        </span>
      ) : (
        <span className="text-[var(--color-text-subtle)]">—</span>
      ),
  },
  {
    key: 'status',
    header: 'Status',
    width: 'w-36',
    cell: (dependency) => {
      const presentation = STATE_PRESENTATION[dependency.state];
      return <ToneBadge label={presentation.label} tone={presentation.tone} />;
    },
  },
];

/** A headline card for one dependency, or nothing if the API does not report it. */
function dependencyCard(
  data: ReadinessResponse,
  key: string,
  label: string,
): StatCardItem | null {
  const dependency = data.dependencies.find((entry) => entry.name === key);
  if (!dependency) return null;
  return {
    key,
    label,
    value: STATE_PRESENTATION[dependency.state].label,
    meta: dependency.detail || infoFor(key).label,
  };
}

function headlineCards(data: ReadinessResponse | undefined): StatCardItem[] {
  if (!data) return [];
  return [
    {
      key: 'platform',
      label: 'Platform',
      value: data.ready ? 'Operational' : 'Not accepting work',
      meta: data.ready
        ? `Accepting work · ${data.environment} ${data.version}`
        : 'A required service is unavailable. Nothing has been lost.',
    },
    dependencyCard(data, 'redis', 'Queue'),
    dependencyCard(data, 'imap', 'Mail'),
    dependencyCard(data, 'malware_scanner', 'Scanner'),
  ].filter((item): item is StatCardItem => item !== null);
}

/**
 * Operational health.
 *
 * Reports the API's actual readiness check. Every row names the consequence of a
 * failure, because "redis: down" tells an operator nothing about whether work is
 * being lost.
 */
export function SystemHealthPage() {
  const { data, isLoading, isError, error, refetch, isFetching, dataUpdatedAt } =
    useHealth();

  const dependencies = data?.dependencies ?? [];

  return (
    <>
      <PageHeader
        title="System health"
        purpose="Current status of Finora dependencies."
        toolbar={
          dataUpdatedAt ? (
            <p className="m-0 text-[12px] text-[var(--color-text-subtle)]">
              Last checked{' '}
              {new Date(dataUpdatedAt).toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}
              . Refreshes automatically every 30 seconds.
            </p>
          ) : null
        }
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void refetch()}
            isLoading={isFetching && !isLoading}
            loadingLabel="Refreshing"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            Refresh
          </Button>
        }
      />

      {isError ? (
        <Card className="mb-[var(--space-6)] border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              Could not reach the API to check status
            </p>
            <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              {error instanceof Error
                ? error.message
                : 'The status check did not complete.'}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <StatCards items={headlineCards(data)} isLoading={isLoading} />

      {isLoading ? (
        <Card>
          <CardContent>
            <SkeletonText lines={6} />
          </CardContent>
        </Card>
      ) : dependencies.length > 0 ? (
        <DataTable
          ariaLabel="Dependencies"
          columns={dependencyColumns}
          rows={dependencies}
          getRowKey={(dependency) => dependency.name}
        />
      ) : null}
    </>
  );
}
