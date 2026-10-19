import { useState } from 'react';
import { ClipboardList, Plus, Search } from 'lucide-react';
import { useNavigate } from '@/lib/app-link';

import type { PurchaseOrderSummary } from '@finora/shared-types';

import { cn } from '@/lib/utils';
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
  capacityDescriptor,
  waitingOn,
} from '@/features/purchase-orders/purchase-order-vocabulary';
import {
  NO_FILTERS,
  PAGE_SIZE,
  type OrderFilters,
  useCreatePurchaseOrder,
  usePurchaseOrders,
} from '@/features/purchase-orders/use-purchase-orders';

/**
 * The views of the register.
 *
 * "Open" leads because it is the only question the register is asked in the
 * ordinary course of work: what have we committed to that suppliers can still
 * bill against. Everything else here is either unfinished or history.
 */
interface RegisterView {
  id: string;
  label: string;
  filters: OrderFilters;
  empty: string;
  emptyExplanation: string;
  forApprovers?: boolean;
  forBuyers?: boolean;
}

const VIEWS: RegisterView[] = [
  {
    id: 'open',
    label: 'Open',
    filters: { ...NO_FILTERS, openOnly: true },
    empty: 'No open orders',
    emptyExplanation:
      'An order is open once it has been committed and nobody has closed it. Suppliers can bill against an open order and against nothing else.',
  },
  {
    id: 'awaiting-me',
    label: 'Waiting on my approval',
    filters: { ...NO_FILTERS, awaitingMeOnly: true },
    empty: 'Nothing is waiting on your approval',
    emptyExplanation:
      'An order appears here when it has been committed and the route reaches a step you are the approver for. Orders an approved estimate already covers never come here.',
    forApprovers: true,
  },
  {
    id: 'drafts',
    label: 'Drafts',
    filters: { ...NO_FILTERS, state: ['draft'] },
    empty: 'No drafts',
    emptyExplanation:
      'A draft commits the organisation to nothing. It becomes a commitment when it is submitted, which is also the point at which it is checked.',
    forBuyers: true,
  },
  {
    id: 'all',
    label: 'Everything',
    filters: NO_FILTERS,
    empty: 'No purchase orders yet',
    emptyExplanation:
      'Orders appear here as they are raised. An order is how the organisation commits to spend before an invoice arrives, and above JMD 50,000 an invoice must name one.',
  },
];

const orderColumns: Column<PurchaseOrderSummary>[] = [
  {
    key: 'reference',
    header: 'Reference',
    width: 'w-40',
    cell: (order) => (
      <span className="tabular font-medium text-[var(--color-text-strong)]">{order.number}</span>
    ),
  },
  {
    key: 'counterparty',
    header: 'Counterparty',
    cell: (order) => (
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{order.vendor_name || 'No supplier yet'}</span>
        <span className="truncate text-[11px] text-[var(--color-text-subtle)]">
          {order.description || 'No description yet'}
        </span>
      </span>
    ),
  },
  {
    key: 'amount',
    header: 'Amount',
    width: 'w-40',
    cell: (order) => {
      const capacity = capacityDescriptor(order.remaining_minor_units, order.remaining_formatted);
      return (
        <span className="flex flex-col">
          <span className="tabular">{order.total_formatted ?? '—'}</span>
          {/* What is left, not what has been billed. A reviewer deciding whether
              an invoice fits is asking how much room there is, and making them
              subtract two figures for every row is how an order gets overrun. */}
          {capacity ? (
            <span
              className={cn(
                'tabular text-[11px]',
                capacity.tone === 'danger'
                  ? 'font-medium text-[var(--color-danger-700)]'
                  : 'text-[var(--color-text-subtle)]',
              )}
              title={
                order.billed_formatted ? `${order.billed_formatted} billed so far` : undefined
              }
            >
              {capacity.label}
            </span>
          ) : null}
        </span>
      );
    },
  },
  {
    key: 'waiting',
    header: 'Waiting on',
    hideBelow: 'md',
    cell: (order) => {
      const waiting = waitingOn(order.state, order.blocker_count);
      const names = order.awaiting.join(', ');
      const unfinished = waiting?.tone === 'warning' ? waiting.label : null;
      return (
        <span className="flex flex-col">
          <span>{names || (waiting && !unfinished ? waiting.label : '—')}</span>
          {unfinished ? (
            <span className="text-[11px] font-medium text-[var(--color-warning-700)]">
              {unfinished}
            </span>
          ) : null}
        </span>
      );
    },
  },
  {
    key: 'status',
    header: 'Status',
    width: 'w-44',
    cell: (order) => (
      <span className="relative z-10 flex flex-wrap items-center gap-[var(--space-2)]">
        {/* One badge. Open and closed are what an approved order can be, so the
            pair reads as two facts where there is one, and on the orders that
            opened without anybody approving them the word "approved" is not
            even true. */}
        {order.is_awaiting_me ? (
          <ToneBadge label="Yours to decide" tone="progress" />
        ) : order.state === 'approved' ? (
          <ToneBadge label={order.state_label} tone={order.is_open ? 'success' : 'neutral'} />
        ) : (
          <StatusBadge state={order.state} />
        )}
      </span>
    ),
  },
  {
    key: 'owner',
    header: 'Owner',
    width: 'w-40',
    hideBelow: 'lg',
    cell: (order) => <span>{order.raised_by_label || '—'}</span>,
  },
];

