import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  RefreshCw,
  XCircle,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SkeletonText } from '@/components/ui/skeleton';
import { PageHeader } from '@/features/shared/page-header';
import {
  DEPENDENCY_INFO,
  type DependencyState,
  useHealth,
} from '@/features/operations/use-health';

const STATE_PRESENTATION: Record<
  DependencyState,
  { label: string; icon: typeof CheckCircle2; className: string }
> = {
  up: {
    label: 'Working',
    icon: CheckCircle2,
    className: 'text-[var(--color-success-700)] bg-[var(--color-success-50)]',
  },
  degraded: {
    label: 'Degraded',
    icon: AlertTriangle,
    className: 'text-[var(--color-warning-700)] bg-[var(--color-warning-50)]',
  },
  down: {
    label: 'Unavailable',
    icon: XCircle,
    className: 'text-[var(--color-danger-700)] bg-[var(--color-danger-50)]',
  },
  not_configured: {
    label: 'Not configured',
    icon: CircleSlash,
    className: 'text-[var(--color-text-muted)] bg-[var(--color-surface-subtle)]',
  },
};

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

  return (
    <>
      <PageHeader
        title="Operational health"
        purpose="Live status of the services the platform depends on, and what a failure in each one means for your work."
        actions={
          <Button
            variant="secondary"
            onClick={() => void refetch()}
            isLoading={isFetching && !isLoading}
            loadingLabel="Refreshing"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            Refresh
          </Button>
        }
        meta={
          dataUpdatedAt ? (
            <p className="m-0 text-[var(--text-caption)] text-[var(--color-text-subtle)]">
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
      />

      {isError ? (
        <Card className="mb-[var(--space-6)] border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              Could not reach the API to check status
            </p>
            <p className="mt-2 m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
              {error instanceof Error
                ? error.message
                : 'The status check did not complete.'}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {data ? (
        <Card
          className={cn(
            'mb-[var(--space-6)]',
            data.ready
              ? 'border-[color-mix(in_srgb,var(--color-success-600)_38%,white)]'
              : 'border-[var(--color-danger-600)]',
          )}
        >
          <CardContent className="flex flex-wrap items-center justify-between gap-[var(--space-4)]">
            <div className="flex items-center gap-[var(--space-3)]">
              {data.ready ? (
                <CheckCircle2
                  aria-hidden="true"
                  className="size-6 text-[var(--color-success-600)]"
                />
              ) : (
                <XCircle
                  aria-hidden="true"
                  className="size-6 text-[var(--color-danger-600)]"
                />
              )}
              <div>
                <p className="m-0 text-[length:var(--text-heading-3)] font-semibold">
                  {data.ready
                    ? 'The platform is accepting work'
                    : 'The platform cannot accept work'}
                </p>
                <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                  {data.ready
                    ? 'Individual services below may still need attention.'
                    : 'A required service is unavailable. Nothing has been lost.'}
                </p>
              </div>
            </div>

            <dl className="m-0 flex gap-[var(--space-6)] text-[var(--text-body-sm)]">
              <div>
                <dt className="m-0 text-[var(--color-text-subtle)]">Version</dt>
                <dd className="m-0 font-mono font-semibold">{data.version}</dd>
              </div>
              <div>
                <dt className="m-0 text-[var(--color-text-subtle)]">Environment</dt>
                <dd className="m-0 font-semibold capitalize">{data.environment}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Services</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-[var(--space-5)]">
              <SkeletonText lines={6} />
            </div>
          ) : (
            <ul className="m-0 list-none p-0">
              {(data?.dependencies ?? []).map((dependency) => {
                const info = DEPENDENCY_INFO[dependency.name] ?? {
                  label: dependency.name,
                  impact: 'Impact is not documented for this service.',
                };
                const presentation = STATE_PRESENTATION[dependency.state];
                const Icon = presentation.icon;

                return (
                  <li
                    key={dependency.name}
                    className={cn(
                      'flex flex-col gap-[var(--space-2)] border-b border-[var(--color-divider)]',
                      'px-[var(--space-5)] py-[var(--space-4)] last:border-b-0',
                      'sm:flex-row sm:items-start sm:justify-between sm:gap-[var(--space-6)]',
                    )}
                  >
                    <div className="min-w-0">
                      <p className="m-0 font-semibold text-[var(--color-text-strong)]">
                        {info.label}
                      </p>
                      <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                        {info.impact}
                      </p>
                      {dependency.detail ? (
                        <p className="mt-1 m-0 font-mono text-[var(--text-caption)] text-[var(--color-text-subtle)]">
                          {dependency.detail}
                        </p>
                      ) : null}
                    </div>

                    <span
                      className={cn(
                        'inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-pill)]',
                        'px-2.5 py-1 text-[var(--text-caption)] font-semibold',
                        presentation.className,
                      )}
                    >
                      <Icon aria-hidden="true" className="size-3.5" />
                      {presentation.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
