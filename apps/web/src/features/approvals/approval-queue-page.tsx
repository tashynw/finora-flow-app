import { useState } from 'react';
import { CheckCheck } from 'lucide-react';

import type { ApprovalQueueItemOut } from '@finora/shared-types';

import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonText } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/workflow/status-badge';
import { PageHeader } from '@/features/shared/page-header';
import { waitedFor } from '@/features/approvals/approval-vocabulary';
import { PAGE_SIZE, useApprovalQueue } from '@/features/approvals/use-approval-queue';

/**
 * One queue for everything waiting on this approver.
 *
 * Oldest first, and not reorderable. A work queue whose order the reader can
 * change is a work queue where the awkward item stays at the bottom, and the
 * whole point of a single queue is that nothing hides behind a record type
 * somebody visits less often.
 *
 * The filters subtract rather than add: everything is shown until a type is
 * excluded, and the count of what a filter is hiding stays on screen.
 */
const TYPES = [
  { id: 'estimate', label: 'Estimates' },
  { id: 'invoice', label: 'Invoices' },
  { id: 'purchase_order', label: 'Purchase orders' },
] as const;

/** A toggle in the same visual language as `ViewTabs`, for filters that are not single-choice. */
const PILL = cn(
  'inline-flex h-9 items-center gap-1 rounded-[var(--radius-md)] px-3.5',
  'text-[12px] font-medium whitespace-nowrap',
  'transition-colors duration-[var(--duration-fast)]',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary-600)]',
);
/** An included type: quiet, because several are on at once. */
const PILL_ON =
  'border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-text-strong)] hover:border-[var(--color-border-strong)]';
const PILL_OFF =
  'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text-strong)]';

const queueColumns: Column<ApprovalQueueItemOut>[] = [
  {
    key: 'reference',
    header: 'Reference',
    width: 'w-40',
    cell: (item) => (
      <span className="flex flex-col">
        <span className="tabular font-medium text-[var(--color-text-strong)]">
          {item.reference}
        </span>
        <span className="text-[11px] text-[var(--color-text-subtle)]">
          {item.record_type_label}
        </span>
      </span>
    ),
  },
  {
    key: 'counterparty',
    header: 'Counterparty',
    cell: (item) => (
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{item.vendor_name || 'No supplier named'}</span>
        <span className="truncate text-[11px] text-[var(--color-text-subtle)]">
          {item.description || 'No description'}
        </span>
      </span>
    ),
  },
  {
    key: 'amount',
    header: 'Amount',
    width: 'w-36',
    cell: (item) => <span className="tabular">{item.amount_formatted}</span>,
  },
  {
    key: 'waiting',
    header: 'Waiting on',
    hideBelow: 'md',
    cell: (item) => {
      const waited = waitedFor(item.waiting_hours);
      return (
        <span className="flex flex-col">
          {/* Which half of a parallel step is theirs. Without it, two approvers
              looking at the same row cannot tell whether the other one's
              decision has already settled it. */}
          <span>
            {item.my_levels.length > 0
              ? `You, as ${item.my_levels.join(' and ')}`
              : item.awaiting_labels.join(', ') || '—'}
          </span>
          <span
            // Counted from now, so the same row reads differently tomorrow.
            data-visual-volatile
            className={cn(
              'text-[11px]',
              waited.tone === 'danger'
                ? 'font-medium text-[var(--color-danger-700)]'
                : waited.tone === 'warning'
                  ? 'font-medium text-[var(--color-warning-700)]'
                  : 'text-[var(--color-text-subtle)]',
            )}
          >
            {waited.label}
          </span>
        </span>
      );
    },
  },
  {
    key: 'status',
    header: 'Status',
    width: 'w-44',
    cell: (item) =>
      // Only from the second time round. "Round 1" next to the only round
      // there has ever been asks the reader what the others were.
      item.attempt > 1 ? (
        <ToneBadge label={`Back for round ${item.attempt}`} tone="warning" />
      ) : (
        <ToneBadge label="Yours to decide" tone="progress" />
      ),
  },
  {
    key: 'owner',
    header: 'Raised by',
    width: 'w-40',
    hideBelow: 'lg',
    cell: (item) => <span>{item.requester_label ?? '—'}</span>,
  },
];

