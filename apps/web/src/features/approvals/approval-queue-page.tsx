import { useState } from 'react';
import { CheckCheck } from 'lucide-react';
import { Link } from 'react-router-dom';

import type { ApprovalQueueItemOut } from '@finora/shared-types';

import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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

function QueueRow({ item }: { item: ApprovalQueueItemOut }) {
  const waited = waitedFor(item.waiting_hours);

  return (
    <li className="border-b border-[var(--color-divider)] last:border-b-0">
      <Link
        to={item.record_path}
        className={cn(
          'motion-interactive flex flex-col gap-[var(--space-2)] px-[var(--space-5)] py-[var(--space-4)]',
          'no-underline hover:bg-[var(--color-surface-subtle)]',
          'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-focus-ring)]',
          'sm:flex-row sm:items-center sm:gap-[var(--space-5)]',
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="m-0 flex flex-wrap items-baseline gap-x-[var(--space-2)]">
            <span className="text-[var(--text-caption)] text-[var(--color-text-subtle)]">
              {item.record_type_label}
            </span>
            <span className="tabular text-[var(--text-caption)] text-[var(--color-text-subtle)]">
              {item.reference}
            </span>
            <span className="truncate font-semibold text-[var(--color-text-strong)]">
              {item.vendor_name || 'No supplier named'}
            </span>
          </p>
          <p className="m-0 truncate text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
            {item.description || 'No description'}
            {item.requester_label ? ` · raised by ${item.requester_label}` : ''}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-[var(--space-4)]">
          {/* Which half of a parallel step is theirs. Without it, two approvers
              looking at the same row cannot tell whether the other one's
              decision has already settled it. */}
          {item.my_levels.length > 0 ? (
            <span className="text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
              as {item.my_levels.join(' and ')}
            </span>
          ) : null}

          {/* Only from the second time round. "Round 1" next to the only round
              there has ever been asks the reader what the others were. */}
          {item.attempt > 1 ? (
            <ToneBadge label={`Back for round ${item.attempt}`} tone="warning" />
          ) : null}

          <span
            className={cn(
              'text-[var(--text-body-sm)]',
              waited.tone === 'danger'
                ? 'font-semibold text-[var(--color-danger-700)]'
                : waited.tone === 'warning'
                  ? 'font-semibold text-[var(--color-warning-700)]'
                  : 'text-[var(--color-text-subtle)]',
            )}
          >
            {waited.label}
          </span>

          <span className="tabular min-w-[8rem] text-right font-semibold text-[var(--color-text-strong)]">
            {item.amount_formatted}
          </span>
        </div>
      </Link>
    </li>
  );
}

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

  return (
    <>
      <PageHeader
        title="Approvals"
        purpose="Everything waiting on you, oldest first, whatever kind of record it is. Deciding happens on the record itself, where the evidence is."
      />

      <div className="mb-[var(--space-4)] flex flex-col gap-[var(--space-3)] lg:flex-row lg:items-center lg:justify-between">
        <div
          role="group"
          aria-label="Filter by record type"
          className="flex flex-wrap gap-[var(--space-2)]"
        >
          {TYPES.map((type) => {
            const on = !excluded.has(type.id);
            const count = counts[type.id] ?? 0;
            return (
              <Button
                key={type.id}
                // Secondary rather than primary, unlike the single-choice view
                // pickers elsewhere. These are all on by default, and three
                // filled buttons at the top of a quiet page shout louder than
                // the work they are filtering.
                variant={on ? 'secondary' : 'ghost'}
                size="sm"
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
              >
                {/* Struck through when excluded. The difference between a
                    bordered and an unbordered button is too quiet to carry the
                    only clue about what a list is leaving out. */}
                <span className={on ? undefined : 'line-through'}>{type.label}</span>
                {count > 0 ? ` (${count})` : ''}
              </Button>
            );
          })}
        </div>

        {hidden > 0 ? (
          <p
            aria-live="polite"
            className="m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]"
          >
            {hidden} {hidden === 1 ? 'item is' : 'items are'} hidden by the filter.
          </p>
        ) : null}
      </div>

      {isError ? (
        <Card className="mb-[var(--space-6)] border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              Could not load your queue
            </p>
            <p className="mt-2 m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
              {errorMessage(error) ?? 'The request did not complete.'} Nothing has been decided
              or missed; this is only the list.
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
                ? {
                    action: {
                      label: 'Show everything',
                      onClick: () => {
                        setExcluded(new Set());
                        setPage(1);
                      },
                    },
                  }
                : {})}
            />
          ) : (
            <ul className="m-0 list-none p-0">
              {items.map((item) => (
                <QueueRow key={item.request_id} item={item} />
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
