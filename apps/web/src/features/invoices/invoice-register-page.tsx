import { useState } from 'react';
import { Plus, Receipt, Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import type { InvoiceSummary } from '@finora/shared-types';

import { cn } from '@/lib/utils';
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
import { StatBand } from '@/features/shared/stat-band';
import { blockerSummary, dueDescriptor } from '@/features/invoices/invoice-vocabulary';
import {
  NO_FILTERS,
  PAGE_SIZE,
  type InvoiceFilters,
  useCreateInvoice,
  useInvoices,
  useInvoiceSummary,
} from '@/features/invoices/use-invoices';

/**
 * The views of the register, each with what to say when it is empty.
 *
 * These are views rather than status filters, for the same reason as on the
 * estimate register: nobody arrives wanting `pending_sign_off`, they arrive
 * wanting the ones that are theirs to do something about.
 *
 * Two of them exist only here. Confirming receipt is the step that stalls, so
 * the people who owe one get a view of their own; and an invoice past its due
 * date is the one thing on this screen with a consequence outside the building,
 * so it gets a view rather than being left to a sort order.
 */
interface RegisterView {
  id: string;
  label: string;
  filters: InvoiceFilters;
  empty: string;
  emptyExplanation: string;
  /** Hidden for people who never approve anything. */
  forApprovers?: boolean;
  /** Hidden for people who are never asked to confirm receipt. */
  forSigners?: boolean;
  /** Hidden for people who never record an invoice. */
  forRecorders?: boolean;
}

const VIEWS: RegisterView[] = [
  {
    id: 'to-confirm',
    label: 'Waiting on me to confirm',
    filters: { ...NO_FILTERS, awaitingMySignOff: true },
    empty: 'Nobody is waiting on you to confirm anything',
    emptyExplanation:
      'An invoice appears here when finance names you as the person who can say the goods or services arrived. You are asked by email as well, and chased every three working hours until you answer.',
    forSigners: true,
  },
  {
    id: 'awaiting-me',
    label: 'Waiting on my approval',
    filters: { ...NO_FILTERS, awaitingMe: true },
    empty: 'Nothing is waiting on your approval',
    emptyExplanation:
      'An invoice appears here once receipt has been confirmed and the route reaches a step you are the approver for.',
    forApprovers: true,
  },
  {
    id: 'overdue',
    label: 'Past due',
    filters: { ...NO_FILTERS, overdue: true },
    empty: 'Nothing is past its due date',
    emptyExplanation:
      'Every invoice still in the workflow is inside the payment date its supplier expects.',
  },
  {
    id: 'my-drafts',
    label: 'My drafts',
    filters: { ...NO_FILTERS, mine: true, state: ['draft'] },
    empty: 'You have no drafts',
    emptyExplanation:
      'A draft is an invoice you have recorded and not yet sent for confirmation. Nobody has been asked about it while it is here.',
    forRecorders: true,
  },
  {
    id: 'all',
    label: 'Everything',
    filters: NO_FILTERS,
    empty: 'No invoices yet',
    emptyExplanation:
      'Invoices appear here as they are recorded, from an emailed document or typed in. What you can see depends on your role.',
  },
];

const invoiceColumns: Column<InvoiceSummary>[] = [
  {
    key: 'reference',
    header: 'Reference',
    width: 'w-40',
    cell: (invoice) => (
      <span className="flex flex-col">
        <span className="tabular font-medium text-[var(--color-text-strong)]">
          {invoice.reference}
        </span>
        {invoice.invoice_number ? (
          <span className="tabular text-[11px] text-[var(--color-text-subtle)]">
            their no. {invoice.invoice_number}
          </span>
        ) : null}
      </span>
    ),
  },
  {
    key: 'counterparty',
    header: 'Counterparty',
    cell: (invoice) => (
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{invoice.vendor_name || 'No supplier yet'}</span>
        {invoice.description ? (
          <span className="truncate text-[11px] text-[var(--color-text-subtle)]">
            {invoice.description}
          </span>
        ) : null}
      </span>
    ),
  },
  {
    key: 'amount',
    header: 'Amount',
    width: 'w-36',
    cell: (invoice) => (
      <span className="tabular">{invoice.total_formatted ?? '—'}</span>
    ),
  },
  {
    key: 'waiting',
    header: 'Waiting on',
    hideBelow: 'md',
    cell: (invoice) => {
      const due = dueDescriptor(invoice.days_until_due);
      const blockers = blockerSummary(invoice.problem_count, invoice.blocker_count);
      const waitingOn = invoice.awaiting_labels.join(', ');
      return (
        <span className="flex flex-col">
          <span>{waitingOn || '—'}</span>
          {/* A control that has fired is red; a form left unfinished is amber.
              They are different work for different people. */}
          {blockers ? (
            <span
              className={cn(
                'text-[11px] font-medium',
                invoice.blocker_count > 0
                  ? 'text-[var(--color-danger-700)]'
                  : 'text-[var(--color-warning-700)]',
              )}
            >
              {blockers}
            </span>
          ) : due && due.tone !== 'neutral' ? (
            <span
              // Counted from today, so the same row reads differently tomorrow.
              // Hidden from the visual baselines, which keeps its space.
              data-visual-volatile
              className={cn(
                'text-[11px] font-medium',
                due.tone === 'danger'
                  ? 'text-[var(--color-danger-700)]'
                  : 'text-[var(--color-warning-700)]',
              )}
              title={
                invoice.due_date ? `Payment due ${formatDate(invoice.due_date)}` : undefined
              }
            >
              {due.label}
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
    cell: (invoice) => (
      <span className="relative z-10 flex flex-wrap items-center gap-[var(--space-2)]">
        {invoice.awaiting_my_sign_off ? (
          <ToneBadge label="Confirm receipt" tone="warning" />
        ) : invoice.awaiting_me ? (
          <ToneBadge label="Yours to decide" tone="progress" />
        ) : (
          <StatusBadge state={invoice.state} />
        )}
      </span>
    ),
  },
  {
    key: 'owner',
    header: 'Owner',
    width: 'w-40',
    hideBelow: 'lg',
    cell: (invoice) => <span>{invoice.requester_label ?? '—'}</span>,
  },
];

/**
 * The invoice register.
 *
 * Opens on whatever this person is most likely to be here for. Confirming
 * receipt comes first because it is the only thing on this screen that somebody
 * is actively being chased about, and an approver's queue only fills once those
 * confirmations come in.
 */
export function InvoiceRegisterPage() {
  const { can } = useAuth();
  const navigate = useNavigate();

  const approves = can('approval:decide');
  const confirms = can('invoice:sign_off');
  const records = can('invoice:create');

  const views = VIEWS.filter(
    (view) =>
      (!view.forApprovers || approves) &&
      (!view.forSigners || confirms) &&
      (!view.forRecorders || records),
  );

  // Opens on this person's own queue. Confirming receipt and approving are
  // mutually exclusive duties, so at most one of the two applies to anybody, and
  // whoever does neither records invoices and wants their unfinished ones.
  const [viewId, setViewId] = useState(() => {
    if (confirms) return 'to-confirm';
    if (approves) return 'awaiting-me';
    return records ? 'my-drafts' : 'all';
  });
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);

  const view = views.find((option) => option.id === viewId) ?? views[0]!;
  const filters: InvoiceFilters = { ...view.filters, search };

  const { data, isLoading, isError, error } = useInvoices(filters, offset);
  const summary = useInvoiceSummary();
  const create = useCreateInvoice();

  const total = data?.total ?? 0;
  const items = data?.items ?? [];
  const showingTo = offset + items.length;
  const searching = search.trim().length > 0;

  const mayCreate = can('invoice:create');

  return (
    <>
      <PageHeader
        title="Invoices"
        purpose="Invoices, receipt confirmation and coding status."
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
                placeholder="Reference, supplier or number"
                aria-label="Search invoices"
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
                  { onSuccess: (detail) => void navigate(`/invoices/${detail.id}`) },
                );
              }}
              isLoading={create.isPending}
              loadingLabel="Creating"
            >
              <Plus aria-hidden="true" className="size-4" />
              Create invoice
            </Button>
          ) : null
        }
      />

      <StatBand
        summary={summary.data}
        isLoading={summary.isLoading}
        meta={{
          count: 'All live invoices',
          outstanding: 'Approved, not yet paid',
          paid: 'Marked paid',
        }}
      />

      {create.isError ? (
        <Card className="mb-[var(--space-5)] border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              The invoice could not be created
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
              has been lost; every invoice is stored and will still be here.
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
              icon={searching ? Search : Receipt}
              title={searching ? `Nothing matches “${search.trim()}”` : view.empty}
              explanation={
                searching
                  ? 'The search looks at the reference, the supplier, the description and the supplier’s own invoice number, within the view you are in.'
                  : view.emptyExplanation
              }
              nextStep={
                searching
                  ? 'Clear the search, or widen the view to everything you are allowed to see.'
                  : 'Record one from a document that has arrived, or start a blank invoice and type in the supplier’s bill.'
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
          ariaLabel="Invoices"
          columns={invoiceColumns}
          rows={items}
          getRowKey={(invoice) => invoice.id}
          getRowHref={(invoice) => `/invoices/${invoice.id}`}
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
