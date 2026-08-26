import { AlertTriangle, CheckCircle2, Mail, RefreshCw } from 'lucide-react';

import type { CheckpointReport, OperationsReport } from '@finora/shared-types';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SkeletonText } from '@/components/ui/skeleton';
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
      <dt className="m-0 text-[var(--text-caption)] text-[var(--color-text-subtle)]">
        {label}
      </dt>
      <dd
        className={
          emphasis
            ? 'm-0 text-[length:var(--text-heading-3)] font-bold text-[var(--color-danger-700)]'
            : 'm-0 text-[length:var(--text-heading-3)] font-bold text-[var(--color-text-strong)]'
        }
      >
        {value}
      </dd>
      {hint ? (
        <p className="mt-1 m-0 text-[var(--text-caption)] text-[var(--color-text-muted)]">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function CheckpointCard({ checkpoint }: { checkpoint: CheckpointReport }) {
  return (
    <li className="border-b border-[var(--color-divider)] px-[var(--space-5)] py-[var(--space-4)] last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-[var(--space-3)]">
        <p className="m-0 font-mono font-semibold text-[var(--color-text-strong)]">
          {checkpoint.folder}
        </p>
        <ToneBadge
          label={checkpoint.is_stalled ? 'Stalled' : 'Polling'}
          tone={checkpoint.is_stalled ? 'danger' : 'success'}
        />
      </div>

      <dl className="mt-[var(--space-3)] grid grid-cols-2 gap-[var(--space-4)] sm:grid-cols-4">
        <Measure
          label="Last poll"
          value={formatDuration(checkpoint.seconds_since_poll)}
          emphasis={checkpoint.is_stalled}
        />
        <Measure label="Last UID read" value={String(checkpoint.last_seen_uid)} />
        {/* Shown because a changed UIDVALIDITY is the one event that makes every
            stored UID meaningless, and it explains a re-read nobody asked for. */}
        <Measure label="UIDVALIDITY" value={String(checkpoint.uid_validity)} />
        <Measure
          label="Last reset"
          value={
            checkpoint.last_reset_at
              ? new Date(checkpoint.last_reset_at).toLocaleString(undefined, {
                  dateStyle: 'short',
                  timeStyle: 'short',
                })
              : 'Never'
          }
          {...(checkpoint.last_reset_reason
            ? { hint: checkpoint.last_reset_reason.replace(/_/g, ' ') }
            : {})}
        />
      </dl>
    </li>
  );
}

function MailboxCard({ mailbox }: { mailbox: OperationsReport['mailbox'] }) {
  if (!mailbox) {
    return (
      <CardContent>
        <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
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
        <p className="mt-[var(--space-4)] m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
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
        purpose="Whether mail is actually being collected, and what is waiting on a person."
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => void refetch()}
              isLoading={isFetching && !isLoading}
              loadingLabel="Refreshing"
            >
              <RefreshCw aria-hidden="true" className="size-4" />
              Refresh
            </Button>
            <Button
              variant="secondary"
              onClick={() => void probe.refetch()}
              isLoading={probe.isFetching}
              loadingLabel="Contacting the mailbox"
            >
              <Mail aria-hidden="true" className="size-4" />
              Check the mailbox
            </Button>
          </>
        }
        meta={
          state ? (
            <div className="flex flex-col gap-[var(--space-2)]">
              <ToneBadge label={state.label} tone={state.tone} />
              <p className="m-0 max-w-prose text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                {state.description}
              </p>
            </div>
          ) : null
        }
      />

      {isError ? (
        <Card className="mb-[var(--space-6)] border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              Could not read intake health
            </p>
            <p className="mt-2 m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
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
        <Card>
          <CardContent>
            <SkeletonText lines={6} />
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-[var(--space-6)]">
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
                      className="text-[var(--text-body-sm)] text-[var(--color-text)]"
                    >
                      {concern}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                  The mailbox is being polled on schedule and nothing is
                  quarantined, failed or stuck.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Queue</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-[var(--space-5)] sm:grid-cols-4">
                <Measure
                  label="Messages recorded"
                  value={String(report.backlog.total)}
                />
                <Measure
                  label="Waiting on a person"
                  value={String(report.backlog.needs_attention)}
                  emphasis={report.backlog.needs_attention > 0}
                  hint="Quarantined or refused at intake."
                />
                <Measure
                  label="Mid-ingest"
                  value={String(report.backlog.in_flight)}
                  emphasis={report.backlog.in_flight > 0}
                  hint="Should always be zero once a poll has finished."
                />
                <Measure
                  label="Oldest unresolved"
                  value={formatDuration(
                    report.backlog.oldest_unresolved_age_seconds,
                  )}
                  emphasis={
                    (report.backlog.oldest_unresolved_age_seconds ?? 0) > 3600
                  }
                  hint={
                    report.backlog.oldest_unresolved_at
                      ? 'Approval clocks run from receipt.'
                      : 'Nothing is unresolved.'
                  }
                />
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Mailbox polling</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {report.checkpoints.length === 0 ? (
                <p className="m-0 px-[var(--space-5)] py-[var(--space-6)] text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                  No folder has ever been polled. Until the worker runs once,
                  nothing here reflects the mailbox, and an empty queue on this
                  page does not mean an empty mailbox.
                </p>
              ) : (
                <ul className="m-0 list-none p-0">
                  {report.checkpoints.map((checkpoint) => (
                    <CheckpointCard
                      key={checkpoint.folder}
                      checkpoint={checkpoint}
                    />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Mailbox connection</CardTitle>
            </CardHeader>
            {probe.isError ? (
              <CardContent>
                <p role="alert" className="m-0 text-[var(--text-body-sm)] text-[var(--color-danger-700)]">
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

          <p className="m-0 text-[var(--text-caption)] text-[var(--color-text-subtle)]">
            Read at{' '}
            <time data-visual-volatile dateTime={report.generated_at}>
              {new Date(report.generated_at).toLocaleTimeString()}
            </time>
            . Refreshes automatically every 30 seconds.
          </p>
        </div>
      )}
    </>
  );
}
