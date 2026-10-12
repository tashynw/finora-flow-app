import { ArrowRight, ScrollText } from 'lucide-react';
import { Link, useNavigate } from '@/lib/app-link';

import type { DocumentDetail } from '@finora/shared-types';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/features/auth/auth-context';
import { useCreateEstimate } from '@/features/estimates/use-estimates';

/**
 * What to do with an accepted reading of a quotation.
 *
 * The review workspace ends with somebody agreeing that a document says what the
 * reader claims. That is not the reason they were there: they were there because
 * a supplier quoted for something and permission is needed to spend it. Without
 * this panel a reviewer accepts a reading and is left on a page with nothing
 * further to do, having to know that estimates are a different screen.
 *
 * Shown only once the reading is accepted. Raising an estimate from unconfirmed
 * values would put figures nobody has checked in front of an approver, and the
 * API refuses it for the same reason.
 */
export function RaiseEstimatePanel({ document }: { document: DocumentDetail }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const create = useCreateEstimate();

  const raised = document.raised_as;
  const accepted = document.status === 'accepted';

  if (document.kind !== 'estimate') return null;
  if (!raised && (!accepted || !can('estimate:create'))) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{raised ? 'Raised as an estimate' : 'Raise an estimate from this'}</CardTitle>
        <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
          {raised
            ? 'This quotation has already been turned into a request for spending approval.'
            : 'The supplier, quotation number, date and total are copied across. You add what it is for, why it is needed and the cost centre, then send it for approval.'}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-[var(--space-4)]">
        {raised ? (
          <div className="flex flex-wrap items-center gap-[var(--space-3)]">
            <Button variant="secondary" asChild>
              <Link to={`/estimates/${raised.id}`}>
                <ScrollText aria-hidden="true" className="size-4" />
                {raised.reference}
                <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            </Button>
            <span className="text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              {raised.state_label}
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
                  : 'The estimate was not created.'}
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
                    { onSuccess: (estimate) => void navigate(`/estimates/${estimate.id}`) },
                  )
                }
              >
                <ScrollText aria-hidden="true" className="size-4" />
                Raise an estimate
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
