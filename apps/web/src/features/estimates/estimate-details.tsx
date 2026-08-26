import { FileText } from 'lucide-react';
import { Link } from 'react-router-dom';

import type { EstimateDetail } from '@finora/shared-types';

import { formatDate } from '@/lib/dates';
import { DetailRow as Row } from '@/features/shared/detail-row';

/**
 * An estimate as it reads once it can no longer be edited.
 *
 * The amount is given its own line at the top, because it is the number every
 * approver looks for first and the one an auditor will come back for.
 */

export function EstimateDetails({ estimate }: { estimate: EstimateDetail }) {
  return (
    <>
      <p className="tabular m-0 text-[length:var(--text-heading-2)] leading-[var(--text-heading-2--line-height)] font-bold text-[var(--color-text-strong)]">
        {estimate.total_formatted ?? 'No amount'}
      </p>
      <p className="mt-[var(--space-1)] mb-[var(--space-5)] m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
        {estimate.description || 'No description'}
      </p>

      <dl className="m-0">
        <Row label="Supplier">
          {estimate.vendor_name || '—'}
          {estimate.vendor_id ? null : (
            // Worth saying. A name with no supplier record behind it is a name
            // somebody typed, and finance has to reconcile it before payment.
            <span className="block text-[var(--text-caption)] text-[var(--color-text-muted)]">
              Not yet matched to a supplier record.
            </span>
          )}
        </Row>
        <Row label="Their quotation number">{estimate.estimate_number || '—'}</Row>
        <Row label="Date on the quotation">{formatDate(estimate.estimate_date)}</Row>
        <Row label="Needed by">{formatDate(estimate.needed_by)}</Row>
        <Row label="Cost centre">
          {estimate.cost_centre
            ? `${estimate.cost_centre.code} — ${estimate.cost_centre.name}`
            : '—'}
        </Row>
        <Row label="GL account">
          {estimate.gl_account ? `${estimate.gl_account.code} — ${estimate.gl_account.name}` : '—'}
        </Row>
        <Row label="Raised by">
          {estimate.requester_label}
          {estimate.department ? (
            <span className="text-[var(--color-text-muted)]"> · {estimate.department}</span>
          ) : null}
        </Row>
        <Row label="Why it is needed">
          {/* Kept as the requester wrote it, line breaks and all. It is the case
              for the spend, and reflowing it into one paragraph would lose the
              structure they gave it. */}
          <span className="block whitespace-pre-line">{estimate.justification || '—'}</span>
        </Row>
        {estimate.document_id ? (
          <Row label="Read from">
            <Link
              to={`/documents/${estimate.document_id}`}
              className="inline-flex items-center gap-[var(--space-2)] text-[var(--color-primary-700)]"
            >
              <FileText aria-hidden="true" className="size-4" />
              The supplier’s own document
            </Link>
            <span className="block text-[var(--text-caption)] text-[var(--color-text-muted)]">
              These figures were copied from that reading when this estimate was raised, and do
              not change if it is read again.
            </span>
          </Row>
        ) : null}
      </dl>
    </>
  );
}
