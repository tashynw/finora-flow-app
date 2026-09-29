import { useState } from 'react';
import { Inbox, Paperclip, RefreshCw, ShieldAlert, Upload } from 'lucide-react';

import type { IntakeStatus, MessageSummary } from '@finora/shared-types';

import { formatMoment, formatRelative } from '@/lib/dates';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonText } from '@/components/ui/skeleton';
import { ViewTabs } from '@/components/ui/view-tabs';
import { ToneBadge } from '@/components/workflow/status-badge';
import { PageHeader } from '@/features/shared/page-header';
import { INTAKE_SOURCE, INTAKE_STATUS } from '@/features/intake/intake-vocabulary';
import { PAGE_SIZE, useMessages } from '@/features/intake/use-intake';
import { UploadDialog } from '@/features/intake/upload-dialog';

const FILTERS: { id: IntakeStatus | 'all'; label: string }[] = [
  { id: 'all', label: 'Everything' },
  { id: 'ready', label: 'Ready to review' },
  { id: 'quarantined', label: 'Quarantined' },
  { id: 'failed', label: 'Needs attention' },
  { id: 'scanning', label: 'Scanning' },
];

const messageColumns: Column<MessageSummary>[] = [
  {
    key: 'message',
    header: 'Message',
    cell: (message) => (
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-[var(--color-text-strong)]">
          {message.subject || 'No subject'}
        </span>
        <span className="truncate text-[11px] text-[var(--color-text-subtle)]">
          {message.from_display_name ?? message.from_address ?? 'Unknown sender'}
          {message.forwarded_from_address
            ? ` (forwarded from ${message.forwarded_from_address})`
            : ''}
        </span>
      </span>
    ),
  },
  {
    key: 'source',
    header: 'Source',
    width: 'w-36',
    hideBelow: 'sm',
    cell: (message) => <span>{INTAKE_SOURCE[message.source]}</span>,
  },
  {
    key: 'attachments',
    header: 'Attachments',
    width: 'w-40',
    cell: (message) => (
      // A quarantined count is shown on the row rather than discovered on
      // click, so nobody plans work around a document they cannot get to.
      <span className="flex flex-col">
        <span className="inline-flex items-center gap-1">
          <Paperclip aria-hidden="true" className="size-3.5 text-[var(--color-text-subtle)]" />
          {message.attachment_count} {message.attachment_count === 1 ? 'file' : 'files'}
        </span>
        {message.quarantined_count > 0 ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--color-danger-700)]">
            <ShieldAlert aria-hidden="true" className="size-3" />
            {message.quarantined_count} quarantined
          </span>
        ) : null}
      </span>
    ),
  },
  {
    key: 'received',
    header: 'Received',
    width: 'w-44',
    hideBelow: 'md',
    // Absolute time with a relative hint, because "2 hours ago" alone is
    // useless in an audit conversation and an absolute timestamp alone is hard
    // to scan.
    cell: (message) => (
      <time dateTime={message.received_at} className="flex flex-col">
        <span>{formatMoment(message.received_at)}</span>
        <span data-visual-volatile className="text-[11px] text-[var(--color-text-subtle)]">
          {formatRelative(message.received_at)}
        </span>
      </time>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    width: 'w-44',
    cell: (message) => {
      const status = INTAKE_STATUS[message.status];
      return <ToneBadge label={status.label} tone={status.tone} />;
    },
  },
];

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
        title="Inbox"
        purpose="Forwarded mail and manually uploaded finance documents."
        toolbar={
          <ViewTabs
            tabs={FILTERS}
            value={filter}
            label="Filter by status"
            onChange={(id) => {
              setFilter(id as IntakeStatus | 'all');
              setOffset(0);
            }}
          />
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
            <Button variant="primary" size="sm" onClick={() => setUploadOpen(true)}>
              <Upload aria-hidden="true" className="size-4" />
              Upload
            </Button>
          </>
        }
      />

      {isError ? (
        <Card className="mb-[var(--space-6)] border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              Could not load the intake queue
            </p>
            <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              {error instanceof Error
                ? error.message
                : 'The request did not complete.'}{' '}
              Nothing has been lost; messages stay in the mailbox until they are
              collected.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {isLoading ? (
        <Card>
          <CardContent>
            <SkeletonText lines={6} />
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-0">
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
          </CardContent>
        </Card>
      ) : (
        <DataTable
          ariaLabel="Messages received"
          columns={messageColumns}
          rows={items}
          getRowKey={(message) => message.id}
          getRowHref={(message) => `/intake/${message.id}`}
        />
      )}

      {total > PAGE_SIZE ? (
        <nav
          aria-label="Pagination"
          className="mt-[var(--space-4)] flex items-center justify-between gap-[var(--space-4)]"
        >
          <p
            aria-live="polite"
            className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]"
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
