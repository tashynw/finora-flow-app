import { useState } from 'react';
import { useParams } from '@/lib/app-link';
import { CheckCircle2, ShieldQuestion } from 'lucide-react';

import type { ClaimOutcome, VendorQuestionOut } from '@finora/shared-types';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Textarea } from '@/components/ui/field';
import { FinoraMark } from '@/components/brand/finora-mark';
import { MoneyDisplay } from '@/components/finance/money-display';
import { SkeletonText } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api-client';
import { formatDate, formatMoment } from '@/lib/dates';
import { toMoneyValue } from '@/features/payments/currency-totals';
import { ChoiceList, type Choice } from '@/features/vendor-confirmations/choice-list';
import {
  useAnswerAsVendor,
  useVendorQuestion,
} from '@/features/vendor-confirmations/use-vendor-check-ins';

/**
 * The supplier's own page.
 *
 * The only screen in the platform reached without signing in, and the only one
 * written for somebody outside the organisation. Almost every convention the
 * rest of the app follows is deliberately absent: no shell, no sidebar, no
 * navigation at all, because there is nowhere else here for this reader to go
 * and a menu full of links they cannot open would only tell them what they are
 * shut out of.
 *
 * Three things govern what it says.
 *
 * *It asks, and it does not assert.* The page never tells a supplier they were
 * paid. It tells them what we sent and asks whether it arrived, because the
 * whole reason this page exists is that we do not know.
 *
 * *It says plainly that an answer is not a settlement.* A supplier who clicks
 * "Yes, it arrived" has told us something; nothing in our records has moved and
 * nobody has been paid off the strength of it. Saying only "thank you" would
 * imply the matter is closed, and a supplier who believes that stops chasing.
 *
 * *It shows them only what is already theirs.* Their invoice numbers, their
 * amounts, their due dates. No internal reference beyond the one quoted in the
 * email they are holding, nothing about any other supplier, and no name of
 * anybody who works here.
 */
export function VendorCheckInPage() {
  const { token } = useParams<{ token: string }>();
  const question = useVendorQuestion(token);

  return (
    <div className="min-h-dvh bg-[var(--color-surface-subtle)]">
      <header className="border-b border-[var(--color-divider)] bg-[var(--color-surface)]">
        <div className="mx-auto flex max-w-3xl items-center px-[var(--space-5)] py-[var(--space-4)]">
          <FinoraMark showWordmark />
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-[var(--space-5)] py-[var(--space-8)]">
        {question.isLoading ? (
          <Card>
            <CardContent>
              <SkeletonText lines={6} />
            </CardContent>
          </Card>
        ) : question.isError || !question.data ? (
          <LinkRefused message={errorMessage(question.error)} />
        ) : (
          <Question question={question.data} token={token ?? ''} />
        )}
      </main>

      <footer className="mx-auto max-w-3xl px-[var(--space-5)] pb-[var(--space-10)]">
        <p className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-subtle)]">
          This page was opened from a link we emailed you. It cannot be used to
          sign in, and it shows only the payment it was sent about.
        </p>
      </footer>
    </div>
  );
}

/**
 * Every way a link can fail, said the same way.
 *
 * Expired, already used, revoked, never existed — one message for all of them,
 * because distinguishing them would tell a stranger which tokens are real. The
 * wording still has to be useful to the supplier who has simply come back to an
 * old email, so it names the two likely innocent explanations and gives them
 * somebody to write to.
 */
