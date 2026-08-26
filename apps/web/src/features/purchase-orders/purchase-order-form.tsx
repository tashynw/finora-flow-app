import { useMemo } from 'react';

import type {
  PurchaseOrderDetail,
  PurchaseOrderDraftRequest,
  PurchaseOrderReferenceData,
} from '@finora/shared-types';

import { Field, Input, Select } from '@/components/ui/field';
import { amountInputValue, parseAmount } from '@/lib/money';

/**
 * The editor for an order that has not yet been committed.
 *
 * Short on purpose. An order says who, what, how much and against which budget,
 * and everything else about it — whether it needs approving, what has been
 * billed to it, whether it can still be edited — is decided elsewhere and shown
 * elsewhere. A form that also tried to explain the approval consequences of the
 * figure would be reproducing the matrix in the browser, which is the one place
 * it must not live.
 *
 * The estimate selector is the exception worth reading twice. Naming an approved
 * estimate is not filing: it is the difference between an order that opens on
 * submission and an order that goes round for signatures. The help text says so,
 * because somebody who does not know that will send perfectly authorised spend
 * back through a route it has already been through.
 */

export interface OrderFormValues {
  vendorId: string;
  description: string;
  amount: string;
  currency: string;
  costCentreId: string;
  glAccountId: string;
  estimateId: string;
}

/** The saved order as form text. */
export function valuesFrom(order: PurchaseOrderDetail): OrderFormValues {
  const currency = order.currency ?? 'JMD';
  return {
    vendorId: order.vendor?.id ?? '',
    description: order.description,
    amount: amountInputValue(order.total_minor_units, currency),
    currency,
    costCentreId: order.cost_centre?.id ?? '',
    glAccountId: order.gl_account?.id ?? '',
    estimateId: order.estimate_id ?? '',
  };
}

/** The form as the request body the API takes. */
export function draftFrom(values: OrderFormValues): PurchaseOrderDraftRequest {
  const minorUnits = parseAmount(values.amount, values.currency);
  return {
    vendor_id: values.vendorId || null,
    description: values.description.trim(),
    total_minor_units: minorUnits,
    // An amount without a currency is not a sum of money, and a currency left
    // behind after the amount is cleared is a denomination for nothing.
    currency: minorUnits === null ? null : values.currency,
    cost_centre_id: values.costCentreId || null,
    gl_account_id: values.glAccountId || null,
    estimate_id: values.estimateId || null,
  };
}

export function isSameDraft(a: PurchaseOrderDraftRequest, b: PurchaseOrderDraftRequest): boolean {
  return (Object.keys(a) as (keyof PurchaseOrderDraftRequest)[]).every((key) => a[key] === b[key]);
}

/**
 * Whether nothing has been entered on this order yet.
 *
 * A brand-new order is missing everything by definition, and painting the whole
 * form red before anybody has typed a character accuses them of a mistake they
 * have not had the chance to make. The checklist above the form still lists it
 * all. The currency is ignored because it defaults and so is never empty.
 */
export function isBlankDraft(draft: PurchaseOrderDraftRequest): boolean {
  return (
    !draft.vendor_id &&
    !draft.description &&
    draft.total_minor_units === null &&
    !draft.cost_centre_id &&
    !draft.gl_account_id &&
    !draft.estimate_id
  );
}

export interface PurchaseOrderFormProps {
  values: OrderFormValues;
  onChange: (values: OrderFormValues) => void;
  reference: PurchaseOrderReferenceData | undefined;
  /** Currencies the platform will accept, from the shared reference data. */
  currencies: string[];
  /** Field names the server says are outstanding, keyed to their explanation. */
  problems: Record<string, string>;
  /** Fields edited since the last save, whose saved problems no longer apply. */
  touched: Set<string>;
  disabled?: boolean;
}

export function PurchaseOrderForm({
  values,
  onChange,
  reference,
  currencies,
  problems,
  touched,
  disabled = false,
}: PurchaseOrderFormProps) {
  const vendors = reference?.vendors ?? [];
  const costCentres = reference?.cost_centres ?? [];
  const glAccounts = reference?.gl_accounts ?? [];
  const estimates = reference?.approved_estimates ?? [];

  /**
   * A problem for this field, unless it has been edited since the save the
   * problem was computed from. Once somebody types in a box, what the server
   * last said about it is out of date and repeating it is a lie about their work.
   */
  const errorFor = useMemo(
    () => (name: string) => (touched.has(name) ? undefined : problems[name]),
    [problems, touched],
  );

  const set = (patch: Partial<OrderFormValues>) => onChange({ ...values, ...patch });

  return (
    <div className="flex flex-col gap-[var(--space-5)]">
      <Field
        label="Supplier"
        required
        error={errorFor('vendor_id')}
        help="Who the commitment is with. Only suppliers finance has set up can be committed to, because this is the record an invoice is matched against."
      >
        {({ inputId, describedBy, invalid }) => (
          <Select
            id={inputId}
            aria-describedby={describedBy}
            invalid={invalid}
            disabled={disabled}
            value={values.vendorId}
            onChange={(event) => set({ vendorId: event.target.value })}
          >
            <option value="">Choose a supplier</option>
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.name}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field
        label="What is being ordered"
        required
        error={errorFor('description')}
        help="One line an approver can recognise without opening anything else."
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
          label="Order total"
          required
          error={errorFor('total')}
          help="The most this order commits the organisation to. Invoices against it cannot add up to more. Figures only, in the form"
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

      <Field
        label="Approved estimate this draws on"
        error={errorFor('estimate_id')}
        help="If an approved estimate already covers this supplier at this amount, name it and the order opens on submission instead of going round for signatures again."
      >
        {({ inputId, describedBy, invalid }) => (
          <Select
            id={inputId}
            aria-describedby={describedBy}
            invalid={invalid}
            disabled={disabled}
            value={values.estimateId}
            onChange={(event) => set({ estimateId: event.target.value })}
          >
            <option value="">Not against an estimate</option>
            {estimates.map((estimate) => (
              <option key={estimate.id} value={estimate.id}>
                {estimate.name}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <div className="grid gap-[var(--space-5)] md:grid-cols-2">
        <Field
          label="Cost centre"
          required
          error={errorFor('cost_centre_id')}
          help="Whose budget this comes out of. It also decides which department’s approvers see it."
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
              {costCentres.map((centre) => (
                <option key={centre.id} value={centre.id}>
                  {centre.name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          label="Account code"
          error={errorFor('gl_account_id')}
          help="Optional here. Finance can set it later, and will need it before anything is paid."
        >
          {({ inputId, describedBy, invalid }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              invalid={invalid}
              disabled={disabled}
              value={values.glAccountId}
              onChange={(event) => set({ glAccountId: event.target.value })}
            >
              <option value="">Not coded yet</option>
              {glAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
    </div>
  );
}
