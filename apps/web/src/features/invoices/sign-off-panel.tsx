import { useState } from 'react';
import { CheckCircle2, Clock, ThumbsDown, XCircle } from 'lucide-react';

import type { InvoiceDetail } from '@finora/shared-types';

import { formatMoment } from '@/lib/dates';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Textarea } from '@/components/ui/field';
import { ToneBadge } from '@/components/workflow/status-badge';
import { chasingDescriptor } from '@/features/invoices/invoice-vocabulary';

/**
 * Receipt confirmation: who was asked, how long they have had it, and — if they
 * are the one reading — the two buttons that answer it.
 *
 * This is the control that separates an invoice from a piece of paper claiming
 * money is owed. Nothing goes to an approver until somebody who is not in
 * finance says the goods or services actually arrived, so the panel states in
 * words what confirming means rather than labelling a button "Approve" and
 * hoping the person reads the heading.
 *
 * The chase count is shown to everybody, not just to finance. Somebody who has
 * been asked four times should see that they have been asked four times: hiding
 * it from them and showing it to the person about to escalate would be a
 * politeness that costs them the chance to act first.
 */
export interface SignOffPanelProps {
  invoice: InvoiceDetail;
  onConfirm: (note: string | undefined) => void;
  onDecline: () => void;
  isConfirming: boolean;
  /** The server's own words for a refused confirmation. Shown unchanged. */
  error: string | undefined;
}

