import { describe, expect, it } from 'vitest';

import {
  contentsSummary,
  lineStanding,
  packageStanding,
  waitingOn,
} from '@/features/payments/payment-vocabulary';

describe('packageStanding', () => {
  it('uses the label the API decided on rather than inventing one', () => {
    // Open, submitted and cancelled are derived from two timestamps on the
    // server. A second vocabulary here would eventually disagree with the one
    // the register filters by.
    expect(packageStanding('open', 'Being assembled').label).toBe('Being assembled');
    expect(packageStanding('submitted', 'Sent').label).toBe('Sent');
  });

  it('never reads as a decision anybody made about the money', () => {
    // Nothing in a package is awaiting approval: everything in it was approved
    // before it could be added. A success tone on "sent" would read as a
    // payment that has cleared, which is precisely what has not happened yet.
    const sent = packageStanding('submitted', 'Sent');

    expect(sent.tone).toBe('progress');
    expect(sent.description).not.toMatch(/approv|paid/i);
  });

  it('says plainly that an open package has cost nothing yet', () => {
    expect(packageStanding('open', 'Being assembled').description).toMatch(
      /nothing has left the account/i,
    );
  });

  it('treats an abandoned package as unremarkable rather than as a failure', () => {
    // Abandoning costs nobody anything — every invoice goes back to approved
    // and unpaid — so it is neutral, not danger.
    expect(packageStanding('cancelled', 'Abandoned').tone).toBe('neutral');
  });
});

describe('waitingOn', () => {
  it('says nothing once a package has gone', () => {
    // A submitted package is waiting on the bank, and after that on a supplier
    // confirming. Neither is this screen's business, and a label here would be
    // noise on every settled row in the register.
    expect(waitingOn('submitted', 4, 0)).toBeNull();
    expect(waitingOn('cancelled', 0, 0)).toBeNull();
  });

  it('puts a line that is no longer payable ahead of being ready', () => {
    const waiting = waitingOn('open', 6, 1);

    expect(waiting).toEqual({ label: '1 thing to look at', tone: 'warning' });
  });

  it('counts several problems in the plural', () => {
    expect(waitingOn('open', 6, 3)?.label).toBe('3 things to look at');
  });

  it('distinguishes an empty package from one that is ready', () => {
    // Both are unblocked, and reporting them the same way would let an empty
    // package sit in the register looking finished.
    expect(waitingOn('open', 0, 0)).toEqual({ label: 'Nothing in it yet', tone: 'neutral' });
    expect(waitingOn('open', 2, 0)).toEqual({ label: 'Ready to send', tone: 'info' });
  });
});

describe('contentsSummary', () => {
  it('reports invoices and suppliers separately', () => {
    // Eighty invoices across three suppliers and eighty across eighty are the
    // same size of payment run and nothing like the same amount of risk.
    expect(contentsSummary(80, 3)).toBe('80 invoices, 3 suppliers');
  });

  it('gets the singular right on both counts', () => {
    expect(contentsSummary(1, 1)).toBe('1 invoice, 1 supplier');
  });

  it('says empty rather than counting to zero', () => {
    expect(contentsSummary(0, 0)).toBe('Empty');
  });
});

describe('lineStanding', () => {
  it('says nothing about a line that is still what the package thought it was', () => {
    expect(lineStanding(true, 'Ready for submission')).toBeNull();
  });

  it('flags a line that has stopped being payable and says what to do', () => {
    // An invoice cancelled after it was added leaves the line quoting a figure
    // nobody owes, and the reader's next action is to take it out.
    const standing = lineStanding(false, 'Cancelled');

    expect(standing?.tone).toBe('danger');
    expect(standing?.label).toBe('Cancelled');
    expect(standing?.description).toMatch(/has to come out/i);
  });
});
