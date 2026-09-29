import { AlertTriangle, CheckCircle2, Mail, RefreshCw } from 'lucide-react';

import type { CheckpointReport, OperationsReport } from '@finora/shared-types';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { SkeletonText } from '@/components/ui/skeleton';
import { StatCards, type StatCardItem } from '@/components/ui/stat-cards';
import { ToneBadge } from '@/components/workflow/status-badge';
import { PageHeader } from '@/features/shared/page-header';
import {
  describeOperationalState,
  formatDuration,
} from '@/features/intake/intake-vocabulary';
import {
  useIntakeOperations,
  useMailboxProbe,
} from '@/features/intake/use-intake';

function Measure({
  label,
  value,
  hint,
  emphasis,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <dt className="m-0 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
        {label}
      </dt>
      <dd
        className={
          emphasis
            ? 'mt-1 m-0 text-[20px] font-semibold text-[var(--color-danger-700)]'
            : 'mt-1 m-0 text-[20px] font-semibold text-[var(--color-text-strong)]'
        }
      >
        {value}
      </dd>
      {hint ? (
        <p className="mt-1 m-0 text-[11px] text-[var(--color-text-muted)]">{hint}</p>
      ) : null}
    </div>
  );
}

/** A headline figure, red when it is the thing that needs a person. */
function Figure({ value, emphasis }: { value: string; emphasis?: boolean }) {
  return (
    <span className={emphasis ? 'text-[var(--color-danger-700)]' : undefined}>
      {value.charAt(0).toUpperCase() + value.slice(1)}
    </span>
  );
}

