import { useState } from 'react';
import { HandCoins, Search } from 'lucide-react';

import type { CheckInSummary } from '@finora/shared-types';

import { cn } from '@/lib/utils';
import { formatMoment } from '@/lib/dates';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { ViewTabs } from '@/components/ui/view-tabs';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/field';
import { SkeletonText } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/workflow/status-badge';
import { PageHeader } from '@/features/shared/page-header';
import {
  coverage,
  headlineStatus,
  waitingOn,
} from '@/features/vendor-confirmations/confirmation-vocabulary';
import {
  type CheckInFilters,
  NO_FILTERS,
  PAGE_SIZE,
  useVendorCheckIns,
} from '@/features/vendor-confirmations/use-vendor-check-ins';

/**
 * The review queue.
 *
 * Ordered and filtered around one question: whose turn is it? A check-in a
 * supplier has answered is waiting on somebody here and leads; one still out
 * with the supplier is waiting on them; a reviewed one is waiting on nobody and
 * is history. The default view is therefore the work rather than everything,
 * because a queue that opens on six months of concluded conversations is a queue
 * people stop opening.
 *
 * Nothing in a row is ever green on the strength of what a supplier said. The
 * badge shows the review outcome once there is one and the standing until then,
 * so "Paid" appears here only after somebody here decided it.
 */
interface RegisterView {
  id: string;
  label: string;
  filters: CheckInFilters;
  empty: string;
  emptyExplanation: string;
  nextStep: string;
}

const VIEWS: RegisterView[] = [
  {
    id: 'to-review',
    label: 'Needs a decision',
    filters: { ...NO_FILTERS, standing: ['vendor_answered'] },
    empty: 'Nothing is waiting on you',
    emptyExplanation:
      'A supplier who answers appears here until somebody weighs what they said against our own record and concludes.',
    nextStep:
      'Nothing to do. Check what is still out with suppliers if you want to see what is coming.',
  },
  {
    id: 'awaiting',
    label: 'Out with suppliers',
    filters: { ...NO_FILTERS, standing: ['not_sent', 'awaiting_vendor'] },
    empty: 'Nobody is being asked anything',
    emptyExplanation:
      'After a package goes to the bank, one question goes to each supplier in it asking whether the money arrived. Those questions live here until they are answered.',
    nextStep:
      'Open a submitted payment package and ask its suppliers, or wait for the next payment run.',
  },
  {
    id: 'reviewed',
    label: 'Concluded',
    filters: { ...NO_FILTERS, standing: ['reviewed'] },
    empty: 'Nothing has been concluded yet',
    emptyExplanation:
      'A concluded check-in records who decided, what they decided and what the supplier had told them — including where the two disagreed.',
    nextStep: 'Conclusions appear here as reviewers reach them.',
  },
  {
    id: 'all',
    label: 'Everything',
    filters: NO_FILTERS,
    empty: 'No supplier check-ins yet',
    emptyExplanation:
      'Submitting a package records that an instruction went to the bank. It does not record that anybody was paid, and this is where that gap gets closed.',
    nextStep: 'Send a payment package to the bank, then ask its suppliers whether it arrived.',
  },
];

