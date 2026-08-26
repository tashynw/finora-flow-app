import { useState } from 'react';
import { FileSpreadsheet, Plus, Search } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';

import type { EstimateSummary } from '@finora/shared-types';

import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/dates';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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

function EstimateRow({ estimate }: { estimate: EstimateSummary }) {
  return (
    <li className="border-b border-[var(--color-divider)] last:border-b-0">
      <Link
        to={`/estimates/${estimate.id}`}
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
              {estimate.reference}
            </span>
            <span className="truncate font-semibold text-[var(--color-text-strong)]">
              {estimate.vendor_name || 'No supplier yet'}
            </span>
          </p>
          <p className="m-0 truncate text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
            {estimate.description || 'No description yet'}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-[var(--space-4)]">
          {estimate.needed_by ? (
            <span className="text-[var(--text-caption)] text-[var(--color-text-subtle)]">
              needed by {formatDate(estimate.needed_by)}
            </span>
          ) : null}

          {/* Whose turn it is, on the row. It is the one thing an approver
              scanning this list is looking for, and opening five estimates to
              find out is how a queue stops being read. */}
          {estimate.awaiting_labels.length > 0 ? (
            <span className="text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
              with {estimate.awaiting_labels.join(' and ')}
            </span>
          ) : null}

          {estimate.problem_count > 0 ? (
            <span className="text-[var(--text-body-sm)] font-semibold text-[var(--color-warning-700)]">
              {estimate.problem_count} to finish
            </span>
          ) : null}

          <span className="tabular min-w-[8rem] text-right font-semibold text-[var(--color-text-strong)]">
            {estimate.total_formatted ?? '—'}
          </span>

          {estimate.awaiting_me ? <ToneBadge label="Yours to decide" tone="progress" /> : null}
          <StatusBadge state={estimate.state} />
        </div>
      </Link>
    </li>
  );
}

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
        purpose="Supplier quotations raised for approval, what each one commits, and who has to decide it."
        actions={
          mayCreate ? (
            <Button
              variant="primary"
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
              New estimate
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
            <p className="mt-2 m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
              {create.error instanceof Error
                ? create.error.message
                : 'The request did not complete.'}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="mb-[var(--space-4)] flex flex-col gap-[var(--space-3)] lg:flex-row lg:items-center lg:justify-between">
        <div role="group" aria-label="Choose a view" className="flex flex-wrap gap-[var(--space-2)]">
          {views.map((option) => (
            <Button
              key={option.id}
              variant={viewId === option.id ? 'primary' : 'ghost'}
              size="sm"
              aria-pressed={viewId === option.id}
              onClick={() => {
                setViewId(option.id);
                setOffset(0);
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
              setOffset(0);
            }}
            placeholder="Reference, supplier or description"
            aria-label="Search estimates"
            className="pl-9"
          />
        </div>
      </div>

      {isError ? (
        <Card className="mb-[var(--space-6)] border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              Could not load the register
            </p>
            <p className="mt-2 m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
              {error instanceof Error ? error.message : 'The request did not complete.'} Nothing
              has been lost; every estimate is stored and will still be here.
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
            // A search that found nothing is a different situation from a view
            // that is empty, and saying "you have no drafts" to someone who just
            // searched for a reference would be answering a question they did
            // not ask.
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
          ) : (
            <ul className="m-0 list-none p-0">
              {items.map((estimate) => (
                <EstimateRow key={estimate.id} estimate={estimate} />
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
    </>
  );
}
