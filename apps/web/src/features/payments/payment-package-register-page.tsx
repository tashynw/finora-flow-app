import { useState } from 'react';
import { Plus, Search, Wallet } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';

import type { PaymentPackageSummary } from '@finora/shared-types';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/field';
import { SkeletonText } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/workflow/status-badge';
import { useAuth } from '@/features/auth/auth-context';
import { PageHeader } from '@/features/shared/page-header';
import { CurrencyTotals } from '@/features/payments/currency-totals';
import {
  contentsSummary,
  packageStanding,
  waitingOn,
} from '@/features/payments/payment-vocabulary';
import {
  NO_FILTERS,
  PAGE_SIZE,
  type PackageFilters,
  useCreatePaymentPackage,
  usePaymentPackages,
} from '@/features/payments/use-payment-packages';

/**
 * The views of the register.
 *
 * "Being assembled" leads rather than "everything", because a package that has
 * gone is finished work: the only one anybody acts on is the one still open.
 * There is at most one of those most weeks, which is exactly why it should not
 * be found by scrolling past six months of history.
 */
interface RegisterView {
  id: string;
  label: string;
  filters: PackageFilters;
  empty: string;
  emptyExplanation: string;
}

const VIEWS: RegisterView[] = [
  {
    id: 'open',
    label: 'Being assembled',
    filters: { ...NO_FILTERS, standing: ['open'] },
    empty: 'No package is being assembled',
    emptyExplanation:
      'A package gathers approved invoices so they go to the bank as one instruction, against one reference. Nothing in it has left the account until it is submitted.',
  },
  {
    id: 'submitted',
    label: 'Sent',
    filters: { ...NO_FILTERS, standing: ['submitted'] },
    empty: 'Nothing has been sent yet',
    emptyExplanation:
      'A submitted package records the reference the bank gave back and the manifest that went with it. Both stay readable afterwards, which is what makes a payment answerable later.',
  },
  {
    id: 'all',
    label: 'Everything',
    filters: NO_FILTERS,
    empty: 'No payment packages yet',
    emptyExplanation:
      'Packages appear here as they are assembled. Paying each invoice the moment it is approved means no single point at which anybody looked at the outgoing total; a package is that point.',
  },
];

function PackageRow({ row }: { row: PaymentPackageSummary }) {
  const standing = packageStanding(row.standing, row.standing_label);
  const waiting = waitingOn(row.standing, row.invoice_count, row.blocker_count);

  return (
    <li className="border-b border-[var(--color-divider)] last:border-b-0">
      <Link
        to={`/payments/${row.id}`}
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
              {row.description || 'No description yet'}
            </span>
          </p>
          <p className="m-0 truncate text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
            {contentsSummary(row.invoice_count, row.vendor_count)}
            {row.payment_method_label ? ` · ${row.payment_method_label}` : ''}
            {row.submission_reference ? ` · bank reference ${row.submission_reference}` : ''}
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

          {/* Stacked, one per currency, and never added up. A package holding
              JMD and USD comes to two figures, and a single number beside them
              would be denominated in nothing. */}
          <CurrencyTotals totals={row.totals} align="right" className="min-w-[9rem]" />

          <ToneBadge label={standing.label} tone={standing.tone} />
        </div>
      </Link>
    </li>
  );
}

export function PaymentPackageRegisterPage() {
  const { can } = useAuth();
  const navigate = useNavigate();

  const manages = can('payment:package_manage');

  const [viewId, setViewId] = useState('open');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const view = VIEWS.find((option) => option.id === viewId) ?? VIEWS[0]!;
  const filters: PackageFilters = { ...view.filters, search };

  const { data, isLoading, isError, error } = usePaymentPackages(filters, page);
  const create = useCreatePaymentPackage();

  const total = data?.total ?? 0;
  const rows = data?.rows ?? [];
  const showingFrom = (page - 1) * PAGE_SIZE + 1;
  const showingTo = (page - 1) * PAGE_SIZE + rows.length;
  const searching = search.trim().length > 0;

  return (
    <>
      <PageHeader
        title="Payment packages"
        purpose="Approved invoices gathered into one instruction to the bank, with what each package comes to in every currency it holds."
        actions={
          manages ? (
            <Button
              variant="primary"
              onClick={() => {
                create.mutate(
                  { description: '', payment_method: null, intended_payment_date: null },
                  { onSuccess: (detail) => void navigate(`/payments/${detail.id}`) },
                );
              }}
              isLoading={create.isPending}
              loadingLabel="Opening"
            >
              <Plus aria-hidden="true" className="size-4" />
              Start a package
            </Button>
          ) : null
        }
      />

      {create.isError ? (
        <Card className="mb-[var(--space-5)] border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              The package could not be opened
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
            placeholder="Our reference, description or the bank's reference"
            aria-label="Search payment packages"
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
              has been lost; every package is stored and will still be here.
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
              icon={searching ? Search : Wallet}
              title={searching ? `Nothing matches “${search.trim()}”` : view.empty}
              explanation={
                searching
                  ? 'The search looks at our own reference, the description and the reference the bank returned, within the view you are in.'
                  : view.emptyExplanation
              }
              nextStep={
                searching
                  ? 'Clear the search, or widen the view to everything.'
                  : manages
                    ? 'Start a package and add the approved invoices it is meant to pay. Nothing leaves the account until it is submitted.'
                    : 'Packages are assembled by the payments team. Nothing is needed from you here.'
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
                <PackageRow key={row.id} row={row} />
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
