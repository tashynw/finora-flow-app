import { useState } from 'react';
import { FileText, Play, RefreshCw } from 'lucide-react';

import type { DocumentKind, DocumentSummary, ExtractionStatus } from '@finora/shared-types';

import { formatMoment, formatRelative } from '@/lib/dates';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonText } from '@/components/ui/skeleton';
import { ViewTabs } from '@/components/ui/view-tabs';
import { ToneBadge } from '@/components/workflow/status-badge';
import { PageHeader } from '@/features/shared/page-header';
import {
  EXTRACTION_STATUS,
  formatConfidence,
} from '@/features/documents/document-vocabulary';
import { PAGE_SIZE, useDocuments, useReadPending } from '@/features/documents/use-documents';

/**
 * The filters, each with what to say when it matches nothing.
 *
 * Written out per filter rather than composed from the status descriptions, for
 * two reasons. Composing the heading produces "Nothing is needs review", which a
 * reviewer has to decode. And a status description describes a document, so
 * reusing it here explains a document that is not there.
 */
const FILTERS: {
  id: ExtractionStatus | 'all';
  label: string;
  empty: string;
  emptyExplanation: string;
}[] = [
  {
    id: 'needs_review',
    label: 'Needs review',
    empty: 'Nothing needs review',
    emptyExplanation:
      'Every document that has been read was either clear enough to stand on its own or has already been checked by a person.',
  },
  {
    id: 'extracted',
    label: 'Ready to accept',
    empty: 'Nothing is ready to accept',
    emptyExplanation:
      'A document waits here once every value has been read confidently or checked, and until someone accepts the reading.',
  },
  {
    id: 'accepted',
    label: 'Accepted',
    empty: 'Nothing has been accepted yet',
    emptyExplanation:
      'Accepting a reading is what makes its values available to the rest of the platform, and only a person can do it.',
  },
  {
    id: 'manual_entry_required',
    label: 'Type it in',
    empty: 'Nothing needs typing in by hand',
    emptyExplanation:
      'A document lands here when nothing could be read from it at all, most often a scan with no text in it.',
  },
  {
    id: 'pending',
    label: 'Waiting to be read',
    empty: 'Nothing is waiting to be read',
    emptyExplanation:
      'Reading starts by itself shortly after a document arrives, so this is empty most of the time.',
  },
  {
    id: 'failed',
    label: 'Could not be read',
    empty: 'Every document could be read',
    emptyExplanation:
      'A document lands here when reading it failed outright. The file itself is never harmed by that, and reading can be tried again.',
  },
  {
    id: 'all',
    label: 'Everything',
    empty: 'No documents yet',
    emptyExplanation:
      'Documents appear here once an invoice or estimate has arrived by mailbox or been uploaded.',
  },
];

