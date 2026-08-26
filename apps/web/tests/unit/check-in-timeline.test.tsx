import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { CheckInDetailOut } from '@finora/shared-types';

import { CheckInTimeline } from '@/features/vendor-confirmations/check-in-timeline';

/**
 * The timeline is the argument this feature makes, so it is tested as an
 * argument rather than as a list of five boxes.
 *
 * The claim under test throughout: nothing on the timeline says the money
 * arrived until `confirmed_paid` says so, and `confirmed_paid` is computed from
 * the invoices rather than from anything a supplier or a reviewer asserted.
 */

const BASE: CheckInDetailOut = {
  id: '2f9c1b4a-0000-4000-8000-000000000001',
  reference: 'VC-000123',
  version: 1,
  package_id: '2f9c1b4a-0000-4000-8000-000000000002',
  package_reference: 'PP-000045',
  package_submitted_at: '2026-07-01T14:05:00Z',
  submission_reference: 'NCB-8891',
  vendor_name: 'Kingston Supplies Limited',
  vendor_email: 'accounts@kingston-supplies.example',
  standing: 'not_sent',
  standing_label: 'Not asked yet',
  standing_description: 'The supplier has not been contacted.',
  lines: [],
  totals: [],
  sent_at: null,
  answered_at: null,
  claim: null,
  claim_label: null,
  claim_description: null,
  claim_channel: null,
  claim_channel_label: null,
  respondent_name: null,
  respondent_note: null,
  reviewed_at: null,
  reviewed_by_label: null,
  review_outcome: null,
  review_outcome_label: null,
  review_note: null,
  suggestion: { outcome: null, outcome_label: null, because: 'Nobody has answered.' },
  confirmed_paid: false,
  can_send: true,
  can_record_answer: false,
  can_review: false,
};

function withStage(overrides: Partial<CheckInDetailOut>): CheckInDetailOut {
  return { ...BASE, ...overrides };
}

/** The check-in as it stands after a supplier has said the money arrived. */
const ANSWERED_YES = withStage({
  standing: 'vendor_answered',
  sent_at: '2026-07-02T09:00:00Z',
  answered_at: '2026-07-03T11:30:00Z',
  claim: 'received',
  claim_channel: 'signed_link',
  respondent_name: 'Marcia Bennett',
});

describe('the sequence', () => {
  it('always shows all five steps, including the ones not reached', () => {
    // The steps still to come are the point. A timeline that rendered only what
    // had happened would show a supplier's "yes" as the last thing on the page.
    render(<CheckInTimeline checkIn={BASE} />);

    expect(screen.getByText('Sent to the bank')).toBeInTheDocument();
    expect(screen.getByText('Supplier asked')).toBeInTheDocument();
    expect(screen.getByText('Supplier answered')).toBeInTheDocument();
    expect(screen.getByText('Checked here')).toBeInTheDocument();
    expect(screen.getByText('Not settled')).toBeInTheDocument();
  });

  it('separates the instruction from the payment landing', () => {
    // Submitting a package is a fact about us, not about the supplier's bank
    // account. The first step must not claim otherwise.
    render(<CheckInTimeline checkIn={BASE} />);

    expect(screen.getByText(/against bank reference NCB-8891/i)).toBeInTheDocument();
  });
});

describe('a supplier saying the money arrived', () => {
  it('does not settle anything', () => {
    render(<CheckInTimeline checkIn={ANSWERED_YES} />);

    expect(screen.getByText('Not settled')).toBeInTheDocument();
    expect(screen.queryByText('Settled')).not.toBeInTheDocument();
  });

  it('is shown attributed to them and marked unverified', () => {
    render(<CheckInTimeline checkIn={ANSWERED_YES} />);

    expect(screen.getByText(/They say it arrived/)).toBeInTheDocument();
    expect(screen.getByText(/Given by Marcia Bennett, unverified/)).toBeInTheDocument();
  });

  it('says what still has to happen rather than leaving the step blank', () => {
    render(<CheckInTimeline checkIn={ANSWERED_YES} />);

    expect(screen.getByText(/right to mark a payment paid/i)).toBeInTheDocument();
  });
});

describe('after a review', () => {
  it('marks it settled only when the invoices themselves are paid', () => {
    const paid = withStage({
      ...ANSWERED_YES,
      standing: 'reviewed',
      reviewed_at: '2026-07-04T10:00:00Z',
      reviewed_by_label: 'Andrea Clarke',
      review_outcome: 'paid',
      confirmed_paid: true,
    });

    render(<CheckInTimeline checkIn={paid} />);

    expect(screen.getByText('Settled')).toBeInTheDocument();
    expect(screen.getByText(/Every invoice in this check-in is now paid/i)).toBeInTheDocument();
  });

  it('leaves the last step open when the reviewer concluded outstanding', () => {
    // A review is not the same as a settlement, and a reviewer concluding the
    // money never landed must not tick the box that says it did.
    const outstanding = withStage({
      standing: 'reviewed',
      sent_at: '2026-07-02T09:00:00Z',
      answered_at: '2026-07-03T11:30:00Z',
      claim: 'not_received',
      reviewed_at: '2026-07-04T10:00:00Z',
      reviewed_by_label: 'Andrea Clarke',
      review_outcome: 'outstanding',
      confirmed_paid: false,
    });

    render(<CheckInTimeline checkIn={outstanding} />);

    expect(screen.getByText('Not settled')).toBeInTheDocument();
    expect(screen.getByText(/back to being owed/i)).toBeInTheDocument();
  });

  it('names who decided, because the decision is the thing that moved money', () => {
    const paid = withStage({
      ...ANSWERED_YES,
      standing: 'reviewed',
      reviewed_at: '2026-07-04T10:00:00Z',
      reviewed_by_label: 'Andrea Clarke',
      review_outcome: 'paid',
      confirmed_paid: true,
    });

    render(<CheckInTimeline checkIn={paid} />);

    expect(screen.getByText(/by Andrea Clarke/)).toBeInTheDocument();
  });
});

describe('a supplier with no address', () => {
  it('says why they cannot be emailed and what to do instead', () => {
    // Otherwise the step reads as an oversight and somebody waits for a reply
    // that was never going to be sent.
    render(<CheckInTimeline checkIn={withStage({ vendor_email: null, can_send: false })} />);

    expect(screen.getByText(/Telephone them and record what they say/i)).toBeInTheDocument();
  });
});

describe('what the reader is told while waiting', () => {
  it('does not let silence read as either payment or refusal', () => {
    const waiting = withStage({
      standing: 'awaiting_vendor',
      sent_at: '2026-07-02T09:00:00Z',
      can_send: false,
    });

    render(<CheckInTimeline checkIn={waiting} />);

    expect(screen.getByText(/Silence is not payment/i)).toBeInTheDocument();
  });

  it('marks every timestamp as volatile so screenshots do not churn', () => {
    // Times are the one thing on this page that differ between two identical
    // runs, and an unmarked one turns every visual baseline into a false
    // failure.
    const { container } = render(<CheckInTimeline checkIn={ANSWERED_YES} />);

    const times = container.querySelectorAll('time');
    expect(times.length).toBeGreaterThan(0);
    for (const time of times) {
      expect(time).toHaveAttribute('data-visual-volatile');
    }
  });
});
