import { useState } from 'react';
import { FileSpreadsheet, Plus, Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import type { EstimateSummary } from '@finora/shared-types';

import { formatDate } from '@/lib/dates';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { ViewTabs } from '@/components/ui/view-tabs';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/field';
import { SkeletonText } from '@/components/ui/skeleton';
import { StatusBadge, ToneBadge } from '@/components/workflow/status-badge';
import { useAuth } from '@/features/auth/auth-context';
import { PageHeader } from '@/features/shared/page-header';
import {
  NO_FILTERS,
  PAGE_SIZE,
  type EstimateFilters,
  useCreateEstimate,
  useEstimates,
} from '@/features/estimates/use-estimates';

/**
 * The views of the register, each with what to say when it is empty.
 *
 * These are views rather than status filters. A requester wants "the ones I have
 * to finish"; an approver wants "the ones waiting on me". Neither is a state, and
 * offering the twelve workflow states as buttons would make both of them think.
 */
interface RegisterView {
  id: string;
  label: string;
  filters: EstimateFilters;
  empty: string;
  emptyExplanation: string;
  /** Hidden for people who never approve anything. */
  forApprovers?: boolean;
}

const VIEWS: RegisterView[] = [
  {
    id: 'awaiting-me',
    label: 'Waiting on me',
    filters: { ...NO_FILTERS, awaitingMe: true },
    empty: 'Nothing is waiting on you',
    emptyExplanation:
      'An estimate appears here when a route reaches a step you are the approver for, either in your own right or as somebody’s delegate.',
    forApprovers: true,
  },
  {
    id: 'my-drafts',
    label: 'My drafts',
    filters: { ...NO_FILTERS, mine: true, state: ['draft'] },
    empty: 'You have no drafts',
    emptyExplanation:
      'A draft is an estimate you have started and not yet sent for approval. Nobody else sees it while it is here.',
  },
  {
    id: 'mine-open',
    label: 'Mine, awaiting approval',
    filters: { ...NO_FILTERS, mine: true, state: ['pending_approval'] },
    empty: 'None of yours is waiting for approval',
    emptyExplanation: 'An estimate sits here from the moment you submit it until the route closes.',
  },
  {
    id: 'mine',
    label: 'Everything I raised',
    filters: { ...NO_FILTERS, mine: true },
    empty: 'You have not raised an estimate yet',
    emptyExplanation:
      'Raise one from an accepted document reading, or start a blank one and type in what the supplier quoted.',
  },
  {
    id: 'all',
    label: 'Everything',
    filters: NO_FILTERS,
    empty: 'No estimates yet',
    emptyExplanation:
      'Estimates appear here as people raise them. What you can see depends on your role: a requester sees their own.',
  },
];

const estimateColumns: Column<EstimateSummary>[] = [
  {
    key: 'reference',
    header: 'Reference',
    width: 'w-40',
    cell: (estimate) => (
      <span className="flex flex-col">
        <span className="tabular font-medium text-[var(--color-text-strong)]">
          {estimate.reference}
        </span>
        {estimate.needed_by ? (
          <span className="text-[11px] text-[var(--color-text-subtle)]">
            needed by {formatDate(estimate.needed_by)}
          </span>
        ) : null}
      </span>
    ),
  },
  {
    key: 'counterparty',
    header: 'Counterparty',
    cell: (estimate) => (
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{estimate.vendor_name || 'No supplier yet'}</span>
        <span className="truncate text-[11px] text-[var(--color-text-subtle)]">
          {estimate.description || 'No description yet'}
        </span>
      </span>
    ),
  },
  {
    key: 'amount',
    header: 'Amount',
    width: 'w-36',
    cell: (estimate) => <span className="tabular">{estimate.total_formatted ?? '—'}</span>,
  },
  {
    key: 'waiting',
    header: 'Waiting on',
    hideBelow: 'md',
    // Whose turn it is, on the row. It is the one thing an approver scanning
    // this list is looking for, and opening five estimates to find out is how a
    // queue stops being read.
    cell: (estimate) => (
      <span className="flex flex-col">
        <span>{estimate.awaiting_labels.join(', ') || '—'}</span>
        {estimate.problem_count > 0 ? (
          <span className="text-[11px] font-medium text-[var(--color-warning-700)]">
            {estimate.problem_count} to finish
          </span>
        ) : null}
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    width: 'w-44',
    cell: (estimate) => (
      <span className="relative z-10 flex flex-wrap items-center gap-[var(--space-2)]">
        {estimate.awaiting_me ? (
          <ToneBadge label="Yours to decide" tone="progress" />
        ) : (
          <StatusBadge state={estimate.state} />
        )}
      </span>
    ),
  },
  {
    key: 'owner',
    header: 'Owner',
    width: 'w-40',
    hideBelow: 'lg',
    cell: (estimate) => <span>{estimate.requester_label || '—'}</span>,
  },
];

/**
 * The estimate register.
 *
 * Opens on whatever this person is most likely to be here for: an approver's own
 * queue if they approve anything, their drafts otherwise. Opening on "everything"
 * would be neutral and would make every visit start with a filter click.
 */
export function EstimateRegisterPage() {
  const { can } = useAuth();
  const navigate = useNavigate();

  const approves = can('approval:decide');
  const views = VIEWS.filter((view) => !view.forApprovers || approves);
  const [viewId, setViewId] = useState(() => (approves ? 'awaiting-me' : 'my-drafts'));
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);

  const view = views.find((option) => option.id === viewId) ?? views[0]!;
  const filters: EstimateFilters = { ...view.filters, search };

  const { data, isLoading, isError, error } = useEstimates(filters, offset);
  const create = useCreateEstimate();

  const total = data?.total ?? 0;
  const items = data?.items ?? [];
  const showingTo = offset + items.length;
  const searching = search.trim().length > 0;

  const mayCreate = can('estimate:create');

  return (
    <>
      <PageHeader
        title="Estimates"
        purpose="Requests for permission to spend."
        toolbar={
          <div className="flex flex-col gap-[var(--space-3)] md:flex-row md:items-center md:justify-between">
            <ViewTabs
              tabs={views}
              value={view.id}
              onChange={(id) => {
                setViewId(id);
                setOffset(0);
              }}
            />
            <div className="relative md:mr-[var(--space-3)] md:w-64">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-[var(--space-3)] size-4 -translate-y-1/2 text-[var(--color-text-subtle)]"
              />
              <Input
                type="search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setOffset(0);
                }}
                placeholder="Reference, supplier or description"
                aria-label="Search estimates"
                className="h-9 pl-9 text-[12px]"
              />
            </div>
          </div>
        }
        actions={
          mayCreate ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                create.mutate(
                  {},
                  { onSuccess: (detail) => void navigate(`/estimates/${detail.id}`) },
                );
              }}
              isLoading={create.isPending}
              loadingLabel="Creating"
            >
              <Plus aria-hidden="true" className="size-4" />
              Create estimate
            </Button>
          ) : null
        }
      />

      {create.isError ? (
        <Card className="mb-[var(--space-5)] border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              The estimate could not be created
            </p>
            <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              {create.error instanceof Error
                ? create.error.message
                : 'The request did not complete.'}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {isError ? (
        <Card className="mb-[var(--space-6)] border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              Could not load the register
            </p>
            <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              {error instanceof Error ? error.message : 'The request did not complete.'} Nothing
              has been lost; every estimate is stored and will still be here.
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
        // A search that found nothing is a different situation from a view that
        // is empty, and saying "you have no drafts" to someone who just searched
        // for a reference would be answering a question they did not ask.
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={searching ? Search : FileSpreadsheet}
              title={searching ? `Nothing matches “${search.trim()}”` : view.empty}
              explanation={
                searching
                  ? 'The search looks at the reference, the supplier, the description and the supplier’s own quotation number, within the view you are in.'
                  : view.emptyExplanation
              }
              nextStep={
                searching
                  ? 'Clear the search, or widen the view to everything you are allowed to see.'
                  : 'Raise one from an accepted document, or start a blank estimate and type in the quotation.'
              }
              action={
                searching
                  ? { label: 'Clear the search', onClick: () => setSearch('') }
                  : { label: 'Go to documents', to: '/documents' }
              }
              {...(searching || viewId === 'all'
                ? {}
                : { secondaryAction: { label: 'Show everything', onClick: () => setViewId('all') } })}
            />
          </CardContent>
        </Card>
      ) : (
        <DataTable
          ariaLabel="Estimates"
          columns={estimateColumns}
          rows={items}
          getRowKey={(estimate) => estimate.id}
          getRowHref={(estimate) => `/estimates/${estimate.id}`}
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
