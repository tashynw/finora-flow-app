import { useState } from 'react';
import { Plus, Search, Wallet } from 'lucide-react';
import { useNavigate } from '@/lib/app-link';

import type { PaymentPackageSummary } from '@finora/shared-types';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { ViewTabs } from '@/components/ui/view-tabs';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/field';
import { SkeletonText } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/workflow/status-badge';
import { useAuth } from '@/features/auth/auth-context';
import { PageHeader } from '@/features/shared/page-header';
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

const packageColumns: Column<PaymentPackageSummary>[] = [
  {
    key: 'reference',
    header: 'Reference',
    width: 'w-44',
    cell: (row) => (
      <span className="flex flex-col">
        <span className="tabular font-medium text-[var(--color-text-strong)]">
          {row.reference}
        </span>
        {row.submission_reference ? (
          <span className="tabular text-[11px] text-[var(--color-text-subtle)]">
            bank ref. {row.submission_reference}
          </span>
        ) : null}
      </span>
    ),
  },
  {
    key: 'counterparty',
    header: 'Counterparty',
    cell: (row) => (
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{contentsSummary(row.invoice_count, row.vendor_count)}</span>
        <span className="truncate text-[11px] text-[var(--color-text-subtle)]">
          {row.description || 'No description yet'}
          {row.payment_method_label ? ` · ${row.payment_method_label}` : ''}
        </span>
      </span>
    ),
  },
  {
    key: 'amount',
    header: 'Amount',
    width: 'w-40',
    // Stacked, one per currency, and never added up. A package holding JMD and
    // USD comes to two figures, and a single number beside them would be
    // denominated in nothing.
    cell: (row) =>
      row.totals.length === 0 ? (
        <span className="text-[var(--color-text-subtle)]">Nothing yet</span>
      ) : (
        <span className="flex flex-col">
          {row.totals.map((amount) => (
            <span key={amount.currency} className="tabular">
              {amount.formatted}
            </span>
          ))}
        </span>
      ),
  },
  {
    key: 'waiting',
    header: 'Waiting on',
    hideBelow: 'md',
    cell: (row) => {
      const waiting = waitingOn(row.standing, row.invoice_count, row.blocker_count);
      return (
        <span
          className={cn(
            waiting?.tone === 'warning' && 'font-medium text-[var(--color-warning-700)]',
          )}
        >
          {waiting?.label ?? '—'}
        </span>
      );
    },
  },
  {
    key: 'status',
    header: 'Status',
    width: 'w-44',
    cell: (row) => {
      const standing = packageStanding(row.standing, row.standing_label);
      return (
        <span className="relative z-10 flex flex-wrap items-center gap-[var(--space-2)]">
          <ToneBadge label={standing.label} tone={standing.tone} />
        </span>
      );
    },
  },
];

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
        purpose="Approved invoices prepared for submission to the bank."
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
            <div className="relative md:mr-[var(--space-3)] md:w-96">
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
                className="h-9 pl-9 text-[12px]"
              />
            </div>
          </div>
        }
        actions={
          manages ? (
            <Button
              variant="primary"
              size="sm"
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
              New package
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
              has been lost; every package is stored and will still be here.
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
          </CardContent>
        </Card>
      ) : (
        <DataTable
          ariaLabel="Payment packages"
          columns={packageColumns}
          rows={rows}
          getRowKey={(row) => row.id}
          getRowHref={(row) => `/payments/${row.id}`}
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