export function PurchaseOrderRegisterPage() {
  const { can } = useAuth();
  const navigate = useNavigate();

  const approves = can('approval:decide');
  const manages = can('purchase_order:manage');

  const views = VIEWS.filter(
    (view) => (!view.forApprovers || approves) && (!view.forBuyers || manages),
  );

  const [viewId, setViewId] = useState(() => (approves && !manages ? 'awaiting-me' : 'open'));
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const view = views.find((option) => option.id === viewId) ?? views[0]!;
  const filters: OrderFilters = { ...view.filters, search };

  const { data, isLoading, isError, error } = usePurchaseOrders(filters, page);
  const create = useCreatePurchaseOrder();

  const total = data?.total ?? 0;
  const rows = data?.rows ?? [];
  const showingFrom = (page - 1) * PAGE_SIZE + 1;
  const showingTo = (page - 1) * PAGE_SIZE + rows.length;
  const searching = search.trim().length > 0;

  return (
    <>
      <PageHeader
        title="Purchase orders"
        purpose="Commitments suppliers can bill against."
        toolbar={
          <div className="flex flex-col gap-[var(--space-3)] md:flex-row md:items-center md:justify-between">
            <ViewTabs
              tabs={views}
              value={view.id}
              onChange={(id) => {
                setViewId(id);
                setPage(1);
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
                  setPage(1);
                }}
                placeholder="Order number or description"
                aria-label="Search purchase orders"
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
                  {},
                  { onSuccess: (detail) => void navigate(`/purchase-orders/${detail.id}`) },
                );
              }}
              isLoading={create.isPending}
              loadingLabel="Creating"
            >
              <Plus aria-hidden="true" className="size-4" />
              Create PO
            </Button>
          ) : null
        }
      />

      {create.isError ? (
        <Card className="mb-[var(--space-5)] border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              The order could not be created
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
              has been lost; every order is stored and will still be here.
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
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={searching ? Search : ClipboardList}
              title={searching ? `Nothing matches “${search.trim()}”` : view.empty}
              explanation={
                searching
                  ? 'The search looks at the order number and the description, within the view you are in.'
                  : view.emptyExplanation
              }
              nextStep={
                searching
                  ? 'Clear the search, or widen the view to everything you are allowed to see.'
                  : manages
                    ? 'Raise an order for spend that has been agreed, or start from an approved estimate so it opens without going round again.'
                    : 'Orders are raised by the people who commit spend. Nothing is needed from you here.'
              }
              {...(searching
                ? { action: { label: 'Clear the search', onClick: () => setSearch('') } }
                : {})}
              {...(searching || viewId === 'all'
                ? {}
                : { secondaryAction: { label: 'Show everything', onClick: () => setViewId('all') } })}
            />
          </CardContent>
        </Card>
      ) : (
        <DataTable
          ariaLabel="Purchase orders"
          columns={orderColumns}
          rows={rows}
          getRowKey={(order) => order.id}
          getRowHref={(order) => `/purchase-orders/${order.id}`}
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
