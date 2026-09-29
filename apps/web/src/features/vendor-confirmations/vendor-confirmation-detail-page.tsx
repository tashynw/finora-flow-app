import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Gavel, Mail, PhoneCall } from 'lucide-react';

import type { CheckInDetailOut } from '@finora/shared-types';

import { ApiError, errorMessage } from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SkeletonText } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/workflow/status-badge';
import { MoneyDisplay } from '@/components/finance/money-display';
import { PageHeader } from '@/features/shared/page-header';
import { DetailRow } from '@/features/shared/detail-row';
import { CurrencyTotals, toMoneyValue } from '@/features/payments/currency-totals';
import { CheckInTimeline } from '@/features/vendor-confirmations/check-in-timeline';
import { RecordAnswerDialog } from '@/features/vendor-confirmations/record-answer-dialog';
import { ReviewDialog } from '@/features/vendor-confirmations/review-dialog';
import {
  CHANNEL,
  CLAIM,
  headlineStatus,
  STANDING,
} from '@/features/vendor-confirmations/confirmation-vocabulary';
import {
  useSendCheckIn,
  useVendorCheckIn,
} from '@/features/vendor-confirmations/use-vendor-check-ins';

/**
 * One conversation with one supplier about one payment.
 *
 * The screen is arranged so the reader meets the sequence before they meet the
 * claim. The timeline runs down the main column, the supplier's own words sit
 * beneath it clearly attributed, and the conclusion is a deliberate act at the
 * end rather than a confirmation of what is already on screen.
 *
 * There is exactly one place green appears, and it is governed by
 * `confirmed_paid` — which the API computes from the invoices themselves rather
 * than from the review or the claim. A supplier saying the money arrived changes
 * nothing about the colour of this page.
 */
function purposeFor(checkIn: CheckInDetailOut): string {
  if (checkIn.confirmed_paid) {
    return 'Confirmed paid. Every invoice in this check-in has been settled.';
  }
  return STANDING[checkIn.standing].description;
}

