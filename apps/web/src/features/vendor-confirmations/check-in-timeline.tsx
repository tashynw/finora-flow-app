import { Check, Circle, Clock } from 'lucide-react';

import type { CheckInDetailOut } from '@finora/shared-types';

import { cn } from '@/lib/utils';
import { formatMoment } from '@/lib/dates';
import { CHANNEL, CLAIM, REVIEW } from '@/features/vendor-confirmations/confirmation-vocabulary';

/**
 * The five things that happen to a payment, in the order they happen.
 *
 * Drawn as a timeline rather than listed as fields because the sequence is the
 * argument. Read top to bottom it says: we sent an instruction, we asked, they
 * answered, somebody here checked, and only then was it settled. A reader who
 * has seen that shape once knows why a supplier's "yes" on step three is not the
 * same as the tick on step five, and no amount of explanatory text does that as
 * economically.
 *
 * The last step is the one the design turns on. It is never marked done on the
 * strength of the review alone — `confirmed_paid` comes from the invoices
 * themselves, every one of which must actually be in `paid`. A review concluding
 * Outstanding leaves it unticked and says so, which is exactly right: nothing
 * was settled.
 */

type StepState = 'done' | 'current' | 'waiting';

interface Step {
  key: string;
  title: string;
  state: StepState;
  when: string | null;
  detail: string;
  /** Shown in the strong colour. Reserved for the money actually landing. */
  settled?: boolean;
}

function stepsFor(checkIn: CheckInDetailOut): Step[] {
  const asked = checkIn.sent_at !== null;
  const answered = checkIn.answered_at !== null;
  const reviewed = checkIn.reviewed_at !== null;

  return [
    {
      key: 'submitted',
      title: 'Sent to the bank',
      state: 'done',
      when: checkIn.package_submitted_at,
      detail: checkIn.submission_reference
        ? `In ${checkIn.package_reference}, against bank reference ${checkIn.submission_reference}.`
        : `In ${checkIn.package_reference}. An instruction went out; nothing yet says it landed.`,
    },
    {
      key: 'asked',
      title: 'Supplier asked',
      state: asked ? 'done' : 'current',
      when: checkIn.sent_at,
      detail: asked
        ? `We emailed ${checkIn.vendor_email ?? 'them'} asking whether the money arrived.`
        : checkIn.vendor_email
          ? 'Nobody has asked them yet.'
          : 'There is no email address on the supplier record, so they cannot be emailed. Telephone them and record what they say.',
    },
    {
      key: 'answered',
      title: 'Supplier answered',
      state: answered ? 'done' : asked ? 'current' : 'waiting',
      when: checkIn.answered_at,
      detail: answered
        ? [
            checkIn.claim ? CLAIM[checkIn.claim].label : 'They replied.',
            checkIn.claim_channel ? CHANNEL[checkIn.claim_channel] : null,
            checkIn.respondent_name ? `Given by ${checkIn.respondent_name}, unverified.` : null,
          ]
            .filter(Boolean)
            .join(' · ')
        : asked
          ? 'Nothing back yet. Silence is not payment, and it is not a refusal either.'
          : 'Nothing to answer yet.',
    },
    {
      key: 'reviewed',
      title: 'Checked here',
      state: reviewed ? 'done' : answered ? 'current' : 'waiting',
      when: checkIn.reviewed_at,
      detail: reviewed
        ? [
            checkIn.review_outcome ? REVIEW[checkIn.review_outcome].label : null,
            checkIn.reviewed_by_label ? `by ${checkIn.reviewed_by_label}` : null,
          ]
            .filter(Boolean)
            .join(' ')
        : 'Somebody holding the right to mark a payment paid has to weigh what the supplier said against our own record.',
    },
    {
      key: 'settled',
      // `confirmed_paid` reads the invoices rather than the review, so a review
      // that concluded Outstanding correctly leaves this open.
      title: checkIn.confirmed_paid ? 'Settled' : 'Not settled',
      state: checkIn.confirmed_paid ? 'done' : 'waiting',
      when: null,
      detail: checkIn.confirmed_paid
        ? 'Every invoice in this check-in is now paid.'
        : reviewed
          ? 'The invoices went back to being owed. Somebody has to chase the bank.'
          : 'No invoice moves until somebody here concludes.',
      settled: checkIn.confirmed_paid,
    },
  ];
}

const ICONS: Record<StepState, typeof Check> = {
  done: Check,
  current: Clock,
  waiting: Circle,
};

export function CheckInTimeline({ checkIn }: { checkIn: CheckInDetailOut }) {
  const steps = stepsFor(checkIn);

  return (
    <ol className="m-0 list-none p-0">
      {steps.map((step, index) => {
        const Icon = ICONS[step.state];
        const last = index === steps.length - 1;

        return (
          <li key={step.key} className="flex gap-[var(--space-4)]">
            <div className="flex flex-col items-center">
              <span
                aria-hidden="true"
                className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-full border',
                  step.settled
                    ? 'border-[var(--color-success-600)] bg-[var(--color-success-600)] text-[var(--color-text-inverse)]'
                    : step.state === 'done'
                      ? 'border-[var(--color-border-strong)] bg-[var(--color-surface-subtle)] text-[var(--color-text-strong)]'
                      : step.state === 'current'
                        ? 'border-[var(--color-primary-600)] bg-[var(--color-primary-50)] text-[var(--color-primary-700)]'
                        : 'border-[var(--color-divider)] bg-[var(--color-surface)] text-[var(--color-text-subtle)]',
                )}
              >
                <Icon className="size-3.5" />
              </span>
              {last ? null : (
                <span
                  aria-hidden="true"
                  className="w-px flex-1 bg-[var(--color-divider)]"
                />
              )}
            </div>

            <div className={cn('min-w-0 pb-[var(--space-5)]', last && 'pb-0')}>
              <p className="m-0 flex flex-wrap items-baseline gap-x-[var(--space-2)]">
                <span
                  className={cn(
                    'font-semibold',
                    step.state === 'waiting'
                      ? 'text-[var(--color-text-muted)]'
                      : 'text-[var(--color-text-strong)]',
                  )}
                >
                  {step.title}
                </span>
                {step.when ? (
                  <time
                    dateTime={step.when}
                    data-visual-volatile
                    className="text-[var(--text-caption)] text-[var(--color-text-subtle)]"
                  >
                    {formatMoment(step.when)}
                  </time>
                ) : null}
              </p>
              <p className="mt-1 m-0 text-[var(--text-body-sm)] text-[var(--color-text-muted)]">
                {step.detail}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
