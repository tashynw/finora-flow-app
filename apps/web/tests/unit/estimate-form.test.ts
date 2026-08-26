import { describe, expect, it } from 'vitest';

import type { EstimateDetail } from '@finora/shared-types';

import {
  type EstimateFormValues,
  draftFrom,
  isBlankDraft,
  isSameDraft,
  valuesFrom,
} from '@/features/estimates/estimate-form';

/**
 * A saved estimate, as the API sends it.
 *
 * Only the fields the form reads are given real values. The rest exist because
 * the type requires them, and a helper that filled them with plausible-looking
 * data would invite a test to assert against something the form never touches.
 */
function estimate(overrides: Partial<EstimateDetail> = {}): EstimateDetail {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    reference: 'EST-000001',
    state: 'draft',
    state_label: 'Draft',
    vendor_name: 'Kingston Supplies Limited',
    description: 'Replacement air handling unit',
    total_minor_units: 4_500_000,
    currency: 'JMD',
    total_formatted: 'JMD 45,000.00',
    estimate_date: '2026-07-28',
    needed_by: '2026-09-01',
    requester_label: 'Alex Requester',
    department: 'Facilities',
    created_at: '2026-07-29T10:00:00Z',
    submitted_at: null,
    decided_at: null,
    route_summary: null,
    awaiting_labels: [],
    awaiting_me: false,
    problem_count: 0,
    vendor_id: '22222222-2222-2222-2222-222222222222',
    estimate_number: 'Q-8841',
    justification: 'The current unit has failed and the server room is overheating.',
    cost_centre: { id: '33333333-3333-3333-3333-333333333333', code: 'CC-100', name: 'Facilities' },
    gl_account: null,
    document_id: null,
    problems: [],
    route: null,
    route_history: [],
    transitions: [],
    planned_route: null,
    planned_route_problem: null,
    actions: {
      may_edit: true,
      may_submit: true,
      may_withdraw: false,
      may_cancel: true,
      may_decide: false,
    },
    ...overrides,
  };
}

describe('valuesFrom', () => {
  it('fills the boxes from the saved record', () => {
    const values = valuesFrom(estimate());
    expect(values.vendorId).toBe('22222222-2222-2222-2222-222222222222');
    expect(values.amount).toBe('45000.00');
    expect(values.currency).toBe('JMD');
    expect(values.estimateDate).toBe('2026-07-28');
    expect(values.costCentreId).toBe('33333333-3333-3333-3333-333333333333');
  });

  it('shows a typed-in supplier as one that is not on the list', () => {
    // Otherwise a name somebody typed would come back as an unselected picker and
    // look as though the supplier had been lost.
    const values = valuesFrom(estimate({ vendor_id: null, vendor_name: 'A new supplier' }));
    expect(values.vendorId).toBe('__other__');
    expect(values.vendorName).toBe('A new supplier');
  });

  it('leaves the supplier unset on a blank draft rather than inventing a choice', () => {
    const values = valuesFrom(estimate({ vendor_id: null, vendor_name: '' }));
    expect(values.vendorId).toBe('');
  });

  it('defaults the currency so the amount box has a scale to be read in', () => {
    // An amount with no currency is not a sum of money, and the picker cannot sit
    // empty while the number beside it is being typed.
    expect(valuesFrom(estimate({ currency: null, total_minor_units: null })).currency).toBe('JMD');
  });

  it('leaves the amount empty when none is recorded', () => {
    expect(valuesFrom(estimate({ total_minor_units: null })).amount).toBe('');
  });
});

