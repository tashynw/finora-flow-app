import { useMemo, useState } from 'react';

import type { EstimateDraftRequest, EstimateDetail, ReferenceData } from '@finora/shared-types';

import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { amountInputValue, parseAmount } from '@/lib/money';

/**
 * The editor for a draft estimate.
 *
 * Every field an approver needs is on one screen, in the order somebody
 * reconstructs a quotation in: who it is from, what it is for, what it costs,
 * when it is needed, where it is coded, and why. Nothing is behind a step or a
 * disclosure, because a requester filling this in has the supplier's document in
 * front of them and wants to copy it once.
 *
 * The completeness rules are not evaluated here. The server returns the list of
 * what is outstanding on every read, and this form marks the fields that list
 * names. A copy of those rules in the browser would eventually disagree with the
 * server's copy, and the server's is the one that decides.
 */

const OTHER_VENDOR = '__other__';

export interface EstimateFormValues {
  vendorId: string;
  vendorName: string;
  description: string;
  justification: string;
  estimateNumber: string;
  estimateDate: string;
  neededBy: string;
  amount: string;
  currency: string;
  costCentreId: string;
  glAccountId: string;
}

/** The saved estimate as form text. */
export function valuesFrom(estimate: EstimateDetail): EstimateFormValues {
  const currency = estimate.currency ?? 'JMD';
  return {
    vendorId: estimate.vendor_id ?? (estimate.vendor_name ? OTHER_VENDOR : ''),
    vendorName: estimate.vendor_name,
    description: estimate.description,
    justification: estimate.justification,
    estimateNumber: estimate.estimate_number ?? '',
    estimateDate: estimate.estimate_date ?? '',
    neededBy: estimate.needed_by ?? '',
    amount: amountInputValue(estimate.total_minor_units, currency),
    currency,
    costCentreId: estimate.cost_centre?.id ?? '',
    glAccountId: estimate.gl_account?.id ?? '',
  };
}

/** The form as the request body the API takes. */
export function draftFrom(values: EstimateFormValues): EstimateDraftRequest {
  const minorUnits = parseAmount(values.amount, values.currency);
  return {
    vendor_name: values.vendorName.trim(),
    description: values.description.trim(),
    justification: values.justification.trim(),
    vendor_id: values.vendorId && values.vendorId !== OTHER_VENDOR ? values.vendorId : null,
    estimate_number: values.estimateNumber.trim() || null,
    estimate_date: values.estimateDate || null,
    needed_by: values.neededBy || null,
    total_minor_units: minorUnits,
    // Sent whenever an amount is, because an amount without a currency is not a
    // sum of money. Sent as null with no amount so a currency chosen and then
    // emptied does not linger on the record.
    currency: minorUnits === null ? null : values.currency,
    cost_centre_id: values.costCentreId || null,
    gl_account_id: values.glAccountId || null,
  };
}

export function isSameDraft(a: EstimateDraftRequest, b: EstimateDraftRequest): boolean {
  return (
    Object.keys(a) as (keyof EstimateDraftRequest)[]
  ).every((key) => a[key] === b[key]);
}

/**
 * Whether nothing has been entered on this estimate yet.
 *
 * Used to decide whether to mark the empty boxes as problems. A brand-new
 * estimate is missing everything by definition, and colouring the whole form red
 * before the requester has typed a character accuses them of a mistake they have
 * not had the chance to make. The checklist above the form still lists all of it.
 *
 * The currency is ignored because it is never empty — it defaults — so counting
 * it would make every estimate look started.
 */
export function isBlankDraft(draft: EstimateDraftRequest): boolean {
  return (
    !draft.vendor_id &&
    !draft.vendor_name &&
    !draft.description &&
    !draft.justification &&
    !draft.estimate_number &&
    !draft.estimate_date &&
    !draft.needed_by &&
    draft.total_minor_units === null &&
    !draft.cost_centre_id &&
    !draft.gl_account_id
  );
}

export interface EstimateFormProps {
  values: EstimateFormValues;
  onChange: (values: EstimateFormValues) => void;
  reference: ReferenceData | undefined;
  /** Field names the server says are outstanding, keyed to their explanation. */
  problems: Record<string, string>;
  /** Fields edited since the last save, whose saved problems no longer apply. */
  touched: Set<string>;
  disabled?: boolean;
}

