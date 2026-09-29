import { Link } from 'react-router-dom';

import type { InvoiceDetail } from '@finora/shared-types';

import { cn } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ToneBadge } from '@/components/workflow/status-badge';
import { orderStanding } from '@/features/purchase-orders/purchase-order-vocabulary';

/**
 * What this invoice is billed against, and what is left of it.
 *
 * The panel exists to answer one question: does this bill fit inside what was
 * already approved. The remaining figure is therefore the largest thing in it and
 * the server works it out, so the browser is never in the position of computing
 * a number that decides whether a payment is allowed.
 *
 * A negative remainder is stated as an overrun in words rather than shown as a
 * minus sign. "JMD -4,000.00 left" is a sentence that has to be decoded, and the
 * person decoding it is about to approve a payment.
 */

function Remaining({
  minorUnits,
  formatted,
  of,
}: {
  minorUnits: number | null;
  formatted: string | null;
  of: string;
}) {
  if (formatted === null || minorUnits === null) return null;
  const over = minorUnits < 0;

  return (
    <p
      className={cn(
        'tabular m-0 text-[length:var(--text-body)] font-semibold',
        over ? 'text-[var(--color-danger-700)]' : 'text-[var(--color-text-strong)]',
      )}
    >
      {over ? (
        <>
          {formatted.replace('-', '')} more than the {of}
        </>
      ) : (
        <>
          {formatted} left on the {of}
        </>
      )}
    </p>
  );
}

export function LinkagePanel({ invoice }: { invoice: InvoiceDetail }) {
  const { estimate, purchase_order: order } = invoice;

  if (!estimate && !order) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Billed against</CardTitle>
          <CardDescription>
            What approved spend this invoice draws on, and how much of it is left.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
            Nothing linked. An invoice with no estimate behind it is spend nobody approved in
            advance, which is allowed but is checked more closely at approval.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Billed against</CardTitle>
        <CardDescription>
          What approved spend this invoice draws on, and how much of it is left.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-[var(--space-5)]">
        {estimate ? (
          <div>
            <p className="m-0 flex flex-wrap items-center gap-[var(--space-2)]">
              <Link
                to={`/estimates/${estimate.id}`}
                className="tabular font-semibold text-[var(--color-primary-700)]"
              >
                {estimate.reference}
              </Link>
              <ToneBadge
                label={estimate.state_label}
                tone={estimate.state === 'approved' ? 'success' : 'warning'}
              />
            </p>
            <p className="mt-[var(--space-1)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              {estimate.vendor_name}
              {estimate.approved_total_formatted
                ? ` · ${estimate.approved_total_formatted} approved`
                : ''}
            </p>
            <div className="mt-[var(--space-2)]">
              <Remaining
                minorUnits={estimate.remaining_minor_units}
                formatted={estimate.remaining_formatted}
                of="estimate"
              />
            </div>
          </div>
        ) : null}

        {order ? (
          <div>
            <p className="m-0 flex flex-wrap items-center gap-[var(--space-2)]">
              <span className="tabular font-semibold text-[var(--color-text-strong)]">
                Order {order.number}
              </span>
              <ToneBadge
                label={order.state_label}
                tone={orderStanding(order.state_label, order.is_open).tone}
              />
            </p>
            <p className="mt-[var(--space-1)] m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              {order.vendor_name} · {order.total_formatted} ordered
              {/* Shown because an order that looks to have room may already be
                  spoken for by an invoice somebody else is putting through, and
                  the two only conflict at the moment of payment. */}
              {order.billed_by_others_minor_units > 0
                ? ` · ${order.billed_by_others_formatted} billed on other invoices`
                : ''}
            </p>
            <div className="mt-[var(--space-2)]">
              <Remaining
                minorUnits={order.remaining_minor_units}
                formatted={order.remaining_formatted}
                of="order"
              />
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