export function ApprovalQueuePage() {
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [page, setPage] = useState(1);

  const included = TYPES.filter((type) => !excluded.has(type.id)).map((type) => type.id);
  const filtering = excluded.size > 0;

  const { data, isLoading, isError, error } = useApprovalQueue(
    // An empty list means "everything" to the API. Sending every type
    // explicitly would say the same thing in a way that breaks the moment a
    // fourth record type joins the matrix.
    filtering ? included : [],
    page,
  );

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const counts = data?.counts_by_type ?? {};
  const everything = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const hidden = everything - total;

  const showingFrom = (page - 1) * PAGE_SIZE + 1;
  const showingTo = (page - 1) * PAGE_SIZE + items.length;

  function showEverything() {
    setExcluded(new Set());
    setPage(1);
  }

  return (
    <>
      <PageHeader
        title="Approvals"
        purpose="Decisions routed to you across estimates, invoices and purchase orders."
        toolbar={
          <div className="flex flex-wrap items-center gap-x-[var(--space-4)] gap-y-[var(--space-2)]">
            <div
              role="group"
              aria-label="Filter by record type"
              className="flex flex-wrap items-center gap-1"
            >
              {TYPES.map((type) => {
                const on = !excluded.has(type.id);
                const count = counts[type.id] ?? 0;
                return (
                  <button
                    key={type.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      setExcluded((current) => {
                        const next = new Set(current);
                        if (next.has(type.id)) next.delete(type.id);
                        else next.add(type.id);
                        return next;
                      });
                      setPage(1);
                    }}
                    className={cn(PILL, on ? PILL_ON : PILL_OFF)}
                  >
                    {/* Struck through when excluded. The difference between a
                        dark and a plain pill is too quiet to carry the only
                        clue about what a list is leaving out. */}
                    <span className={on ? undefined : 'line-through'}>{type.label}</span>
                    {count > 0 ? <span className="tabular opacity-70">{count}</span> : null}
                  </button>
                );
              })}
            </div>

            {hidden > 0 ? (
              <p aria-live="polite" className="m-0 text-[12px] text-[var(--color-text-muted)]">
                {hidden} {hidden === 1 ? 'item is' : 'items are'} hidden by the filter.
              </p>
            ) : null}
          </div>
        }
      />

      {isError ? (
        <Card className="mb-[var(--space-6)] border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              Could not load your queue
            </p>
            <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              {errorMessage(error) ?? 'The request did not complete.'} Nothing has been decided
              or missed; this is only the list.
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
              icon={CheckCheck}
              title={filtering ? 'Nothing here in the kinds you are showing' : 'Nothing is waiting on you'}
              explanation={
                filtering
                  ? `${hidden} ${hidden === 1 ? 'item is' : 'items are'} waiting in the kinds you have hidden.`
                  : 'Work appears here the moment a route reaches a step you can decide. Anything you raised yourself never appears, whatever levels you hold.'
              }
              nextStep={
                filtering
                  ? 'Show every kind to see the rest.'
                  : 'Nothing is needed from you. Records you have already decided are on the record itself, with your decision against them.'
              }
              {...(filtering
                ? { action: { label: 'Show everything', onClick: showEverything } }
                : {})}
            />
          </CardContent>
        </Card>
      ) : (
        <DataTable
          ariaLabel="Approvals waiting on you"
          columns={queueColumns}
          rows={items}
          getRowKey={(item) => item.request_id}
          getRowHref={(item) => item.record_path}
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
            Showing {showingFrom} to {showingTo} of {total}
          </p>
          <div className="flex gap-[var(--space-2)]">
            <Button
              variant="secondary"
              size="sm"
              disabled={page === 1}
              onClick={() => setPage(Math.max(1, page - 1))}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={showingTo >= total}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </nav>
      ) : null}
    </>
  );
}