export function EstimateForm({
  values,
  onChange,
  reference,
  problems,
  touched,
  disabled = false,
}: EstimateFormProps) {
  const [showVendorName, setShowVendorName] = useState(
    () => values.vendorId === OTHER_VENDOR || (!values.vendorId && Boolean(values.vendorName)),
  );

  const vendors = reference?.vendors ?? [];
  const currencies = reference?.currencies ?? [values.currency];

  /**
   * A problem for this field, unless it has been edited since the save the
   * problem was computed from. Once somebody types in a box, what the server
   * last said about it is out of date and repeating it is a lie about their work.
   */
  const errorFor = useMemo(
    () => (name: string) => (touched.has(name) ? undefined : problems[name]),
    [problems, touched],
  );

  const set = (patch: Partial<EstimateFormValues>) => onChange({ ...values, ...patch });

  return (
    <div className="flex flex-col gap-[var(--space-5)]">
      <div className="grid gap-[var(--space-5)] md:grid-cols-2">
        <Field
          label="Supplier"
          required
          // Carried by the name box instead when one is showing, so a missing
          // supplier is not reported twice for one gap.
          error={showVendorName ? undefined : errorFor('vendor_name')}
          help="Choose from the suppliers finance has already set up, so payment details and history stay attached to one record."
        >
          {({ inputId, describedBy, invalid }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              disabled={disabled}
              value={values.vendorId}
              onChange={(event) => {
                const choice = event.target.value;
                if (choice === OTHER_VENDOR) {
                  setShowVendorName(true);
                  set({ vendorId: OTHER_VENDOR, vendorName: '' });
                  return;
                }
                setShowVendorName(false);
                const vendor = vendors.find((row) => row.id === choice);
                set({ vendorId: choice, vendorName: vendor?.name ?? '' });
              }}
            >
              <option value="">Choose a supplier</option>
              {vendors.map((vendor) => (
                <option key={vendor.id} value={vendor.id}>
                  {vendor.name}
                </option>
              ))}
              <option value={OTHER_VENDOR}>Not in this list</option>
            </Select>
          )}
        </Field>

        {showVendorName ? (
          <Field
            label="Supplier name"
            required
            error={errorFor('vendor_name')}
            help="Typed in because this supplier is not set up yet. Finance matches it to a supplier record before anything is paid."
          >
            {({ inputId, describedBy, invalid }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                invalid={invalid}
                disabled={disabled}
                value={values.vendorName}
                maxLength={300}
                onChange={(event) => set({ vendorName: event.target.value })}
              />
            )}
          </Field>
        ) : null}

        <Field
          label="Supplier’s quotation number"
          help="Their reference for this quotation, so a later invoice can be matched to it."
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              disabled={disabled}
              value={values.estimateNumber}
              maxLength={120}
              onChange={(event) => set({ estimateNumber: event.target.value })}
            />
          )}
        </Field>
      </div>

      <Field
        label="What is being bought"
        required
        error={errorFor('description')}
        help="One line, readable by an approver who has not seen the quotation."
      >
        {({ inputId, describedBy, invalid }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            invalid={invalid}
            disabled={disabled}
            value={values.description}
            maxLength={500}
            onChange={(event) => set({ description: event.target.value })}
          />
        )}
      </Field>

      <div className="grid gap-[var(--space-5)] md:grid-cols-[2fr_1fr]">
        <Field
          label="Total"
          required
          error={errorFor('total')}
          // The hint is a fragment of the sentence before it rather than a token
          // dropped after it, because a bare "1234.56" under a box reads as a
          // value somebody left behind.
          help="The whole amount being sought, as the quotation states it. Figures only, in the form"
          formatHint="1234.56"
        >
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              disabled={disabled}
              numeric
              inputMode="decimal"
              value={values.amount}
              onChange={(event) => set({ amount: event.target.value })}
            />
          )}
        </Field>

        <Field label="Currency" required>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              disabled={disabled}
              value={values.currency}
              onChange={(event) => set({ currency: event.target.value })}
            >
              {currencies.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <div className="grid gap-[var(--space-5)] md:grid-cols-2">
        <Field
          label="Date on the quotation"
          required
          error={errorFor('estimate_date')}
          help="As printed by the supplier, not today’s date."
        >
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              type="date"
              aria-describedby={describedBy}
              invalid={invalid}
              disabled={disabled}
              value={values.estimateDate}
              onChange={(event) => set({ estimateDate: event.target.value })}
            />
          )}
        </Field>

        <Field
          label="Needed by"
          error={errorFor('needed_by')}
          help="When the goods or services have to be in place. Approvers use it to order their queue."
        >
          {({ inputId, describedBy, invalid }) => (
            <Input
              id={inputId}
              type="date"
              aria-describedby={describedBy}
              invalid={invalid}
              disabled={disabled}
              value={values.neededBy}
              onChange={(event) => set({ neededBy: event.target.value })}
            />
          )}
        </Field>
      </div>

      <div className="grid gap-[var(--space-5)] md:grid-cols-2">
        <Field
          label="Cost centre"
          required
          error={errorFor('cost_centre_id')}
          help="Whose budget this comes out of. It decides who has to approve it."
        >
          {({ inputId, describedBy, invalid }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              disabled={disabled}
              value={values.costCentreId}
              onChange={(event) => set({ costCentreId: event.target.value })}
            >
              <option value="">Choose a cost centre</option>
              {(reference?.cost_centres ?? []).map((centre) => (
                <option key={centre.id} value={centre.id}>
                  {centre.code} — {centre.name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          label="GL account"
          help="Optional here. Finance sets it before the invoice is coded, and choosing it now saves them a question."
        >
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              disabled={disabled}
              value={values.glAccountId}
              onChange={(event) => set({ glAccountId: event.target.value })}
            >
              <option value="">Leave for finance</option>
              {(reference?.gl_accounts ?? []).map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} — {account.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <Field
        label="Why this is needed"
        required
        error={errorFor('justification')}
        help="The first thing an approver reads. Say what happens if it is not bought, not what it is."
      >
        {({ inputId, describedBy, invalid }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            invalid={invalid}
            disabled={disabled}
            rows={5}
            value={values.justification}
            maxLength={4000}
            onChange={(event) => set({ justification: event.target.value })}
          />
        )}
      </Field>
    </div>
  );
}
