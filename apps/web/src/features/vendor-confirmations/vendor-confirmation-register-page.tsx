import { useState } from 'react';
import { Link } from 'react-router-dom';
import { HandCoins, Search } from 'lucide-react';

import type { CheckInSummary } from '@finora/shared-types';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/field';
import { SkeletonText } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/workflow/status-badge';
import { PageHeader } from '@/features/shared/page-header';
import { CurrencyTotals } from '@/features/payments/currency-totals';
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

function CheckInRow({ row }: { row: CheckInSummary }) {
  const status = headlineStatus(
    row.standing,
    row.standing_label,
    row.review_outcome ?? null,
    row.review_outcome_label ?? null,
  );
  const waiting = waitingOn(row.standing);

  return (
    <li className="border-b border-[var(--color-divider)] last:border-b-0">
      <Link
        to={`/vendor-confirmations/${row.id}`}
        className={cn(
          'motion-interactive flex flex-col gap-[var(--space-2)] px-[var(--space-5)] py-[var(--space-4)]',
          'no-underline hover:bg-[var(--color-surface-subtle)]',
          'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-focus-ring)]',
          'sm:flex-row sm:items-center sm:gap-[var(--space-5)]',
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="m-0 flex flex-wrap items-baseline gap-x-[var(--space-2)]">
            <span className="tabular text-[var(--text-caption)] text-[var(--color-text-subtle)]">
              {row.reference}
            </span>
            <span className="truncate font-semibold text-[var(--color-text-strong)]">
              {row.vendor_name}
            </span>
          </p>
          <p className="m-0 truncate text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
            {coverage(row.invoice_count)} in {row.package_reference}
            {/* What they said, always attributed, and never in place of the
                status. A row reading "Paid" because a supplier said so is the
                exact confusion this whole feature exists to prevent. */}
            {row.claim_label ? ` · they say: ${row.claim_label.toLowerCase()}` : ''}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-[var(--space-4)]">
          {waiting ? (
            <span
              className={cn(
                'text-[var(--text-body-sm)]',
                waiting.tone === 'warning'
                  ? 'font-semibold text-[var(--color-warning-700)]'
                  : 'text-[var(--color-text-muted)]',
              )}
            >
              {waiting.label}
            </span>
          ) : null}

          <CurrencyTotals totals={row.totals} align="right" className="min-w-[9rem]" />

          <ToneBadge label={status.label} tone={status.tone} />
        </div>
      </Link>
    </li>
  );
}

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
        purpose="Whether the money we sent actually arrived. A supplier's answer is evidence; only a review here settles it."
      />

      <div className="mb-[var(--space-4)] flex flex-col gap-[var(--space-3)] lg:flex-row lg:items-center lg:justify-between">
        <div role="group" aria-label="Choose a view" className="flex flex-wrap gap-[var(--space-2)]">
          {VIEWS.map((option) => (
            <Button
              key={option.id}
              variant={viewId === option.id ? 'primary' : 'ghost'}
              size="sm"
              aria-pressed={viewId === option.id}
              onClick={() => {
                setViewId(option.id);
                setPage(1);
              }}
            >
              {option.label}
            </Button>
          ))}
        </div>

        <div className="relative lg:w-80">
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
            className="pl-9"
          />
        </div>
      </div>

      {isError ? (
        <Card className="mb-[var(--space-6)] border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              Could not load the queue
            </p>
            <p className="mt-2 m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
              {error instanceof Error ? error.message : 'The request did not complete.'} Nothing
              has been lost; every answer a supplier has given is stored and will still be here.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-[var(--space-5)]">
              <SkeletonText lines={5} />
            </div>
          ) : rows.length === 0 ? (
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
          ) : (
            <ul className="m-0 list-none p-0">
              {rows.map((row) => (
                <CheckInRow key={row.id} row={row} />
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
