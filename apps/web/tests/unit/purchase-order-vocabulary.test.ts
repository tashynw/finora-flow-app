import { describe, expect, it } from 'vitest';

import {
  capacityDescriptor,
  orderStanding,
  waitingOn,
} from '@/features/purchase-orders/purchase-order-vocabulary';

describe('orderStanding', () => {
  it('uses the label the API decided on rather than inventing one', () => {
    // Open and closed are labels, not states, and the server is the only thing
    // that knows which applies. A second vocabulary here would eventually
    // disagree with the one the register filters by.
    expect(orderStanding('Open', true).label).toBe('Open');
    expect(orderStanding('Closed', false).label).toBe('Closed');
  });

  it('reads as live only while invoices can still be billed against it', () => {
    expect(orderStanding('Open', true).tone).toBe('success');
    expect(orderStanding('Closed', false).tone).toBe('neutral');
  });
});

describe('capacityDescriptor', () => {
  it('says nothing at all for an order with no figure yet', () => {
    // A draft naming no amount has no capacity to report, and "0 left" would
    // read as an order that is finished.
    expect(capacityDescriptor(null, null)).toBeNull();
    expect(capacityDescriptor(null, 'JMD 0.00')).toBeNull();
  });

  it('treats a fully billed order as finished rather than as a problem', () => {
    const descriptor = capacityDescriptor(0, 'JMD 0.00');

    expect(descriptor?.tone).toBe('neutral');
    expect(descriptor?.label).toBe('Fully billed');
  });

  it('flags an overrun, because that is money nobody committed', () => {
    const descriptor = capacityDescriptor(-150_000, 'JMD 1,500.00');

    expect(descriptor?.tone).toBe('danger');
    expect(descriptor?.label).toBe('JMD 1,500.00 over');
  });

  it('says what is left rather than what has been spent', () => {
    // A reviewer asking whether an invoice fits wants the remainder. Making
    // them subtract two figures per row is how an order gets overrun.
    expect(capacityDescriptor(500_000, 'JMD 5,000.00')?.label).toBe('JMD 5,000.00 left');
  });
});

describe('waitingOn', () => {
  it('counts what is unfinished on a draft, in the singular where it should', () => {
    expect(waitingOn('draft', 1)?.label).toBe('1 thing to finish');
    expect(waitingOn('draft', 3)?.label).toBe('3 things to finish');
  });

  it('says a complete draft is ready rather than saying nothing', () => {
    expect(waitingOn('draft', 0)).toEqual({ label: 'Ready to commit', tone: 'info' });
  });

  it('names who has it while it is out for approval', () => {
    expect(waitingOn('pending_approval', 0)?.label).toBe('With approvers');
  });

  it('says nothing once the order has been decided', () => {
    // An approved order is not waiting on anybody, and a label saying so would
    // be noise on every settled row in the register.
    expect(waitingOn('approved', 0)).toBeNull();
    expect(waitingOn('cancelled', 0)).toBeNull();
  });
});
