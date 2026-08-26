import { describe, expect, it } from 'vitest';

import type { InvoiceDetail } from '@finora/shared-types';

import {
  type InvoiceFormValues,
  draftFrom,
  isBlankDraft,
  isSameDraft,
  valuesFrom,
} from '@/features/invoices/invoice-form';

/**
 * A saved invoice, as the API sends it.
 *
 * Only the fields the form reads are given real values. The rest exist because
 * the type requires them, and filling them with plausible-looking data would
 * invite a test to assert against something the form never touches.
 */
function invoice(overrides: Partial<InvoiceDetail> = {}): InvoiceDetail {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    reference: 'INV-000001',
    state: 'draft',
    state_label: 'Draft',
    vendor_name: 'Kingston Supplies Limited',
    description: 'Replacement air handling unit',
    invoice_number: 'INV-8841',
    invoice_date: '2026-07-28',
    due_date: '2026-08-27',
    total_minor_units: 4_500_000,
    currency: 'JMD',
    total_formatted: 'JMD 45,000.00',
    requester_label: 'Alex Requester',
    department: 'Facilities',
    created_at: '2026-07-29T10:00:00Z',
    submitted_at: null,
    signed_off_at: null,
    decided_at: null,
    route_summary: null,
    awaiting_labels: [],
    awaiting_me: false,
    awaiting_my_sign_off: false,
    problem_count: 0,
    blocker_count: 0,
    days_until_due: 29,
    reminders_sent: null,
    vendor_id: '22222222-2222-2222-2222-222222222222',
    cost_centre: { id: '33333333-3333-3333-3333-333333333333', code: 'CC-100', name: 'Facilities' },
    gl_account: null,
    document_id: null,
    created_by_label: 'Fran Finance',
    estimate: null,
    purchase_order: null,
    suggested_requester_id: null,
    problems: [],
    sign_off: {
      requester_id: '44444444-4444-4444-4444-444444444444',
      requester_label: 'Alex Requester',
      requester_email: 'alex@example.com',
      requested_at: null,
      signed_off_at: null,
      signed_off_by_label: null,
      note: null,
      reminders_sent: 0,
      next_reminder_at: null,
      escalation_level: 0,
      is_mine_to_sign: false,
    },
    route: null,
    route_history: [],
    transitions: [],
    planned_route: null,
    planned_route_problem: null,
    actions: {
      may_edit: true,
      may_request_sign_off: true,
      may_sign_off: false,
      may_decline: false,
      may_recall: false,
      may_cancel: true,
      may_decide: false,
    },
    ...overrides,
  };
}

describe('valuesFrom', () => {
  it('fills the boxes from the saved invoice', () => {
    const values = valuesFrom(invoice());

    expect(values.vendorId).toBe('22222222-2222-2222-2222-222222222222');
    expect(values.invoiceNumber).toBe('INV-8841');
    expect(values.dueDate).toBe('2026-08-27');
    expect(values.amount).toBe('45000.00');
    expect(values.costCentreId).toBe('33333333-3333-3333-3333-333333333333');
  });

  it('defaults the currency rather than leaving the selector on nothing', () => {
    expect(valuesFrom(invoice({ currency: null, total_minor_units: null })).currency).toBe('JMD');
  });

  it('marks a typed-in supplier as one that is not on the master', () => {
    const values = valuesFrom(invoice({ vendor_id: null, vendor_name: 'Somebody Not Set Up' }));

    // The picker shows "Not in this list" and the name box appears beside it,
    // rather than the picker silently reading as "choose a supplier" while a
    // name sits on the record.
    expect(values.vendorId).toBe('__other__');
    expect(values.vendorName).toBe('Somebody Not Set Up');
  });

  it('offers the estimate’s requester when nobody has been assigned yet', () => {
    const values = valuesFrom(
      invoice({
        sign_off: { ...invoice().sign_off, requester_id: null },
        suggested_requester_id: '55555555-5555-5555-5555-555555555555',
      }),
    );

    expect(values.requesterId).toBe('55555555-5555-5555-5555-555555555555');
  });

  it('prefers the assigned person over the suggestion', () => {
    // A suggestion that overrode an assignment would silently reassign the
    // chasing to somebody else the next time the form was saved.
    const values = valuesFrom(
      invoice({ suggested_requester_id: '55555555-5555-5555-5555-555555555555' }),
    );

    expect(values.requesterId).toBe('44444444-4444-4444-4444-444444444444');
  });
});