export function SignOffPanel({
  invoice,
  onConfirm,
  onDecline,
  isConfirming,
  error,
}: SignOffPanelProps) {
  const [note, setNote] = useState('');
  const signOff = invoice.sign_off;
  const actions = invoice.actions;

  // Confirmed receipt only counts once the invoice has left pending sign-off.
  // A signed_off timestamp while still pending means the route failed to open —
  // keep the confirm action available so the requester can retry after the matrix
  // is fixed, without cancelling the invoice.
  if (signOff.signed_off_at && invoice.state !== 'pending_sign_off') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            <span className="inline-flex items-center gap-[var(--space-2)]">
              <CheckCircle2 aria-hidden="true" className="size-4 text-[var(--color-success-600)]" />
              Receipt confirmed
            </span>
          </CardTitle>
          <CardDescription>
            {signOff.signed_off_by_label ?? 'Somebody'} confirmed that this was received on{' '}
            <time dateTime={signOff.signed_off_at} data-visual-volatile>
              {formatMoment(signOff.signed_off_at)}
            </time>
            .
          </CardDescription>
        </CardHeader>
        {signOff.note ? (
          <CardContent>
            <p className="m-0 whitespace-pre-line text-[length:var(--text-body-sm)] text-[var(--color-text)]">
              {signOff.note}
            </p>
          </CardContent>
        ) : null}
      </Card>
    );
  }

  const declined = declineOf(invoice);
  if (declined) {
    return (
      <Card className="border-[var(--color-danger-600)]">
        <CardHeader>
          <CardTitle>
            <span className="inline-flex items-center gap-[var(--space-2)]">
              <XCircle aria-hidden="true" className="size-4 text-[var(--color-danger-600)]" />
              Receipt was declined
            </span>
          </CardTitle>
          <CardDescription>
            {declined.actor_label ?? 'The person asked'} was asked to confirm this and said it did
            not arrive as billed, on{' '}
            <time dateTime={declined.occurred_at} data-visual-volatile>
              {formatMoment(declined.occurred_at)}
            </time>
            . The chasing has stopped.
          </CardDescription>
        </CardHeader>
        {declined.reason ? (
          <CardContent>
            <p className="m-0 whitespace-pre-line text-[length:var(--text-body-sm)] text-[var(--color-text)]">
              {declined.reason}
            </p>
            <p className="mt-[var(--space-3)] m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
              Correct the invoice and ask again, or cancel it. Nothing is paid either way until
              somebody confirms the goods arrived.
            </p>
          </CardContent>
        ) : null}
      </Card>
    );
  }

  if (!signOff.requested_at) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Receipt not yet confirmed</CardTitle>
          <CardDescription>
            {signOff.requester_label
              ? `${signOff.requester_label} will be asked to confirm the goods or services arrived before this reaches any approver.`
              : 'Name the person who can say the goods or services arrived. Nothing goes to an approver until they have confirmed it.'}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const chasing = chasingDescriptor(signOff.reminders_sent, signOff.escalation_level);
  const mine = actions.may_sign_off;
  const approvalStuck =
    Boolean(signOff.signed_off_at) && invoice.state === 'pending_sign_off';

  return (
    <Card
      className={
        mine ? 'border-[color-mix(in_srgb,var(--color-warning-600)_38%,white)]' : undefined
      }
    >
      <CardHeader>
        <CardTitle>
          {approvalStuck
            ? mine
              ? 'Confirm again to open approval'
              : 'Receipt noted, approval not opened'
            : mine
              ? 'Did this arrive?'
              : 'Waiting on receipt confirmation'}
        </CardTitle>
        <CardDescription>
          {approvalStuck
            ? mine
              ? 'Your earlier confirmation was kept back because the approval route could not open. Fix the matrix or assignees if needed, then confirm again — you do not need to cancel this invoice.'
              : 'Receipt was confirmed, but the approval route did not open. An administrator should check the approval matrix, then the requester can confirm again.'
            : mine
              ? 'You were named as the person who asked for this. Nothing goes to an approver until you answer, and nobody is paid until it does.'
              : `${signOff.requester_label ?? 'The requester'} has been asked to confirm the goods or services arrived.`}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-[var(--space-4)]">
        <div className="flex flex-wrap items-center gap-[var(--space-3)]">
          <ToneBadge label={chasing.label} tone={chasing.tone} detail={chasing.description} />
          {signOff.next_reminder_at ? (
            <span className="inline-flex items-center gap-[var(--space-2)] text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              <Clock aria-hidden="true" className="size-4" />
              Next reminder{' '}
              <time dateTime={signOff.next_reminder_at} data-visual-volatile>
                {formatMoment(signOff.next_reminder_at)}
              </time>
            </span>
          ) : null}
        </div>

        {!mine ? (
          <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
            Asked on{' '}
            <time dateTime={signOff.requested_at} data-visual-volatile>
              {formatMoment(signOff.requested_at)}
            </time>
            {signOff.requester_email ? ` at ${signOff.requester_email}` : ''}.
          </p>
        ) : null}

        {mine ? (
          <>
            <Field
              label="Anything worth recording"
              help="Optional. Partial deliveries, a substituted item, a date that differs from the invoice — anything an approver should know before they commit the money."
            >
              {({ inputId, describedBy }) => (
                <Textarea
                  id={inputId}
                  aria-describedby={describedBy}
                  rows={3}
                  value={note}
                  maxLength={2000}
                  disabled={isConfirming}
                  onChange={(event) => setNote(event.target.value)}
                />
              )}
            </Field>

            {error ? (
              <div aria-live="polite">
                <p className="m-0 font-semibold text-[var(--color-danger-700)]">
                  This was not confirmed
                </p>
                <p className="mt-1 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text)]">
                  {error}
                </p>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-[var(--space-3)]">
              <Button
                variant="primary"
                onClick={() => onConfirm(note.trim() || undefined)}
                isLoading={isConfirming}
                loadingLabel="Recording"
              >
                <CheckCircle2 aria-hidden="true" className="size-4" />
                Yes, this arrived
              </Button>
              {actions.may_decline ? (
                <Button variant="secondary" onClick={onDecline} disabled={isConfirming}>
                  <ThumbsDown aria-hidden="true" className="size-4" />
                  No, something is wrong
                </Button>
              ) : null}
            </div>

            <p className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
              Confirming says the goods or services were received. It is not an approval of the
              spending, and it does not commit your budget — that comes afterwards, from the
              approvers the amount requires.
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * The refusal this invoice is sitting on, if it is sitting on one.
 *
 * Read from the history rather than from a field of its own, because the move
 * out of sign-off and into exception *is* the refusal: only a decline makes it,
 * a recall goes back to draft instead. Taking it from the transition also brings
 * the reason and the person with it, which is what finance is here to read.
 *
 * Without this the panel below would tell finance that the requester "has been
 * asked to confirm" long after she answered and said no — the one thing on this
 * screen that would send somebody off to chase a person who has already replied.
 */
export function declineOf(invoice: InvoiceDetail) {
  if (invoice.state !== 'exception' || invoice.sign_off.signed_off_at) return undefined;
  return [...invoice.transitions]
    .reverse()
    .find((entry) => entry.from_state === 'pending_sign_off' && entry.to_state === 'exception');
}