const checkpointColumns: Column<CheckpointReport>[] = [
  {
    key: 'folder',
    header: 'Checkpoint',
    cell: (checkpoint) => (
      <span className="font-mono font-semibold text-[var(--color-text-strong)]">
        {checkpoint.folder}
      </span>
    ),
  },
  {
    key: 'last-poll',
    header: 'Last poll',
    width: 'w-40',
    cell: (checkpoint) => (
      <span
        className={
          checkpoint.is_stalled ? 'font-semibold text-[var(--color-danger-700)]' : undefined
        }
      >
        {formatDuration(checkpoint.seconds_since_poll)}
      </span>
    ),
  },
  {
    key: 'uid',
    header: 'Last UID read',
    width: 'w-32',
    hideBelow: 'md',
    cell: (checkpoint) => <span className="tabular">{checkpoint.last_seen_uid}</span>,
  },
  {
    // Shown because a changed UIDVALIDITY is the one event that makes every
    // stored UID meaningless, and it explains a re-read nobody asked for.
    key: 'uid-validity',
    header: 'UIDVALIDITY',
    width: 'w-32',
    hideBelow: 'md',
    cell: (checkpoint) => <span className="tabular">{checkpoint.uid_validity}</span>,
  },
  {
    key: 'reset',
    header: 'Last reset',
    width: 'w-48',
    hideBelow: 'lg',
    cell: (checkpoint) => (
      <span className="flex flex-col">
        <span>
          {checkpoint.last_reset_at
            ? new Date(checkpoint.last_reset_at).toLocaleString(undefined, {
                dateStyle: 'short',
                timeStyle: 'short',
              })
            : 'Never'}
        </span>
        {checkpoint.last_reset_reason ? (
          <span className="text-[11px] text-[var(--color-text-subtle)]">
            {checkpoint.last_reset_reason.replace(/_/g, ' ')}
          </span>
        ) : null}
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    width: 'w-32',
    cell: (checkpoint) => (
      <ToneBadge
        label={checkpoint.is_stalled ? 'Stalled' : 'Polling'}
        tone={checkpoint.is_stalled ? 'danger' : 'success'}
      />
    ),
  },
];

function headlineCards(report: OperationsReport): StatCardItem[] {
  const { backlog, checkpoints } = report;
  const polled = checkpoints
    .map((checkpoint) => checkpoint.seconds_since_poll)
    .filter((seconds): seconds is number => seconds !== null);
  const latest = polled.length > 0 ? Math.min(...polled) : null;
  const stalled = checkpoints.filter((checkpoint) => checkpoint.is_stalled).length;
  const oldest = backlog.oldest_unresolved_age_seconds;

  return [
    {
      key: 'last-poll',
      label: 'Last poll',
      value: <Figure value={formatDuration(latest)} emphasis={latest === null || stalled > 0} />,
      meta:
        checkpoints.length === 0
          ? 'No folder has been polled'
          : stalled > 0
            ? `${stalled} of ${checkpoints.length} folders stalled`
            : `${checkpoints.length} ${checkpoints.length === 1 ? 'folder' : 'folders'} polling`,
    },
    {
      key: 'failures',
      label: 'Failures',
      value: <Figure value={String(backlog.failed)} emphasis={backlog.failed > 0} />,
      meta: 'Refused at intake',
    },
    {
      key: 'quarantine',
      label: 'Quarantine',
      value: <Figure value={String(backlog.quarantined)} emphasis={backlog.quarantined > 0} />,
      meta: backlog.quarantined > 0 ? 'Needs review' : 'Nothing withheld',
    },
    {
      key: 'oldest',
      label: 'Oldest unresolved',
      value: (
        <Figure
          value={oldest === null ? 'None' : formatDuration(oldest)}
          emphasis={(oldest ?? 0) > 3600}
        />
      ),
      meta: oldest === null ? 'Nothing is unresolved' : 'Approval clocks run from receipt',
    },
  ];
}

function MailboxCard({ mailbox }: { mailbox: OperationsReport['mailbox'] }) {
  if (!mailbox) {
    return (
      <CardContent>
        <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
          The mailbox has not been contacted for this reading. Checking it opens a
          real connection and attempts a sign-in, so it is done on request rather
          than on every refresh.
        </p>
      </CardContent>
    );
  }

  const percent = mailbox.quota_used_percent;

  return (
    <CardContent>
      <dl className="grid grid-cols-2 gap-[var(--space-4)] sm:grid-cols-3">
        <Measure
          label="Reachable"
          value={mailbox.reachable ? 'Yes' : 'No'}
          emphasis={!mailbox.reachable}
        />
        <Measure
          label="Credentials"
          value={mailbox.authenticated ? 'Accepted' : 'Rejected'}
          emphasis={!mailbox.authenticated}
        />
        <Measure
          label="Storage used"
          value={
            percent !== null && percent !== undefined
              ? `${percent.toFixed(0)}%`
              : mailbox.quota_supported
                ? 'Unlimited'
                : 'Not reported'
          }
          emphasis={(percent ?? 0) >= 85}
          {...(mailbox.quota_limit_kb
            ? {
                hint: `${Math.round((mailbox.quota_used_kb ?? 0) / 1024)} MB of ${Math.round(
                  mailbox.quota_limit_kb / 1024,
                )} MB`,
              }
            : {})}
        />
      </dl>

      {mailbox.detail ? (
        <p className="mt-[var(--space-4)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
          {mailbox.detail}
        </p>
      ) : null}
    </CardContent>
  );
}

/**
 * Intake operational health.
 *
 * Exists because intake fails quietly. A stopped worker, rejected credentials or
 * a full mailbox all produce the same visible result as a quiet week: nothing
 * arrives. This page is the only place that difference is visible, so it leads
 * with whether collection is happening at all rather than with throughput
 * numbers that look fine while nothing is being collected.
 */
export function IntakeOperationsPage() {
  const { data, isLoading, isError, error, refetch, isFetching } =
    useIntakeOperations();
  const probe = useMailboxProbe();

  // The probe's report is strictly newer and includes everything the polled one
  // does, so it supersedes it once a person has asked for it.
  const report = probe.data ?? data;
  const state = report ? describeOperationalState(report.state) : null;

  return (
    <>
      <PageHeader
        title="Intake health"
        purpose="Mailbox polling, failures and what is waiting on a person."
        toolbar={
          state ? (
            <div className="flex flex-wrap items-center gap-[var(--space-3)]">
              <ToneBadge label={state.label} tone={state.tone} />
              <p className="m-0 max-w-prose text-[12px] text-[var(--color-text-muted)]">
                {state.description}
              </p>
            </div>
          ) : null
        }
        actions={
          <>
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
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void probe.refetch()}
              isLoading={probe.isFetching}
              loadingLabel="Contacting the mailbox"
            >
              <Mail aria-hidden="true" className="size-4" />
              Check the mailbox
            </Button>
          </>
        }
      />

      {isError ? (
        <Card className="mb-[var(--space-6)] border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              Could not read intake health
            </p>
            <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              {error instanceof Error
                ? error.message
                : 'The request did not complete.'}{' '}
              This page failing says nothing about whether intake itself is
              running.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {isLoading || !report ? (
        <>
          <StatCards items={[]} isLoading />
          <Card>
            <CardContent>
              <SkeletonText lines={6} />
            </CardContent>
          </Card>
        </>
      ) : (
        <>
          <StatCards items={headlineCards(report)} />

          <div className="flex flex-col gap-[var(--space-6)]">
            {report.checkpoints.length === 0 ? (
              <Card>
                <CardContent>
                  <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                    No folder has ever been polled. Until the worker runs once,
                    nothing here reflects the mailbox, and an empty queue on this
                    page does not mean an empty mailbox.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <DataTable
                ariaLabel="Mailbox polling"
                columns={checkpointColumns}
                rows={report.checkpoints}
                getRowKey={(checkpoint) => checkpoint.folder}
              />
            )}

            <div className="grid gap-[var(--space-6)] lg:grid-cols-2">
              <Card
                className={
                  report.concerns.length > 0
                    ? 'border-[color-mix(in_srgb,var(--color-warning-600)_38%,white)]'
                    : undefined
                }
              >
                <CardHeader>
                  <CardTitle>
                    <span className="inline-flex items-center gap-[var(--space-2)]">
                      {report.concerns.length > 0 ? (
                        <AlertTriangle
                          aria-hidden="true"
                          className="size-4 text-[var(--color-warning-600)]"
                        />
                      ) : (
                        <CheckCircle2
                          aria-hidden="true"
                          className="size-4 text-[var(--color-success-600)]"
                        />
                      )}
                      {report.concerns.length > 0
                        ? 'What needs doing'
                        : 'Nothing needs doing'}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {report.concerns.length > 0 ? (
                    <ul className="m-0 flex list-disc flex-col gap-[var(--space-2)] pl-[var(--space-5)]">
                      {report.concerns.map((concern) => (
                        <li
                          key={concern}
                          className="text-[length:var(--text-body-sm)] text-[var(--color-text)]"
                        >
                          {concern}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                      The mailbox is being polled on schedule and nothing is
                      quarantined, failed or stuck.
                    </p>
                  )}
                  <dl className="mt-[var(--space-5)] grid grid-cols-2 gap-[var(--space-4)]">
                    <Measure
                      label="Messages recorded"
                      value={String(report.backlog.total)}
                    />
                    <Measure
                      label="Mid-ingest"
                      value={String(report.backlog.in_flight)}
                      emphasis={report.backlog.in_flight > 0}
                      hint="Should always be zero once a poll has finished."
                    />
                  </dl>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Mailbox connection</CardTitle>
                </CardHeader>
                {probe.isError ? (
                  <CardContent>
                    <p role="alert" className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-danger-700)]">
                      {probe.error instanceof Error
                        ? probe.error.message
                        : 'The mailbox check did not complete.'}{' '}
                      This is the check failing, not necessarily the mailbox.
                    </p>
                  </CardContent>
                ) : (
                  <MailboxCard mailbox={report.mailbox} />
                )}
              </Card>
            </div>

            <p className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-subtle)]">
              Read at{' '}
              <time data-visual-volatile dateTime={report.generated_at}>
                {new Date(report.generated_at).toLocaleTimeString()}
              </time>
              . Refreshes automatically every 30 seconds.
            </p>
          </div>
        </>
      )}
    </>
  );
}