function LinkRefused({ message }: { message: string | undefined }) {
  return (
    <Card className="border-[var(--color-warning-600)]">
      <CardContent className="flex gap-[var(--space-4)]">
        <ShieldQuestion
          aria-hidden="true"
          className="mt-0.5 size-6 shrink-0 text-[var(--color-warning-700)]"
        />
        <div>
          <h1 className="m-0 text-[length:var(--text-heading-2)] leading-[var(--text-heading-2--line-height)] font-semibold">
            This link cannot be opened
          </h1>
          <p className="mt-[var(--space-3)] m-0 text-[length:var(--text-body)] text-[var(--color-text-muted)]">
            {message ??
              'The link has expired, has already been used, or was not quite copied in full.'}
          </p>
          <p className="mt-[var(--space-3)] m-0 text-[length:var(--text-body)] text-[var(--color-text-muted)]">
            If you have already answered, there is nothing further you need to
            do. If you have not, reply to the email this link came from and
            somebody will pick it up.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The supplier's three answers, in their words rather than ours.
 *
 * Deliberately not the internal wording. A supplier is asked whether money
 * arrived, not to classify a claim outcome, and "Yes, the full amount arrived"
 * is answerable by somebody who has their bank app open.
 */
const CHOICES: readonly Choice<ClaimOutcome>[] = [
  {
    value: 'received',
    label: 'Yes, the full amount arrived',
    help: 'The whole payment reached your account.',
  },
  {
    value: 'partly_received',
    label: 'Only part of it arrived',
    help: 'Some of it reached you and some did not. Please say how much below.',
  },
  {
    value: 'not_received',
    label: 'No, nothing has arrived',
    help: 'Nothing has reached your account from us for this payment.',
  },
];

function Question({ question, token }: { question: VendorQuestionOut; token: string }) {
  const answer = useAnswerAsVendor(token);

  const [claim, setClaim] = useState<ClaimOutcome | null>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  // Held separately from the field values so a blank name is only ever
  // complained about after somebody has tried to send, never on arrival.
  const [attempted, setAttempted] = useState(false);

  if (answer.isSuccess) {
    return <Answered message={answer.data.message} />;
  }

  // Not treated as an error state. Somebody here reviewed the check-in between
  // this page loading and the answer arriving, which is a genuine race and not
  // this supplier's fault.
  const alreadyClosed = answer.error !== null && answer.isError;

  if (question.already_answered) {
    return (
      <Answered
        message={
          'We already have an answer from you for this payment, recorded on ' +
          `${formatMoment(question.answered_at)}. There is nothing further you need to do.`
        }
      />
    );
  }

  const nameMissing = attempted && name.trim().length === 0;
  const choiceMissing = attempted && claim === null;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (claim === null || name.trim().length === 0) return;
    answer.mutate({ claim, respondentName: name.trim(), note: note.trim() });
  };

  return (
    <>
      <h1 className="m-0 text-[length:var(--text-display-sm)] leading-[var(--text-display-sm--line-height)] font-bold">
        Did this payment reach you?
      </h1>
      <p className="mt-[var(--space-3)] m-0 text-[length:var(--text-body-lg)] text-[var(--color-text-muted)]">
        We sent the payment below to {question.vendor_name} on{' '}
        {formatDate(question.paid_on?.slice(0, 10))} and would like to know
        whether it arrived. Please quote {question.reference} if you telephone us
        about it.
      </p>

      <Card className="mt-[var(--space-6)]">
        <CardHeader>
          <CardTitle>What we sent</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ul className="m-0 list-none p-0">
            {question.lines.map((line) => (
              <li
                key={line.our_reference}
                className="flex flex-wrap items-baseline justify-between gap-[var(--space-3)] border-b border-[var(--color-divider)] px-[var(--space-5)] py-[var(--space-4)] last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="m-0 font-semibold text-[var(--color-text-strong)]">
                    {line.invoice_number ?? 'Invoice number not recorded'}
                  </p>
                  <p className="mt-1 m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
                    {line.due_date ? `Due ${formatDate(line.due_date)}` : 'No due date recorded'}
                  </p>
                </div>
                <MoneyDisplay value={toMoneyValue(line.amount)} />
              </li>
            ))}
          </ul>
        </CardContent>
        <div className="flex flex-wrap items-baseline justify-between gap-[var(--space-3)] border-t border-[var(--color-divider)] bg-[var(--color-surface-subtle)] px-[var(--space-5)] py-[var(--space-4)]">
          <p className="m-0 font-semibold text-[var(--color-text-strong)]">
            {question.totals.length > 1 ? 'Totals' : 'Total'}
          </p>
          {/* One figure per currency, never added together. Two currencies
              means two separate payments were sent, and a combined number
              would be denominated in nothing. */}
          <ul className="m-0 flex list-none flex-col items-end gap-[var(--space-1)] p-0">
            {question.totals.map((total) => (
              <li key={total.currency}>
                <MoneyDisplay value={toMoneyValue(total)} size="lg" />
              </li>
            ))}
          </ul>
        </div>
      </Card>

      <form onSubmit={submit} noValidate className="mt-[var(--space-6)]">
        <Card>
          <CardHeader>
            <CardTitle as="h2">Your answer</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-[var(--space-5)]">
            <ChoiceList
              legend="What happened?"
              name="claim"
              choices={CHOICES}
              value={claim}
              onChange={setClaim}
              error={choiceMissing ? 'Please choose one of the three answers below.' : undefined}
            />

            <Field
              label="Your name"
              required
              help="So we know who to come back to if we need to ask anything."
              error={nameMissing ? 'Please tell us who is answering.' : undefined}
            >
              {({ inputId, describedBy, invalid }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  name="respondent_name"
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              )}
            </Field>

            <Field
              label="Anything else we should know"
              help="The date it landed, the amount if it differed, or a reference from your bank."
            >
              {({ inputId, describedBy }) => (
                <Textarea
                  id={inputId}
                  aria-describedby={describedBy}
                  name="note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              )}
            </Field>

            {alreadyClosed ? (
              <p
                role="alert"
                className="m-0 rounded-[var(--radius-md)] border border-[var(--color-warning-600)] bg-[var(--color-warning-50)] p-[var(--space-4)] text-[length:var(--text-body-sm)] text-[var(--color-warning-700)]"
              >
                {errorMessage(answer.error) ??
                  'Your answer could not be recorded. Please reply to the email this link came from.'}
              </p>
            ) : null}
          </CardContent>

          <div className="flex flex-col gap-[var(--space-3)] border-t border-[var(--color-divider)] bg-[var(--color-surface-subtle)] px-[var(--space-5)] py-[var(--space-4)]">
            {/* Said before they commit, not after. A supplier who reads
                "thank you" and nothing else concludes the matter is closed and
                stops chasing us, which is exactly the wrong outcome when they
                have just told us the money never arrived. */}
            <p className="m-0 text-[length:var(--text-body-sm)] text-[var(--color-text-muted)]">
              Your answer is recorded as what you have told us. It does not close
              anything on its own — somebody in our accounts team checks it
              against our bank records before the invoice is marked as settled.
            </p>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              isLoading={answer.isPending}
              loadingLabel="Sending your answer"
            >
              Send my answer
            </Button>
          </div>
        </Card>
      </form>
    </>
  );
}

function Answered({ message }: { message: string }) {
  return (
    <Card>
      <CardContent className="flex gap-[var(--space-4)]">
        <CheckCircle2
          aria-hidden="true"
          className="mt-0.5 size-6 shrink-0 text-[var(--color-success-600)]"
        />
        <div>
          <h1
            // Announced because the form it replaced was submitted by the
            // reader, and a page that silently swaps its content leaves
            // somebody using a screen reader with no idea it worked.
            role="status"
            className="m-0 text-[length:var(--text-heading-2)] leading-[var(--text-heading-2--line-height)] font-semibold"
          >
            Thank you
          </h1>
          <p className="mt-[var(--space-3)] m-0 text-[length:var(--text-body)] text-[var(--color-text-muted)]">
            {message}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