export function VendorConfirmationDetailPage() {
  const { checkInId } = useParams<{ checkInId: string }>();
  const { data: checkIn, isLoading, isError, error } = useVendorCheckIn(checkInId);
  const send = useSendCheckIn(checkInId);
  const [dialog, setDialog] = useState<'answer' | 'review' | null>(null);

  if (isLoading || (!checkIn && !isError)) {
    return (
      <>
        <PageHeader title="Vendor confirmation" purpose="Opening this check-in." />
        <Card>
          <CardContent>
            <SkeletonText lines={8} />
          </CardContent>
        </Card>
      </>
    );
  }

  if (!checkIn) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <>
        <PageHeader
          title="Vendor confirmation"
          purpose="This check-in could not be opened."
          actions={
            <Button variant="secondary" asChild>
              <Link to="/vendor-confirmations">
                <ArrowLeft aria-hidden="true" className="size-4" />
                Back to the queue
              </Link>
            </Button>
          }
        />
        <Card className="border-[var(--color-danger-600)]">
          <CardContent>
            <p className="m-0 font-semibold text-[var(--color-danger-700)]">
              {missing ? 'That check-in could not be found' : 'Could not load this check-in'}
            </p>
            <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              {missing
                ? 'The link may be to a check-in that never existed, or to one raised against a package that has since been abandoned.'
                : (errorMessage(error) ?? 'The request did not complete.')}
            </p>
          </CardContent>
        </Card>
      </>
    );
  }

  const status = headlineStatus(
    checkIn.standing,
    checkIn.standing_label,
    checkIn.review_outcome ?? null,
    checkIn.review_outcome_label ?? null,
  );

  return (
    <>
      <PageHeader
        title={checkIn.vendor_name}
        purpose={purposeFor(checkIn)}
        meta={
          <div className="flex flex-wrap items-center gap-[var(--space-3)]">
            <ToneBadge label={status.label} tone={status.tone} />
            <span className="tabular text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              {checkIn.reference} · {checkIn.package_reference}
            </span>
          </div>
        }
        actions={
          <>
            <Button variant="ghost" asChild>
              <Link to="/vendor-confirmations">
                <ArrowLeft aria-hidden="true" className="size-4" />
                All check-ins
              </Link>
            </Button>

            {checkIn.can_send ? (
              <Button
                variant="secondary"
                onClick={() => send.mutate()}
                isLoading={send.isPending}
                loadingLabel="Sending"
              >
                <Mail aria-hidden="true" className="size-4" />
                Ask the supplier
              </Button>
            ) : null}

            {checkIn.can_record_answer ? (
              <Button variant="secondary" onClick={() => setDialog('answer')}>
                <PhoneCall aria-hidden="true" className="size-4" />
                Write down what they said
              </Button>
            ) : null}

            {checkIn.can_review ? (
              <Button variant="primary" onClick={() => setDialog('review')}>
                <Gavel aria-hidden="true" className="size-4" />
                Conclude
              </Button>
            ) : null}
          </>
        }
      />

      <div aria-live="polite">
        {send.isError ? (
          <Card className="mb-[var(--space-5)] border-[var(--color-danger-600)]">
            <CardContent>
              <p className="m-0 font-semibold text-[var(--color-danger-700)]">
                The supplier was not asked
              </p>
              <p className="mt-2 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text)]">
                {errorMessage(send.error) ?? 'The request did not complete.'}
              </p>
            </CardContent>
          </Card>
        ) : null}
      </div>

      <div className="grid gap-[var(--space-5)] lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col gap-[var(--space-5)]">
          <Card>
            <CardHeader>
              <CardTitle>What has happened</CardTitle>
              <CardDescription>
                An instruction to a bank is not a payment, and a supplier saying so is not
                proof. Each step below is a different fact.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CheckInTimeline checkIn={checkIn} />
            </CardContent>
          </Card>

          {checkIn.claim ? (
            <Card>
              <CardHeader>
                <CardTitle>What the supplier says</CardTitle>
                {/* The heading says "says" and the description says whose account
                    this is, because a panel headed "Payment status" holding the
                    same words would be read as our finding rather than theirs. */}
                <CardDescription>
                  Their account of it, recorded as given and not verified by anybody here.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="m-0">
                  <DetailRow label="They say">
                    <span className="font-semibold">
                      {checkIn.claim_label ?? CLAIM[checkIn.claim].label}
                    </span>
                  </DetailRow>
                  <DetailRow label="How it reached us">
                    {checkIn.claim_channel_label ??
                      (checkIn.claim_channel ? CHANNEL[checkIn.claim_channel] : '—')}
                  </DetailRow>
                  <DetailRow label="Given by">{checkIn.respondent_name || '—'}</DetailRow>
                  <DetailRow label="In their words">
                    {checkIn.respondent_note ? (
                      <span className="whitespace-pre-wrap">{checkIn.respondent_note}</span>
                    ) : (
                      <span className="text-[var(--color-text-muted)]">
                        They added nothing beyond the answer itself.
                      </span>
                    )}
                  </DetailRow>
                </dl>
              </CardContent>
            </Card>
          ) : null}

          {checkIn.reviewed_at ? (
            <Card>
              <CardHeader>
                <CardTitle>The decision</CardTitle>
                <CardDescription>
                  What somebody here concluded, and on what basis. This is what moved the
                  invoices.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="m-0">
                  <DetailRow label="Concluded">
                    {checkIn.review_outcome_label ?? '—'}
                  </DetailRow>
                  <DetailRow label="By">{checkIn.reviewed_by_label || '—'}</DetailRow>
                  <DetailRow label="Why">
                    {checkIn.review_note ? (
                      <span className="whitespace-pre-wrap">{checkIn.review_note}</span>
                    ) : (
                      <span className="text-[var(--color-text-muted)]">
                        No reason was recorded. The supplier’s answer and the conclusion agreed.
                      </span>
                    )}
                  </DetailRow>
                </dl>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>The invoices this covers</CardTitle>
              <CardDescription>
                The bank pays a package as one credit, so this supplier saw one deposit and
                was asked one question. These are the invoices behind it.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <ul className="m-0 list-none p-0">
                {checkIn.lines.map((line) => (
                  <li
                    key={line.invoice_reference}
                    className="flex flex-wrap items-baseline justify-between gap-[var(--space-3)] border-b border-[var(--color-divider)] px-[var(--space-5)] py-[var(--space-4)] last:border-b-0"
                  >
                    <div className="min-w-0">
                      <p className="m-0 flex flex-wrap items-baseline gap-x-[var(--space-2)]">
                        <span className="tabular text-[length:var(--text-caption)] text-[var(--color-text-subtle)]">
                          {line.invoice_reference}
                        </span>
                        <span className="truncate font-semibold text-[var(--color-text-strong)]">
                          {line.invoice_number ?? 'No invoice number'}
                        </span>
                      </p>
                      <p className="mt-1 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                        {line.invoice_state_label}
                        {line.due_date ? ` · due ${formatDate(line.due_date)}` : ''}
                      </p>
                    </div>
                    <MoneyDisplay value={toMoneyValue(line.amount)} />
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-[var(--space-5)]">
          <Card>
            <CardHeader>
              <CardTitle>What we sent them</CardTitle>
              <CardDescription>
                {checkIn.totals.length > 1
                  ? 'One figure per currency. They are separate payments and there is no rate at which they add up.'
                  : 'The amount that left us for this supplier.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CurrencyTotals totals={checkIn.totals} emphasis />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Where to reach them</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="m-0">
                <DetailRow label="Email">
                  {checkIn.vendor_email ?? (
                    <span className="text-[var(--color-warning-700)]">
                      None on the supplier record. They cannot be emailed.
                    </span>
                  )}
                </DetailRow>
                <DetailRow label="Bank reference">
                  {checkIn.submission_reference || '—'}
                </DetailRow>
              </dl>
            </CardContent>
          </Card>

          {checkIn.can_review ? null : checkIn.reviewed_at ? null : (
            // Said where the Conclude button would be, so somebody who cannot
            // see it knows the button is missing on purpose rather than broken.
            <Card>
              <CardContent>
                <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                  {checkIn.standing === 'not_sent'
                    ? 'Nothing can be concluded until the supplier has been asked.'
                    : 'Concluding needs the right to mark a payment paid, which is held separately from the right to submit one. Somebody else has to do this part.'}
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <RecordAnswerDialog
        checkIn={checkIn}
        open={dialog === 'answer'}
        onClose={() => setDialog(null)}
      />
      <ReviewDialog
        checkIn={checkIn}
        open={dialog === 'review'}
        onClose={() => setDialog(null)}
      />
    </>
  );
}
