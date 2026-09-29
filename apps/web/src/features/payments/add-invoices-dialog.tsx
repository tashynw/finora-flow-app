import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';

import type { EligibleInvoiceOut } from '@finora/shared-types';

import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/dates';
import { formatMoney, groupByCurrency } from '@/lib/money';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { SkeletonText } from '@/components/ui/skeleton';
import { MoneyDisplay } from '@/components/finance/money-display';
import { toMoneyValue } from '@/features/payments/currency-totals';

/**
 * Choosing what goes out.
 *
 * The list is only ever approved invoices that no other package has claimed, so
 * nothing here can be picked twice and nothing unapproved can be picked at all.
 * The running total is per currency and updates as boxes are ticked, because the
 * question this dialog is really answering is not "which invoices" but "how much
 * is about to leave", and somebody who has to add up thirty rows themselves will
 * not.
 *
 * Nothing is preselected. A dialog that opens with everything ticked turns
 * paying a supplier into a matter of not noticing, and the whole point of
 * gathering payments into a package is that somebody looks at the total once
 * before it goes.
 */
export interface AddInvoicesDialogProps {
  open: boolean;
  invoices: EligibleInvoiceOut[];
  isLoading: boolean;
  isPending: boolean;
  error: string | undefined;
  onClose: () => void;
  onConfirm: (invoiceIds: string[]) => void;
}

export function AddInvoicesDialog({
  open,
  invoices,
  isLoading,
  isPending,
  error,
  onClose,
  onConfirm,
}: AddInvoicesDialogProps) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (open) {
      setChosen(new Set());
      setSearch('');
    }
  }, [open]);

  const term = search.trim().toLowerCase();
  const shown = useMemo(
    () =>
      term
        ? invoices.filter((invoice) =>
            [invoice.vendor_name, invoice.invoice_number ?? '', invoice.reference].some((field) =>
              field.toLowerCase().includes(term),
            ),
          )
        : invoices,
    [invoices, term],
  );

  // Totalled from what is ticked, not from what is listed. Filtering the list
  // must never quietly change what the button is about to send, so a selection
  // made before a search still counts towards the total after it.
  const totals = useMemo(
    () =>
      groupByCurrency(
        invoices
          .filter((invoice) => chosen.has(invoice.id))
          .map((invoice) => toMoneyValue(invoice.amount)),
      ),
    [invoices, chosen],
  );

  const shownIds = shown.map((invoice) => invoice.id);
  const allShownChosen = shownIds.length > 0 && shownIds.every((id) => chosen.has(id));

  function toggle(id: string) {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllShown() {
    setChosen((current) => {
      const next = new Set(current);
      if (allShownChosen) for (const id of shownIds) next.delete(id);
      else for (const id of shownIds) next.add(id);
      return next;
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add approved invoices"
      description="Only invoices that have been approved and are not already in another package."
      busy={isPending}
      className="w-[min(56rem,calc(100vw-2rem))]"
      footer={
        <>
          <div className="mr-auto flex flex-wrap items-center gap-[var(--space-3)]">
            <span
              aria-live="polite"
              className="text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]"
            >
              {chosen.size === 0
                ? 'Nothing chosen yet'
                : `${chosen.size} chosen, coming to ${
                    totals.map((total) => formatMoney(total)).join(' and ') || 'nothing'
                  }`}
            </span>
          </div>
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            Back
          </Button>
          <Button
            variant="primary"
            disabled={chosen.size === 0}
            isLoading={isPending}
            loadingLabel="Adding"
            onClick={() => onConfirm([...chosen])}
          >
            Add {chosen.size > 0 ? `${chosen.size} ` : ''}
            {chosen.size === 1 ? 'invoice' : 'invoices'}
          </Button>
        </>
      }
    >
      {error ? (
        <p className="mb-[var(--space-4)] m-0 font-semibold text-[var(--color-danger-700)]">
          {error}
        </p>
      ) : null}

      <div className="mb-[var(--space-4)] flex flex-wrap items-center gap-[var(--space-3)]">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-[var(--space-3)] size-4 -translate-y-1/2 text-[var(--color-text-subtle)]"
          />
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Supplier, invoice number or reference"
            aria-label="Search approved invoices"
            className="pl-9"
            disabled={isPending}
          />
        </div>
        {shown.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={toggleAllShown} disabled={isPending}>
            {allShownChosen ? 'Untick these' : `Tick these ${shown.length}`}
          </Button>
        ) : null}
      </div>

      {isLoading ? (
        <SkeletonText lines={6} />
      ) : invoices.length === 0 ? (
        <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
          Nothing is waiting to be paid. An invoice appears here once it has been approved, and
          leaves again as soon as any package claims it.
        </p>
      ) : shown.length === 0 ? (
        <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
          Nothing matches “{search.trim()}”. {invoices.length}{' '}
          {invoices.length === 1 ? 'invoice is' : 'invoices are'} waiting to be paid.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {shown.map((invoice) => {
            const ticked = chosen.has(invoice.id);
            return (
              <li key={invoice.id} className="border-b border-[var(--color-divider)] last:border-b-0">
                <label
                  className={cn(
                    'motion-interactive flex cursor-pointer items-center gap-[var(--space-3)]',
                    'px-[var(--space-2)] py-[var(--space-3)]',
                    'hover:bg-[var(--color-surface-subtle)]',
                    'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--color-focus-ring)]',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={ticked}
                    disabled={isPending}
                    onChange={() => toggle(invoice.id)}
                    className="size-4 shrink-0 accent-[var(--color-primary-600)]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-[var(--color-text-strong)]">
                      {invoice.vendor_name}
                    </span>
                    <span className="block truncate text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                      {invoice.invoice_number ?? invoice.reference}
                      {invoice.department ? ` · ${invoice.department}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <MoneyDisplay value={toMoneyValue(invoice.amount)} size="md" />
                    <span className="block text-[length:var(--text-caption)] text-[var(--color-text-subtle)]">
                      {invoice.due_date ? `due ${formatDate(invoice.due_date)}` : 'no due date'}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