describe('draftFrom', () => {
  function values(overrides: Partial<InvoiceFormValues> = {}): InvoiceFormValues {
    return { ...valuesFrom(invoice()), ...overrides };
  }

  it('sends the amount as integer minor units', () => {
    expect(draftFrom(values({ amount: '1200.50' })).total_minor_units).toBe(120_050);
  });

  it('trims what somebody typed', () => {
    const draft = draftFrom(values({ description: '  Air handling unit  ' }));
    expect(draft.description).toBe('Air handling unit');
  });

  it('sends no currency when there is no amount', () => {
    // A currency without an amount is not a sum of money, and leaving one on the
    // record makes an empty invoice look partly filled in.
    const draft = draftFrom(values({ amount: '' }));

    expect(draft.total_minor_units).toBeNull();
    expect(draft.currency).toBeNull();
  });

  it('sends no vendor id for a supplier that is not on the master', () => {
    const draft = draftFrom(values({ vendorId: '__other__', vendorName: 'Somebody Not Set Up' }));

    expect(draft.vendor_id).toBeNull();
    expect(draft.vendor_name).toBe('Somebody Not Set Up');
  });

  it('turns an unset linkage into null rather than an empty string', () => {
    const draft = draftFrom(values({ estimateId: '', purchaseOrderId: '' }));

    expect(draft.estimate_id).toBeNull();
    expect(draft.purchase_order_id).toBeNull();
  });
});

describe('isSameDraft', () => {
  it('is true for a draft nobody has changed', () => {
    const saved = draftFrom(valuesFrom(invoice()));
    expect(isSameDraft(saved, draftFrom(valuesFrom(invoice())))).toBe(true);
  });

  it('notices a changed linkage', () => {
    // The linkage decides whether the overrun controls fire at all, so treating a
    // changed one as no change would let somebody leave the page believing the
    // estimate they picked had been saved.
    const saved = draftFrom(valuesFrom(invoice()));
    const changed = draftFrom({
      ...valuesFrom(invoice()),
      estimateId: '66666666-6666-6666-6666-666666666666',
    });

    expect(isSameDraft(saved, changed)).toBe(false);
  });

  it('notices a changed amount', () => {
    const saved = draftFrom(valuesFrom(invoice()));
    const changed = draftFrom({ ...valuesFrom(invoice()), amount: '45000.01' });

    expect(isSameDraft(saved, changed)).toBe(false);
  });
});

describe('isBlankDraft', () => {
  it('is true for an invoice nobody has typed into', () => {
    const blank = invoice({
      vendor_id: null,
      vendor_name: '',
      description: '',
      invoice_number: null,
      invoice_date: null,
      due_date: null,
      total_minor_units: null,
      currency: null,
      cost_centre: null,
      gl_account: null,
      sign_off: { ...invoice().sign_off, requester_id: null },
    });

    expect(isBlankDraft(draftFrom(valuesFrom(blank)))).toBe(true);
  });

  it('is false once anything at all has been entered', () => {
    const started = invoice({
      vendor_id: null,
      vendor_name: '',
      description: '',
      invoice_number: 'INV-1',
      invoice_date: null,
      due_date: null,
      total_minor_units: null,
      currency: null,
      cost_centre: null,
      gl_account: null,
      sign_off: { ...invoice().sign_off, requester_id: null },
    });

    expect(isBlankDraft(draftFrom(valuesFrom(started)))).toBe(false);
  });

  it('does not count the currency, which is never empty', () => {
    // Counting the defaulted currency would make every invoice look started, and
    // the whole form would go red before anybody had typed a character.
    const blank = invoice({
      vendor_id: null,
      vendor_name: '',
      description: '',
      invoice_number: null,
      invoice_date: null,
      due_date: null,
      total_minor_units: null,
      currency: 'USD',
      cost_centre: null,
      gl_account: null,
      sign_off: { ...invoice().sign_off, requester_id: null },
    });

    expect(isBlankDraft(draftFrom(valuesFrom(blank)))).toBe(true);
  });
});