describe('draftFrom', () => {
  it('round-trips a saved record unchanged', () => {
    // What the form sends back after touching nothing has to equal what came in,
    // or every draft would report unsaved changes the moment it opened.
    const row = estimate();
    const draft = draftFrom(valuesFrom(row));
    expect(draft.vendor_id).toBe(row.vendor_id);
    expect(draft.vendor_name).toBe(row.vendor_name);
    expect(draft.total_minor_units).toBe(row.total_minor_units);
    expect(draft.currency).toBe(row.currency);
    expect(draft.estimate_date).toBe(row.estimate_date);
    expect(draft.needed_by).toBe(row.needed_by);
    expect(draft.cost_centre_id).toBe(row.cost_centre?.id);
    expect(draft.gl_account_id).toBeNull();
  });

  it('sends no supplier identifier for a name that is not on the list', () => {
    const values: EstimateFormValues = {
      ...valuesFrom(estimate()),
      vendorId: '__other__',
      vendorName: 'A new supplier',
    };
    const draft = draftFrom(values);
    expect(draft.vendor_id).toBeNull();
    expect(draft.vendor_name).toBe('A new supplier');
  });

  it('does not leave a currency behind on a record with no amount', () => {
    // A currency with nothing to scale would be a stored value nothing means.
    const draft = draftFrom({ ...valuesFrom(estimate()), amount: '' });
    expect(draft.total_minor_units).toBeNull();
    expect(draft.currency).toBeNull();
  });

  it('trims what was typed and sends an empty optional as absent', () => {
    const draft = draftFrom({
      ...valuesFrom(estimate()),
      description: '  Replacement unit  ',
      estimateNumber: '   ',
      neededBy: '',
    });
    expect(draft.description).toBe('Replacement unit');
    expect(draft.estimate_number).toBeNull();
    expect(draft.needed_by).toBeNull();
  });
});

describe('isSameDraft', () => {
  it('sees no change in a record that has only been opened', () => {
    const values = valuesFrom(estimate());
    expect(isSameDraft(draftFrom(values), draftFrom(values))).toBe(true);
  });

  it('notices the change that matters most', () => {
    const before = draftFrom(valuesFrom(estimate()));
    const after = draftFrom({ ...valuesFrom(estimate()), amount: '60000.00' });
    expect(isSameDraft(before, after)).toBe(false);
  });

  it('does not report a change for whitespace nobody meant to type', () => {
    // The trailing space is stripped on the way out, so the record is identical
    // and the save button has nothing to offer.
    const before = draftFrom(valuesFrom(estimate()));
    const after = draftFrom({
      ...valuesFrom(estimate()),
      description: `${estimate().description} `,
    });
    expect(isSameDraft(before, after)).toBe(true);
  });
});

/**
 * This decides whether a form arrives with its gaps already marked in red. On a
 * blank estimate that would be an accusation before the requester has typed
 * anything, so getting the "nothing here yet" case right matters more than the
 * usual boolean helper.
 */
describe('isBlankDraft', () => {
  const blank = (): EstimateFormValues =>
    valuesFrom(
      estimate({
        vendor_id: null,
        vendor_name: '',
        description: '',
        justification: '',
        estimate_number: null,
        estimate_date: null,
        needed_by: null,
        total_minor_units: null,
        currency: null,
        cost_centre: null,
        gl_account: null,
      }),
    );

  it('recognises an estimate nobody has typed into', () => {
    expect(isBlankDraft(draftFrom(blank()))).toBe(true);
  });

  it('does not count the defaulted currency as something the user entered', () => {
    // The currency picker is never empty, so counting it would make every new
    // estimate look started and defeat the whole check.
    expect(draftFrom(blank()).currency).toBeNull();
    expect(isBlankDraft(draftFrom({ ...blank(), currency: 'USD' }))).toBe(true);
  });

  it('treats a single filled box as work in progress', () => {
    expect(isBlankDraft(draftFrom({ ...blank(), description: 'A new laptop' }))).toBe(false);
  });

  it('treats an amount of zero as entered rather than absent', () => {
    // Zero is a figure somebody typed, and a quotation for nothing is a mistake
    // worth flagging rather than hiding.
    expect(isBlankDraft(draftFrom({ ...blank(), amount: '0' }))).toBe(false);
  });

  it('sees a whole saved estimate as anything but blank', () => {
    expect(isBlankDraft(draftFrom(valuesFrom(estimate())))).toBe(false);
  });

  it('counts an optional field on its own as a start', () => {
    // Somebody who typed only the supplier's quotation number has still begun,
    // and marking the rest is then help rather than accusation.
    expect(isBlankDraft(draftFrom({ ...blank(), estimateNumber: 'Q-8841' }))).toBe(false);
  });
});
