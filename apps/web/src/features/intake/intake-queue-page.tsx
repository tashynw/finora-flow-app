import { useState } from 'react';
import { Inbox, Paperclip, RefreshCw, ShieldAlert, Upload } from 'lucide-react';
import { Link } from 'react-router-dom';

import type { IntakeStatus, MessageSummary } from '@finora/shared-types';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonText } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/workflow/status-badge';
import { PageHeader } from '@/features/shared/page-header';
import { INTAKE_SOURCE, INTAKE_STATUS } from '@/features/intake/intake-vocabulary';
import { PAGE_SIZE, useMessages } from '@/features/intake/use-intake';
import { UploadDialog } from '@/features/intake/upload-dialog';

const FILTERS: { value: IntakeStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'ready', label: 'Ready to review' },
  { value: 'quarantined', label: 'Quarantined' },
  { value: 'failed', label: 'Needs attention' },
  { value: 'scanning', label: 'Scanning' },
];

/** Absolute time with a relative hint, because "2 hours ago" alone is useless in
 * an audit conversation and an absolute timestamp alone is hard to scan. */
function formatReceived(iso: string): { absolute: string; relative: string } {
  const date = new Date(iso);
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);

  let relative: string;
  if (minutes < 1) relative = 'just now';
  else if (minutes < 60) relative = `${minutes} min ago`;
  else if (minutes < 60 * 24) relative = `${Math.round(minutes / 60)} h ago`;
  else relative = `${Math.round(minutes / (60 * 24))} d ago`;

  return {
    absolute: date.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
    relative,
  };
}

function MessageRow({ message }: { message: MessageSummary }) {
  const status = INTAKE_STATUS[message.status];
  const received = formatReceived(message.received_at);

  return (
    <li className="border-b border-[var(--color-divider)] last:border-b-0">
      <Link
        to={`/intake/${message.id}`}
        className={cn(
          'motion-interactive flex flex-col gap-[var(--space-2)] px-[var(--space-5)] py-[var(--space-4)]',
          'no-underline hover:bg-[var(--color-surface-subtle)]',
          'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-focus-ring)]',
          'sm:flex-row sm:items-center sm:gap-[var(--space-5)]',
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="m-0 truncate font-semibold text-[var(--color-text-strong)]">
            {message.subject || 'No subject'}
          </p>
          <p className="m-0 truncate text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
            {message.from_display_name ?? message.from_address ?? 'Unknown sender'}
            {message.forwarded_from_address ? (
              <>
                {' '}
                <span className="text-[var(--color-text-subtle)]">
                  (forwarded from {message.forwarded_from_address})
                </span>
              </>
            ) : null}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-[var(--space-4)]">
          {message.attachment_count > 0 ? (
            <span className="inline-flex items-center gap-1 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
              <Paperclip aria-hidden="true" className="size-3.5" />
              {message.attachment_count}
              <span className="sr-only">
                {message.attachment_count === 1 ? 'attachment' : 'attachments'}
              </span>
            </span>
          ) : null}

          {message.quarantined_count > 0 ? (
            <span className="inline-flex items-center gap-1 text-[var(--text-body-sm)] font-semibold text-[var(--color-danger-700)]">
              <ShieldAlert aria-hidden="true" className="size-3.5" />
              {message.quarantined_count} quarantined
            </span>
          ) : null}

          <span className="text-[var(--text-caption)] text-[var(--color-text-subtle)]">
            {INTAKE_SOURCE[message.source]}
          </span>

          <ToneBadge label={status.label} tone={status.tone} />

          <time
            data-visual-volatile
            dateTime={message.received_at}
            title={received.absolute}
            className="w-[5.5rem] shrink-0 text-right text-[var(--text-caption)] text-[var(--color-text-subtle)]"
          >
            {received.relative}
          </time>
        </div>
      </Link>
    </li>
  );
}

/**
 * Intake queue.
 *
 * The list is deliberately honest about files it will not let you open: a
 * quarantined count is shown on the row rather than discovered on click, so
 * nobody plans work around a document they cannot get to.
 */
export function IntakeQueuePage() {
  const [filter, setFilter] = useState<IntakeStatus | 'all'>('all');
  const [offset, setOffset] = useState(0);
  const [uploadOpen, setUploadOpen] = useState(false);

  const { data, isLoading, isError, error, refetch, isFetching } = useMessages(
    filter,
    offset,
  );

  const total = data?.total ?? 0;
  const items = data?.items ?? [];
  const showingTo = offset + items.length;

  return (
    <>
      <PageHeader
        title="Intake"
        purpose="Everything that has arrived by mailbox or upload, and what still needs a person."
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
            <Button variant="primary" onClick={() => setUploadOpen(true)}>
              <Upload aria-hidden="true" className="size-4" />
              Upload a document
            </Button>
          </>
        }
      />

      <div
        role="group"
        aria-label="Filter by status"
        className="mb-[var(--space-4)] flex flex-wrap gap-[var(--space-2)]"
      >
        {FILTERS.map((option) => (
          <Button
            key={option.value}
            variant={filter === option.value ? 'primary' : 'ghost'}
            size="sm"
            aria-pressed={filter === option.value}
            onClick={() => {
              setFilter(option.value);
              setOffset(0);
            }}
          >
            {option.label}
          </Button>
        ))}
      </div>

      {isError ? (
        <Card className="mb-[var(--space-6)] border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              Could not load the intake queue
            </p>
            <p className="mt-2 m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
              {error instanceof Error
                ? error.message
                : 'The request did not complete.'}{' '}
              Nothing has been lost; messages stay in the mailbox until they are
              collected.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-[var(--space-5)]">
              <SkeletonText lines={6} />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title={
                filter === 'all'
                  ? 'Nothing has arrived yet'
                  : `Nothing is ${INTAKE_STATUS[filter].label.toLowerCase()}`
              }
              explanation={
                filter === 'all'
                  ? 'No invoices or estimates have been forwarded to the mailbox, and nothing has been uploaded.'
                  : INTAKE_STATUS[filter].description
              }
              nextStep={
                filter === 'all'
                  ? 'Forward an invoice to the intake mailbox, or upload a document directly.'
                  : 'Change the filter to see everything that has arrived.'
              }
              action={
                filter === 'all'
                  ? { label: 'Upload a document', onClick: () => setUploadOpen(true) }
                  : { label: 'Show everything', onClick: () => setFilter('all') }
              }
            />
          ) : (
            <ul className="m-0 list-none p-0">
              {items.map((message) => (
                <MessageRow key={message.id} message={message} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {total > PAGE_SIZE ? (
        <nav
          aria-label="Pagination"
          className="mt-[var(--space-4)] flex items-center justify-between gap-[var(--space-4)]"
        >
          <p
            aria-live="polite"
            className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]"
          >
            Showing {offset + 1} to {showingTo} of {total}
          </p>
          <div className="flex gap-[var(--space-2)]">
            <Button
              variant="secondary"
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={showingTo >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </nav>
      ) : null}

      <UploadDialog open={uploadOpen} onClose={() => setUploadOpen(false)} />
    </>
  );
}