const documentColumns: Column<DocumentSummary>[] = [
  {
    key: 'document',
    header: 'Document',
    cell: (document) => (
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-[var(--color-text-strong)]">
          {document.filename}
        </span>
        <span className="truncate text-[11px] text-[var(--color-text-subtle)]">
          {document.subject || 'Uploaded directly'}
        </span>
      </span>
    ),
  },
  {
    key: 'kind',
    header: 'Kind',
    width: 'w-36',
    hideBelow: 'sm',
    cell: (document) => <span>{document.kind_label}</span>,
  },
  {
    key: 'confidence',
    header: 'Lowest confidence',
    width: 'w-40',
    cell: (document) => (
      // The weakest value in the reading, because a document is only as
      // trustworthy as the least certain thing read from it.
      <span className="flex flex-col">
        <span className="tabular">
          {document.lowest_confidence !== null
            ? formatConfidence(document.lowest_confidence)
            : '—'}
        </span>
        {document.fields_needing_attention > 0 ? (
          <span className="text-[11px] font-medium text-[var(--color-warning-700)]">
            {document.fields_needing_attention}{' '}
            {document.fields_needing_attention === 1 ? 'value' : 'values'} to check
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
    cell: (document) => (
      <span className="flex flex-col">
        <span>{formatMoment(document.created_at)}</span>
        <span data-visual-volatile className="text-[11px] text-[var(--color-text-subtle)]">
          {formatRelative(document.created_at)}
        </span>
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    width: 'w-44',
    cell: (document) => {
      const status = EXTRACTION_STATUS[document.status];
      return (
        <span className="flex flex-col items-start gap-1">
          <ToneBadge label={status.label} tone={status.tone} />
          {document.signal_count > 0 ? (
            <span className="text-[11px] text-[var(--color-text-subtle)]">
              {document.signal_count} {document.signal_count === 1 ? 'warning' : 'warnings'}
            </span>
          ) : null}
        </span>
      );
    },
  },
  {
    key: 'from',
    header: 'From',
    width: 'w-48',
    hideBelow: 'lg',
    cell: (document) => (
      <span className="block truncate">{document.from_address ?? 'Uploaded directly'}</span>
    ),
  },
];

/**
 * The documents waiting to be read and reviewed.
 *
 * Oldest first, unlike the intake list. Intake is a record of what arrived and is
 * read newest first; this is a work queue, and the document that has waited
 * longest is the one to do next.
 *
 * Each row shows the weakest value in the reading rather than an average. An
 * average confidence would let one badly read total hide behind eleven good ones.
 */
export function DocumentQueuePage() {
  const [filter, setFilter] = useState<ExtractionStatus | 'all'>('needs_review');
  const [kind] = useState<DocumentKind | 'all'>('all');
  const [offset, setOffset] = useState(0);

  const { data, isLoading, isError, error, refetch, isFetching } = useDocuments(
    filter,
    kind,
    offset,
  );
  const readPending = useReadPending();

  const total = data?.total ?? 0;
  const items = data?.items ?? [];
  const showingTo = offset + items.length;
  const current = FILTERS.find((option) => option.id === filter);

  return (
    <>
      <PageHeader
        title="Documents"
        purpose="Extracted documents and field review."
        toolbar={
          <ViewTabs
            tabs={FILTERS}
            value={filter}
            label="Filter by state"
            onChange={(id) => {
              setFilter(id as ExtractionStatus | 'all');
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
            <Button
              variant="primary"
              size="sm"
              onClick={() => readPending.mutate()}
              isLoading={readPending.isPending}
              loadingLabel="Starting"
            >
              <Play aria-hidden="true" className="size-4" />
              Read what is waiting
            </Button>
          </>
        }
      />

      {readPending.data ? (
        <p
          aria-live="polite"
          className="mb-[var(--space-4)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]"
        >
          {readPending.data.detail}
        </p>
      ) : null}

      {isError ? (
        <Card className="mb-[var(--space-6)] border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              Could not load the document list
            </p>
            <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              {error instanceof Error ? error.message : 'The request did not complete.'}{' '}
              Nothing has been lost; every document is stored and will still be here.
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
              icon={FileText}
              title={current?.empty ?? 'Nothing here'}
              explanation={current?.emptyExplanation ?? ''}
              nextStep={
                filter === 'all'
                  ? 'Upload a document from the intake screen, or forward one to the intake mailbox.'
                  : 'Change the filter to see every document, or go to intake to add one.'
              }
              action={
                filter === 'all'
                  ? { label: 'Go to intake', to: '/intake' }
                  : { label: 'Show everything', onClick: () => setFilter('all') }
              }
              // Somewhere to go is offered on every filter, not only on
              // "everything", so that clearing the queue is not a dead end whose
              // only exit changes which emptiness is being looked at.
              {...(filter === 'all'
                ? {}
                : { secondaryAction: { label: 'Go to intake', to: '/intake' } })}
            />
          </CardContent>
        </Card>
      ) : (
        <DataTable
          ariaLabel="Documents"
          columns={documentColumns}
          rows={items}
          getRowKey={(document) => document.id}
          getRowHref={(document) => `/documents/${document.id}`}
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
    </>
  );
}