const checkInColumns: Column<CheckInSummary>[] = [
  {
    key: 'reference',
    header: 'Reference',
    width: 'w-40',
    cell: (row) => (
      <span className="flex flex-col">
        <span className="tabular font-medium text-[var(--color-text-strong)]">
          {row.reference}
        </span>
        <span className="tabular text-[11px] text-[var(--color-text-subtle)]">
          in {row.package_reference}
        </span>
      </span>
    ),
  },
  {
    key: 'supplier',
    header: 'Supplier',
    cell: (row) => (
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{row.vendor_name}</span>
        {/* What they said, always attributed, and never in place of the
            status. A row reading "Paid" because a supplier said so is the
            exact confusion this whole feature exists to prevent. */}
        {row.claim_label ? (
          <span className="truncate text-[11px] text-[var(--color-text-subtle)]">
            they say: {row.claim_label.toLowerCase()}
          </span>
        ) : null}
      </span>
    ),
  },
  {
    key: 'amount',
    header: 'Amount',
    width: 'w-40',
    cell: (row) => (
      <span className="flex flex-col">
        {row.totals.length === 0 ? (
          <span className="text-[var(--color-text-subtle)]">Nothing yet</span>
        ) : (
          row.totals.map((total) => (
            <span key={total.currency} className="tabular">
              {total.formatted}
            </span>
          ))
        )}
        <span className="text-[11px] text-[var(--color-text-subtle)]">
          {coverage(row.invoice_count)}
        </span>
      </span>
    ),
  },
  {
    key: 'waiting',
    header: 'Waiting on',
    hideBelow: 'md',
    cell: (row) => {
      const waiting = waitingOn(row.standing);
      if (!waiting) return <span>—</span>;
      return (
        <span
          className={cn(
            waiting.tone === 'warning' && 'font-medium text-[var(--color-warning-700)]',
          )}
        >
          {waiting.label}
        </span>
      );
    },
  },
  {
    key: 'status',
    header: 'Status',
    width: 'w-48',
    cell: (row) => {
      const status = headlineStatus(
        row.standing,
        row.standing_label,
        row.review_outcome ?? null,
        row.review_outcome_label ?? null,
      );
      return <ToneBadge label={status.label} tone={status.tone} />;
    },
  },
  {
    key: 'activity',
    header: 'Last activity',
    width: 'w-40',
    hideBelow: 'lg',
    cell: (row) =>
      row.reviewed_at ? (
        <span>Reviewed {formatMoment(row.reviewed_at)}</span>
      ) : row.answered_at ? (
        <span>Answered {formatMoment(row.answered_at)}</span>
      ) : row.sent_at ? (
        <span>Asked {formatMoment(row.sent_at)}</span>
      ) : (
        <span>—</span>
      ),
  },
];

export function VendorConfirmationRegisterPage() {
  const [viewId, setViewId] = useState('to-review');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const view = VIEWS.find((option) => option.id === viewId) ?? VIEWS[0]!;
  const filters: CheckInFilters = { ...view.filters, search };

  const { data, isLoading, isError, error } = useVendorCheckIns(filters, page);

  const total = data?.total ?? 0;
  const rows = data?.rows ?? [];
  const showingFrom = (page - 1) * PAGE_SIZE + 1;
  const showingTo = (page - 1) * PAGE_SIZE + rows.length;
  const searching = search.trim().length > 0;

  return (
    <>
      <PageHeader
        title="Vendor confirmations"
        purpose="Supplier payment confirmations requiring review. A supplier's answer is evidence; only a review here settles it."
        toolbar={
          <div className="flex flex-col gap-[var(--space-3)] md:flex-row md:items-center md:justify-between">
            <ViewTabs
              tabs={VIEWS}
              value={view.id}
              onChange={(id) => {
                setViewId(id);
                setPage(1);
              }}
            />
            <div className="relative md:w-72">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-[var(--space-3)] size-4 -translate-y-1/2 text-[var(--color-text-subtle)]"
              />
              <Input
                type="search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
                placeholder="Our reference or the supplier's name"
                aria-label="Search supplier check-ins"
                className="h-9 pl-9 text-[12px]"
              />
            </div>
          </div>
        }
      />

      {isError ? (
        <Card className="mb-[var(--space-6)] border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              Could not load the queue
            </p>
            <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              {error instanceof Error ? error.message : 'The request did not complete.'} Nothing
              has been lost; every answer a supplier has given is stored and will still be here.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {isLoading ? (
        <Card>
          <CardContent>
            <SkeletonText lines={5} />
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={searching ? Search : HandCoins}
              title={searching ? `Nothing matches “${search.trim()}”` : view.empty}
              explanation={
                searching
                  ? 'The search looks at our own reference and the supplier’s name, within the view you are in.'
                  : view.emptyExplanation
              }
              nextStep={
                searching ? 'Clear the search, or widen the view to everything.' : view.nextStep
              }
              {...(searching
                ? { action: { label: 'Clear the search', onClick: () => setSearch('') } }
                : {})}
              {...(searching || viewId === 'all'
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
          ariaLabel="Supplier check-ins"
          columns={checkInColumns}
          rows={rows}
          getRowKey={(row) => row.id}
          getRowHref={(row) => `/vendor-confirmations/${row.id}`}
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
