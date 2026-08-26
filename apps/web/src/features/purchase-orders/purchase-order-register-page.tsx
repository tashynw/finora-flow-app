import { useState } from 'react';
import { ClipboardList, Plus, Search } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';

import type { PurchaseOrderSummary } from '@finora/shared-types';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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

function OrderRow({ order }: { order: PurchaseOrderSummary }) {
  const capacity = capacityDescriptor(order.remaining_minor_units, order.remaining_formatted);
  const waiting = waitingOn(order.state, order.blocker_count);

  return (
    <li className="border-b border-[var(--color-divider)] last:border-b-0">
      <Link
        to={`/purchase-orders/${order.id}`}
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
              {order.number}
            </span>
            <span className="truncate font-semibold text-[var(--color-text-strong)]">
              {order.vendor_name || 'No supplier yet'}
            </span>
          </p>
          <p className="m-0 truncate text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
            {order.description || 'No description yet'}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-[var(--space-4)]">
          {/* What is left, not what has been billed. A reviewer deciding whether
              an invoice fits is asking how much room there is, and making them
              subtract two figures for every row is how an order gets overrun. */}
          {capacity ? (
            <span
              className={cn(
                'text-[var(--text-caption)]',
                capacity.tone === 'danger'
                  ? 'font-semibold text-[var(--color-danger-700)]'
                  : 'text-[var(--color-text-subtle)]',
              )}
              title={
                order.billed_formatted ? `${order.billed_formatted} billed so far` : undefined
              }
            >
              {capacity.label}
            </span>
          ) : null}

          {order.awaiting.length > 0 ? (
            <span className="text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
              with {order.awaiting.join(' and ')}
            </span>
          ) : null}

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

          <span className="tabular min-w-[8rem] text-right font-semibold text-[var(--color-text-strong)]">
            {order.total_formatted ?? '—'}
          </span>

          {order.is_awaiting_me ? <ToneBadge label="Yours to decide" tone="progress" /> : null}
          {/* One badge. Open and closed are what an approved order can be, so
              the pair reads as two facts where there is one, and on the orders
              that opened without anybody approving them the word "approved" is
              not even true. Draft, with approvers, open, closed, turned down
              and cancelled cover every order between them. */}
          {order.state === 'approved' ? (
            <ToneBadge label={order.state_label} tone={order.is_open ? 'success' : 'neutral'} />
          ) : (
            <StatusBadge state={order.state} />
          )}
        </div>
      </Link>
    </li>
  );
}

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
        purpose="What the organisation has committed to spend, how much of each commitment is left, and what is waiting to be agreed."
        actions={
          manages ? (
            <Button
              variant="primary"
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
              Raise an order
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
            placeholder="Order number or description"
            aria-label="Search purchase orders"
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
              has been lost; every order is stored and will still be here.
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
          ) : rows.length === 0 ? (
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
          ) : (
            <ul className="m-0 list-none p-0">
              {rows.map((order) => (
                <OrderRow key={order.id} order={order} />
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
