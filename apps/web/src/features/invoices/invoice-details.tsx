import { FileText } from 'lucide-react';
import { Link } from 'react-router-dom';

import type { InvoiceDetail } from '@finora/shared-types';

import { formatDate } from '@/lib/dates';
import { DetailRow as Row } from '@/features/shared/detail-row';
import { dueDescriptor } from '@/features/invoices/invoice-vocabulary';

/**
 * An invoice as it reads once it can no longer be edited.
 *
 * The amount leads, because it is the number every approver looks for first and
 * the one an auditor will come back for. The payment due date carries its own
 * plain reading of how much time is left, since "12 August" only means something
 * to a reader who knows today's date and is counting.
 */
export function InvoiceDetails({ invoice }: { invoice: InvoiceDetail }) {
  const due = dueDescriptor(invoice.days_until_due);

  return (
    <>
      <p className="tabular m-0 text-[length:var(--text-heading-2)] leading-[var(--text-heading-2--line-height)] font-bold text-[var(--color-text-strong)]">
        {invoice.total_formatted ?? 'No amount'}
      </p>
      <p className="mt-[var(--space-1)] mb-[var(--space-5)] m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
        {invoice.description || 'No description'}
      </p>

      <dl className="m-0">
        <Row label="Supplier">
          {invoice.vendor_name || '—'}
          {invoice.vendor_id ? null : (
            // Worth saying plainly. A name with no supplier record behind it is a
            // name somebody typed, and nothing is ever paid to one of those.
            <span className="block text-[var(--text-caption)] text-[var(--color-text-muted)]">
              Not matched to a supplier record. This has to be resolved before payment.
            </span>
          )}
        </Row>
        <Row label="Their invoice number">{invoice.invoice_number || '—'}</Row>
        <Row label="Date on the invoice">{formatDate(invoice.invoice_date)}</Row>
        <Row label="Payment due">
          {formatDate(invoice.due_date)}
          {due ? (
            <span
              // Counted from today, so it reads differently tomorrow against the
              // same stored date. Excluded from the visual baselines for that
              // reason, not because it does not matter.
              data-visual-volatile
              className={
                due.tone === 'danger'
                  ? 'block text-[var(--text-caption)] font-semibold text-[var(--color-danger-700)]'
                  : 'block text-[var(--text-caption)] text-[var(--color-text-muted)]'
              }
            >
              {due.label}
            </span>
          ) : null}
        </Row>
        <Row label="Cost centre">
          {invoice.cost_centre ? `${invoice.cost_centre.code} — ${invoice.cost_centre.name}` : '—'}
        </Row>
        <Row label="GL account">
          {invoice.gl_account ? `${invoice.gl_account.code} — ${invoice.gl_account.name}` : '—'}
        </Row>
        <Row label="Recorded by">
          {invoice.created_by_label}
          {invoice.department ? (
            <span className="text-[var(--color-text-muted)]"> · {invoice.department}</span>
          ) : null}
        </Row>
        {invoice.document_id ? (
          <Row label="Read from">
            <Link
              to={`/documents/${invoice.document_id}`}
              className="inline-flex items-center gap-[var(--space-2)] text-[var(--color-primary-700)]"
            >
              <FileText aria-hidden="true" className="size-4" />
              The supplier’s own invoice
            </Link>
            <span className="block text-[var(--text-caption)] text-[var(--color-text-muted)]">
              These figures were copied from that reading when this invoice was recorded, and do
              not change if it is read again.
            </span>
          </Row>
        ) : null}
      </dl>
    </>
  );
}
