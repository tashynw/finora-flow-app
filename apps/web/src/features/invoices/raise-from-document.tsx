import { ArrowRight, FileText } from 'lucide-react';
import { Link, useNavigate } from '@/lib/app-link';

import type { DocumentDetail } from '@finora/shared-types';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/features/auth/auth-context';
import { useCreateInvoice } from '@/features/invoices/use-invoices';

type RaisedRecord = {
  kind: string;
  id: string;
  reference: string;
  state_label: string;
};

/**
 * What to do with an accepted reading of an invoice.
 *
 * Accepting a reading confirms the values. Recording the invoice is a second
 * deliberate act: that is the record payment is eventually made against. Without
 * this panel a reviewer accepts an invoice PDF and has nowhere obvious to turn
 * those values into a draft.
 */
export function RaiseInvoicePanel({ document }: { document: DocumentDetail }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const create = useCreateInvoice();

  const raised = document.raised_as as RaisedRecord | null;
  const accepted = document.status === 'accepted';
  const raisedInvoice = raised?.kind === 'invoice' ? raised : null;

  if (document.kind !== 'invoice') return null;
  if (!raisedInvoice && (!accepted || !can('invoice:create'))) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {raisedInvoice ? 'Recorded as an invoice' : 'Record an invoice from this'}
        </CardTitle>
        <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
          {raisedInvoice
            ? 'This document has already been turned into an invoice draft.'
            : 'The supplier, invoice number, dates and total are copied across. You add coding and who should confirm receipt, then send it for sign-off.'}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-[var(--space-4)]">
        {raisedInvoice ? (
          <div className="flex flex-wrap items-center gap-[var(--space-3)]">
            <Button variant="secondary" asChild>
              <Link to={`/invoices/${raisedInvoice.id}`}>
                <FileText aria-hidden="true" className="size-4" />
                {raisedInvoice.reference}
                <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            </Button>
            <span className="text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              {raisedInvoice.state_label}
            </span>
          </div>
        ) : (
          <>
            {create.error ? (
              <p
                role="alert"
                className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-danger-700)]"
              >
                {create.error instanceof Error
                  ? create.error.message
                  : 'The invoice was not created.'}
              </p>
            ) : null}
            <div>
              <Button
                variant="primary"
                isLoading={create.isPending}
                loadingLabel="Creating"
                onClick={() =>
                  create.mutate(
                    { documentId: document.id },
                    {
                      onSuccess: (invoice) => void navigate(`/invoices/${invoice.id}`),
                    },
                  )
                }
              >
                <FileText aria-hidden="true" className="size-4" />
                Record invoice
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
